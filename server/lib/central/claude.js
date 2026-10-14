// Adaptador do Claude Code: `claude -p` com saída stream-json.
// O texto do pedido vai pelo stdin (nunca pela linha de comando).
// Permissões: o hook PermissionRequest (settings passado com --settings) chama o
// `lera-decisor --permissao`, que pergunta ao leradev e espera a sua resposta.
import { spawnTool, killTree } from "./ferramentas.js";
import { resumoFerramenta, linhas } from "./comum.js";

export function iniciarClaude({ cwd, prompt, sessao, modo = "acceptEdits", settingsFile, env, emit, extras = [] }) {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", modo];
  if (settingsFile) args.push("--settings", settingsFile);
  if (sessao) args.push("--resume", sessao);
  args.push(...extras);
  const child = spawnTool("claude", args, { cwd, env });
  let fim = false;
  let stderr = "";
  const termina = (evt) => {
    if (fim) return;
    fim = true;
    emit({ t: "fim", ...evt });
  };
  linhas(child.stdout, (line) => {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }
    if (o.type === "system" && o.subtype === "init") return emit({ t: "sessao", id: o.session_id, modelo: o.model ?? null });
    if (o.type === "system" && o.subtype === "api_retry") return emit({ t: "aviso", texto: `A API pediu para esperar; tentando de novo (${o.attempt}/${o.max_retries}).` });
    if (o.type === "rate_limit_event" && o.rate_limit_info) {
      const i = o.rate_limit_info;
      return emit({ t: "limite", tipo: i.rateLimitType ?? i.rate_limit_type ?? "desconhecido", uso: i.utilization ?? null, renova: i.resetsAt ?? i.resets_at ?? null, status: i.status ?? null });
    }
    if (o.type === "system" && o.subtype === "permission_denied") return emit({ t: "aviso", texto: `Permissão negada: ${o.tool_name ?? ""}` });
    if (o.type === "assistant") {
      const sub = !!o.parent_tool_use_id;
      for (const b of o.message?.content ?? []) {
        if (b.type === "text" && b.text?.trim()) emit({ t: "texto", texto: b.text, sub });
        if (b.type === "tool_use") {
          if (b.name === "TodoWrite" && Array.isArray(b.input?.todos)) {
            emit({ t: "plano", itens: b.input.todos.map((x) => ({ texto: x.content ?? x.activeForm ?? "", status: x.status ?? "pending" })) });
          }
          emit({ t: "ferramenta", id: b.id, nome: b.name, resumo: resumoFerramenta(b.name, b.input), arquivo: b.input?.file_path ?? b.input?.notebook_path ?? null, sub });
        }
      }
      return;
    }
    if (o.type === "user") {
      for (const b of o.message?.content ?? []) {
        if (b.type !== "tool_result") continue;
        const txt = Array.isArray(b.content) ? b.content.map((c) => c.text ?? "").join("\n") : String(b.content ?? "");
        emit({ t: "ferramenta_fim", id: b.tool_use_id, ok: !b.is_error, saida: txt.slice(0, 3000) });
      }
      return;
    }
    if (o.type === "result") {
      termina({
        ok: o.subtype === "success" && !o.is_error,
        texto: typeof o.result === "string" ? o.result : null,
        erro: o.is_error ? (typeof o.result === "string" ? o.result : o.subtype) : null,
        custoUsd: o.total_cost_usd ?? null,
        sessao: o.session_id ?? null,
        turnos: o.num_turns ?? null,
        estruturado: o.structured_output ?? null,
      });
    }
  });
  child.stderr.on("data", (d) => {
    stderr = (stderr + d).slice(-4000);
  });
  child.on("error", (e) => termina({ ok: false, erro: e.message }));
  child.on("close", (code) => termina({ ok: false, erro: stderr.trim().split(/\r?\n/).slice(-3).join(" ") || `O Claude Code saiu com código ${code}.` }));
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);
  return {
    parar() {
      killTree(child);
      termina({ ok: false, parada: true, erro: "Parada por você." });
    },
    responder() {
      /* respostas do Claude vão pelo hook, não por aqui */
    },
  };
}
