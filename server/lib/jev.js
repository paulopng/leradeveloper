// Cliente do Jev (TypeSafe), via defapi por padrão.
//
// O Jev não gera texto: recebe um `state` e perguntas tipadas e devolve probabilidades.
// Aqui usamos só perguntas `noul` (sim/não), o único formato já validado na sua conta:
//   - decidir(): uma pergunta → probabilidade de "sim"
//   - escolher(): uma pergunta por opção, todas na mesma chamada (mesmo state),
//     normalizadas para somar 1.
//
// Configuração:
//   TYPESAFE_API_KEY ou DEFAPI_API_KEY   chave (obrigatória, só por variável de ambiente)
//   Modelo e zona de dúvida: tela Escritório → Config (lera.json), ou as variáveis
//   JEV_MODEL, JEV_LIMIAR_BAIXO e JEV_LIMIAR_ALTO, que têm prioridade.
//   JEV_ENDPOINT   padrão https://api.defapi.org/api/v1/decisions
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { appDataDir } from "./paths.js";
import { load as loadLera, update as updateLera } from "./lera-config.js";

// Algumas ferramentas iniciam servidores MCP com um ambiente reduzido. No Windows, se a
// variável não chegou, lê direto das variáveis de usuário (HKCU\Environment).
let regKey;
function keyFromWindowsUserEnv() {
  if (process.platform !== "win32") return "";
  if (regKey !== undefined) return regKey;
  regKey = "";
  for (const name of ["DEFAPI_API_KEY", "TYPESAFE_API_KEY"]) {
    try {
      const out = execFileSync("reg", ["query", "HKCU\\Environment", "/v", name], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      const m = /REG_(?:EXPAND_)?SZ\s+(.+)$/m.exec(out);
      if (m) { regKey = m[1].trim(); break; }
    } catch {
      /* não definida */
    }
  }
  return regKey;
}

const envNum = (name) => (process.env[name] != null && process.env[name] !== "" ? Number(process.env[name]) : null);

export function keySource() {
  if (process.env.DEFAPI_API_KEY?.trim()) return "DEFAPI_API_KEY";
  if (process.env.TYPESAFE_API_KEY?.trim()) return "TYPESAFE_API_KEY";
  if (keyFromWindowsUserEnv()) return "variável de usuário do Windows";
  return null;
}

export function config() {
  const j = loadLera().jev ?? {};
  return {
    key: (process.env.DEFAPI_API_KEY || process.env.TYPESAFE_API_KEY || keyFromWindowsUserEnv() || "").trim(),
    endpoint: process.env.JEV_ENDPOINT || "https://api.defapi.org/api/v1/decisions",
    model: process.env.JEV_MODEL || j.modelo || "typesafe/jev-1.13",
    low: envNum("JEV_LIMIAR_BAIXO") ?? Number(j.limiarBaixo ?? 0.3),
    high: envNum("JEV_LIMIAR_ALTO") ?? Number(j.limiarAlto ?? 0.7),
    timeoutMs: Number(process.env.JEV_TIMEOUT_MS ?? 20000),
  };
}

/** Resumo para a tela (sem a chave). */
export function publicConfig() {
  const c = config();
  return {
    chaveDefinida: !!c.key,
    origemChave: keySource(),
    endpoint: c.endpoint,
    modelo: c.model,
    limiarBaixo: c.low,
    limiarAlto: c.high,
    travadoPorAmbiente: {
      modelo: !!process.env.JEV_MODEL,
      limiarBaixo: envNum("JEV_LIMIAR_BAIXO") != null,
      limiarAlto: envNum("JEV_LIMIAR_ALTO") != null,
    },
  };
}

/** Salva modelo e zona de dúvida em lera.json. */
export function setConfig({ modelo, limiarBaixo, limiarAlto }) {
  const cur = loadLera().jev;
  const next = {
    modelo: modelo === undefined ? cur.modelo : String(modelo).trim(),
    limiarBaixo: limiarBaixo === undefined ? cur.limiarBaixo : Number(limiarBaixo),
    limiarAlto: limiarAlto === undefined ? cur.limiarAlto : Number(limiarAlto),
  };
  if (!/^[\w.-]+\/[\w.-]+$/.test(next.modelo)) throw new JevError("Modelo inválido. Use o formato fornecedor/modelo, por exemplo typesafe/jev-1.13.");
  if (!(next.limiarBaixo > 0 && next.limiarAlto < 1 && next.limiarBaixo < next.limiarAlto)) {
    throw new JevError("A zona de dúvida precisa ficar entre 0 e 1, com o limite baixo menor que o alto.");
  }
  updateLera((c) => {
    c.jev = next;
  });
  return publicConfig();
}

/** Crédito restante na conta do defapi (GET /api/user). */
export async function saldo(cfg = config(), fetchImpl = fetch) {
  if (!cfg.key) throw new JevError("Chave do Jev não encontrada.");
  const url = new URL("/api/user", cfg.endpoint).toString();
  let res;
  try {
    res = await fetchImpl(url, { headers: { Authorization: `Bearer ${cfg.key}`, Accept: "application/json" }, signal: AbortSignal.timeout(cfg.timeoutMs) });
  } catch (e) {
    throw new JevError(`Não foi possível consultar o crédito: ${e.message}`);
  }
  if (res.status === 401) throw new JevError("A chave foi recusada (401).");
  const body = await res.json().catch(() => ({}));
  const credito = Number(body?.data?.credit);
  if (!res.ok || !Number.isFinite(credito)) throw new JevError(`Resposta inesperada ao consultar o crédito (${res.status}).`);
  return { creditoUsd: credito };
}

export class JevError extends Error {}

/** Envia um pedido ao Jev e devolve o JSON da resposta. */
export async function ask({ state, questions }, cfg = config(), fetchImpl = fetch) {
  if (!cfg.key) {
    throw new JevError(
      "Chave do Jev não encontrada. Defina a variável de ambiente TYPESAFE_API_KEY (ou DEFAPI_API_KEY) com a chave do defapi e reinicie a ferramenta.",
    );
  }
  let res;
  try {
    res = await fetchImpl(cfg.endpoint, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({ model: cfg.model, state, questions }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (e) {
    throw new JevError(`Não foi possível falar com o Jev (${cfg.endpoint}): ${e.message}`);
  }
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  if (res.status === 401) throw new JevError("O Jev recusou a chave (401). Confira a variável TYPESAFE_API_KEY.");
  if (res.status === 402) throw new JevError("Sem crédito no defapi (402). Recarregue o saldo da conta.");
  if (res.status === 429 || res.status === 529) throw new JevError(`O Jev está ocupado (${res.status}). Tente de novo em instantes.`);
  if (!res.ok) throw new JevError(`O Jev respondeu ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

export function zone(p, cfg = config()) {
  if (p < cfg.low) return "nao";
  if (p > cfg.high) return "sim";
  return "duvida";
}

const ZONE_TEXT = {
  sim: "Sim, com confiança. Pode seguir.",
  nao: "Não, com confiança. Não siga por este caminho.",
  duvida: "Zona de dúvida. Pare e pergunte ao Paulo antes de seguir.",
};

function costOf(body) {
  const c = body?.usage?.cost ?? body?.consumed;
  return c == null ? null : Number(c);
}

/** Pergunta de sim/não. */
export async function decidir({ pergunta, contexto, criterio_sim, criterio_nao }, cfg = config(), fetchImpl) {
  const q = { type: "noul", instructions: pergunta };
  if (criterio_sim || criterio_nao) q.criteria = { true: criterio_sim ?? "Sim", false: criterio_nao ?? "Não" };
  const body = await ask({ state: contexto, questions: { decisao: q } }, cfg, fetchImpl);
  const p = Number(body?.answers?.decisao?.noul);
  if (!Number.isFinite(p)) throw new JevError(`Resposta inesperada do Jev: ${JSON.stringify(body).slice(0, 300)}`);
  const z = zone(p, cfg);
  return {
    tipo: "decidir",
    pergunta,
    probabilidade_sim: p,
    zona: z,
    recomendacao: ZONE_TEXT[z],
    precisa_humano: z === "duvida",
    modelo: body.model ?? cfg.model,
    custo_usd: costOf(body),
    id: body.id ?? null,
  };
}

/** Escolha entre opções: uma pergunta sim/não por opção, no mesmo state. */
export async function escolher({ pergunta, contexto, opcoes }, cfg = config(), fetchImpl) {
  const list = Array.isArray(opcoes)
    ? opcoes.map((o) => (typeof o === "string" ? { rotulo: o, descricao: "" } : o))
    : Object.entries(opcoes ?? {}).map(([rotulo, descricao]) => ({ rotulo, descricao }));
  if (list.length < 2) throw new JevError("Informe pelo menos duas opções.");
  if (list.length > 20) throw new JevError("No máximo 20 opções por decisão.");
  const questions = {};
  list.forEach((o, i) => {
    questions[`opcao_${i}`] = {
      type: "noul",
      instructions: `${pergunta}\nA melhor opção é: "${o.rotulo}"${o.descricao ? ` (${o.descricao})` : ""}?`,
    };
  });
  const body = await ask({ state: contexto, questions }, cfg, fetchImpl);
  const raw = list.map((o, i) => Number(body?.answers?.[`opcao_${i}`]?.noul));
  if (raw.some((p) => !Number.isFinite(p))) throw new JevError(`Resposta inesperada do Jev: ${JSON.stringify(body).slice(0, 300)}`);
  const sum = raw.reduce((a, b) => a + b, 0) || 1;
  const ranked = list
    .map((o, i) => ({ rotulo: o.rotulo, probabilidade: raw[i] / sum, sim_isolado: raw[i] }))
    .sort((a, b) => b.probabilidade - a.probabilidade);
  const [best, second] = ranked;
  // Clara quando a melhor opção se destaca da segunda e ela própria tem um "sim" confiante.
  const margem = best.probabilidade - (second?.probabilidade ?? 0);
  const clara = best.sim_isolado > cfg.high && margem >= 0.15;
  return {
    tipo: "escolher",
    pergunta,
    escolha: best.rotulo,
    ranking: ranked,
    margem,
    zona: clara ? "clara" : "duvida",
    recomendacao: clara ? `Escolha clara: "${best.rotulo}". Pode seguir.` : "Opções próximas ou sem confiança suficiente. Pare e pergunte ao Paulo.",
    precisa_humano: !clara,
    modelo: body.model ?? cfg.model,
    custo_usd: costOf(body),
    id: body.id ?? null,
  };
}

// ---------- Histórico (para auditoria e para marcar decisões nos mapas) ----------

const historyFile = () => path.join(appDataDir(), "state", "decisoes.jsonl");

export function record(entry) {
  try {
    fs.mkdirSync(path.dirname(historyFile()), { recursive: true });
    fs.appendFileSync(historyFile(), JSON.stringify({ quando: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    /* histórico é opcional */
  }
}

export function history(limit = 20) {
  try {
    const lines = fs.readFileSync(historyFile(), "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l)).reverse();
  } catch {
    return [];
  }
}
