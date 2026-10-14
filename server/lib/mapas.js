// Mapas 3D dos projetos.
//
// Cada mapa é um JSON em <projetosDir>/mapas/<id>.json, escrito pelo agente
// "Gerador de grafos" (ou à mão). Formato:
//   {
//     "titulo": "...", "subtitulo": "...", "atualizado": "2026-10-12",
//     "camadas": [{ "id": "negocio", "rotulo": "Negócio" }, ...],          // de cima para baixo
//     "nos": [{ "id", "camada", "rotulo", "tipo", "status", "descricao", "peso"?, "jev"?, "atributos"? }],
//     "ligacoes": [{ "de", "para", "relacao", "pendente"?, "fluxo"?, "alerta"? }]
//   }
// Ligações entre camadas diferentes viram as correlações (feixes) no mapa.
// "atributos" é um objeto curto { chave: valor } (ex.: método, rota, síncrono, fila, saúde, colunas).
//
// Mapas de projeto (arquitetura gerada pela Central) ficam em <pasta do projeto>/.lera/mapa.json
// e aparecem aqui com o id "projeto-<id do projeto>".
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./paths.js";
import { load, update } from "./lera-config.js";
import { invalidArgument, io } from "./errors.js";

export const TIPOS = [
  "fonte", "sistema", "pessoas", "entregavel", "justificativa", "risco", "dado", "humano", "agente", "ferramenta", "decisao", "tarefa", "marco", "ideia",
  // arquitetura de software (mapas de projeto)
  "tela", "componente", "botao", "api", "fila", "servico", "tabela", "automacao", "mcp", "modelo", "indice", "prompt", "teste", "infra",
];
export const STATUS = ["ok", "atencao", "bloqueado", "confirmar"];
const MAX_BYTES = 2 * 1024 * 1024;
const ID_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/;

const exampleDir = path.join(DATA_DIR, "mapas-exemplo");
const userDir = () => path.join(load().projetosDir, "mapas");
export const PREFIXO_PROJETO = "projeto-";
export const arquivoMapaProjeto = (pasta) => path.join(pasta, ".lera", "mapa.json");
const projetosComPasta = () => (load().central?.projetos ?? []).filter((p) => p?.id && p?.pasta);

// Mapas gerados na hora pelo próprio leradev (ex.: a equipe de agentes e o conhecimento).
const virtuais = new Map(); // id → { titulo, gerar: async () => mapa }
export function registrarMapaVirtual(id, def) {
  virtuais.set(id, def);
}

/** Links do painel do nó: só caminhos do próprio leradev (começam com "/"). */
function normLinks(l) {
  if (!Array.isArray(l)) return null;
  const out = l
    .slice(0, 6)
    .map((x) => ({ rotulo: String(x?.rotulo ?? "").trim().slice(0, 60), href: String(x?.href ?? "").trim().slice(0, 300) }))
    .filter((x) => x.rotulo && /^\/(?!\/)/.test(x.href));
  return out.length ? out : null;
}

/** Normaliza atributos: até 24 pares, chave ≤ 40 e valor ≤ 300 caracteres. */
function normAtributos(a) {
  if (!a || typeof a !== "object" || Array.isArray(a)) return null;
  const out = {};
  for (const [k, v] of Object.entries(a).slice(0, 24)) {
    const chave = String(k).trim().slice(0, 40);
    if (!chave || v == null || v === "") continue;
    out[chave] = (Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v)).slice(0, 300);
  }
  return Object.keys(out).length ? out : null;
}

