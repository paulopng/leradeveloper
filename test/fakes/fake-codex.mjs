#!/usr/bin/env node
// Codex app-server falso para testes (JSON-RPC por linha, sem "jsonrpc").
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

if (process.argv.includes("--version")) { console.log("codex-cli 0.0.0-falso"); process.exit(0); }
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const waiting = new Map();
let threadId = null;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && !msg.method) { waiting.get(msg.id)?.(msg); return; }
  switch (msg.method) {
    case "initialize": return out({ id: msg.id, result: { userAgent: "fake" } });
    case "initialized": return;
    case "thread/start": threadId = "thr-" + Date.now(); return out({ id: msg.id, result: { thread: { id: threadId }, model: "fake-codex" } });
    case "thread/resume": threadId = msg.params.threadId; return out({ id: msg.id, result: { thread: { id: threadId }, model: "fake-codex" } });
    case "turn/interrupt":
      out({ id: msg.id, result: {} });
      return out({ method: "turn/completed", params: { threadId, turn: { id: "turn1", status: "interrupted" } } });
    case "turn/start": {
      out({ id: msg.id, result: { turn: { id: "turn1", status: "inProgress" } } });
      const text = msg.params.input[0].text;
      const m = /\[cmd:([^\]]+)\]/.exec(text);
      if (m) {
        out({ method: "item/started", params: { item: { type: "commandExecution", id: "c1", command: m[1], status: "inProgress" } } });
        const resp = await new Promise((resolve) => { waiting.set(900, resolve); out({ id: 900, method: "item/commandExecution/requestApproval", params: { threadId, turnId: "turn1", itemId: "c1", command: m[1], reason: "rodar testes" } }); });
        const ok = resp.result?.decision === "accept" || resp.result?.decision === "acceptForSession";
        out({ method: "item/completed", params: { item: { type: "commandExecution", id: "c1", command: m[1], status: ok ? "completed" : "declined", exitCode: ok ? 0 : null, aggregatedOutput: ok ? "2 passed" : "" } } });
      }
      if (text.includes("[demorar]")) return; // espera turn/interrupt
      const n = fs.readdirSync(process.cwd()).filter((f) => f.startsWith("feito-codex")).length + 1;
      const arq = `feito-codex-${n}.txt`;
      out({ method: "item/started", params: { item: { type: "fileChange", id: "f1", changes: [{ path: arq, kind: "add" }], status: "inProgress" } } });
      fs.writeFileSync(path.join(process.cwd(), arq), text);
      out({ method: "item/completed", params: { item: { type: "fileChange", id: "f1", changes: [{ path: arq }], status: "completed" } } });
      out({ method: "item/completed", params: { item: { type: "agentMessage", id: "a1", text: `Pronto (codex): ${arq}` } } });
      out({ method: "thread/tokenUsage/updated", params: { tokenUsage: { total: { totalTokens: 1234 } } } });
      out({ method: "turn/completed", params: { threadId, turn: { id: "turn1", status: "completed" } } });
    }
  }
});
