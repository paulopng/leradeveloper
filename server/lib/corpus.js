// Corpus subsystem — the copy of the agency-agents catalog the app reads from.
// Port of the original `corpus/mod.rs`: catalog source selection (bundled /
// managed clone / user clone), seeding, indexing, snapshot refresh, git
// provisioning + pull, status, update checks, and runbooks.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { appDataDir, stateDir, corpusDir, BASELINE_DIR, DATA_DIR, home } from "./paths.js";
import { atomicWrite, readCapped, mkdirp, exists, isDir, isEmptyDir, prettyJson } from "./fsutil.js";
import { io, invalidArgument, internal, network, httpStatus } from "./errors.js";
import { parseAgent } from "./parse.js";
import { slugify } from "./render.js";
import { readTarGz, components } from "./tar.js";
import { runGit, gitAvailable, githubSlug } from "./git.js";
import { requireNetwork } from "./settings.js";

const CATALOG_OWNER_REPO = process.env.LERADEVELOPER_CATALOG_REPO || "msitarzewski/agency-agents";
const CORPUS_TARBALL_URL = `https://codeload.github.com/${CATALOG_OWNER_REPO}/tar.gz/refs/heads/main`;
const CATALOG_GIT_URL = `https://github.com/${CATALOG_OWNER_REPO}.git`;
const SCAN_ROOTS = ["Software", "Projects", "git", "Developer", "code", "dev", "src", "source", "repos", "Documents"];
const MAX_TARBALL_BYTES = 32 * 1024 * 1024;
const MAX_AGENT_BYTES = 1024 * 1024;
const BASELINE_VERSION = "baseline";
const DIVISIONS_FILENAME = "divisions.json";

// ---------- Division metadata ----------

function bundledDivisionMeta() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "agency-categories.json"), "utf8"));
    return withDefaults(raw.categories ?? {});
  } catch {
    return {};
  }
}

function withDefaults(rows) {
  const out = {};
  for (const [k, v] of Object.entries(rows)) out[k] = { label: v.label, icon: v.icon, color: v.color ?? "#94A3B8" };
  return out;
}

function readDivisions(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, DIVISIONS_FILENAME), "utf8"));
    if (raw && typeof raw.divisions === "object") return withDefaults(raw.divisions);
  } catch {
    /* absent or unparseable */
  }
  return null;
}

/** The division set = keys of the catalog's divisions.json (else the bundled floor), sorted. */
function discoverCategories(root) {
  const meta = readDivisions(root) ?? bundledDivisionMeta();
  return Object.keys(meta).sort();
}

/** Bundled floor overlaid with the catalog's own divisions.json. */
function loadDivisionMeta(root) {
  return { ...bundledDivisionMeta(), ...(readDivisions(root) ?? {}) };
}

const titleCase = (slug) =>
  slug
    .split("-")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ""))
    .join(" ");

/** `AGENT_DIRS=( … )` from an older convert.sh — fallback division source for snapshots. */
export function parseAgentDirs(script) {
  const start = script.indexOf("AGENT_DIRS=(");
  if (start < 0) return null;
  const after = script.slice(start + "AGENT_DIRS=(".length);
  const end = after.indexOf(")");
  if (end < 0) return null;
  const seen = new Set();
  const out = [];
  for (const rawLine of after.slice(0, end).split("\n")) {
    for (const tok of rawLine.split("#")[0].split(/\s+/)) {
      if (!tok || !/^[A-Za-z0-9_-]+$/.test(tok)) continue;
      if (!seen.has(tok)) {
        seen.add(tok);
        out.push(tok);
      }
    }
  }
  return out;
}

// ---------- Catalog source ----------

const catalogSourcePath = (adir) => path.join(stateDir(adir), "catalog.json");
const indexPath = (adir) => path.join(stateDir(adir), "corpus-index.json");
const metaPath = (adir) => path.join(stateDir(adir), "corpus-meta.json");

