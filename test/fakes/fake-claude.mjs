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

if (prompt.includes("architecture-map step of leradev") || prompt.includes("architecture map needs another pass")) {
  // camadas pedidas: linhas `- "id" (Rótulo): ...` (na correção, as mesmas de antes; o fake usa as padrão)
  let camadas = [...prompt.matchAll(/^- "([a-z][a-z0-9-]*)" \(/gm)].map((m) => m[1]);
  if (!camadas.length) camadas = ["tela", "api", "dados", "mcp", "ia"];
  const correcao = prompt.includes("needs another pass");
  const nos = camadas.map((c, i) => ({ id: `${c}-1`, camada: c, rotulo: `Parte ${c}`, tipo: ["tela", "api", "tabela", "mcp", "modelo"][i] ?? "ideia", status: "ok", descricao: `Item da camada ${c}`, peso: 2, atributos: c === "api" ? { metodo: "POST", rota: "/api/tarefas", modo: "assincrono", fila: "tarefas", saude: "/health" } : c === "dados" ? { colunas: "id, titulo, feito" } : undefined }));
  if (correcao) nos.push({ id: "extra", camada: camadas[0], rotulo: "Botão salvar", tipo: "botao", status: "ok", descricao: "Corrigido", atributos: { acao: "salvar", chama: "api-1" } });
  const ligacoes = nos.slice(1).map((n, i) => ({ de: nos[i].id, para: n.id, relacao: "chama" }));
  ligacoes.push({ de: nos[0].id, para: "nao-existe", relacao: "quebrada" });
  const mapa = { titulo: "Mapa falso", subtitulo: correcao ? "corrigido" : "primeira versão", camadas: camadas.map((id) => ({ id, rotulo: id })), nos, ligacoes };
  const texto = process.env.FAKE_MAPA_SEM_JSON && !correcao ? "Não achei nada." : "Li o projeto.\n```json\n" + JSON.stringify(mapa) + "\n```";
  out({ type: "assistant", message: { content: [{ type: "text", text: texto }] } });
  out({ type: "result", subtype: "success", is_error: false, result: texto, total_cost_usd: 0.004, session_id: sessao });
  process.exit(0);
}

if (prompt.includes("briefing assistant of leradev") || prompt.includes("Answers from the user:") || prompt.includes("skip the questions") || prompt.includes("changes to the brief") || prompt.includes("The Jev (the decision model that validates the brief)") || prompt.includes("The team plan is invalid")) {
  const responder = (o, msg) => {
    const texto = `${msg}\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\``;
    out({ type: "assistant", message: { content: [{ type: "text", text: texto }] } });
    out({ type: "result", subtype: "success", is_error: false, result: texto, total_cost_usd: 0.003, session_id: sessao });
    process.exit(0);
  };
  if (prompt.includes("briefing assistant of leradev") && prompt.includes("[perguntar]")) {
    responder({ tipo: "perguntas", mensagem: "Preciso saber duas coisas.", perguntas: [
      { id: "q1", pergunta: "Quem vai usar?", opcoes: ["Só eu", "Minha equipe"] },
      { id: "q2", pergunta: "Precisa de login?", opcoes: ["Sim", "Não"], multipla: false },
    ] }, "Antes de montar o plano:");
  }
  const v2 = prompt.includes("The Jev (the decision model") || prompt.includes("changes to the brief");
  const respostas = /Answer: ([^\n]+)/.exec(prompt)?.[1] ?? "";
  responder({
    tipo: "briefing",
    titulo: v2 ? "Lista de tarefas v2" : "Lista de tarefas",
    objetivo: `App de lista de tarefas. ${respostas}${prompt.includes("Conhecimento recuperado") ? " [com-rag]" : ""}`.trim(),
    premissas: ["Salva no navegador"],
    criterios_aceite: ["Adicionar e marcar tarefas", "Funciona no celular"],
    validacoes_iniciais: [{ descricao: "Testes passam", como: "npm test" }, "Abrir no celular e adicionar uma tarefa"],
    riscos: ["Nenhum grande"],
    fora_do_escopo: ["Sincronizar entre aparelhos"],
    equipe: [
      { id: "Base", titulo: "Criar a base", descricao: "Estrutura e lógica", tipo: "backend", depende_de: [], ferramenta: "claude", agentes: ["engineering-backend-architect", "nao-existe"], porque: "raciocínio" },
      { id: "tela", titulo: "Criar a tela", descricao: "Interface no celular", tipo: "frontend", depende_de: ["base"], ferramenta: v2 ? "codex" : "vim", agentes: ["engineering-frontend-developer"], porque: "edição rápida" },
    ],
  }, "Montei o briefing.");
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
// testes mínimos: relata todos como "passou" (o leradev confere rodando de verdade)
const idsTestes = [...prompt.matchAll(/^- \[([\w-]+)\]/gm)].map((m) => m[1]);
const relato = idsTestes.length ? "\n```json\n" + JSON.stringify({ testes: idsTestes.map((id) => ({ id, status: "passou", evidencia: "ok no fake" })) }) + "\n```" : "";
out({ type: "assistant", message: { content: [{ type: "text", text: `Pronto: ${path.basename(arq)}${relato}` }] } });
out({ type: "result", subtype: "success", is_error: false, result: `Pronto: ${path.basename(arq)}${relato}`, total_cost_usd: 0.01, num_turns: 3, session_id: sessao });
