// Cliente do Jev (TypeSafe), via defapi por padrão.
//
// O Jev não gera texto: recebe um `state` e perguntas tipadas e devolve probabilidades
// calibradas. Os três tipos de pergunta são usados:
//   - noul   (sim/não)          → decidir()
//   - choice (uma entre opções) → escolher()
//   - score  (nível numa escala descrita) → avaliar()
// Várias perguntas de tipos diferentes vão numa chamada só, sobre o mesmo state →
// consultar() e o modelo pronto revisarMudanca(). Se o provedor não aceitar choice ou
// score, o cliente cai sozinho para perguntas noul equivalentes e lembra disso.
// O Jev é mais preciso em inglês: as perguntas prontas daqui são em inglês.
//
// Configuração:
//   TYPESAFE_API_KEY ou DEFAPI_API_KEY   chave (obrigatória, só por variável de ambiente)
//   Modelo e zona de dúvida: tela Escritório → Config (lera.json), ou as variáveis
//   JEV_MODEL, JEV_LIMIAR_BAIXO e JEV_LIMIAR_ALTO, que têm prioridade.
//   JEV_ENDPOINT   padrão https://api.defapi.org/api/v1/decisions
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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

export class JevError extends Error {
  constructor(message, { status = null, body = null } = {}) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504, 529]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoffBase = () => Number(process.env.JEV_BACKOFF_MS ?? 600);

