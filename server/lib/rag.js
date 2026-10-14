// Conhecimento (RAG) de cada agente e de cada função do leradev.
//
// Dono do conhecimento:
//   "agente:<slug>"  um agente do catálogo (vale em toda tarefa em que ele for ligado)
//   "papel:<id>"     uma função do leradev: mapa (gerador do mapa 3D), assistente (briefing),
//                    planejador (plano do objetivo), jev (validações e revisões)
// Fontes: pasta, arquivo, nota (texto) ou url. Caminho relativo vale dentro da pasta da
// tarefa (ex.: "docs/" do projeto); absoluto vale como está.
//
// Recuperação sem dependências: os textos viram trechos (~1.200 caracteres) e a busca usa
// BM25 com as palavras do pedido. Os melhores trechos entram no pedido da ferramenta (ou no
// contexto do Jev) com a origem de cada um. O índice fica em cache e só refaz o que mudou.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { appDataDir } from "./paths.js";
import { invalidArgument } from "./errors.js";

export const PAPEIS = {
  mapa: { nome: "Gerador do mapa 3D", descricao: "Lê o projeto e desenha o mapa de arquitetura (telas, APIs, banco, MCP, IA).", agentes: true },
  assistente: { nome: "Assistente de briefing", descricao: "Conversa com você, monta o briefing, os testes mínimos e a equipe.", agentes: true },
  planejador: { nome: "Planejador do objetivo", descricao: "Divide um objetivo em etapas (modo Objetivo).", agentes: true },
  jev: { nome: "Jev (validação)", descricao: "Valida briefing, mapa e cada entrega antes de juntar. Recebe o conhecimento como regras e referências.", agentes: false },
};
export const TIPOS_FONTE = ["pasta", "arquivo", "nota", "url"];

const TEXTO = new Set([".md", ".mdx", ".txt", ".rst", ".adoc", ".json", ".yaml", ".yml", ".toml", ".ini", ".csv", ".tsv", ".html", ".htm", ".xml", ".sql", ".graphql", ".gql", ".prisma",
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".svelte", ".vue", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".cs", ".php", ".swift", ".c", ".h", ".cpp", ".hpp", ".sh", ".ps1", ".css", ".scss", ".env.example"]);
const PULAR = new Set([".git", ".lera", "node_modules", "dist", "build", ".next", ".svelte-kit", "out", "target", "vendor", "__pycache__", ".venv", "venv", "coverage", ".cache"]);
const MAX_ARQUIVOS = 400;
const MAX_BYTES_ARQ = 1024 * 1024;
const TAM_TRECHO = 1200;
const SOBRA = 200;

const dir = () => path.join(appDataDir(), "state", "rag");
const arqFontes = () => path.join(dir(), "fontes.json");

// ---------- fontes ----------