export async function loadCatalogSource(adir = appDataDir()) {
  try {
    const v = JSON.parse(await fsp.readFile(catalogSourcePath(adir), "utf8"));
    if (v && ["bundled", "managed", "userClone"].includes(v.kind)) return v;
  } catch {
    /* default */
  }
  return { kind: "bundled" };
}

async function saveCatalogSource(adir, source) {
  await mkdirp(stateDir(adir));
  await atomicWrite(catalogSourcePath(adir), prettyJson(source));
}

export function catalogRoot(adir, source) {
  return source.kind === "bundled" ? corpusDir(adir) : source.path;
}

function looksLikeCatalog(root) {
  if (exists(path.join(root, "scripts", "convert.sh"))) return true;
  return Object.keys(bundledDivisionMeta()).some((c) => isDir(path.join(root, c)));
}

// ---------- Build / index ----------

function collectMdFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (path.extname(e.name) === ".md") out.push(p);
    }
  }
  return out.sort(comparePaths);
}

/** Component-wise path ordering (Rust `PathBuf` Ord). */
function comparePaths(a, b) {
  const x = a.split(path.sep);
  const y = b.split(path.sep);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return x.length - y.length;
}

function findMdUnder(dir, fileName) {
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === fileName) return p;
    }
  }
  return null;
}

class Corpus {
  constructor({ agents, index, categoryOrder, divisionMeta, meta }) {
    this.agents = agents;
    this.index = index; // Map slug -> entry
    this.categoryOrder = categoryOrder;
    this.divisionMeta = divisionMeta;
    this.metaInfo = meta;
  }
  count() {
    return this.index.size;
  }
  meta() {
    return { ...this.metaInfo, count: this.count() };
  }
  version() {
    return this.metaInfo.version;
  }
  list(category) {
    return this.agents.filter((a) => category == null || a.category === category).map((a) => ({ ...a, body: "" }));
  }
  get(slug) {
    const a = this.agents.find((x) => x.slug === slug);
    return a ? { ...a } : null;
  }
  getByConversionSlug(slug) {
    const a = this.agents.find((x) => slugify(x.name) === slug);
    return a ? { ...a } : null;
  }
  entry(slug) {
    return this.index.get(slug) ?? null;
  }
  categories() {
    const counts = new Map();
    for (const e of this.index.values()) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
    return this.categoryOrder.map((slug) => {
      const row = this.divisionMeta[slug];
      return {
        slug,
        label: row?.label ?? titleCase(slug),
        icon: row?.icon ?? "Folder",
        color: row?.color ?? "#94A3B8",
        count: counts.get(slug) ?? 0,
      };
    });
  }
  indexJson() {
    const obj = {};
    for (const k of [...this.index.keys()].sort()) obj[k] = this.index.get(k);
    return prettyJson(obj);
  }
}

async function buildFromDir(dir, version, categories) {
  const agents = [];
  const index = new Map();
  for (const category of categories) {
    const catDir = path.join(dir, category);
    if (!isDir(catDir)) continue;
    for (const file of collectMdFiles(catDir)) {
      const slug = path.basename(file, ".md");
      let buf;
      try {
        buf = await readCapped(file, MAX_AGENT_BYTES);
      } catch (e) {
        console.warn(`corpus: skip ${file} (${e.message})`);
        continue;
      }
      let source;
      try {
        source = new TextDecoder("utf-8", { fatal: true }).decode(buf);
      } catch {
        console.warn(`corpus: skip ${file} (non-utf8)`);
        continue;
      }
      try {
        const parsed = parseAgent(slug, category, source);
        if (parsed) {
          index.set(parsed.entry.slug, parsed.entry);
          agents.push(parsed.agent);
        }
      } catch (e) {
        console.warn(`corpus: ${e.message}`);
      }
    }
  }
  return new Corpus({
    agents,
    index,
    categoryOrder: [...categories],
    divisionMeta: bundledDivisionMeta(),
    meta: { version, commit: null, fetchedAt: "", count: index.size },
  });
}

