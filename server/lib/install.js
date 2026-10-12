// Install + reconcile — the cross-tool agent state layer. Port of the original
// `install/mod.rs`: an install ledger (`installs.json`), backups before every
// destructive write, and reconciliation of ledger ↔ disk ↔ catalog into the
// five states (current / outdated / modified / removed / foreign).
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { appDataDir, stateDir, home as osHome } from "./paths.js";
import { atomicWrite, readCapped, mkdirp, exists, prettyJson } from "./fsutil.js";
import { io } from "./errors.js";
import * as registry from "./registry.js";
import * as render from "./render.js";
import { ensureCorpus, readSource } from "./corpus.js";
import { effective } from "./settings.js";

const MAX_INSTALLED_BYTES = 4 * 1024 * 1024;

// ---------- Ledger ----------

const ledgerPath = () => path.join(stateDir(appDataDir()), "installs.json");
const backupsDir = () => path.join(appDataDir(), "backups");
const nowIso = () => new Date().toISOString();
const fsStamp = (iso) => iso.replace(/[:/]/g, "-");
const sameKey = (r, slug, tool, projectPath) =>
  r.slug === slug && r.tool === tool && (r.projectPath ?? null) === (projectPath ?? null);

async function loadLedger() {
  let raw;
  try {
    raw = await fsp.readFile(ledgerPath(), "utf8");
  } catch {
    return [];
  }
  try {
    return JSON.parse(raw).map((r) => ({ bodyHash: "", ...r }));
  } catch (e) {
    throw io(`parse installs.json: ${e.message}`);
  }
}

async function saveLedger(records) {
  await mkdirp(path.dirname(ledgerPath()));
  await atomicWrite(ledgerPath(), prettyJson(records));
}

/** Per-tool user base dir: a configured custom path (e.g. a WSL home) or the OS home. */
function toolHome(tool) {
  const custom = effective()?.toolPaths?.[tool];
  return custom ? custom : osHome();
}

function recordFor(agent, primaryDest, tool, projectRoot, renderedHash, sourceHash, bodyHash, corpusVersion, installedAt) {
  return {
    slug: agent.slug,
    tool,
    scope: render.scopeFor(projectRoot),
    projectPath: projectRoot ?? null,
    dest: primaryDest,
    sourceHash,
    bodyHash,
    renderedHash,
    installedAt,
    corpusVersion,
  };
}

async function backupIfDiffers(dest, newBytes, backupDir, stamp) {
  let existing;
  try {
    existing = await fsp.readFile(dest);
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw io(`read existing file ${dest} before backup: ${e.message}`);
  }
  if (existing.equals(Buffer.from(newBytes))) return;
  await mkdirp(backupDir);
  await atomicWrite(path.join(backupDir, `${path.basename(dest)}.${fsStamp(stamp)}.bak`), existing);
}

/** Possible physical destinations: catalog-filename slug and converter slug variants. */
function candidateDests(agent, raw, tool, home, projectRoot) {
  const paths = render.dests(tool, agent.slug, home, projectRoot);
  const conv = render.outputSlug(agent, raw, tool);
  if (conv !== agent.slug) {
    for (const p of render.dests(tool, conv, home, projectRoot)) if (!paths.includes(p)) paths.push(p);
  }
  return paths;
}

function toolIsDirUnit(tool) {
  const dest = registry.get(tool)?.dest;
  if (!dest) return false;
  return [...(dest.user ?? []), ...(dest.project ?? [])].some((t) => {
    const i = t.indexOf("{slug}");
    return i >= 0 && t.slice(i + "{slug}".length).startsWith("/");
  });
}

async function writeAgentFiles(agent, raw, tool, home, projectRoot, backupDir, sourceHash, bodyHash, corpusVersion, installedAt, preferredDest) {
  const { bytes, hash } = render.renderWithHash(agent, raw, tool);
  const paths = render.dests(tool, agent.slug, home, projectRoot);
  const valid = candidateDests(agent, raw, tool, home, projectRoot);
  if (preferredDest && valid.includes(preferredDest)) {
    if (paths.length === 1) paths[0] = preferredDest;
    else {
      const i = paths.indexOf(preferredDest);
      if (i > 0) [paths[0], paths[i]] = [paths[i], paths[0]];
    }
  }
  for (const dest of paths) {
    if (backupDir) await backupIfDiffers(dest, bytes, backupDir, installedAt);
    await mkdirp(path.dirname(dest));
    await atomicWrite(dest, bytes);
  }
  return recordFor(agent, paths[0], tool, projectRoot, hash, sourceHash, bodyHash, corpusVersion, installedAt);
}

