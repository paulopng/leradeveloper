// Configuração própria do leradev (fora do settings.json herdado do app original,
// que a interface reescreve inteiro): pasta dos projetos e acesso remoto.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appDataDir } from "./paths.js";

const file = () => path.join(appDataDir(), "lera.json");

const defaults = () => ({
  projetosDir: path.join(os.homedir(), "lera-projetos"),
  remoto: {
    ativo: false,
    senha: null, // { salt, hash } (scrypt)
    hostsPermitidos: [".ts.net"], // sufixos ou nomes exatos aceitos no cabeçalho Host
    sessoes: [], // { hash, expira }
  },
  // Ajustes do decisor Jev. A chave nunca fica aqui: só em variável de ambiente.
  // Variáveis de ambiente (JEV_MODEL, JEV_LIMIAR_*) têm prioridade sobre estes valores.
  jev: {
    modelo: "typesafe/jev-1.13",
    limiarBaixo: 0.3,
    limiarAlto: 0.7,
  },
  // Central de comando: projetos de código onde as ferramentas trabalham.
  central: {
    projetos: [], // { id, nome, pasta }
    raiz: null, // pasta onde "novo projeto" cria as pastas (padrão: ~/projetos)
    autonomia: "editar", // editar | perguntar | jev
    paralelo: 3, // tarefas simultâneas do coordenador
    limites: {}, // { cursor: { mensal: 500 } } — pedidos por mês que você quer respeitar
    agentes: "auto", // auto | nenhum — o Jev liga agentes do catálogo por tarefa
  },
  // Funções do leradev e os agentes do catálogo de cada uma: { mapa: { agentes: [slugs] }, ... }
  // (o conhecimento/RAG de cada função e agente fica em state/rag/fontes.json)
  papeis: {},
  // Prévias: porta do servidor de prévias e endereço dele no celular (Tailscale)
  previa: { porta: 4750, urlRemota: null },
});

let cache = null;
let cacheMtime = 0;

// Recarrega quando o arquivo muda no disco (ex.: `leradev --senha` rodado
// em outro terminal enquanto o servidor está no ar).
export function load() {
  let mtime = 0;
  try {
    mtime = fs.statSync(file()).mtimeMs;
  } catch {
    /* primeira vez */
  }
  if (cache && mtime === cacheMtime) return cache;
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file(), "utf8"));
  } catch {
    /* primeira vez ou arquivo corrompido: volta aos padrões */
  }
  const d = defaults();
  cache = { ...d, ...data, remoto: { ...d.remoto, ...(data.remoto ?? {}) }, jev: { ...d.jev, ...(data.jev ?? {}) }, central: { ...d.central, ...(data.central ?? {}) }, papeis: { ...d.papeis, ...(data.papeis ?? {}) }, previa: { ...d.previa, ...(data.previa ?? {}) } };
  cacheMtime = mtime;
  return cache;
}

export function save(next) {
  cache = next;
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file());
  cacheMtime = fs.statSync(file()).mtimeMs;
}

export function update(fn) {
  const cur = structuredClone(load());
  const next = fn(cur) ?? cur;
  save(next);
  return next;
}

/** Só para testes: esquece o cache em memória. */
export function _reset() {
  cache = null;
  cacheMtime = 0;
}
