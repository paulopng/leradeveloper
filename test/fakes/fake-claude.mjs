#!/usr/bin/env node
// Claude Code falso para testes: fala stream-json e chama o hook PermissionRequest.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
if (argv.includes("--version")) { console.log("9.9.9 (Claude Code falso)"); process.exit(0); }
if (argv[0] === "auth" && argv[1] === "status") { console.log(JSON.stringify({ authMethod: process.env.FAKE_CLAUDE_AUTH ?? "claude.ai", email: "paulo@example.com", subscriptionType: "max" })); process.exit(0); }
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
let prompt = "";
for await (const c of process.stdin) prompt += c;
const sessao = val("--resume") ?? crypto.randomUUID();
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
out({ type: "system", subtype: "init", session_id: sessao, model: "fake-claude" });

if (prompt.includes("planning step of a software coordinator")) {
  const plano = process.env.FAKE_PLANO ? JSON.parse(process.env.FAKE_PLANO) : {
    resumo: "Plano falso", tarefas: [
      { id: "base", titulo: "Criar a base", descricao: "Arquivo base", depende_de: [], tipo: "backend" },
      { id: "tela", titulo: "Criar a tela", descricao: "Arquivo da tela", depende_de: ["base"], tipo: "frontend" },
    ],
  };
  const texto = "Analisei o projeto.\n```json\n" + JSON.stringify(plano) + "\n```";
  out({ type: "assistant", message: { content: [{ type: "text", text: texto }] } });
  out({ type: "result", subtype: "success", is_error: false, result: texto, total_cost_usd: 0.002, session_id: sessao });
  process.exit(0);
}

const conflito = /git merge --no-ff (\S+?)`/.exec(prompt);
if (conflito) {
  // resolve o conflito ficando com a versão já juntada
  const r = spawnSync("git", ["merge", "--no-ff", "-X", "ours", "-m", "resolver conflito", conflito[1]], { cwd: process.cwd(), encoding: "utf8" });
  out({ type: "result", subtype: r.status === 0 ? "success" : "error_during_execution", is_error: r.status !== 0, result: r.status === 0 ? "Conflito resolvido" : r.stderr, total_cost_usd: 0.003, session_id: sessao });
  process.exit(0);
}
if (process.env.FAKE_CLAUDE_LIMITE) out({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", utilization: Number(process.env.FAKE_CLAUDE_LIMITE), rateLimitType: "five_hour", resetsAt: Date.now() + 3600e3 }, session_id: sessao });
const agDir = path.join(process.cwd(), ".claude", "agents");
const agentesVistos = fs.existsSync(agDir) ? fs.readdirSync(agDir).join(",") : "";
out({ type: "assistant", message: { content: [{ type: "text", text: `Vou trabalhar nisso. agentes=[${agentesVistos}] especialistas=${prompt.includes("Especialistas ligados") ? "sim" : "nao"}` }] }, parent_tool_use_id: null });
out({ type: "assistant", message: { content: [{ type: "tool_use", id: "todo1", name: "TodoWrite", input: { todos: [{ content: "Escrever", status: "completed" }, { content: "Testar", status: "in_progress" }] } }] } });

const n = fs.readdirSync(process.cwd()).filter((f) => f.startsWith("feito-claude")).length + 1;
const arq = path.join(process.cwd(), `feito-claude-${n}.txt`);
out({ type: "assistant", message: { content: [{ type: "tool_use", id: "w1", name: "Write", input: { file_path: arq, content: prompt } }] } });
fs.writeFileSync(arq, prompt);
out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "w1", content: "ok" }] } });

const m = /\[cmd:([^\]]+)\]/.exec(prompt);
if (m) {
  const command = m[1];
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command } }] } });
  let allowed = false;
  const settings = val("--settings");
  if (settings) {
    const cfg = JSON.parse(fs.readFileSync(settings, "utf8"));
    const hook = cfg.hooks?.PermissionRequest?.[0]?.hooks?.[0]?.command;
    if (hook) {
      const r = spawnSync(hook, { shell: true, input: JSON.stringify({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command } }), encoding: "utf8", env: process.env });
      try { allowed = JSON.parse(r.stdout).hookSpecificOutput.decision.behavior === "allow"; } catch { allowed = false; }
    }
  }
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b1", content: allowed ? "tests: 3 passed" : "Permission denied", is_error: !allowed }] } });
}
if (prompt.includes("[falhar]")) {
  out({ type: "result", subtype: "error_during_execution", is_error: true, result: "Falhei de propósito", total_cost_usd: 0.001, session_id: sessao });
  process.exit(1);
}
if (prompt.includes("[demorar]")) await new Promise((r) => setTimeout(r, 30000));
out({ type: "assistant", message: { content: [{ type: "text", text: `Pronto: ${path.basename(arq)}` }] } });
out({ type: "result", subtype: "success", is_error: false, result: `Pronto: ${path.basename(arq)}`, total_cost_usd: 0.01, num_turns: 3, session_id: sessao });