async function seedFromBaseline(baseline, dest, categories) {
  if (!exists(baseline)) throw io(`baseline corpus not found at ${baseline}`);
  let seeded = 0;
  for (const category of categories) {
    let ents;
    try {
      ents = await fsp.readdir(path.join(baseline, category), { withFileTypes: true });
    } catch {
      continue;
    }
    const dstCat = path.join(dest, category);
    await mkdirp(dstCat);
    for (const e of ents) {
      if (!e.isFile() || path.extname(e.name) !== ".md") continue;
      const bytes = await readCapped(path.join(baseline, category, e.name), MAX_AGENT_BYTES);
      await atomicWrite(path.join(dstCat, e.name), bytes);
      seeded++;
    }
  }
  for (const rel of [["scripts", "convert.sh"], [DIVISIONS_FILENAME], ["strategy", "runbooks.json"]]) {
    const src = path.join(baseline, ...rel);
    if (!exists(src)) continue;
    const dst = path.join(dest, ...rel);
    await mkdirp(path.dirname(dst));
    await atomicWrite(dst, await readCapped(src, MAX_AGENT_BYTES));
  }
  console.log(`corpus: seeded ${seeded} agents from baseline`);
}

async function loadStoredMeta(adir) {
  try {
    return JSON.parse(await fsp.readFile(metaPath(adir), "utf8"));
  } catch {
    return null;
  }
}

async function persist(adir, corpus) {
  await mkdirp(stateDir(adir));
  await atomicWrite(indexPath(adir), corpus.indexJson());
  const prior = await loadStoredMeta(adir);
  const fetchedAt = prior?.fetchedAt || new Date().toISOString();
  corpus.metaInfo.fetchedAt = fetchedAt;
  corpus.metaInfo.commit = prior?.commit ?? null;
  const stored = { version: corpus.version(), commit: prior?.commit ?? null, fetchedAt, count: corpus.count() };
  await atomicWrite(metaPath(adir), prettyJson(stored));
}

async function resolveActive(adir) {
  const source = await loadCatalogSource(adir);
  const dir = catalogRoot(adir, source);
  if (source.kind === "bundled" && isEmptyDir(dir)) {
    try {
      await seedFromBaseline(BASELINE_DIR, dir, discoverCategories(BASELINE_DIR));
    } catch (e) {
      console.warn(`corpus: seed from baseline failed: ${e.message}`);
    }
  }
  const categories = discoverCategories(dir);
  const version = (await loadStoredMeta(adir))?.version ?? BASELINE_VERSION;
  let corpus;
  try {
    corpus = await buildFromDir(dir, version, categories);
  } catch (e) {
    console.error(`corpus: index build failed (${e.message}); serving empty corpus`);
    corpus = new Corpus({
      agents: [],
      index: new Map(),
      categoryOrder: categories,
      divisionMeta: bundledDivisionMeta(),
      meta: { version, commit: null, fetchedAt: "", count: 0 },
    });
  }
  corpus.divisionMeta = loadDivisionMeta(dir);
  try {
    await persist(adir, corpus);
  } catch (e) {
    console.warn(`corpus: persist index/meta failed: ${e.message}`);
  }
  return corpus;
}

// Memoized corpus; first load is single-flight (the UI fires several calls at mount).
let corpusPromise = null;
export function ensureCorpus() {
  if (!corpusPromise) {
    corpusPromise = resolveActive(appDataDir()).catch((e) => {
      corpusPromise = null;
      throw e;
    });
  }
  return corpusPromise;
}

async function rebuildCorpus() {
  const fresh = await resolveActive(appDataDir());
  corpusPromise = Promise.resolve(fresh);
  return fresh.meta();
}

/** Raw, byte-exact source of an agent from the active catalog root. */
export async function readSource(category, slug) {
  const adir = appDataDir();
  const source = await loadCatalogSource(adir);
  const catDir = path.join(catalogRoot(adir, source), category);
  const fname = `${slug}.md`;
  const flat = path.join(catDir, fname);
  const file = exists(flat) ? flat : findMdUnder(catDir, fname) ?? flat;
  const buf = await readCapped(file, MAX_AGENT_BYTES);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch (e) {
    throw io(`agent source ${slug}.md not UTF-8: ${e.message}`);
  }
}

