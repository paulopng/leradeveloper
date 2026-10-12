#!/usr/bin/env node
// Cursor CLI falso para testes.
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
if (argv.includes("--version")) { console.log("2026.10.01 (falso)"); process.exit(0); }
if (argv[0] === "status") { console.log("\u001b[32m✓\u001b[0m Logged in as paulo@example.com"); process.exit(0); }
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const last = argv[argv.length - 1];
const rel = /Read the file (\S+)/.exec(last)?.[1];
const prompt = rel ? fs.readFileSync(path.join(process.cwd(), rel), "utf8") : "";
const resume = argv.find((a) => a.startsWith("--resume="))?.slice(9);
const sid = resume ?? "chat-" + Date.now();
out({ type: "system", subtype: "init", session_id: sid, model: "fake-cursor" });
out({ type: "assistant", message: { content: [{ type: "text", text: "Editando." }] }, session_id: sid, model_call_id: "m1" });
const n = fs.readdirSync(process.cwd()).filter((f) => f.startsWith("feito-cursor")).length + 1;
const arq = `feito-cursor-${n}.txt`;
out({ type: "tool_call", subtype: "started", call_id: "w1", tool_call: { writeToolCall: { args: { path: arq } } }, session_id: sid });
fs.writeFileSync(path.join(process.cwd(), arq), prompt);
out({ type: "tool_call", subtype: "completed", call_id: "w1", tool_call: { writeToolCall: { args: { path: arq }, result: { success: { linesCreated: 1 } } } }, session_id: sid });
out({ type: "result", subtype: "success", is_error: false, result: `Pronto (cursor): ${arq}`, session_id: sid, duration_ms: 10 });
