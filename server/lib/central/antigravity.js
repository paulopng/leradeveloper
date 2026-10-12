// Adaptador do Antigravity CLI (`agy`), o substituto do Gemini CLI.
// Modo sem tela: `agy -p <pedido> --output-format stream-json --mode accept-edits`.
// O formato dos eventos não é documentado em detalhe, então a leitura é tolerante:
// aceita eventos no estilo do Claude Code e no estilo do antigo Gemini CLI.
// O pedido vai num arquivo em .lera/; na linha de comando só passa o caminho.
import fs from "node:fs";
import path from "node:path";
import { spawnTool, killTree, ignorarLera } from "./ferramentas.js";
import { linhas, curto, resumoFerramenta } from "./comum.js";

const textoDe = (c) => {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === "string" ? x : x?.text ?? "")).join("");
  return c?.text ?? "";
};

export function iniciarAntigravity({ cwd, prompt, sessao, tarefaId, env, emit }) {
  const dir = path.join(cwd, ".lera", "prompts");
  fs.mkdirSync(dir, { recursive: true });
  ignorarLera(cwd);
  const arquivo = path.join(dir, `${tarefaId}-${Date.now()}.md`);
  fs.writeFileSync(arquivo, prompt);
  const rel = path.relative(cwd, arquivo).replace(/\\/g, "/");
  const args = ["-p", `Read the file ${rel} and carry out the task it describes. Do not edit that file.`, "--output-format", "stream-json", "--mode", "accept-edits"];
  if (sessao) args.push("--conversation", sessao);
  const child = spawnTool("antigravity", args, { cwd, env });
  let fim = false;
  let stderr = "";
  let sessaoAtual = sessao ?? null;
  let ultimoTexto = "";
  let parcial = "";
  const termina = (evt) => {
    if (fim) return;
    fim = true;
    if (parcial.trim()) emit({ t: "texto", texto: parcial });
    emit({ t: "fim", sessao: sessaoAtual, ...evt });
  };
  linhas(child.stdout, (line) => {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      if (line.trim()) emit({ t: "texto", texto: line });
      return;
    }
    const sid = o.session_id ?? o.sessionId ?? o.conversation_id ?? o.conversationId;
    if (sid && sid !== sessaoAtual) {
      sessaoAtual = sid;
      emit({ t: "sessao", id: sid, modelo: o.model ?? null });
    }
    const tipo = o.type ?? o.event;
    if (tipo === "message" || tipo === "assistant") {
      const role = o.role ?? o.message?.role ?? "assistant";
      if (role !== "assistant" && tipo === "message") return;
      const txt = textoDe(o.content ?? o.message?.content ?? o.text);
      if (o.delta || o.partial) parcial += txt;
      else if (txt.trim()) {
        if (parcial.trim()) { emit({ t: "texto", texto: parcial }); parcial = ""; }
        ultimoTexto = txt;
        emit({ t: "texto", texto: txt });
      }
      return;
    }
    if (tipo === "tool_use" || tipo === "tool_call") {
      const nome = o.tool_name ?? o.name ?? o.tool ?? "ferramenta";
      const input = o.parameters ?? o.args ?? o.input ?? {};
      const cmd = input.command ?? input.cmd;
      emit({ t: "ferramenta", id: o.tool_id ?? o.id ?? o.call_id ?? null, nome, resumo: cmd ? `$ ${curto(cmd)}` : resumoFerramenta(nome, input), arquivo: input.file_path ?? input.path ?? null });
      return;
    }
    if (tipo === "tool_result") {
      const ok = !(o.status === "error" || o.is_error || o.error);
      emit({ t: "ferramenta_fim", id: o.tool_id ?? o.id ?? o.call_id ?? null, ok, saida: String(textoDe(o.output ?? o.content ?? o.error?.message ?? "")).slice(0, 3000) });
      return;
    }
    if (tipo === "error") {
      emit({ t: "aviso", texto: o.message ?? o.error?.message ?? "Erro do Antigravity." });
      return;
    }
    if (tipo === "result" || o.response !== undefined || o.status !== undefined && o.conversation_id) {
      const erro = o.error?.message ?? (o.status === "error" || o.is_error ? String(o.response ?? o.result ?? "erro") : null);
      const resp = typeof o.response === "string" ? o.response : typeof o.result === "string" ? o.result : null;
      if (resp && resp !== ultimoTexto && !parcial) emit({ t: "texto", texto: resp });
      const u = o.stats ?? o.usage ?? {};
      const tokens = u.total_tokens ?? u.totalTokens ?? (u.input_tokens != null ? (u.input_tokens ?? 0) + (u.output_tokens ?? 0) : null);
      termina({ ok: !erro, texto: resp ?? ultimoTexto ?? null, erro, tokens });
    }
  });
  child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
  child.on("error", (e) => termina({ ok: false, erro: e.message }));
  child.on("close", (code) => {
    try { fs.rmSync(arquivo, { force: true }); } catch { /* ok */ }
    if (code === 0 && !fim) termina({ ok: true, texto: ultimoTexto || null });
    termina({ ok: false, erro: stderr.trim().split(/\r?\n/).slice(-3).join(" ") || `O Antigravity saiu com código ${code}.` });
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
