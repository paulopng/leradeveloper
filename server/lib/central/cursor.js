// Adaptador do Cursor: `agent -p --output-format stream-json --force`.
// O Cursor em modo automático aplica mudanças e roda comandos sem pedir aprovação
// (é o único modo em que ele altera arquivos sem tela). O texto do pedido vai num
// arquivo dentro de .lera/ no projeto; na linha de comando só passa o caminho.
import fs from "node:fs";
import path from "node:path";
import { spawnTool, killTree, ignorarLera } from "./ferramentas.js";
import { linhas, curto } from "./comum.js";

const TOOL_NOMES = {
  shellToolCall: ["Comando", (a) => `$ ${curto(a.command)}`],
  readToolCall: ["Ler", (a) => `ler ${curto(a.path)}`],
  writeToolCall: ["Escrever", (a) => `editar ${curto(a.path)}`],
  editToolCall: ["Editar", (a) => `editar ${curto(a.path)}`],
  deleteToolCall: ["Apagar", (a) => `apagar ${curto(a.path)}`],
  grepToolCall: ["Buscar", (a) => `buscar "${curto(a.pattern, 60)}"`],
  globToolCall: ["Listar", (a) => `listar ${curto(a.globPattern ?? a.pattern)}`],
  lsToolCall: ["Listar", (a) => `listar ${curto(a.path)}`],
  todoToolCall: ["Plano", () => "atualizar a lista de tarefas"],
};

function descreve(tc = {}) {
  const k = Object.keys(tc)[0];
  const v = tc[k] ?? {};
  const [nome, fn] = TOOL_NOMES[k] ?? [k?.replace(/ToolCall$/, "") ?? "Ferramenta", (a) => curto(JSON.stringify(a), 100)];
  const args = v.args ?? {};
  return { nome, resumo: fn(args), arquivo: ["writeToolCall", "editToolCall", "deleteToolCall"].includes(k) ? args.path ?? null : null, result: v.result };
}

export function iniciarCursor({ cwd, prompt, sessao, tarefaId, env, emit }) {
  const dir = path.join(cwd, ".lera", "prompts");
  fs.mkdirSync(dir, { recursive: true });
  ignorarLera(cwd);
  const arquivo = path.join(dir, `${tarefaId}-${Date.now()}.md`);
  fs.writeFileSync(arquivo, prompt);
  const rel = path.relative(cwd, arquivo).replace(/\\/g, "/");
  const args = ["-p", "--output-format", "stream-json", "--force", "--workspace", cwd];
  if (sessao) args.push(`--resume=${sessao}`);
  args.push(`Read the file ${rel} and carry out the task it describes. Do not edit that file.`);
  const child = spawnTool("cursor", args, { cwd, env });
  let fim = false;
  let stderr = "";
  let sessaoAtual = sessao ?? null;
  const termina = (evt) => {
    if (fim) return;
    fim = true;
    emit({ t: "fim", sessao: sessaoAtual, ...evt });
  };
  linhas(child.stdout, (line) => {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }
    const sid = o.session_id ?? o.chatId ?? o.chat_id;
    if (sid && sid !== sessaoAtual) {
      sessaoAtual = sid;
      emit({ t: "sessao", id: sid, modelo: o.model ?? null });
    }
    if (o.type === "assistant") {
      if (o.timestamp_ms && !o.model_call_id) return; // pedaço parcial
      const txt = (o.message?.content ?? []).map((c) => c.text ?? "").join("");
      if (txt.trim()) emit({ t: "texto", texto: txt });
      return;
    }
    if (o.type === "tool_call") {
      const d = descreve(o.tool_call);
      const id = o.call_id ?? o.tool_call_id ?? null;
      if (o.subtype === "started") emit({ t: "ferramenta", id, nome: d.nome, resumo: d.resumo, arquivo: d.arquivo });
      else if (o.subtype === "completed") {
        const r = d.result ?? {};
        const ok = !r.error && !r.failure && !r.rejected;
        const saida = r.success?.stdout ?? r.success?.content ?? r.error?.message ?? "";
        emit({ t: "ferramenta_fim", id, ok, saida: String(saida).slice(0, 3000) });
      }
      return;
    }
    if (o.type === "result") {
      termina({ ok: !o.is_error && o.subtype !== "error", texto: typeof o.result === "string" ? o.result : null, erro: o.is_error ? String(o.result ?? "erro") : null });
    }
  });
  child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
  child.on("error", (e) => termina({ ok: false, erro: e.message }));
  child.on("close", (code) => {
    try { fs.rmSync(arquivo, { force: true }); } catch { /* ok */ }
    termina({ ok: false, erro: stderr.trim().split(/\r?\n/).slice(-3).join(" ") || `O Cursor saiu com código ${code}.` });
  });
  child.stdin.on("error", () => {});
  child.stdin.end();
  return {
    parar() {
      killTree(child);
      termina({ ok: false, parada: true, erro: "Parada por você." });
    },
    responder() {
      return false;
    },
  };
}