/** Envia um pedido ao Jev e devolve { body, latencia_ms }. Repete em 429/529/5xx e falha de rede. */
export async function ask({ state, questions }, cfg = config(), fetchImpl = fetch) {
  if (!cfg.key) {
    throw new JevError(
      "Chave do Jev não encontrada. Defina a variável de ambiente TYPESAFE_API_KEY (ou DEFAPI_API_KEY) com a chave do defapi e reinicie a ferramenta.",
    );
  }
  const t0 = Date.now();
  const tries = 3;
  for (let attempt = 0; attempt < tries; attempt++) {
    let res;
    try {
      res = await fetchImpl(cfg.endpoint, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${cfg.key}` },
        body: JSON.stringify({ model: cfg.model, state, questions }),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch (e) {
      if (attempt < tries - 1) { await sleep(backoffBase() * 3 ** attempt); continue; }
      throw new JevError(`Não foi possível falar com o Jev (${cfg.endpoint}): ${e.message}`);
    }
    if (RETRY_STATUS.has(res.status) && attempt < tries - 1) {
      const ra = Number(res.headers?.get?.("retry-after"));
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10000) : backoffBase() * 3 ** attempt);
      continue;
    }
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text.slice(0, 500) };
    }
    const info = { status: res.status, body };
    if (res.status === 401) throw new JevError("O Jev recusou a chave (401). Confira a variável TYPESAFE_API_KEY.", info);
    if (res.status === 402) throw new JevError("Sem crédito no defapi (402). Recarregue o saldo da conta.", info);
    if (res.status === 422) throw new JevError(`O Jev recusou o formato da pergunta (422): ${JSON.stringify(body).slice(0, 300)}`, info);
    if (res.status === 429 || res.status === 529) throw new JevError(`O Jev está ocupado (${res.status}) mesmo depois de 3 tentativas. Tente de novo em instantes.`, info);
    if (!res.ok) throw new JevError(`O Jev respondeu ${res.status}: ${JSON.stringify(body).slice(0, 300)}`, info);
    return { body, latencia_ms: Date.now() - t0 };
  }
  throw new JevError("O Jev não respondeu.");
}

export function zone(p, cfg = config()) {
  if (p < cfg.low) return "nao";
  if (p > cfg.high) return "sim";
  return "duvida";
}

function costOf(body) {
  const c = body?.usage?.cost ?? body?.consumed;
  return c == null ? null : Number(c);
}

// ---------- Capacidades do provedor (choice/score nativos ou emulados com noul) ----------

const capsFile = () => path.join(appDataDir(), "state", "jev-capacidades.json");
const capsKey = (cfg) => `${cfg.endpoint}|${cfg.model}`;
function nativeTypes(cfg) {
  if (process.env.JEV_EMULAR === "1") return false;
  try {
    return JSON.parse(fs.readFileSync(capsFile(), "utf8"))[capsKey(cfg)]?.nativo !== false;
  } catch {
    return true;
  }
}
function rememberNative(cfg, nativo) {
  try {
    let all = {};
    try { all = JSON.parse(fs.readFileSync(capsFile(), "utf8")); } catch { /* novo */ }
    all[capsKey(cfg)] = { nativo, quando: new Date().toISOString() };
    fs.mkdirSync(path.dirname(capsFile()), { recursive: true });
    fs.writeFileSync(capsFile(), JSON.stringify(all, null, 2));
  } catch {
    /* opcional */
  }
}
const looksUnsupported = (e) =>
  e instanceof JevError && [400, 404, 422].includes(e.status) && /choice|score|type|unsupported|not supported|invalid|unknown/i.test(JSON.stringify(e.body ?? ""));

// ---------- Perguntas ----------

export const OUTRA = "none_of_these";
const OUTRA_DESC = "None of the listed options fits; a different option is needed.";
const MAX_PERGUNTAS = 40;
const str = (v) => (v == null ? "" : String(v)).trim();

function noulText(pergunta, sim, nao) {
  let t = str(pergunta);
  if (str(sim)) t += `\nAnswer yes if: ${str(sim)}`;
  if (str(nao)) t += `\nAnswer no if: ${str(nao)}`;
  return t;
}

function normOpcoes(opcoes, incluirOutra) {
  const list = Array.isArray(opcoes)
    ? opcoes.map((o) => (typeof o === "string" ? { rotulo: o, descricao: "" } : { rotulo: o?.rotulo, descricao: o?.descricao ?? "" }))
    : Object.entries(opcoes ?? {}).map(([rotulo, descricao]) => ({ rotulo, descricao }));
  const clean = list.map((o) => ({ rotulo: str(o.rotulo).slice(0, 120), descricao: str(o.descricao).slice(0, 600) }));
  if (clean.some((o) => !o.rotulo)) throw new JevError("Toda opção precisa de um rótulo.");
  if (new Set(clean.map((o) => o.rotulo.toLowerCase())).size !== clean.length) throw new JevError("Há opções repetidas.");
  if (clean.length < 2) throw new JevError("Informe pelo menos duas opções.");
  if (clean.length > 254) throw new JevError("No máximo 254 opções por pergunta.");
  if (incluirOutra) clean.push({ rotulo: OUTRA, descricao: OUTRA_DESC });
  return clean;
}

function normNiveis(niveis) {
  if (!Array.isArray(niveis)) throw new JevError("Informe os níveis em uma lista, do menor para o maior.");
  const list = niveis.map((n) => str(typeof n === "string" ? n : n?.descricao ?? n?.rotulo).slice(0, 600));
  if (list.length < 2 || list.length > 10) throw new JevError("A escala precisa ter de 2 a 10 níveis.");
  if (list.some((n) => !n)) throw new JevError("Todo nível precisa de uma descrição.");
  return list;
}

/** Normaliza uma pergunta lógica (decidir | escolher | avaliar). */
function normQuestion(q) {
  const tipo = q?.tipo ?? "decidir";
  const pergunta = str(q?.pergunta);
  if (!pergunta) throw new JevError("Toda pergunta precisa do texto em 'pergunta'.");
  if (tipo === "decidir") return { tipo, pergunta, criterio_sim: str(q.criterio_sim), criterio_nao: str(q.criterio_nao) };
  if (tipo === "escolher") return { tipo, pergunta, opcoes: normOpcoes(q.opcoes, q.incluir_outra !== false) };
  if (tipo === "avaliar") {
    const niveis = normNiveis(q.niveis);
    let limite = q.limite_humano == null || q.limite_humano === "" ? null : Number(q.limite_humano);
    if (limite != null && !(Number.isInteger(limite) && limite >= 1 && limite < niveis.length)) {
      throw new JevError(`limite_humano precisa ser um índice de nível entre 1 e ${niveis.length - 1}.`);
    }
    return { tipo, pergunta, niveis, limite_humano: limite };
  }
  throw new JevError(`Tipo de pergunta desconhecido: ${tipo}. Use decidir, escolher ou avaliar.`);
}

/** Transforma a pergunta lógica em perguntas do Jev e devolve como ler a resposta. */
function compile(id, q, nativo) {
  if (q.tipo === "decidir") {
    return { questions: { [id]: { type: "noul", instructions: noulText(q.pergunta, q.criterio_sim, q.criterio_nao) } }, read: (a) => ({ p: num(a?.[id]?.noul) }) };
  }
  if (q.tipo === "escolher") {
    if (nativo) {
      const criteria = Object.fromEntries(q.opcoes.map((o) => [o.rotulo, o.descricao || o.rotulo]));
      return {
        questions: { [id]: { type: "choice", instructions: q.pergunta, criteria } },
        read: (a) => {
          const probs = a?.[id]?.probabilities ?? {};
          return { probs: q.opcoes.map((o) => num(probs[o.rotulo])), confianca: a?.[id]?.confidence ?? null };
        },
      };
    }
    const questions = {};
    q.opcoes.forEach((o, i) => {
      questions[`${id}__${i}`] = { type: "noul", instructions: `${q.pergunta}\nIs the best option "${o.rotulo}"${o.descricao && o.descricao !== o.rotulo ? ` (${o.descricao})` : ""}?` };
    });
    return { questions, read: (a) => ({ probs: normalize(q.opcoes.map((_, i) => num(a?.[`${id}__${i}`]?.noul))), confianca: null }) };
  }
  // avaliar
  if (nativo) {
    return {
      questions: { [id]: { type: "score", instructions: q.pergunta, criteria: q.niveis } },
      read: (a) => {
        const probs = a?.[id]?.probabilities ?? {};
        return { probs: q.niveis.map((_, i) => num(probs[String(i)])), confianca: a?.[id]?.confidence ?? null, score: a?.[id]?.score };
      },
    };
  }
  const questions = {};
  q.niveis.forEach((n, i) => {
    questions[`${id}__${i}`] = { type: "noul", instructions: `${q.pergunta}\nIs the correct level: "${n}"?` };
  });
  return { questions, read: (a) => ({ probs: normalize(q.niveis.map((_, i) => num(a?.[`${id}__${i}`]?.noul))), confianca: null }) };
}

function num(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new JevError("Resposta inesperada do Jev: faltou uma probabilidade.");
  return n;
}
function normalize(list) {
  const sum = list.reduce((a, b) => a + b, 0) || 1;
  return list.map((p) => p / sum);
}
/** Concentração da distribuição (1 = toda no topo, 0 = uniforme), quando o provedor não manda. */
function concentration(probs) {
  const n = probs.length;
  if (n < 2) return 1;
  const h = -probs.reduce((a, p) => a + (p > 0 ? p * Math.log(p) : 0), 0);
  return 1 - h / Math.log(n);
}

const ZONE_TEXT = {
  sim: "Sim, com confiança. Pode seguir.",
  nao: "Não, com confiança. Não siga por este caminho.",
  duvida: "Zona de dúvida. Pare e pergunte ao Paulo antes de seguir.",
};

/** Interpreta a resposta de uma pergunta lógica. */
function interpret(q, raw, cfg, nativo) {
  if (q.tipo === "decidir") {
    const z = zone(raw.p, cfg);
    return { tipo: "decidir", pergunta: q.pergunta, probabilidade_sim: raw.p, zona: z, recomendacao: ZONE_TEXT[z], precisa_humano: z === "duvida" };
  }
  if (q.tipo === "escolher") {
    const ranking = q.opcoes
      .map((o, i) => ({ rotulo: o.rotulo === OUTRA ? "nenhuma das opções" : o.rotulo, probabilidade: raw.probs[i], outra: o.rotulo === OUTRA }))
      .sort((a, b) => b.probabilidade - a.probabilidade);
    const [best, second] = ranking;
    const margem = best.probabilidade - (second?.probabilidade ?? 0);
    const clara = !best.outra && best.probabilidade > cfg.high && margem >= 0.15;
    return {
      tipo: "escolher",
      pergunta: q.pergunta,
      escolha: best.outra ? null : best.rotulo,
      ranking: ranking.map(({ outra, ...r }) => r),
      margem,
      confianca: raw.confianca ?? concentration(raw.probs),
      zona: clara ? "clara" : "duvida",
      recomendacao: best.outra
        ? "Nenhuma das opções serve, segundo o Jev. Pare e pergunte ao Paulo qual caminho seguir."
        : clara
          ? `Escolha clara: "${best.rotulo}". Pode seguir.`
          : "Opções próximas ou sem confiança suficiente. Pare e pergunte ao Paulo.",
      precisa_humano: !clara,
      nativo,
    };
  }
  // avaliar
  const probs = raw.probs;
  const score = Number.isFinite(Number(raw.score)) ? Number(raw.score) : probs.reduce((a, p, i) => a + p * i, 0);
  let nivel = 0;
  probs.forEach((p, i) => { if (p > probs[nivel]) nivel = i; });
  const out = {
    tipo: "avaliar",
    pergunta: q.pergunta,
    score,
    nivel,
    nivel_texto: q.niveis[nivel],
    maximo: q.niveis.length - 1,
    distribuicao: q.niveis.map((texto, i) => ({ nivel: i, texto, probabilidade: probs[i] })),
    confianca: raw.confianca ?? concentration(probs),
    nativo,
  };
  if (q.limite_humano != null) {
    const acima = probs.slice(q.limite_humano).reduce((a, b) => a + b, 0);
    out.limite_humano = q.limite_humano;
    out.prob_acima_limite = acima;
    out.zona = acima > cfg.high ? "acima" : acima < cfg.low ? "abaixo" : "duvida";
    out.precisa_humano = acima >= cfg.low;
    out.recomendacao =
      out.zona === "abaixo"
        ? `Abaixo do limite ("${q.niveis[q.limite_humano]}"). Pode seguir.`
        : out.zona === "acima"
          ? `Acima do limite com confiança (${Math.round(acima * 100)}%). Pare e leve ao Paulo.`
          : `Pode estar acima do limite (${Math.round(acima * 100)}%). Pare e pergunte ao Paulo.`;
  } else {
    out.zona = probs[nivel] > cfg.high ? "clara" : "duvida";
    out.precisa_humano = out.zona === "duvida";
    out.recomendacao = out.zona === "clara" ? `Nível claro: "${q.niveis[nivel]}".` : "Distribuição espalhada entre níveis. Confirme com o Paulo antes de agir com base nisso.";
  }
  return out;
}

const newRef = () => crypto.randomBytes(5).toString("hex");

/**
 * Várias perguntas (decidir/escolher/avaliar) sobre o mesmo contexto, numa chamada.
 * perguntas: lista de { id, tipo, pergunta, ... } ou objeto { id: { tipo, ... } }.
 */
export async function consultar({ contexto, perguntas }, cfg = config(), fetchImpl = fetch) {
  const entries = Array.isArray(perguntas) ? perguntas.map((q, i) => [str(q?.id) || `p${i + 1}`, q]) : Object.entries(perguntas ?? {});
  if (!entries.length) throw new JevError("Informe pelo menos uma pergunta.");
  if (entries.length > MAX_PERGUNTAS) throw new JevError(`No máximo ${MAX_PERGUNTAS} perguntas por consulta.`);
  if (contexto == null || contexto === "") throw new JevError("Informe o contexto (os fatos) da decisão.");
  const ids = new Set();
  const logical = entries.map(([id, q]) => {
    const safe = id.replace(/[^\w-]/g, "_").slice(0, 48);
    if (ids.has(safe)) throw new JevError(`Pergunta repetida: ${id}`);
    ids.add(safe);
    return { id: safe, q: normQuestion(q) };
  });
  const needsTypes = logical.some(({ q }) => q.tipo !== "decidir");
  let nativo = needsTypes ? nativeTypes(cfg) : true;

  const run = async (nat) => {
    const compiled = logical.map(({ id, q }) => ({ id, q, c: compile(id, q, nat) }));
    const questions = Object.assign({}, ...compiled.map((x) => x.c.questions));
    const { body, latencia_ms } = await ask({ state: contexto, questions }, cfg, fetchImpl);
    const respostas = {};
    for (const { id, q, c } of compiled) respostas[id] = interpret(q, c.read(body?.answers), cfg, nat);
    return { body, latencia_ms, respostas };
  };

  let r;
  try {
    r = await run(nativo);
  } catch (e) {
    if (!(needsTypes && nativo && looksUnsupported(e))) throw e;
    rememberNative(cfg, false);
    nativo = false;
    r = await run(false);
  }
  const lista = Object.values(r.respostas);
  return {
    tipo: "consulta",
    respostas: r.respostas,
    precisa_humano: lista.some((x) => x.precisa_humano),
    zona: lista.some((x) => x.zona === "duvida") ? "duvida" : "clara",
    modelo: r.body?.model ?? cfg.model,
    custo_usd: costOf(r.body),
    tokens_entrada: r.body?.usage?.input_tokens ?? null,
    latencia_ms: r.latencia_ms,
    tipos_nativos: nativo,
    id: r.body?.id ?? null,
    ref: newRef(),
  };
}

/** Uma pergunta só: devolve a resposta interpretada mais os dados da chamada. */
async function single(q, contexto, cfg, fetchImpl) {
  const r = await consultar({ contexto, perguntas: { decisao: q } }, cfg, fetchImpl);
  const { respostas, tipo, zona, precisa_humano, ...meta } = r;
  return { ...respostas.decisao, ...meta };
}

/** Pergunta de sim/não (noul). */
export function decidir({ pergunta, contexto, criterio_sim, criterio_nao }, cfg = config(), fetchImpl = fetch) {
  return single({ tipo: "decidir", pergunta, criterio_sim, criterio_nao }, contexto, cfg, fetchImpl);
}

/** Uma opção entre várias (choice). Por padrão inclui "nenhuma das opções". */
export function escolher({ pergunta, contexto, opcoes, incluir_outra }, cfg = config(), fetchImpl = fetch) {
  return single({ tipo: "escolher", pergunta, opcoes, incluir_outra }, contexto, cfg, fetchImpl);
}

/** Nível numa escala descrita (score), do menor para o maior. */
export function avaliar({ pergunta, contexto, niveis, limite_humano }, cfg = config(), fetchImpl = fetch) {
  return single({ tipo: "avaliar", pergunta, niveis, limite_humano }, contexto, cfg, fetchImpl);
}

// ---------- Modelo pronto: revisão de uma mudança de código ----------

export const RISCO_NIVEIS = [
  "Trivial: documentation, comments or formatting only",
  "Low: small, isolated change covered by tests",
  "Moderate: touches shared code paths or behavior that users rely on",
  "High: changes core logic, data handling, public interfaces or dependencies",
  "Critical: could cause data loss, a security exposure or a broken release",
];
const MAX_MUDANCA = 60000;

/**
 * Seis perguntas numa chamada sobre uma mudança (diff ou resumo) e um veredito:
 * aprovar | ajustar | refazer | humano.
 */
export async function revisarMudanca({ objetivo, mudanca, testes, arquivos, conhecimento }, cfg = config(), fetchImpl = fetch) {
  if (!str(objetivo)) throw new JevError("Informe em 'objetivo' o que a mudança deveria fazer.");
  if (!str(mudanca)) throw new JevError("Informe em 'mudanca' o diff ou um resumo fiel da mudança.");
  let m = String(mudanca);
  const cortada = m.length > MAX_MUDANCA;
  if (cortada) m = m.slice(0, MAX_MUDANCA) + "\n[... truncated ...]";
  const contexto = {
    objective: str(objetivo),
    change: m,
    tests: str(testes) || "No test information was provided.",
    files: Array.isArray(arquivos) ? arquivos.map(String).slice(0, 200) : str(arquivos) || undefined,
    // regras e referências da equipe (RAG do Jev), quando houver
    ...(str(conhecimento) ? { team_knowledge: str(conhecimento).slice(0, 6000) } : {}),
  };
  const r = await consultar(
    {
      contexto,
      perguntas: {
        risco: { tipo: "avaliar", pergunta: "How risky is it to merge the change in `change`?", niveis: RISCO_NIVEIS, limite_humano: 3 },
        cumpre_objetivo: { tipo: "decidir", pergunta: "Does the change in `change` do what `objective` describes, without unrelated changes?" },
        testes_adequados: { tipo: "decidir", pergunta: "Do the tests described in `tests` exercise the changed behavior and pass?" },
        quebra_compatibilidade: {
          tipo: "decidir",
          pergunta: "Does the change break a public API, command-line flag, file format or configuration that existing users or callers depend on?",
        },
        seguranca: {
          tipo: "decidir",
          pergunta: "Does the change touch security-sensitive areas such as authentication, secrets, permissions, input validation or network exposure?",
        },
        proximo_passo: {
          tipo: "escolher",
          pergunta: "What is the right next step for this change?",
          incluir_outra: false,
          opcoes: {
            merge: "Ready to merge as it is",
            ajustar: "Needs small fixes before merging",
            revisao_humana: "Needs a careful human review before any decision",
            refazer: "The approach is wrong and should be redone",
          },
        },
      },
    },
    cfg,
    fetchImpl,
  );
  const a = r.respostas;
  const p = (k) => a[k].probabilidade_sim;
  const motivos = [];
  let veredito;
  const duvidas = Object.entries(a).filter(([, x]) => x.zona === "duvida").map(([k]) => k);
  if (duvidas.length) {
    veredito = "humano";
    motivos.push(`O Jev ficou em dúvida em: ${duvidas.join(", ")}.`);
  }
  if (a.risco.zona === "acima") motivos.push(`Risco alto: ${Math.round(a.risco.prob_acima_limite * 100)}% de ser alto ou crítico.`);
  if (p("seguranca") > cfg.high) motivos.push(`Mexe em área sensível de segurança (${Math.round(p("seguranca") * 100)}%).`);
  if (p("quebra_compatibilidade") > cfg.high) motivos.push(`Pode quebrar compatibilidade (${Math.round(p("quebra_compatibilidade") * 100)}%).`);
  if (!veredito && motivos.length) veredito = "humano";
  if (!veredito && (p("cumpre_objetivo") < cfg.low || a.proximo_passo.escolha === "refazer")) {
    veredito = "refazer";
    motivos.push("Não cumpre o objetivo ou a abordagem precisa ser refeita.");
  }
  if (!veredito && (p("testes_adequados") < cfg.low || a.proximo_passo.escolha === "ajustar")) {
    veredito = "ajustar";
    motivos.push(p("testes_adequados") < cfg.low ? "Os testes não cobrem a mudança ou não passaram." : "Precisa de ajustes pequenos.");
  }
  if (!veredito && a.proximo_passo.escolha === "merge" && p("cumpre_objetivo") > cfg.high && p("testes_adequados") > cfg.high) {
    veredito = "aprovar";
    motivos.push(`Risco ${["trivial", "baixo", "moderado", "alto", "crítico"][a.risco.nivel]}, cumpre o objetivo e tem testes.`);
  }
  if (!veredito) {
    veredito = "humano";
    motivos.push("Os sinais não fecham uma decisão clara.");
  }
  if (cortada) motivos.push(`A mudança foi cortada em ${MAX_MUDANCA} caracteres; mande um resumo se for maior.`);
  const { tipo, zona, precisa_humano, ...meta } = r;
  return {
    ...meta,
    tipo: "revisao",
    pergunta: `Revisão: ${str(objetivo).slice(0, 140)}`,
    veredito,
    motivos,
    zona: veredito === "humano" ? "duvida" : veredito === "aprovar" ? "sim" : "nao",
    precisa_humano: veredito === "humano",
    recomendacao: {
      aprovar: "Pode seguir com o merge.",
      ajustar: "Faça os ajustes e rode a revisão de novo.",
      refazer: "Repense a abordagem antes de continuar.",
      humano: "Pare e leve a mudança ao Paulo, com os motivos.",
    }[veredito],
  };
}

// ---------- Histórico, resultados e calibração ----------

const historyFile = () => path.join(appDataDir(), "state", "decisoes.jsonl");
const outcomesFile = () => path.join(appDataDir(), "state", "resultados.jsonl");

function readJsonl(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

export function record(entry) {
  try {
    fs.mkdirSync(path.dirname(historyFile()), { recursive: true });
    fs.appendFileSync(historyFile(), JSON.stringify({ quando: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    /* histórico é opcional */
  }
}

export function history(limit = 20) {
  const res = new Map(readJsonl(outcomesFile()).map((o) => [o.ref, o]));
  return readJsonl(historyFile())
    .slice(-limit)
    .reverse()
    .map((d) => (d.ref && res.has(d.ref) ? { ...d, resultado: res.get(d.ref) } : d));
}

/**
 * Guarda o que aconteceu de verdade depois de uma decisão, para medir e calibrar o Jev.
 * resposta_real: decidir → "sim"/"nao"; escolher → rótulo; avaliar → índice do nível.
 * Ou só correta: true/false.
 */
export function registrarResultado({ ref, resposta_real, correta, observacao }) {
  const r = str(ref);
  const d = readJsonl(historyFile()).reverse().find((x) => x.ref === r);
  if (!d) throw new JevError(`Decisão não encontrada: ${r || "(sem ref)"}. Use o 'ref' devolvido pela decisão.`);
  let real = resposta_real == null || resposta_real === "" ? null : resposta_real;
  let ok = typeof correta === "boolean" ? correta : null;
  if (d.tipo === "decidir" || d.tipo === "guarda") {
    if (real != null) {
      const v = String(real).toLowerCase();
      if (!["sim", "nao", "não", "true", "false", "yes", "no"].includes(v)) throw new JevError("Para decidir, resposta_real é 'sim' ou 'nao'.");
      real = ["sim", "true", "yes"].includes(v) ? "sim" : "nao";
      ok = (d.probabilidade_sim > 0.5) === (real === "sim");
    }
  } else if (d.tipo === "escolher" && real != null) {
    ok = String(real).toLowerCase() === String(d.escolha ?? "").toLowerCase();
  } else if (d.tipo === "avaliar" && real != null) {
    real = Number(real);
    if (!Number.isInteger(real)) throw new JevError("Para avaliar, resposta_real é o índice do nível (0, 1, 2...).");
    ok = real === d.nivel;
  }
  if (ok == null) throw new JevError("Informe resposta_real ou correta (true/false).");
  const entry = { quando: new Date().toISOString(), ref: r, tipo: d.tipo, real, correta: ok, observacao: str(observacao).slice(0, 300) || null };
  fs.mkdirSync(path.dirname(outcomesFile()), { recursive: true });
  fs.appendFileSync(outcomesFile(), JSON.stringify(entry) + "\n");
  return entry;
}

export const MIN_CALIBRACAO = 30;

/** Mede o Jev nas decisões com resultado conhecido e sugere limites para a zona de dúvida. */
export function calibracao({ erroAlvo = 0.1 } = {}, cfg = config()) {
  const outcomes = new Map(readJsonl(outcomesFile()).map((o) => [o.ref, o]));
  const decs = readJsonl(historyFile()).filter((d) => d.ref && outcomes.has(d.ref));
  const porTipo = {};
  for (const d of decs) {
    const o = outcomes.get(d.ref);
    const t = (porTipo[d.tipo] ??= { total: 0, corretas: 0 });
    t.total++;
    if (o.correta) t.corretas++;
  }
  const pares = decs
    .filter((d) => (d.tipo === "decidir" || d.tipo === "guarda") && outcomes.get(d.ref).real != null && Number.isFinite(d.probabilidade_sim))
    .map((d) => ({ p: d.probabilidade_sim, y: outcomes.get(d.ref).real === "sim" ? 1 : 0 }));
  const n = pares.length;
  const brier = n ? pares.reduce((a, { p, y }) => a + (p - y) ** 2, 0) / n : null;
  const edges = [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1.0001];
  const faixas = edges.slice(0, -1).map((lo, i) => {
    const hi = edges[i + 1];
    const xs = pares.filter(({ p }) => p >= lo && p < hi);
    return {
      de: lo,
      ate: Math.min(1, hi),
      n: xs.length,
      media_prevista: xs.length ? xs.reduce((a, x) => a + x.p, 0) / xs.length : null,
      taxa_real_sim: xs.length ? xs.reduce((a, x) => a + x.y, 0) / xs.length : null,
    };
  });
  let sugestao = null;
  if (n >= MIN_CALIBRACAO) {
    const grid = Array.from({ length: 19 }, (_, i) => Math.round((0.05 + i * 0.05) * 100) / 100);
    let alto = null;
    for (const t of grid.filter((g) => g > 0.5)) {
      const xs = pares.filter(({ p }) => p > t);
      if (xs.length >= 5 && xs.filter((x) => !x.y).length / xs.length <= erroAlvo) { alto = t; break; }
    }
    let baixo = null;
    for (const t of grid.filter((g) => g < 0.5).reverse()) {
      const xs = pares.filter(({ p }) => p < t);
      if (xs.length >= 5 && xs.filter((x) => x.y).length / xs.length <= erroAlvo) { baixo = t; break; }
    }
    if (alto != null && baixo != null && baixo < alto) {
      const naDuvida = pares.filter(({ p }) => p >= baixo && p <= alto).length / n;
      sugestao = { limiarBaixo: baixo, limiarAlto: alto, erroAlvo, fracaoParaVoce: naDuvida };
    }
  }
  const naDuvidaAtual = n ? pares.filter(({ p }) => p >= cfg.low && p <= cfg.high).length / n : null;
  return {
    rotuladas: decs.length,
    simNao: n,
    minimo: MIN_CALIBRACAO,
    brier,
    acertoSimNao: n ? pares.filter(({ p, y }) => (p > 0.5) === !!y).length / n : null,
    porTipo,
    faixas,
    atual: { limiarBaixo: cfg.low, limiarAlto: cfg.high, fracaoParaVoce: naDuvidaAtual },
    sugestao,
  };
}