/** Valida e normaliza um mapa. Devolve { mapa, avisos } ou lança erro com a lista de problemas. */
export function validate(raw, origem = "mapa") {
  const problemas = [];
  const avisos = [];
  if (!raw || typeof raw !== "object") throw invalidArgument(`${origem}: não é um objeto JSON.`);
  const camadas = Array.isArray(raw.camadas) ? raw.camadas : [];
  if (!camadas.length) problemas.push("precisa de pelo menos uma camada em \"camadas\"");
  const camadaIds = new Set();
  for (const c of camadas) {
    if (!c?.id || !c?.rotulo) problemas.push(`camada sem id ou rótulo: ${JSON.stringify(c)}`);
    else if (camadaIds.has(c.id)) problemas.push(`camada repetida: ${c.id}`);
    else camadaIds.add(c.id);
  }
  const nos = Array.isArray(raw.nos) ? raw.nos : [];
  if (!nos.length) problemas.push("precisa de pelo menos um nó em \"nos\"");
  const noIds = new Set();
  for (const n of nos) {
    if (!n?.id || !n?.rotulo) { problemas.push(`nó sem id ou rótulo: ${JSON.stringify(n).slice(0, 80)}`); continue; }
    if (noIds.has(n.id)) problemas.push(`nó repetido: ${n.id}`);
    noIds.add(n.id);
    if (!camadaIds.has(n.camada)) problemas.push(`nó ${n.id}: camada "${n.camada}" não existe`);
    if (n.tipo && !TIPOS.includes(n.tipo)) avisos.push(`nó ${n.id}: tipo "${n.tipo}" desconhecido, usando "ideia"`);
    if (n.status && !STATUS.includes(n.status)) avisos.push(`nó ${n.id}: status "${n.status}" desconhecido, usando "confirmar"`);
  }
  const ligacoes = Array.isArray(raw.ligacoes) ? raw.ligacoes : [];
  for (const l of ligacoes) {
    if (!noIds.has(l?.de) || !noIds.has(l?.para)) problemas.push(`ligação aponta para nó inexistente: ${l?.de} → ${l?.para}`);
  }
  if (problemas.length) throw invalidArgument(`${origem} tem problemas:\n- ${problemas.slice(0, 12).join("\n- ")}`);

  const mapa = {
    titulo: String(raw.titulo ?? "Sem título"),
    subtitulo: String(raw.subtitulo ?? ""),
    atualizado: raw.atualizado ? String(raw.atualizado) : null,
    camadas: camadas.map((c) => ({ id: String(c.id), rotulo: String(c.rotulo) })),
    nos: nos.map((n) => ({
      id: String(n.id),
      camada: String(n.camada),
      rotulo: String(n.rotulo),
      tipo: TIPOS.includes(n.tipo) ? n.tipo : "ideia",
      status: STATUS.includes(n.status) ? n.status : "confirmar",
      descricao: String(n.descricao ?? ""),
      peso: Math.min(3, Math.max(1, Number(n.peso) || 1)),
      ...(n.jev && Number.isFinite(Number(n.jev.probabilidade))
        ? { jev: { pergunta: String(n.jev.pergunta ?? ""), probabilidade: Number(n.jev.probabilidade), quando: n.jev.quando ?? null } }
        : {}),
      ...(normAtributos(n.atributos) ? { atributos: normAtributos(n.atributos) } : {}),
      ...(normLinks(n.links) ? { links: normLinks(n.links) } : {}),
    })),
    ligacoes: ligacoes.map((l) => ({
      de: String(l.de),
      para: String(l.para),
      relacao: String(l.relacao ?? ""),
      pendente: !!l.pendente,
      fluxo: !!l.fluxo,
      alerta: !!l.alerta,
    })),
    ...(raw.validacao && typeof raw.validacao === "object" ? { validacao: raw.validacao } : {}),
    ...(raw.projetoId ? { projetoId: String(raw.projetoId) } : {}),
  };
  return { mapa, avisos };
}

function listDir(dir, exemplo) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return names
    .map((f) => {
      const id = f.slice(0, -5);
      if (!ID_RE.test(id)) return null;
      const file = path.join(dir, f);
      try {
        const st = fs.statSync(file);
        if (st.size > MAX_BYTES) return { id, exemplo, erro: "arquivo grande demais" };
        const { mapa, avisos } = validate(JSON.parse(fs.readFileSync(file, "utf8")), f);
        return { id, exemplo, titulo: mapa.titulo, subtitulo: mapa.subtitulo, atualizado: mapa.atualizado ?? st.mtime.toISOString(), camadas: mapa.camadas.length, nos: mapa.nos.length, avisos: avisos.length };
      } catch (e) {
        return { id, exemplo, titulo: id, erro: e.payload?.message ?? e.message };
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.atualizado ?? "").localeCompare(String(a.atualizado ?? "")));
}