function lerFontes() {
  try {
    return JSON.parse(fs.readFileSync(arqFontes(), "utf8"));
  } catch {
    return { donos: {} };
  }
}
function gravarFontes(d) {
  fs.mkdirSync(dir(), { recursive: true });
  const tmp = `${arqFontes()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, arqFontes());
}

export function validarDono(dono) {
  const m = /^(agente|papel):([\w.-]{1,80})$/.exec(String(dono ?? ""));
  if (!m) throw invalidArgument(`Dono de conhecimento inválido: ${dono}`);
  if (m[1] === "papel" && !PAPEIS[m[2]]) throw invalidArgument(`Função desconhecida: ${m[2]}`);
  return dono;
}

export function fontesDe(dono) {
  return lerFontes().donos[dono]?.fontes ?? [];
}
export function todosDonos() {
  return lerFontes().donos;
}

export function adicionarFonte({ dono, tipo, caminho, texto, url, titulo }) {
  validarDono(dono);
  if (!TIPOS_FONTE.includes(tipo)) throw invalidArgument(`Tipo de fonte inválido: ${tipo}`);
  const f = { id: crypto.randomBytes(4).toString("hex"), tipo, criada: new Date().toISOString() };
  if (tipo === "nota") {
    f.texto = String(texto ?? "").trim().slice(0, 50000);
    if (!f.texto) throw invalidArgument("Escreva o texto da nota.");
    f.titulo = String(titulo ?? "").trim().slice(0, 120) || f.texto.split("\n")[0].slice(0, 60);
  } else if (tipo === "url") {
    let u;
    try {
      u = new URL(String(url ?? caminho ?? ""));
    } catch {
      throw invalidArgument("Endereço inválido.");
    }
    if (!/^https?:$/.test(u.protocol)) throw invalidArgument("Use um endereço http ou https.");
    f.url = u.toString();
    f.titulo = String(titulo ?? "").trim().slice(0, 120) || u.hostname + u.pathname;
  } else {
    f.caminho = String(caminho ?? "").trim();
    if (!f.caminho) throw invalidArgument("Informe o caminho.");
    if (f.caminho.length > 500) throw invalidArgument("Caminho longo demais.");
    f.titulo = String(titulo ?? "").trim().slice(0, 120) || f.caminho;
  }
  const d = lerFontes();
  d.donos[dono] ??= { fontes: [] };
  if (d.donos[dono].fontes.length >= 30) throw invalidArgument("No máximo 30 fontes por agente ou função.");
  d.donos[dono].fontes.push(f);
  gravarFontes(d);
  return f;
}

export function removerFonte({ dono, id }) {
  validarDono(dono);
  const d = lerFontes();
  const lista = d.donos[dono]?.fontes ?? [];
  const i = lista.findIndex((f) => f.id === id);
  if (i < 0) throw invalidArgument("Fonte não encontrada.");
  lista.splice(i, 1);
  if (!lista.length) delete d.donos[dono];
  gravarFontes(d);
  return { ok: true };
}

// ---------- texto → trechos ----------

const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const STOP = new Set(
  "a o e de da do das dos em no na nos nas um uma uns umas para por com sem que se ao aos como mais menos ser ter isso esse essa este esta ele ela eles elas seu sua nao sim the and for with from into that this you are use was were will have has not but can all any".split(" "),
);
export const tokens = (s) => norm(s).split(/[^a-z0-9_]+/).filter((w) => w.length >= 3 && w.length <= 40 && !STOP.has(w));

function trechos(texto, origem) {
  const linhas = String(texto).replace(/\r/g, "").split("\n");
  const out = [];
  let atual = "";
  let inicio = 1;
  let n = 0;
  for (const l of linhas) {
    n++;
    if (atual.length + l.length > TAM_TRECHO && atual) {
      out.push({ origem, linha: inicio, texto: atual });
      const resto = atual.slice(-SOBRA);
      atual = resto + "\n" + l;
      inicio = n;
    } else atual += (atual ? "\n" : "") + l;
  }
  if (atual.trim()) out.push({ origem, linha: inicio, texto: atual });
  return out;
}

function ehTexto(file) {
  const base = path.basename(file).toLowerCase();
  if (["readme", "license", "dockerfile", "makefile", "procfile"].includes(base)) return true;
  return TEXTO.has(path.extname(base));
}

function listarPasta(raiz) {
  const out = [];
  const andar = (d, nivel) => {
    if (nivel > 8 || out.length >= MAX_ARQUIVOS) return;
    let itens = [];
    try {
      itens = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of itens) {
      if (out.length >= MAX_ARQUIVOS) return;
      if (it.name.startsWith(".") && it.name !== ".env.example") continue;
      if (PULAR.has(it.name)) continue;
      const p = path.join(d, it.name);
      if (it.isDirectory()) andar(p, nivel + 1);
      else if (it.isFile() && ehTexto(p)) out.push(p);
    }
  };
  andar(raiz, 0);
  return out;
}

function resolverCaminho(caminho, cwd) {
  if (path.isAbsolute(caminho)) return caminho;
  if (!cwd) return null;
  const p = path.resolve(cwd, caminho);
  if (path.relative(cwd, p).startsWith("..")) return null; // relativo não sai da pasta da tarefa
  return p;
}

// ---------- índice (cache por fonte) ----------

const memoria = new Map(); // chave → { assinatura, docs }
function cacheFile(chave) {
  return path.join(dir(), "indice", `${crypto.createHash("sha1").update(chave).digest("hex").slice(0, 20)}.json`);
}

async function textoDeUrl(url) {
  const ctrl = AbortSignal.timeout(15000);
  const r = await fetch(url, { signal: ctrl, headers: { "User-Agent": "leradev-rag" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const bruto = (await r.text()).slice(0, 2 * 1024 * 1024);
  return /html/i.test(r.headers.get("content-type") ?? "")
    ? bruto.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n")
    : bruto;
}

/** Trechos de uma fonte (usa o cache quando nada mudou). */
async function documentosDe(f, cwd) {
  if (f.tipo === "nota") return trechos(f.texto, `nota: ${f.titulo}`).map((t) => ({ ...t, fonte: f.id }));
  if (f.tipo === "url") {
    const chave = `url|${f.url}`;
    const arq = cacheFile(chave);
    try {
      const c = JSON.parse(fs.readFileSync(arq, "utf8"));
      if (Date.now() - c.quando < 24 * 3600 * 1000) return c.docs;
    } catch {
      /* sem cache */
    }
    try {
      const docs = trechos(await textoDeUrl(f.url), f.url).map((t) => ({ ...t, fonte: f.id }));
      fs.mkdirSync(path.dirname(arq), { recursive: true });
      fs.writeFileSync(arq, JSON.stringify({ quando: Date.now(), docs }));
      return docs;
    } catch {
      return [];
    }
  }
  const alvo = resolverCaminho(f.caminho, cwd);
  if (!alvo || !fs.existsSync(alvo)) return [];
  const arquivos = fs.statSync(alvo).isDirectory() ? listarPasta(alvo) : [alvo];
  const docs = [];
  for (const a of arquivos) {
    let st;
    try {
      st = fs.statSync(a);
    } catch {
      continue;
    }
    if (st.size > MAX_BYTES_ARQ) continue;
    const chave = `arq|${a}`;
    const assinatura = `${st.size}:${st.mtimeMs}`;
    let m = memoria.get(chave);
    if (!m || m.assinatura !== assinatura) {
      let texto;
      try {
        texto = fs.readFileSync(a, "utf8");
      } catch {
        continue;
      }
      if (texto.includes("\u0000")) continue; // binário
      const rel = fs.statSync(alvo).isDirectory() ? path.relative(alvo, a) : path.basename(a);
      m = { assinatura, docs: trechos(texto, `${f.titulo}${rel && rel !== f.titulo ? ` › ${rel.replace(/\\/g, "/")}` : ""}`) };
      memoria.set(chave, m);
    }
    for (const d of m.docs) docs.push({ ...d, fonte: f.id });
  }
  return docs;
}

// ---------- busca ----------

function bm25(docs, consulta, k = 6) {
  const q = [...new Set(tokens(consulta))];
  if (!q.length || !docs.length) return [];
  const tk = docs.map((d) => tokens(`${d.origem} ${d.texto}`));
  const N = docs.length;
  const media = tk.reduce((a, t) => a + t.length, 0) / N || 1;
  const df = new Map();
  for (const t of tk) for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1);
  const k1 = 1.2, b = 0.75;
  return docs
    .map((d, i) => {
      const tf = new Map();
      for (const w of tk[i]) tf.set(w, (tf.get(w) ?? 0) + 1);
      let s = 0;
      for (const w of q) {
        const f = tf.get(w);
        if (!f) continue;
        const idf = Math.log(1 + (N - (df.get(w) ?? 0) + 0.5) / ((df.get(w) ?? 0) + 0.5));
        s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * tk[i].length) / media)));
      }
      return { ...d, score: s };
    })
    .filter((d) => d.score > 0)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, k);
}

/**
 * Busca o conhecimento dos donos para um pedido.
 * Notas curtas (até 1.500 caracteres) entram sempre: costumam ser regras da equipe.
 */
export async function recuperar({ donos, consulta, cwd, k = 6, maxChars = 7000 }) {
  const todos = todosDonos();
  const lista = [...new Set(donos ?? [])].filter((d) => todos[d]?.fontes?.length);
  if (!lista.length) return [];
  const sempre = [];
  const docs = [];
  for (const dono of lista) {
    for (const f of todos[dono].fontes) {
      if (f.tipo === "nota" && f.texto.length <= 1500) {
        sempre.push({ dono, fonte: f.id, origem: `nota: ${f.titulo}`, linha: 1, texto: f.texto, score: Infinity });
        continue;
      }
      for (const d of await documentosDe(f, cwd)) docs.push({ ...d, dono });
    }
  }
  const achados = [...sempre, ...bm25(docs, consulta, k)];
  const out = [];
  let total = 0;
  for (const a of achados) {
    if (total + a.texto.length > maxChars) continue;
    total += a.texto.length;
    out.push({ dono: a.dono, fonte: a.fonte, origem: a.origem, linha: a.linha, texto: a.texto, score: a.score === Infinity ? null : Math.round(a.score * 100) / 100 });
  }
  return out;
}

const nomeDono = (dono, nomes = {}) => {
  const [tipo, id] = dono.split(":");
  return tipo === "papel" ? PAPEIS[id]?.nome ?? id : nomes[id] ?? id;
};

/** Bloco que entra no pedido da ferramenta. */
export function blocoPedido(achados, nomes) {
  if (!achados?.length) return "";
  return `

Conhecimento recuperado para esta tarefa (RAG do leradev; use como referência, sem copiar às cegas):
${achados.map((a, i) => `--- [${i + 1}] ${nomeDono(a.dono, nomes)} · ${a.origem}${a.linha > 1 ? ` (linha ${a.linha})` : ""}\n${a.texto}`).join("\n")}
--- fim do conhecimento recuperado`;
}

/** Texto para o contexto do Jev. */
export function blocoJev(achados) {
  return (achados ?? []).map((a) => `[${a.origem}]\n${a.texto}`).join("\n\n");
}

/** Conhecimento do Jev para uma consulta (texto pronto, vazio se não houver). */
export async function conhecimentoJev(consulta, cwd) {
  try {
    return blocoJev(await recuperar({ donos: ["papel:jev"], consulta, cwd, k: 4, maxChars: 5000 }));
  } catch {
    return "";
  }
}

/** Resumo das fontes de um dono (para telas e para o mapa 3D). */
export async function resumoFontes(dono, cwd) {
  const out = [];
  for (const f of fontesDe(dono)) {
    let trechosN = null;
    let ok = true;
    if (f.tipo === "pasta" || f.tipo === "arquivo") {
      const alvo = resolverCaminho(f.caminho, cwd);
      ok = !!alvo && fs.existsSync(alvo);
      if (ok && f.tipo === "arquivo") trechosN = (await documentosDe(f, cwd)).length;
      if (ok && f.tipo === "pasta") trechosN = listarPasta(alvo).length; // arquivos, não trechos
    }
    out.push({ ...f, texto: f.texto ? f.texto.slice(0, 400) : undefined, existe: ok, contagem: trechosN });
  }
  return out;
}
