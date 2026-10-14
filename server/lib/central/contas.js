// Contas e limites de cada ferramenta.
//   Claude Code: `claude auth status` (JSON) + limites de 5 h e semanal vistos nas tarefas
//                (evento rate_limit_event do stream-json).
//   Codex:       app-server → account/read e account/rateLimits/read (a qualquer momento).
//   Cursor:      `agent status` (só se está logado); uso contado pelo leradev.
//   Antigravity: uso contado pelo leradev.
// Mais o uso que passou pela Central (tarefas, custo, tokens) e limites mensais que você define.
import fs from "node:fs";
import path from "node:path";
import { appDataDir } from "../paths.js";
import { load } from "../lera-config.js";
import { VERSION } from "../system.js";
import { FERRAMENTAS, detectar, spawnTool, killTree } from "./ferramentas.js";
import { linhas } from "./comum.js";
import { limitesCodex } from "./codex.js";

const file = () => path.join(appDataDir(), "state", "central", "limites.json");
let limites = null;
function carregarLimites() {
  if (limites) return limites;
  try {
    limites = JSON.parse(fs.readFileSync(file(), "utf8"));
  } catch {
    limites = {};
  }
  return limites;
}
/** Guarda o último valor de uma janela de limite de uma ferramenta. */
export function registrarLimite(ferramenta, { tipo, uso, renova, status }) {
  const l = carregarLimites();
  l[ferramenta] ??= {};
  l[ferramenta][tipo] = { uso, renova, status, visto: new Date().toISOString() };
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(l, null, 2));
  } catch {
    /* só memória */
  }
}
/** Janelas ainda válidas (a que já renovou some). */
export function limitesAtuais(ferramenta) {
  const out = {};
  for (const [tipo, v] of Object.entries(carregarLimites()[ferramenta] ?? {})) {
    if (v.renova && Number(v.renova) < Date.now()) continue;
    out[tipo] = v;
  }
  return out;
}

/** Roda um comando curto e devolve stdout (ou null). */
function rodarCurto(id, args, ms = 12000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnTool(id, args);
    } catch {
      return resolve(null);
    }
    let out = "";
    const t = setTimeout(() => { killTree(child); resolve(out || null); }, ms);
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => { clearTimeout(t); resolve(null); });
    child.on("close", () => { clearTimeout(t); resolve(out); });
    child.stdin.end();
  });
}
const semAnsi = (s) => String(s ?? "").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").trim();

async function contaClaude() {
  const out = await rodarCurto("claude", ["auth", "status"]);
  try {
    const j = JSON.parse(out);
    const metodo = j.authMethod ?? null;
    return {
      logado: metodo ? metodo !== "none" : !!j.loggedIn,
      metodo,
      descricao: { "claude.ai": "assinatura (claude.ai)", api_key: "chave de API (cobra por uso)", oauth_token: "token da assinatura", api_key_helper: "chave de API (helper)", third_party: "provedor externo", none: "não logado" }[metodo] ?? metodo,
      email: j.email ?? j.account?.email ?? null,
      plano: j.subscriptionType ?? j.subscription ?? j.plan ?? null,
      alerta: metodo === "api_key" ? "Está usando chave de API: cada tarefa é cobrada por uso. Para usar a assinatura, rode claude e /login." : null,
    };
  } catch {
    return { logado: null, descricao: out ? semAnsi(out).split("\n")[0].slice(0, 120) : "não consegui ler o status" };
  }
}

