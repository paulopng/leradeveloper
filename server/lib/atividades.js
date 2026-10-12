// Atividades dos agentes, para o Escritório.
//
// Os agentes (via MCP: ferramenta `registrar_atividade` do lera-decisor) gravam eventos
// em <appData>/state/atividades.jsonl. O servidor lê o arquivo e monta o estado de cada
// mesa. Arquivo, não memória: o decisor roda em outro processo (um por ferramenta).
import fs from "node:fs";
import path from "node:path";
import { appDataDir } from "./paths.js";

export const STATUS = ["trabalhando", "aguardando", "bloqueado", "concluido", "erro"];
const MAX_BYTES = 2 * 1024 * 1024;
const KEEP_LINES = 3000;
const PARADO_MS = 30 * 60e3; // "trabalhando" sem notícia há 30 min vira "parado"
const SOME_MS = 3 * 864e5; // mesas sem notícia há 3 dias saem do escritório

const file = () => path.join(appDataDir(), "state", "atividades.jsonl");

const str = (v, max) => (v == null ? null : String(v).replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, max) || null);

export class AtividadeError extends Error {}

/** Grava um evento. Devolve o evento normalizado. */
export function registrar(evt = {}) {
  const agente = str(evt.agente, 60);
  if (!agente) throw new AtividadeError("Informe o nome do agente em 'agente'.");
  const tarefa = str(evt.tarefa, 200);
  if (!tarefa) throw new AtividadeError("Informe a tarefa em 'tarefa'.");
  const status = evt.status == null ? "trabalhando" : String(evt.status);
  if (!STATUS.includes(status)) throw new AtividadeError(`status inválido: use ${STATUS.join(", ")}.`);
  let progresso = evt.progresso == null || evt.progresso === "" ? null : Number(evt.progresso);
  if (progresso != null && !Number.isFinite(progresso)) throw new AtividadeError("progresso precisa ser um número de 0 a 100.");
  if (progresso != null) progresso = Math.round(Math.min(100, Math.max(0, progresso)));
  if (status === "concluido" && progresso == null) progresso = 100;
  const entry = {
    quando: new Date().toISOString(),
    agente,
    tarefa,
    status,
    progresso,
    mensagem: str(evt.mensagem, 500),
    ferramenta: str(evt.ferramenta, 40),
    projeto: str(evt.projeto, 80),
  };
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.appendFileSync(file(), JSON.stringify(entry) + "\n");
  rotate();
  return entry;
}

function rotate() {
  try {
    if (fs.statSync(file()).size <= MAX_BYTES) return;
    const lines = fs.readFileSync(file(), "utf8").trim().split("\n");
    const tmp = `${file()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, lines.slice(-KEEP_LINES).join("\n") + "\n");
    fs.renameSync(tmp, file());
  } catch {
    /* outro processo pode ter girado antes */
  }
}

export function eventos() {
  try {
    return fs
      .readFileSync(file(), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Uma entrada por agente, com a tarefa atual e um histórico curto. */
export function mesas(now = Date.now(), evs = eventos()) {
  const by = new Map();
  for (const e of evs) {
    const k = e.agente.toLowerCase();
    let m = by.get(k);
    if (!m || m.tarefa !== e.tarefa) {
      const concluidas = m ? m.concluidas + (m.status === "concluido" ? 1 : 0) : 0;
      m = { agente: e.agente, tarefa: e.tarefa, inicio: e.quando, progresso: 0, status: e.status, mensagem: null, historico: [], concluidas };
      by.set(k, m);
    }
    m.agente = e.agente;
    m.status = e.status;
    if (e.progresso != null) m.progresso = e.progresso;
    if (e.mensagem) m.mensagem = e.mensagem;
    if (e.ferramenta) m.ferramenta = e.ferramenta;
    if (e.projeto) m.projeto = e.projeto;
    m.atualizado = e.quando;
    m.historico.push({ quando: e.quando, status: e.status, progresso: e.progresso, mensagem: e.mensagem });
    if (m.historico.length > 10) m.historico.shift();
  }
  return [...by.values()]
    .filter((m) => now - Date.parse(m.atualizado) < SOME_MS)
    .map((m) => ({ ...m, status: m.status === "trabalhando" && now - Date.parse(m.atualizado) > PARADO_MS ? "parado" : m.status }))
    .sort((a, b) => a.inicio.localeCompare(b.inicio));
}

/** Para testes. */
export function _limpar() {
  try {
    fs.rmSync(file());
  } catch {
    /* nada */
  }
}