function trackAgentRecord(agent, raw, tool, home, projectRoot, sourceHash, bodyHash, corpusVersion, installedAt) {
  const { hash } = render.renderWithHash(agent, raw, tool);
  const paths = candidateDests(agent, raw, tool, home, projectRoot);
  const primary = paths.find((p) => exists(p)) ?? paths[0];
  return recordFor(agent, primary, tool, projectRoot, hash, sourceHash, bodyHash, corpusVersion, installedAt);
}

async function lookup(slug) {
  const corpus = await ensureCorpus();
  const agent = corpus.get(slug);
  if (!agent) throw io(`unknown agent: ${slug}`);
  const entry = corpus.entry(slug);
  if (!entry) throw io(`no corpus-index entry for ${slug}`);
  const raw = await readSource(agent.category, slug);
  return { corpus, agent, entry, raw };
}

// Serialize ledger mutations so concurrent UI actions can't lose rows.
let chain = Promise.resolve();
const serial = (fn) => {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
};

function doInstall(slug, tool, projectPath) {
  return serial(async () => {
    const { corpus, agent, entry, raw } = await lookup(slug);
    const ledger = await loadLedger();
    const existing = ledger.find((r) => sameKey(r, slug, tool, projectPath))?.dest ?? null;
    const record = await writeAgentFiles(
      agent, raw, tool, toolHome(tool), projectPath ?? null, backupsDir(),
      entry.sourceHash, entry.bodyHash, corpus.version(), nowIso(), existing,
    );
    const next = ledger.filter((r) => !sameKey(r, slug, tool, projectPath));
    next.push(record);
    await saveLedger(next);
    return record;
  });
}

function classify(disk, renderedHash, recordSource, corpusSource) {
  if (disk == null) return "removed";
  if (disk !== renderedHash) return "modified";
  if (corpusSource == null) return "current";
  return corpusSource === recordSource ? "current" : "outdated";
}

function bytesMatchRender(agent, raw, tool, fileBytes) {
  try {
    return render.sha256Hex(fileBytes) === render.renderWithHash(agent, raw, tool).hash;
  } catch {
    return false;
  }
}

function detect(tool, home) {
  const det = registry.get(tool)?.detect;
  if (!det) return { detected: false, agentsDir: null };
  return {
    detected: (det.dirs ?? []).some((d) => exists(path.join(home, d))),
    agentsDir: det.agentsDir ? path.join(home, det.agentsDir) : null,
  };
}

const supported = () => registry.wired().map((m) => m.id);

/** Scannable agents roots for a tool, each with the template suffix after `{slug}`. */
function agentUnits(tool, home, projectRoot) {
  const dest = registry.get(tool)?.dest;
  if (!dest) return [];
  const templates = projectRoot ? dest.project ?? [] : dest.user ?? [];
  const root = projectRoot || home;
  const seen = new Map();
  for (const t of templates) {
    const i = t.indexOf("{slug}");
    if (i < 0) continue;
    const dir = path.join(root, t.slice(0, i));
    const suffix = t.slice(i + "{slug}".length);
    seen.set(`${dir}\0${suffix}`, [dir, suffix]);
  }
  return [...seen.keys()].sort().map((k) => seen.get(k));
}

async function readMaybe(file) {
  try {
    return await readCapped(file, MAX_INSTALLED_BYTES);
  } catch {
    return null;
  }
}

function probeVersion(tool) {
  const v = registry.get(tool)?.version;
  if (!v) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(v.bin, v.args ?? [], { timeout: 3000, windowsHide: true, shell: process.platform === "win32" }, (err, stdout, stderr) => {
      if (err) return resolve(null);
      const first = (s) => s.toString().split("\n").map((l) => l.trim()).find((l) => l) ?? null;
      const line = first(stdout) ?? first(stderr);
      resolve(line ? [...line].slice(0, 48).join("") : null);
    });
  });
}

function openInFileManager(p) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [p]] : process.platform === "win32" ? ["explorer.exe", [p]] : ["xdg-open", [p]];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: false });
    child.on("error", (e) => reject(io(`could not open ${p}: ${e.message}`)));
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

// ---------- Commands ----------