// ---------- Snapshot refresh ----------

async function downloadCorpusTarball() {
  let resp;
  try {
    resp = await fetch(CORPUS_TARBALL_URL, {
      headers: { "User-Agent": "leradeveloper (+https://github.com/paulopng/leradeveloper)" },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw network(CORPUS_TARBALL_URL, e.message);
  }
  if (!resp.ok) throw httpStatus(CORPUS_TARBALL_URL, resp.status);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > MAX_TARBALL_BYTES) throw io(`corpus tarball ${buf.length} bytes exceeds ${MAX_TARBALL_BYTES} cap`);
  return buf;
}

/** Division set from the snapshot's own divisions.json, else its convert.sh AGENT_DIRS. */
function categoriesFromTarball(tgz) {
  let dirs = null;
  for (const e of readTarGz(tgz, MAX_TARBALL_BYTES * 8)) {
    if (e.type !== "file") continue;
    const c = components(e.path);
    if (c.length === 2 && c[1] === DIVISIONS_FILENAME) {
      try {
        const d = JSON.parse(e.data.toString("utf8")).divisions;
        if (d && Object.keys(d).length) return Object.keys(d).sort();
      } catch {
        /* fall through */
      }
    }
    if (c.length === 3 && c[1] === "scripts" && c[2] === "convert.sh") {
      dirs = parseAgentDirs(e.data.toString("utf8"));
    }
  }
  return dirs && dirs.length ? dirs : null;
}

/**
 * Write `<category>/**.md` (flattened into `<dest>/<category>/`), plus the
 * catalog tooling/metadata files, from the snapshot. Only sanitized components
 * are joined onto `dest`, never the raw archive path.
 */
function extractCategories(tgz, dest, categories) {
  const isCategory = new Set(categories);
  const keep = new Map([
    ["scripts/convert.sh", ["scripts", "convert.sh"]],
    [DIVISIONS_FILENAME, [DIVISIONS_FILENAME]],
    ["strategy/runbooks.json", ["strategy", "runbooks.json"]],
  ]);
  let written = 0;
  for (const e of readTarGz(tgz, MAX_TARBALL_BYTES * 8)) {
    if (e.type !== "file") continue;
    const c = components(e.path);
    const rel = c.slice(1).join("/");
    if (keep.has(rel)) {
      const target = path.join(dest, ...keep.get(rel));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, e.data);
      continue;
    }
    if (c.length < 3) continue;
    const category = c[1];
    const fname = c[c.length - 1];
    if (!isCategory.has(category)) continue;
    if (!fname.endsWith(".md") || fname === "README.md") continue;
    if (fname.includes("\\") || fname.includes(":")) continue;
    const catDir = path.join(dest, category);
    fs.mkdirSync(catDir, { recursive: true });
    fs.writeFileSync(path.join(catDir, fname), e.data);
    written++;
  }
  return written;
}

async function refresh(adir) {
  const source = await loadCatalogSource(adir);
  if (source.kind === "userClone" && !source.manage) {
    throw invalidArgument(
      "catalog source is a read-only user clone; enable manage-with-permission or switch source to refresh",
    );
  }
  const tgz = await downloadCorpusTarball();
  const categories = categoriesFromTarball(tgz) ?? Object.keys(bundledDivisionMeta()).sort();
  const dir = catalogRoot(adir, source);
  const extracted = extractCategories(tgz, dir, categories);
  if (extracted === 0) throw internal("corpus tarball contained no agent files under known categories");
  const version = `github:main@${new Date().toISOString().slice(0, 10)}`;
  const fetchedAt = new Date().toISOString();
  const corpus = await buildFromDir(dir, version, discoverCategories(dir));
  await mkdirp(stateDir(adir));
  await atomicWrite(indexPath(adir), corpus.indexJson());
  await atomicWrite(metaPath(adir), prettyJson({ version, commit: null, fetchedAt, count: corpus.count() }));
}

// ---------- Detection / provisioning / pull ----------

