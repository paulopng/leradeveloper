// Adaptador do Codex: `codex app-server` (o mesmo servidor que o app e a extensão usam),
// JSON-RPC por stdio, uma mensagem por linha, sem o campo "jsonrpc".
//   initialize → initialized → thread/start | thread/resume → turn/start
// Pedidos de aprovação chegam como requisições do servidor
// (item/commandExecution/requestApproval, item/fileChange/requestApproval)
// e são respondidos com { decision: "accept" | "acceptForSession" | "decline" }.
import { spawnTool, killTree } from "./ferramentas.js";
import { linhas, curto } from "./comum.js";
import { VERSION } from "../system.js";

const get = (o, ...ks) => {
  for (const k of ks) if (o?.[k] !== undefined) return o[k];
  return undefined;
};

/** Janelas de limite do Codex (primária ≈ 5 h, secundária ≈ semanal) no formato da Central. */
export function limitesCodex(rl = {}) {
  const out = [];
  for (const [k, w] of [["primary", rl.primary], ["secondary", rl.secondary]]) {
    if (!w) continue;
    const mins = w.windowDurationMins ?? w.window_duration_mins ?? null;
    const tipo = mins && mins <= 600 ? "five_hour" : mins && mins >= 6000 ? "seven_day" : k === "primary" ? "five_hour" : "seven_day";
    const pctUsado = w.usedPercent ?? w.used_percent;
    const reset = w.resetsAt ?? w.resets_at ?? null;
    out.push({ tipo, uso: pctUsado != null ? pctUsado / 100 : null, renova: reset != null ? (reset < 1e12 ? reset * 1000 : reset) : null, status: null, janelaMin: mins });
  }
  return out;
}

