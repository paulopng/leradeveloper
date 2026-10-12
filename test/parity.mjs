// Byte-parity check against the upstream converter.
//
//   1. git clone https://github.com/msitarzewski/agency-agents upstream
//   2. (cd upstream && for t in antigravity gemini-cli opencode cursor qwen zcode codex osaurus dsh; do
//        ./scripts/convert.sh --tool $t --out ../conv; done)
//   3. node test/parity.mjs upstream conv
//
// Renders every catalog agent for every renderer-backed tool and compares the
// bytes with what `convert.sh` produced. Exit code 1 on any mismatch.
import fs from "node:fs";
import path from "node:path";
import { parseAgent } from "../server/lib/parse.js";
import { render, outputSlug } from "../server/lib/render.js";

const [repo, conv] = process.argv.slice(2);
if (!repo || !conv) {
  console.error("usage: node test/parity.mjs <agency-agents clone> <convert.sh --out dir>");
  process.exit(2);
}

const divisions = Object.keys(JSON.parse(fs.readFileSync(path.join(repo, "divisions.json"), "utf8")).divisions);
const walk = (d) =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

// tool id -> (outputSlug) => converter output path
const TARGETS = {
  geminiCli: (s) => path.join(conv, "gemini-cli", "agents", `${s}.md`),
  qwen: (s) => path.join(conv, "qwen", "agents", `${s}.md`),
  zcode: (s) => path.join(conv, "zcode", "agents", `${s}.md`),
  codex: (s) => path.join(conv, "codex", "agents", `${s}.toml`),
  opencode: (s) => path.join(conv, "opencode", "agents", `${s}.md`),
  cursor: (s) => path.join(conv, "cursor", "rules", `${s}.mdc`),
  antigravity: (s) => path.join(conv, "antigravity", s, "SKILL.md"),
  osaurus: (s) => path.join(conv, "osaurus", s, "SKILL.md"),
  deepseekHarness: (s) => path.join(conv, "dsh", s, "SKILL.md"),
};

let checked = 0;
let agents = 0;
const failures = [];
for (const div of divisions) {
  const dir = path.join(repo, div);
  if (!fs.existsSync(dir)) continue;
  for (const file of walk(dir).filter((f) => f.endsWith(".md")).sort()) {
    const raw = fs.readFileSync(file, "utf8");
    let parsed;
    try {
      parsed = parseAgent(path.basename(file, ".md"), div, raw);
    } catch {
      continue;
    }
    if (!parsed) continue;
    agents++;
    for (const [tool, target] of Object.entries(TARGETS)) {
      const out = target(outputSlug(parsed.agent, raw, tool));
      if (!fs.existsSync(out)) {
        failures.push(`${tool} ${parsed.agent.slug}: converter output missing (${out})`);
        continue;
      }
      checked++;
      if (fs.readFileSync(out, "utf8") !== render(parsed.agent, raw, tool)) {
        failures.push(`${tool} ${parsed.agent.slug}: bytes differ (${out})`);
      }
    }
  }
}
console.log(`${agents} agents, ${checked} rendered files compared, ${failures.length} mismatches`);
for (const f of failures.slice(0, 40)) console.log("  " + f);
process.exit(failures.length ? 1 : 0);
