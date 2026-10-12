// Mapas 3D dos projetos.
//
// Cada mapa é um JSON em <projetosDir>/mapas/<id>.json, escrito pelo agente
// "Gerador de grafos" (ou à mão). Formato:
//   {
//     "titulo": "...", "subtitulo": "...", "atualizado": "2026-10-12",
//     "camadas": [{ "id": "negocio", "rotulo": "Negócio" }, ...],          // de cima para baixo
//     "nos": [{ "id", "camada", "rotulo", "tipo", "status", "descricao", "peso"?, "jev"? }],
//     "ligacoes": [{ "de", "para", "relacao", "pendente"?, "fluxo"?, "alerta"? }]
//   }
// Ligações entre camadas diferentes viram as correlações (feixes) no mapa.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./paths.js";
import { load, update } from "./lera-config.js";
import { invalidArgument, io } from "./errors.js";

export const TIPOS = ["fonte", "sistema", "pessoas", "entregavel", "justificativa", "risco", "dado", "humano", "agente", "ferramenta", "decisao", "tarefa", "marco", "ideia"];
export const STATUS = ["ok", "atencao", "bloqueado", "confirmar"];
const MAX_BYTES = 2 * 1024 * 1024;
const ID_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/;

const exampleDir = path.join(DATA_DIR, "mapas-exemplo");
const userDir = () => path.join(load().projetosDir, "mapas");

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
    })),
    ligacoes: ligacoes.map((l) => ({
      de: String(l.de),
      para: String(l.para),
      relacao: String(l.relacao ?? ""),
      pendente: !!l.pendente,
      fluxo: !!l.fluxo,
      alerta: !!l.alerta,
    })),
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

function readMap(id) {
  if (!ID_RE.test(id ?? "")) throw invalidArgument("id de mapa inválido");
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
  mapas_listar() {
    const meus = listDir(userDir(), false);
    // Os exemplos aparecem até existir o primeiro mapa seu.
    const exemplos = meus.length ? [] : listDir(exampleDir, true);
    return { pasta: userDir(), mapas: [...meus, ...exemplos] };
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
