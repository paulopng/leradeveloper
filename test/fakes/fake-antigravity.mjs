#!/usr/bin/env node
// Antigravity CLI (agy) falso para testes, com eventos no estilo do antigo Gemini CLI.
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
if (argv.includes("--version")) { console.log("agy 1.0.0 (falso)"); process.exit(0); }
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const pi = argv.indexOf("-p");
const rel = /Read the file (\S+)/.exec(argv[pi + 1] ?? "")?.[1];
const prompt = rel ? fs.readFileSync(path.join(process.cwd(), rel), "utf8") : "";
const ci = argv.indexOf("--conversation");
const sid = ci >= 0 ? argv[ci + 1] : "conv-" + Date.now();
out({ type: "init", session_id: sid, model: "gemini-falso" });
out({ type: "message", role: "user", content: prompt });
out({ type: "message", role: "assistant", content: "Trabalhando no Antigravity.", delta: false });
const n = fs.readdirSync(process.cwd()).filter((f) => f.startsWith("feito-agy")).length + 1;
const arq = `feito-agy-${n}.txt`;
out({ type: "tool_use", tool_name: "write_file", tool_id: "t1", parameters: { file_path: arq } });
fs.writeFileSync(path.join(process.cwd(), arq), prompt);
out({ type: "tool_result", tool_id: "t1", status: "success", output: "ok" });
out({ type: "result", response: `Pronto (agy): ${arq}`, stats: { total_tokens: 99 } });