function resumoDe(id, file, extra) {
  try {
    const st = fs.statSync(file);
    if (st.size > MAX_BYTES) return { id, ...extra, erro: "arquivo grande demais" };
    const { mapa, avisos } = validate(JSON.parse(fs.readFileSync(file, "utf8")), path.basename(file));
    return { id, ...extra, titulo: mapa.titulo, subtitulo: mapa.subtitulo, atualizado: mapa.atualizado ?? st.mtime.toISOString(), camadas: mapa.camadas.length, nos: mapa.nos.length, avisos: avisos.length, validado: mapa.validacao?.aprovado ?? null };
  } catch (e) {
    return { id, ...extra, titulo: id, erro: e.payload?.message ?? e.message };
  }
}

function listProjetos() {
  return projetosComPasta()
    .map((p) => ({ p, file: arquivoMapaProjeto(p.pasta) }))
    .filter(({ file }) => fs.existsSync(file))
    .map(({ p, file }) => resumoDe(PREFIXO_PROJETO + p.id, file, { exemplo: false, projetoId: p.id, projeto: p.nome }));
}

async function readMap(id) {
  if (!ID_RE.test(id ?? "")) throw invalidArgument("id de mapa inválido");
  if (virtuais.has(id)) {
    const { mapa, avisos } = validate(await virtuais.get(id).gerar(), id);
    return { id, exemplo: false, virtual: true, ...mapa, avisos };
  }
  if (id.startsWith(PREFIXO_PROJETO)) {
    const p = projetosComPasta().find((x) => PREFIXO_PROJETO + x.id === id);
    const file = p && arquivoMapaProjeto(p.pasta);
    if (file && fs.existsSync(file)) {
      if (fs.statSync(file).size > MAX_BYTES) throw io("mapa do projeto é grande demais (máx. 2 MB)");
      let raw;
      try {
        raw = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (e) {
        throw invalidArgument(`mapa do projeto não é um JSON válido: ${e.message}`);
      }
      const { mapa, avisos } = validate(raw, "mapa do projeto");
      return { id, exemplo: false, projetoId: p.id, projeto: p.nome, ...mapa, avisos };
    }
  }
  for (const [dir, exemplo] of [[userDir(), false], [exampleDir, true]]) {
    const file = path.join(dir, `${id}.json`);
    if (!fs.existsSync(file)) continue;
    if (fs.statSync(file).size > MAX_BYTES) throw io(`${id}.json é grande demais (máx. 2 MB)`);
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      throw invalidArgument(`${id}.json não é um JSON válido: ${e.message}`);
    }
    const { mapa, avisos } = validate(raw, `${id}.json`);
    return { id, exemplo, ...mapa, avisos };
  }
  throw invalidArgument(`mapa não encontrado: ${id}`);
}

export const commands = {
  async mapas_listar() {
    const vivos = [];
    for (const [id, v] of virtuais) {
      try {
        const m = validate(await v.gerar(), id).mapa;
        vivos.push({ id, exemplo: false, virtual: true, titulo: m.titulo, subtitulo: m.subtitulo, atualizado: m.atualizado, camadas: m.camadas.length, nos: m.nos.length, avisos: 0 });
      } catch (e) {
        vivos.push({ id, virtual: true, titulo: v.titulo ?? id, erro: e.payload?.message ?? e.message });
      }
    }
    const meus = [...listProjetos(), ...listDir(userDir(), false)];
    // Os exemplos aparecem até existir o primeiro mapa seu.
    const exemplos = meus.length ? [] : listDir(exampleDir, true);
    return { pasta: userDir(), mapas: [...meus, ...vivos, ...exemplos] };
  },
  mapa_obter({ id }) {
    return readMap(id);
  },
  mapas_config_obter() {
    return { projetosDir: load().projetosDir, pastaMapas: userDir() };
  },
  mapas_config_definir({ projetosDir }) {
    if (typeof projetosDir !== "string" || !path.isAbsolute(projetosDir)) throw invalidArgument("informe um caminho absoluto");
    update((c) => {
      c.projetosDir = projetosDir;
    });
    return { projetosDir, pastaMapas: userDir() };
  },
};