function contaCodex() {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnTool("codex", ["app-server"]);
    } catch {
      return resolve({ logado: null, descricao: "não consegui iniciar o Codex" });
    }
    let n = 1;
    const pend = new Map();
    const call = (method, params) => new Promise((ok) => { const id = n++; pend.set(id, ok); child.stdin.write(JSON.stringify({ method, id, params }) + "\n"); });
    linhas(child.stdout, (line) => {
      try {
        const m = JSON.parse(line);
        if (m.id !== undefined && !m.method && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
      } catch { /* ignora */ }
    });
    const fim = (v) => { clearTimeout(t); try { child.stdin.end(); } catch { /* ok */ } killTree(child); resolve(v); };
    const t = setTimeout(() => fim({ logado: null, descricao: "o Codex não respondeu a tempo" }), 15000);
    child.on("error", () => fim({ logado: null, descricao: "não consegui iniciar o Codex" }));
    child.stdin.on("error", () => {});
    (async () => {
      await call("initialize", { clientInfo: { name: "leradev", title: "leradev", version: VERSION } });
      child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
      const acc = (await call("account/read", { refreshToken: false })).result ?? {};
      const a = acc.account ?? null;
      const rl = (await call("account/rateLimits/read", undefined)).result ?? null;
      const janelas = rl ? limitesCodex(rl.rateLimits ?? rl) : [];
      for (const j of janelas) registrarLimite("codex", j);
      fim({
        logado: !!a,
        metodo: a?.type ?? null,
        descricao: a?.type === "chatgpt" ? `conta ChatGPT${a.planType ? ` (${a.planType})` : ""}` : a?.type === "apiKey" ? "chave de API (cobra por uso)" : a ? a.type : acc.requiresOpenaiAuth ? "não logado" : "sem login necessário",
        email: a?.email ?? null,
        plano: a?.planType ?? rl?.rateLimits?.planType ?? null,
        creditos: rl?.rateLimits?.credits ?? null,
      });
    })().catch((e) => fim({ logado: null, descricao: `erro ao ler a conta: ${e.message}` }));
  });
}

async function contaCursor() {
  const out = await rodarCurto("cursor", ["status"]);
  if (!out) return { logado: null, descricao: "sem informação (rode agent login se precisar)" };
  const txt = semAnsi(out);
  const email = /[\w.+-]+@[\w-]+\.[\w.-]+/.exec(txt)?.[0] ?? null;
  return { logado: /not logged|não|unauth/i.test(txt) ? false : email ? true : null, descricao: txt.split("\n").find((l) => l.trim())?.slice(0, 120) ?? "", email };
}

/** Uso que passou pela Central, por ferramenta. */
export function usoProprio(tarefas) {
  const agora = Date.now();
  const out = {};
  for (const t of tarefas) {
    const u = (out[t.ferramenta] ??= { dia: 0, semana: 0, mes: 0, custoMesUsd: 0, tokensMes: 0 });
    for (const p of t.prompts ?? []) {
      const dt = agora - Date.parse(p.quando);
      if (dt < 864e5) u.dia++;
      if (dt < 7 * 864e5) u.semana++;
      if (dt < 30 * 864e5) u.mes++;
    }
    if (agora - Date.parse(t.criado) < 30 * 864e5) {
      u.custoMesUsd += Number(t.custoUsd) || 0;
      u.tokensMes += Number(t.tokens) || 0;
    }
  }
  return out;
}

let cache = null;
export async function contas({ atualizar = false, tarefas = [] } = {}) {
  if (!atualizar && cache && Date.now() - cache.quando < 120000) return montar(cache.contas, tarefas);
  const det = await detectar();
  const lista = {};
  await Promise.all(
    Object.keys(FERRAMENTAS).map(async (id) => {
      if (!det[id]?.ok) return void (lista[id] = { instalado: false });
      const c = id === "claude" ? await contaClaude() : id === "codex" ? await contaCodex() : id === "cursor" ? await contaCursor() : { logado: null, descricao: "o Antigravity não informa a conta por fora" };
      lista[id] = { instalado: true, ...c };
    }),
  );
  cache = { quando: Date.now(), contas: lista };
  return montar(lista, tarefas);
}

function montar(lista, tarefas) {
  const uso = usoProprio(tarefas);
  const meus = load().central.limites ?? {};
  const out = {};
  for (const id of Object.keys(FERRAMENTAS)) {
    const c = lista[id];
    if (!c) continue;
    const janelas = limitesAtuais(id);
    const u = uso[id] ?? { dia: 0, semana: 0, mes: 0, custoMesUsd: 0, tokensMes: 0 };
    const mensal = meus[id]?.mensal ?? null;
    const usoMensal = mensal ? Math.min(1, u.mes / mensal) : null;
    const maior = Math.max(0, ...Object.values(janelas).map((j) => Number(j.uso) || 0), usoMensal ?? 0);
    const bloqueado = Object.values(janelas).some((j) => j.status === "rejected");
    out[id] = { id, nome: FERRAMENTAS[id].nome, ...c, janelas, uso: u, limiteMensal: mensal, usoMensal, maiorUso: maior, perto: bloqueado || maior >= 0.9 };
  }
  return out;
}