export const commands = {
  install_agent({ slug, tool, projectPath }) {
    return doInstall(slug, tool, projectPath ?? null);
  },

  update_agent({ slug, tool, projectPath }) {
    return doInstall(slug, tool, projectPath ?? null);
  },

  track_agent({ slug, tool, projectPath }) {
    return serial(async () => {
      const { corpus, agent, entry, raw } = await lookup(slug);
      const record = trackAgentRecord(
        agent, raw, tool, toolHome(tool), projectPath ?? null,
        entry.sourceHash, entry.bodyHash, corpus.version(), nowIso(),
      );
      const ledger = (await loadLedger()).filter((r) => !sameKey(r, slug, tool, projectPath));
      ledger.push(record);
      await saveLedger(ledger);
      return record;
    });
  },

  async agent_diff({ slug, tool, projectPath }) {
    const { agent, raw } = await lookup(slug);
    const proposed = render.render(agent, raw, tool);
    const ledger = await loadLedger();
    const ledgerDest = ledger.find((r) => sameKey(r, slug, tool, projectPath))?.dest;
    const candidates = candidateDests(agent, raw, tool, toolHome(tool), projectPath ?? null);
    const dest = ledgerDest ?? candidates.find((p) => exists(p)) ?? candidates[0];
    const disk = await readMaybe(dest);
    const onDisk = disk ? disk.toString("utf8") : null;
    return { slug, tool, projectPath: projectPath ?? null, dest, onDisk, proposed, differs: onDisk !== proposed };
  },

  uninstall_agent({ slug, tool, projectPath }) {
    return serial(async () => {
      const { agent, raw } = await lookup(slug);
      const home = toolHome(tool);
      const ledger = await loadLedger();
      const ledgerDest = ledger.find((r) => sameKey(r, slug, tool, projectPath))?.dest;
      const { bytes: canonical } = render.renderWithHash(agent, raw, tool);
      const paths = candidateDests(agent, raw, tool, home, projectPath ?? null);
      if (ledgerDest && !paths.includes(ledgerDest)) paths.push(ledgerDest);
      const present = paths.filter((p) => exists(p));
      const stamp = nowIso();
      // Back up everything first, so a failed backup can't follow a deletion.
      for (const [i, p] of present.entries()) await backupIfDiffers(p, canonical, backupsDir(), `${stamp}-${i}`);
      const dirUnit = toolIsDirUnit(tool);
      for (const p of present) {
        try {
          await fsp.unlink(p);
        } catch (e) {
          if (e.code !== "ENOENT") throw io(`remove agent file ${p}: ${e.message}`);
        }
        if (dirUnit) await fsp.rmdir(path.dirname(p)).catch(() => {});
      }
      await saveLedger(ledger.filter((r) => !sameKey(r, slug, tool, projectPath)));
      return null;
    });
  },

  project_forget({ projectPath }) {
    return serial(async () => {
      await saveLedger((await loadLedger()).filter((r) => r.projectPath !== projectPath));
      return null;
    });
  },

  installs_reconcile({ projectRoots = [] } = {}) {
    return serial(async () => {
      const corpus = await ensureCorpus();
      const ledger = await loadLedger();
      const out = [];

      for (const r of ledger) {
        const disk = exists(r.dest) ? await readMaybe(r.dest) : null;
        const diskHash = disk ? render.sha256Hex(disk) : null;
        const centry = corpus.entry(r.slug);
        let st = classify(diskHash, r.renderedHash, r.sourceHash, centry?.sourceHash ?? null);
        let rendererChanged = false;
        if (st === "current") {
          const agent = corpus.get(r.slug);
          if (agent) {
            let fresh = null;
            try {
              fresh = render.renderWithHash(agent, await readSource(agent.category, r.slug), r.tool).hash;
            } catch {
              fresh = null;
            }
            if (fresh && fresh !== r.renderedHash) {
              st = "outdated";
              rendererChanged = true;
            }
          }
        }
        const updateKind =
          st === "outdated" ? (!rendererChanged && centry?.bodyHash === r.bodyHash ? "cosmetic" : "substantive") : null;
        out.push({
          slug: r.slug,
          name: corpus.get(r.slug)?.name ?? r.slug,
          tool: r.tool,
          scope: r.scope,
          projectPath: r.projectPath ?? null,
          dest: r.dest,
          state: st,
          updateKind,
          tracked: true,
        });
      }

      // Foreign sweep: recognized catalog agents on disk that the ledger doesn't know.
      const keyOf = (slug, tool, proj) => JSON.stringify([slug, tool, proj ?? null]);
      const ledgerKeys = new Set(ledger.map((r) => keyOf(r.slug, r.tool, r.projectPath)));
      const projectDirs = [...new Set([...ledger.map((r) => r.projectPath).filter(Boolean), ...projectRoots])].sort();
      const adopted = [];
      const adoptedSeen = new Set();

      for (const tool of supported()) {
        const home = toolHome(tool);
        const prefix = registry.get(tool)?.slugPrefix ?? "";
        const scanRoots = [];
        if (render.supportsUser(tool)) for (const [d, s] of agentUnits(tool, home, null)) scanRoots.push([null, d, s]);
        if (render.supportsProject(tool))
          for (const p of projectDirs) for (const [d, s] of agentUnits(tool, home, p)) scanRoots.push([p, d, s]);

        for (const [proj, agentsRoot, suffix] of scanRoots) {
          let names;
          try {
            names = await fsp.readdir(agentsRoot);
          } catch {
            continue;
          }
          const dirUnit = suffix.startsWith("/");
          for (const name of names) {
            let token;
            let bytePath;
            if (dirUnit) {
              token = name;
              bytePath = path.join(agentsRoot, name, suffix.replace(/^\/+/, ""));
            } else if (name.endsWith(suffix) && name.length > suffix.length) {
              token = name.slice(0, name.length - suffix.length);
              bytePath = path.join(agentsRoot, name);
            } else continue;
            const cand = prefix && token.startsWith(prefix) ? token.slice(prefix.length) : token;
            const agent = corpus.get(cand) ?? corpus.getByConversionSlug(cand);
            if (!agent) continue;
            const slug = agent.slug;
            if (ledgerKeys.has(keyOf(slug, tool, proj))) continue;

            const raw = await readSource(agent.category, slug).catch(() => null);
            const disk = await readMaybe(bytePath);
            const canonical = raw != null && disk != null && bytesMatchRender(agent, raw, tool, disk);
            let tracked = false;
            let state = "foreign";
            if (canonical) {
              state = "current";
              const entry = corpus.entry(slug);
              if (entry) {
                const k = keyOf(slug, tool, proj);
                if (!adoptedSeen.has(k)) {
                  try {
                    adopted.push(
                      trackAgentRecord(agent, raw, tool, home, proj, entry.sourceHash, entry.bodyHash, corpus.version(), nowIso()),
                    );
                    adoptedSeen.add(k);
                  } catch {
                    /* not trackable */
                  }
                }
                tracked = true;
              }
            }
            out.push({
              slug,
              name: agent.name,
              tool,
              scope: render.scopeFor(proj),
              projectPath: proj,
              dest: bytePath,
              state,
              updateKind: null,
              tracked,
            });
          }
        }
      }

      if (adopted.length) await saveLedger([...ledger, ...adopted]);

      const seen = new Set();
      return out.filter((a) => {
        const k = keyOf(a.slug, a.tool, a.projectPath);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    });
  },

  async installs_for_agent({ slug }) {
    return (await loadLedger()).filter((r) => r.slug === slug);
  },

  async tools_list() {
    const ledger = await loadLedger();
    const os = osHome();
    return supported().map((tool) => {
      const home = toolHome(tool);
      const { detected, agentsDir } = detect(tool, home);
      return {
        tool,
        label: render.label(tool),
        detected,
        scope: render.supportsUser(tool) ? "user" : "project",
        userDest: agentsDir,
        installedCount: ledger.filter((r) => r.tool === tool).length,
        customPath: home !== os ? home : null,
      };
    });
  },

  async tool_versions() {
    return Promise.all(supported().map(async (tool) => ({ tool, version: await probeVersion(tool) })));
  },

  async reveal_path({ path: p }) {
    await openInFileManager(p);
    return null;
  },

  async projects_list() {
    const counts = new Map();
    for (const r of await loadLedger()) if (r.projectPath) counts.set(r.projectPath, (counts.get(r.projectPath) ?? 0) + 1);
    return [...counts.keys()]
      .sort()
      .map((p) => ({ path: p, label: path.basename(p) || p, installedCount: counts.get(p) }));
  },

  async loadout_export({ path: file }) {
    const ledger = await loadLedger();
    const installs = ledger.map((r) => ({ slug: r.slug, tool: r.tool, projectPath: r.projectPath ?? null }));
    await atomicWrite(file, prettyJson({ agentfile: 1, installs }));
    return installs.length;
  },

  async loadout_import({ path: file }) {
    const bytes = await readCapped(file, MAX_INSTALLED_BYTES);
    let af;
    try {
      af = JSON.parse(bytes.toString("utf8"));
    } catch (e) {
      throw io(`parse Agentfile: ${e.message}`);
    }
    const out = [];
    for (const e of af.installs ?? []) {
      try {
        out.push(await doInstall(e.slug, e.tool, e.projectPath ?? null));
      } catch {
        /* skip entries that can't install here */
      }
    }
    return out;
  },
};

// Exported for tests.
export const _internal = { classify, candidateDests, agentUnits, toolIsDirUnit };
