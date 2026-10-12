// Configuração própria do leradeveloper (fora do settings.json herdado do app original,
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
});

let cache = null;
let cacheMtime = 0;

// Recarrega quando o arquivo muda no disco (ex.: `leradeveloper --senha` rodado
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
  cache = { ...d, ...data, remoto: { ...d.remoto, ...(data.remoto ?? {}) } };
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