export function iniciarCodex({ cwd, prompt, sessao, politica = "untrusted", sandbox = "workspace-write", env, emit }) {
  const child = spawnTool("codex", ["app-server"], { cwd, env });
  let nextId = 1;
  const pendentes = new Map(); // id → resolve/reject
  const pedidos = new Map(); // pedidoId → id do servidor
  let threadId = sessao ?? null;
  let turnId = null;
  let fim = false;
  let stderr = "";
  let tokens = null;

  const send = (msg) => {
    try {
      child.stdin.write(JSON.stringify(msg) + "\n");
    } catch {
      /* processo já saiu */
    }
  };
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pendentes.set(id, { resolve, reject });
      send({ method, id, params });
    });
  const termina = (evt) => {
    if (fim) return;
    fim = true;
    emit({ t: "fim", tokens, sessao: threadId, ...evt });
    try { child.stdin.end(); } catch { /* ok */ }
    setTimeout(() => killTree(child), 1500);
  };

  const onRequest = (msg) => {
    const p = msg.params ?? {};
    if (msg.method === "item/commandExecution/requestApproval") {
      const pedidoId = `codex-${msg.id}`;
      pedidos.set(pedidoId, msg.id);
      emit({ t: "permissao", pedidoId, ferramenta: "Comando", comando: p.command ?? null, detalhe: p.reason ?? null, cwd: p.cwd ?? null });
      return;
    }
    if (msg.method === "item/fileChange/requestApproval") {
      const pedidoId = `codex-${msg.id}`;
      pedidos.set(pedidoId, msg.id);
      emit({ t: "permissao", pedidoId, ferramenta: "Arquivos", comando: null, detalhe: p.reason ?? (p.grantRoot ? `Escrever em ${p.grantRoot}` : "Alterar arquivos") });
      return;
    }
    send({ id: msg.id, error: { code: -32601, message: `leradev não atende ${msg.method}` } });
  };

  const onNotification = (msg) => {
    const p = msg.params ?? {};
    const item = p.item ?? {};
    switch (msg.method) {
      case "item/started":
        if (item.type === "commandExecution") emit({ t: "ferramenta", id: item.id, nome: "Comando", resumo: `$ ${curto(item.command)}` });
        else if (item.type === "fileChange") {
          const arqs = (item.changes ?? []).map((c) => c.path).filter(Boolean);
          emit({ t: "ferramenta", id: item.id, nome: "Edição", resumo: `editar ${curto(arqs.join(", "))}`, arquivo: arqs[0] ?? null });
        } else if (item.type === "mcpToolCall") emit({ t: "ferramenta", id: item.id, nome: `${item.server}.${item.tool}`, resumo: `${item.server}.${item.tool}` });
        else if (item.type === "webSearch") emit({ t: "ferramenta", id: item.id, nome: "Pesquisa", resumo: `pesquisar "${curto(item.query, 80)}"` });
        return;
      case "item/completed":
        if (item.type === "agentMessage" && item.text?.trim()) emit({ t: "texto", texto: item.text });
        else if (item.type === "commandExecution") {
          const code = get(item, "exitCode", "exit_code");
          emit({ t: "ferramenta_fim", id: item.id, ok: code === 0 || code == null, saida: String(get(item, "aggregatedOutput", "aggregated_output") ?? "").slice(0, 3000) });
        } else if (item.type === "fileChange" || item.type === "mcpToolCall" || item.type === "webSearch") {
          emit({ t: "ferramenta_fim", id: item.id, ok: item.status !== "failed" && item.status !== "declined", saida: "" });
        } else if (item.type === "plan" && item.text) emit({ t: "texto", texto: item.text });
        return;
      case "thread/tokenUsage/updated": {
        const u = p.tokenUsage ?? p.usage ?? {};
        tokens = u.total?.totalTokens ?? u.totalTokens ?? tokens;
        return;
      }
      case "account/rateLimits/updated": {
        for (const l of limitesCodex(p.rateLimits ?? p)) emit({ t: "limite", ...l });
        return;
      }
      case "turn/completed": {
        const t = p.turn ?? {};
        const status = t.status ?? "completed";
        termina({ ok: status === "completed", parada: status === "interrupted", erro: t.error?.message ?? (status === "failed" ? "O Codex não conseguiu terminar." : null) });
        return;
      }
      case "error":
        emit({ t: "aviso", texto: p.error?.message ?? p.message ?? "Erro do Codex." });
        return;
      default:
    }
  };

  linhas(child.stdout, (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method && msg.id !== undefined) return onRequest(msg);
    if (msg.method) return onNotification(msg);
    if (msg.id !== undefined && pendentes.has(msg.id)) {
      const { resolve, reject } = pendentes.get(msg.id);
      pendentes.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
  child.on("error", (e) => termina({ ok: false, erro: e.message }));
  child.on("close", (code) => termina({ ok: false, erro: stderr.trim().split(/\r?\n/).slice(-3).join(" ") || `O Codex saiu com código ${code}.` }));
  child.stdin.on("error", () => {});

  (async () => {
    try {
      await call("initialize", { clientInfo: { name: "leradev", title: "leradev", version: VERSION } });
      send({ method: "initialized" });
      const opts = { cwd, approvalPolicy: politica, sandbox };
      const r = threadId ? await call("thread/resume", { threadId, ...opts }) : await call("thread/start", opts);
      threadId = r?.thread?.id ?? threadId;
      emit({ t: "sessao", id: threadId, modelo: r?.model ?? null });
      const t = await call("turn/start", { threadId, input: [{ type: "text", text: prompt, textElements: [] }] });
      turnId = t?.turn?.id ?? null;
    } catch (e) {
      termina({ ok: false, erro: `Codex: ${e.message}` });
    }
  })();

  return {
    parar() {
      if (threadId && turnId) send({ method: "turn/interrupt", id: nextId++, params: { threadId, turnId } });
      setTimeout(() => {
        killTree(child);
        termina({ ok: false, parada: true, erro: "Parada por você." });
      }, 2500);
    },
    responder(pedidoId, decisao) {
      const id = pedidos.get(pedidoId);
      if (id === undefined) return false;
      pedidos.delete(pedidoId);
      const decision = decisao === "sempre" ? "acceptForSession" : decisao === "permitir" ? "accept" : "decline";
      send({ id, result: { decision } });
      return true;
    },
  };
}
