// End-to-end tests for the local server: catalog, install, reconcile, uninstall.
// Each run uses throwaway data + home dirs, so nothing touches your real setup.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lera-data-"));
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "lera-home-"));
process.env.LERADEVELOPER_DATA_DIR = dataDir;
process.env.LERADEVELOPER_HOME = homeDir;

const { createServer } = await import("../server/index.js");
let server;
let base;
let token;

async function call(cmd, args = {}, headers = {}) {
  const r = await fetch(`${base}/api/invoke/${cmd}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Leradeveloper-Token": token, ...headers },
    body: JSON.stringify(args),
  });
  const body = await r.json().catch(() => null);
  if (!r.ok) {
    const err = new Error(body?.message ?? `HTTP ${r.status}`);
    err.payload = body;
    err.status = r.status;
    throw err;
  }
  return body;
}

before(async () => {
  ({ server, token } = createServer({ staticDir: path.join(dataDir, "no-ui") }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

test("rejects calls without the per-launch token", async () => {
  const r = await fetch(`${base}/api/invoke/app_version`, { method: "POST" });
  assert.equal(r.status, 401);
});

test("rejects foreign Host headers (DNS rebinding)", async () => {
  // fetch() can't override Host, so use a raw request.
  const http = await import("node:http");
  const status = await new Promise((resolve, reject) => {
    const req = http.request(
      `${base}/api/invoke/app_version`,
      { method: "POST", headers: { Host: "evil.example", "X-Leradeveloper-Token": token } },
      (res) => resolve(res.statusCode),
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 403);
});

test("seeds the bundled catalog on first run", async () => {
  assert.equal(await call("catalog_configured"), false);
  const meta = await call("corpus_status");
  assert.ok(meta.count > 200, `expected 200+ agents, got ${meta.count}`);
  const cats = await call("corpus_categories");
  assert.ok(cats.some((c) => c.slug === "engineering" && c.count > 0));
  const list = await call("corpus_list", { category: "engineering" });
  assert.ok(list.every((a) => a.category === "engineering" && a.body === ""));
});

test("unknown commands and slugs return typed errors", async () => {
  await assert.rejects(call("nope"), (e) => e.payload.code === "invalid_argument");
  await assert.rejects(call("corpus_get", { slug: "does-not-exist" }), (e) => e.payload.code === "invalid_argument");
});

test("install → reconcile → modify → update → uninstall round trip", async () => {
  const [agent] = await call("corpus_list", { category: "engineering" });
  const rec = await call("install_agent", { slug: agent.slug, tool: "claudeCode", projectPath: null });
  assert.equal(rec.dest, path.join(homeDir, ".claude", "agents", `${agent.slug}.md`));
  assert.ok(fs.existsSync(rec.dest));

  let rows = await call("installs_reconcile", { projectRoots: [] });
  assert.equal(rows.find((r) => r.slug === agent.slug && r.tool === "claudeCode").state, "current");

  fs.appendFileSync(rec.dest, "\nlocal edit\n");
  rows = await call("installs_reconcile", { projectRoots: [] });
  assert.equal(rows.find((r) => r.slug === agent.slug).state, "modified");

  const diff = await call("agent_diff", { slug: agent.slug, tool: "claudeCode", projectPath: null });
  assert.equal(diff.differs, true);

  await call("update_agent", { slug: agent.slug, tool: "claudeCode", projectPath: null });
  const backups = fs.readdirSync(path.join(dataDir, "backups"));
  assert.ok(backups.some((b) => b.startsWith(`${agent.slug}.md.`)), "edited file was backed up");
  rows = await call("installs_reconcile", { projectRoots: [] });
  assert.equal(rows.find((r) => r.slug === agent.slug).state, "current");

  await call("uninstall_agent", { slug: agent.slug, tool: "claudeCode", projectPath: null });
  assert.equal(fs.existsSync(rec.dest), false);
  assert.deepEqual(await call("installs_for_agent", { slug: agent.slug }), []);
});

test("project-scoped installs and the foreign sweep", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "lera-proj-"));
  const [agent] = await call("corpus_list", { category: "design" });
  await assert.rejects(call("install_agent", { slug: agent.slug, tool: "cursor", projectPath: null }));
  const rec = await call("install_agent", { slug: agent.slug, tool: "cursor", projectPath: project });
  assert.ok(rec.dest.startsWith(path.join(project, ".cursor", "rules")));
  assert.deepEqual(
    (await call("projects_list")).map((p) => p.path),
    [project],
  );

  // A byte-identical file written by someone else (e.g. install.sh) is adopted as current.
  const other = (await call("corpus_list", { category: "testing" }))[0];
  const src = await call("agent_diff", { slug: other.slug, tool: "claudeCode", projectPath: null });
  fs.mkdirSync(path.dirname(src.dest), { recursive: true });
  fs.writeFileSync(src.dest, src.proposed);
  const rows = await call("installs_reconcile", { projectRoots: [project] });
  const adopted = rows.find((r) => r.slug === other.slug);
  assert.equal(adopted.state, "current");
  assert.equal(adopted.tracked, true);

  await call("project_forget", { projectPath: project });
  assert.deepEqual(await call("projects_list"), []);
  fs.rmSync(project, { recursive: true, force: true });
});

test("settings persist and clamp", async () => {
  const s = await call("settings_get");
  const saved = await call("settings_set", { settings: { ...s, catalogStaleBannerDays: 9999 } });
  assert.equal(saved.catalogStaleBannerDays, 365);
  assert.equal((await call("settings_get")).catalogStaleBannerDays, 365);
  const reset = await call("settings_reset");
  assert.equal(reset.catalogStaleBannerDays, 14);
});

test("offline mode blocks network commands", async () => {
  const s = await call("settings_get");
  await call("settings_set", { settings: { ...s, paranoidMode: true } });
  await assert.rejects(call("corpus_refresh"), (e) => e.payload.code === "paranoid_mode_blocked");
  await call("settings_reset");
});

test("Agentfile export and import", async () => {
  const [agent] = await call("corpus_list", { category: "product" });
  await call("install_agent", { slug: agent.slug, tool: "geminiCli", projectPath: null });
  const file = path.join(dataDir, "Agentfile.json");
  const exported = await call("loadout_export", { path: file });
  assert.equal(exported, JSON.parse(fs.readFileSync(file, "utf8")).installs.length);
  await call("uninstall_agent", { slug: agent.slug, tool: "geminiCli", projectPath: null });
  const imported = await call("loadout_import", { path: file });
  assert.equal(imported.length, exported);
  assert.ok(imported.some((r) => r.slug === agent.slug && r.tool === "geminiCli"));
});
