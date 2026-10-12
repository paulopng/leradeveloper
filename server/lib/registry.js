// Tool registry — loaded from the bundled `data/tools.json` (a baseline of the
// upstream agency-agents catalog). A tool is installable iff we ship a renderer
// for its `format` and it isn't a `plugin` integration.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./paths.js";

export const IMPLEMENTED_FORMATS = [
  "identity",
  "codex-toml",
  "gemini-md",
  "qwen-md",
  "zcode-md",
  "cursor-mdc",
  "opencode-md",
  "skill-md",
];

let cache;
function registry() {
  if (cache) return cache;
  const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "tools.json"), "utf8"));
  // BTreeMap order (by kebab key), then stable sort by (order, label) — mirrors Rust.
  const list = Object.keys(raw.tools)
    .sort()
    .map((k) => raw.tools[k]);
  list.sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || cmp(a.label, b.label));
  cache = list;
  return cache;
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export const all = () => registry();
export const get = (id) => registry().find((t) => t.id === id);

export const supportsUser = (id) => !!get(id)?.scope?.user;
export const supportsProject = (id) => !!get(id)?.scope?.project;

export function installable(meta) {
  if (meta.installKind === "plugin") return false;
  return !!meta.format && IMPLEMENTED_FORMATS.includes(meta.format);
}

/** Tools this app can install, in registry order. */
export const wired = () => registry().filter(installable);
