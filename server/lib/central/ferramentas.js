// Como achar e iniciar as ferramentas de código (Claude Code, Codex, Cursor) sem shell
// sempre que possível, e como parar a árvore de processos inteira.
//
// Para testes (ou instalações fora do PATH), cada ferramenta aceita um comando fixo em
// JSON: LERA_CMD_CLAUDE='["node","/caminho/fake-claude.js"]', idem CODEX e CURSOR.
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";

const WIN = process.platform === "win32";

export const FERRAMENTAS = {
  claude: {
    nome: "Claude Code",
    exes: ["claude"],
    envCmd: "LERA_CMD_CLAUDE",
    perfil: "Raciocínio em várias etapas, mudanças em muitos arquivos, refatoração, arquitetura e depuração difícil. Pede aprovação de comandos pelo leradev.",
    instalar: "https://code.claude.com/docs/en/setup",
  },
  codex: {
    nome: "Codex",
    exes: ["codex"],
    envCmd: "LERA_CMD_CODEX",
    perfil: "Implementação bem delimitada, testes, correções pontuais e scripts. Roda em sandbox no projeto e pede aprovação de comandos pelo leradev.",
    instalar: "npm install -g @openai/codex",
  },
  cursor: {
    nome: "Cursor",
    exes: ["agent", "cursor-agent"],
    envCmd: "LERA_CMD_CURSOR",
    perfil: "Edições rápidas de interface e front-end. Roda em modo automático: aplica mudanças e roda comandos sem pedir aprovação.",
    instalar: "irm 'https://cursor.com/install?win32=true' | iex",
  },
  antigravity: {
    nome: "Antigravity",
    exes: ["agy"],
    envCmd: "LERA_CMD_ANTIGRAVITY",
    perfil: "Agente do Google (substituto do Gemini CLI), bom em pesquisa, contexto grande e tarefas web. Aplica edições sozinho; não pede aprovação de comandos pelo leradev. Experimental.",
    instalar: "irm https://antigravity.google/cli/install.ps1 | iex",
  },
};

/** Caminho do executável (Windows: prefere .exe; aceita .cmd/.bat). null se não achar. */
function whereIs(name) {
  try {
    const out = execFileSync(WIN ? "where" : "sh", WIN ? [name] : ["-c", `command -v ${name}`], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 8000,
    });
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!WIN) return lines[0] ?? null;
    return lines.find((l) => /\.exe$/i.test(l)) ?? lines.find((l) => /\.(cmd|bat)$/i.test(l)) ?? null;
  } catch {
    return null;
  }
}

const cache = new Map();
/** Comando base da ferramenta: [executável, ...args fixos]. */
export function resolveTool(id) {
  const def = FERRAMENTAS[id];
  if (!def) throw new Error(`Ferramenta desconhecida: ${id}`);
  const fixed = process.env[def.envCmd];
  if (fixed) {
    try {
      const arr = JSON.parse(fixed);
      if (Array.isArray(arr) && arr.length) return arr.map(String);
    } catch {
      /* ignora valor inválido */
    }
  }
  if (cache.has(id)) return cache.get(id);
  let found = null;
  for (const exe of def.exes) {
    found = whereIs(exe);
    if (found) break;
  }
  const cmd = found ? [found] : null;
  cache.set(id, cmd);
  return cmd;
}
export const _limparCache = () => cache.clear();

// Argumentos fixos e controlados por nós (flags, ids, caminhos). Texto livre do usuário
// nunca passa por aqui: vai por stdin ou por arquivo.
function quoteWin(a) {
  return /^[\w.\-/:=@\\+,]+$/.test(a) ? a : `"${String(a).replace(/"/g, '""')}"`;
}

/** Inicia a ferramenta com argumentos extras. */
export function spawnTool(id, args, { cwd, env } = {}) {
  const base = resolveTool(id);
  if (!base) throw new Error(`${FERRAMENTAS[id].nome} não foi encontrado neste computador. Instale: ${FERRAMENTAS[id].instalar}`);
  const [exe, ...fixedArgs] = base;
  const all = [...fixedArgs, ...args];
  const opts = { cwd, env: { ...process.env, ...env }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] };
  if (WIN && /\.(cmd|bat)$/i.test(exe)) {
    const line = [quoteWin(exe), ...all.map(quoteWin)].join(" ");
    return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], { ...opts, windowsVerbatimArguments: true });
  }
  return spawn(exe, all, opts);
}

/** Para o processo e tudo que ele abriu. */
export function killTree(child) {
  if (!child || child.exitCode != null) return;
  try {
    if (WIN) execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else if (child.lera_grupo) process.kill(-child.pid, "SIGTERM"); // grupo inteiro (shell → npm → servidor)
    else child.kill("SIGTERM");
  } catch {
    try { child.kill(); } catch { /* já saiu */ }
  }
}

/** Versões instaladas (com cache de 60 s). */
let detCache = null;
export async function detectar({ atualizar = false } = {}) {
  if (!atualizar && detCache && Date.now() - detCache.quando < 60000) return detCache.valor;
  if (atualizar) cache.clear();
  const out = {};
  await Promise.all(
    Object.entries(FERRAMENTAS).map(async ([id, def]) => {
      const base = resolveTool(id);
      if (!base) {
        out[id] = { id, nome: def.nome, ok: false, perfil: def.perfil, instalar: def.instalar };
        return;
      }
      const versao = await new Promise((resolve) => {
        let txt = "";
        let child;
        try {
          child = spawnTool(id, ["--version"]);
        } catch {
          return resolve(null);
        }
        const t = setTimeout(() => { killTree(child); resolve(null); }, 10000);
        child.stdout.on("data", (d) => (txt += d));
        child.on("error", () => { clearTimeout(t); resolve(null); });
        child.on("close", () => { clearTimeout(t); resolve(txt.trim().split(/\r?\n/)[0]?.slice(0, 80) || null); });
        child.stdin.end();
      });
      out[id] = { id, nome: def.nome, ok: versao != null, versao, caminho: base[base.length > 1 ? 1 : 0], perfil: def.perfil, instalar: def.instalar };
    }),
  );
  const ordenado = Object.fromEntries(Object.keys(FERRAMENTAS).map((id) => [id, out[id]]));
  detCache = { quando: Date.now(), valor: ordenado };
  return ordenado;
}

/** Garante que `.lera/` não entre no git do projeto. */
export function ignorarLera(repo) {
  try {
    const gitDir = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: repo, encoding: "utf8", windowsHide: true }).trim();
    const exclude = path.join(path.isAbsolute(gitDir) ? gitDir : path.join(repo, gitDir), "info", "exclude");
    const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
    if (!/^\.lera\/$/m.test(cur)) {
      fs.mkdirSync(path.dirname(exclude), { recursive: true });
      fs.writeFileSync(exclude, cur.replace(/\s*$/, "\n") + ".lera/\n");
    }
  } catch {
    /* não é repositório git */
  }
}