const homeAgencyDir = () => path.join(home(), ".agency-agents");
const hasGitDir = (root) => exists(path.join(root, ".git"));

function quickAgentCount(root) {
  let n = 0;
  for (const cat of discoverCategories(root)) {
    try {
      n += fs
        .readdirSync(path.join(root, cat))
        .filter((f) => path.extname(f) === ".md" && f !== "README.md").length;
    } catch {
      /* missing category */
    }
  }
  return n;
}

function candidateFor(p, kind) {
  if (!looksLikeCatalog(p)) return null;
  return { path: p, kind, hasGit: hasGitDir(p), agentCount: quickAgentCount(p) };
}

async function detectCatalogs(scan) {
  const gitOk = await gitAvailable();
  const candidates = [];
  const seen = new Set();
  const push = (c) => {
    if (c && !seen.has(c.path)) {
      seen.add(c.path);
      candidates.push(c);
    }
  };
  push(candidateFor(homeAgencyDir(), "managed"));
  if (scan) {
    for (const r of SCAN_ROOTS) {
      const base = path.join(home(), r);
      push(candidateFor(path.join(base, "agency-agents"), "userClone"));
      let ents = [];
      try {
        ents = fs.readdirSync(base, { withFileTypes: true });
      } catch {
        /* no such root */
      }
      for (const e of ents) {
        if (e.isDirectory() && e.name.includes("agency")) push(candidateFor(path.join(base, e.name), "userClone"));
      }
    }
  }
  return { gitAvailable: gitOk, scanned: !!scan, candidates };
}

async function provisionManaged() {
  const p = homeAgencyDir();
  if (looksLikeCatalog(p)) return p;
  const gitOk = await gitAvailable();
  if (gitOk && (!exists(p) || isEmptyDir(p))) {
    await runGit(["clone", CATALOG_GIT_URL, p]);
  } else {
    await mkdirp(p);
    const tgz = await downloadCorpusTarball();
    const categories = categoriesFromTarball(tgz) ?? Object.keys(bundledDivisionMeta()).sort();
    if (extractCategories(tgz, p, categories) === 0) throw internal("provision: snapshot tarball contained no agent files");
  }
  return p;
}

async function pullActive(adir) {
  const source = await loadCatalogSource(adir);
  if (source.kind === "userClone" && !source.manage) {
    throw invalidArgument("catalog source is read-only (manage-with-permission is off)");
  }
  const root = catalogRoot(adir, source);
  if (hasGitDir(root) && (await gitAvailable())) await runGit(["-C", root, "pull", "--ff-only"]);
  else await refresh(adir);
}

// ---------- Commands ----------

export const commands = {
  async corpus_status() {
    return (await ensureCorpus()).meta();
  },

  async corpus_refresh() {
    requireNetwork("corpus_refresh");
    await refresh(appDataDir());
    return rebuildCorpus();
  },

  async corpus_list({ category } = {}) {
    return (await ensureCorpus()).list(category ?? null);
  },

  async corpus_get({ slug }) {
    const a = (await ensureCorpus()).get(slug);
    if (!a) throw invalidArgument(`unknown agent slug: ${slug}`);
    return a;
  },

  async corpus_categories() {
    return (await ensureCorpus()).categories();
  },

  catalog_source_get() {
    return loadCatalogSource(appDataDir());
  },

  catalog_configured() {
    return exists(catalogSourcePath(appDataDir()));
  },

  async catalog_source_set({ source }) {
    if (!source || !["bundled", "managed", "userClone"].includes(source.kind))
      throw invalidArgument("unknown catalog source");
    if (source.kind !== "bundled") {
      if (!isDir(source.path)) throw invalidArgument(`catalog path is not a directory: ${source.path}`);
      if (!looksLikeCatalog(source.path)) {
        throw invalidArgument(
          `${source.path} doesn't look like an agency-agents catalog (no scripts/convert.sh or category dirs)`,
        );
      }
    }
    const clean =
      source.kind === "bundled"
        ? { kind: "bundled" }
        : source.kind === "managed"
          ? { kind: "managed", path: source.path }
          : { kind: "userClone", path: source.path, manage: !!source.manage };
    await saveCatalogSource(appDataDir(), clean);
    return rebuildCorpus();
  },

  catalog_detect({ scan } = {}) {
    return detectCatalogs(!!scan);
  },

  async catalog_provision_managed() {
    requireNetwork("catalog_provision_managed");
    const p = await provisionManaged();
    await saveCatalogSource(appDataDir(), { kind: "managed", path: p });
    return rebuildCorpus();
  },

  async catalog_pull() {
    requireNetwork("catalog_pull");
    await pullActive(appDataDir());
    return rebuildCorpus();
  },

  async catalog_status() {
    const adir = appDataDir();
    const source = await loadCatalogSource(adir);
    const corpus = await ensureCorpus();
    const meta = corpus.meta();
    const root = catalogRoot(adir, source);
    const isGit = hasGitDir(root) && (await gitAvailable());
    const out = {
      source,
      root: source.kind === "bundled" ? null : root,
      isGit,
      branch: null,
      commit: null,
      lastCommitSubject: null,
      lastCommitDate: null,
      dirtyCount: 0,
      remoteUrl: null,
      repoSlug: null,
      version: meta.version,
      fetchedAt: meta.fetchedAt,
      agentCount: corpus.count(),
    };
    if (isGit) {
      const g = (args) => runGit(["-C", root, ...args]).then((s) => s.trim()).catch(() => null);
      out.branch = await g(["rev-parse", "--abbrev-ref", "HEAD"]);
      out.commit = await g(["rev-parse", "--short", "HEAD"]);
      const log = await g(["log", "-1", "--format=%s%x1f%cI"]);
      if (log) {
        const [subj, date] = log.split("\x1f");
        out.lastCommitSubject = subj || null;
        out.lastCommitDate = date?.trim() || null;
      }
      const porcelain = await g(["status", "--porcelain"]);
      if (porcelain != null) out.dirtyCount = porcelain.split("\n").filter((l) => l.trim()).length;
      out.remoteUrl = (await g(["remote", "get-url", "origin"])) || null;
      const r = githubSlug(out.remoteUrl);
      out.repoSlug = r ? `${r.owner}/${r.repo}` : null;
    }
    return out;
  },

  async catalog_check_updates() {
    requireNetwork("catalog_check_updates");
    const adir = appDataDir();
    const root = catalogRoot(adir, await loadCatalogSource(adir));
    if (!(hasGitDir(root) && (await gitAvailable()))) {
      return { isGit: false, behind: 0, ahead: 0, changedFiles: 0, diffstat: "", upToDate: false };
    }
    await runGit(["-C", root, "fetch", "--quiet"]);
    let ahead = 0;
    let behind = 0;
    try {
      const [a, b] = (await runGit(["-C", root, "rev-list", "--left-right", "--count", "HEAD...@{u}"])).trim().split(/\s+/);
      ahead = Number(a) || 0;
      behind = Number(b) || 0;
    } catch {
      /* no upstream */
    }
    let diffstat = "";
    let changedFiles = 0;
    if (behind > 0) {
      diffstat = await runGit(["-C", root, "diff", "--stat", "HEAD..@{u}"]).catch(() => "");
      const names = await runGit(["-C", root, "diff", "--name-only", "HEAD..@{u}"]).catch(() => "");
      changedFiles = names.split("\n").filter((l) => l.trim()).length;
    }
    return { isGit: true, behind, ahead, changedFiles, diffstat, upToDate: behind === 0 };
  },

  async runbooks_list() {
    const adir = appDataDir();
    const root = catalogRoot(adir, await loadCatalogSource(adir));
    let raw;
    try {
      raw = await fsp.readFile(path.join(root, "strategy", "runbooks.json"), "utf8");
    } catch {
      return [];
    }
    try {
      return JSON.parse(raw).runbooks ?? [];
    } catch (e) {
      throw io(`parse strategy/runbooks.json: ${e.message}`);
    }
  },
};
