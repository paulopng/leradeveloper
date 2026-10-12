#!/usr/bin/env node
// `leradeveloper` — start the local server and open the UI in the browser.
// A second launch reuses the running instance and just opens a new tab.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "../server/index.js";
import { appDataDir } from "../server/lib/paths.js";
import { VERSION } from "../server/lib/system.js";
import { setPassword, setRemote } from "../server/lib/auth.js";
import { load as loadLera } from "../server/lib/lera-config.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i < 0) return undefined;
  return args[i].includes("=") ? args[i].split("=")[1] : args[i + 1];
};

if (flag("--version") || flag("-v")) {
  console.log(VERSION);
  process.exit(0);
}
// ---------- acesso remoto (celular) ----------
async function askHidden(question) {
  const { createInterface } = await import("node:readline");
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write("\n"); resolve(answer); });
  });
}
if (flag("--senha")) {
  const a = await askHidden("Nova senha para o acesso remoto (mín. 8 caracteres): ");
  const b = await askHidden("Repita a senha: ");
  if (a !== b) { console.error("As senhas não conferem. Nada foi alterado."); process.exit(1); }
  try { setPassword(a); } catch (e) { console.error(e.message); process.exit(1); }
  console.log(`Senha definida e acesso remoto ligado.

Próximos passos (uma vez só):
  1. Instale o Tailscale no PC e no celular, com a mesma conta: https://tailscale.com/download
  2. No painel do Tailscale (DNS), ative "HTTPS Certificates".
  3. No PC, com o leradeveloper rodando:  tailscale serve --bg 4747
  4. No celular, abra o endereço que o comando mostrar (https://<seu-pc>.<sua-rede>.ts.net)
     e entre com esta senha.`);
  process.exit(0);
}
if (flag("--remoto-desligar")) {
  setRemote(false);
  console.log("Acesso remoto desligado. Sessões abertas foram encerradas.");
  process.exit(0);
}
if (flag("--remoto-status")) {
  const r = loadLera().remoto;
  console.log(`Acesso remoto: ${r.ativo && r.senha ? "ligado" : "desligado"}\nHosts permitidos: ${r.hostsPermitidos.join(", ")}\nSessões ativas: ${(r.sessoes ?? []).filter((x) => x.expira > Date.now()).length}`);
  process.exit(0);
}

if (flag("--help") || flag("-h")) {
  console.log(`leradeveloper ${VERSION}

Browse, install and track AI agent personas for Claude Code, Codex, Cursor,
Gemini CLI, Copilot, Qwen, opencode and more — in your browser.

Uso: leradeveloper [opções]

  --port N            Porta (padrão: 4747, ou a próxima livre)
  --no-open           Não abre o navegador
  --senha             Define a senha e liga o acesso pelo celular
  --remoto-desligar   Desliga o acesso remoto
  --remoto-status     Mostra se o acesso remoto está ligado
  --version           Mostra a versão

Mapas 3D: http://127.0.0.1:4747/mapas`);
  process.exit(0);
}

const lockFile = path.join(appDataDir(), "state", "server.json");

function openBrowser(url) {
  const [cmd, cmdArgs] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, cmdArgs, { detached: true, stdio: "ignore", windowsHide: true }).on("error", () => {}).unref();
  } catch {
    /* no browser available — the URL is printed anyway */
  }
}

async function existingInstance() {
  try {
    const info = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    process.kill(info.pid, 0); // throws if the process is gone
    const r = await fetch(`http://127.0.0.1:${info.port}/`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? info : null;
  } catch {
    return null;
  }
}

function listen(server, port, attempts = 20) {
  return new Promise((resolve, reject) => {
    const tryPort = (p, left) => {
      server.once("error", (e) => {
        if (e.code === "EADDRINUSE" && left > 0) tryPort(p + 1, left - 1);
        else reject(e);
      });
      server.listen(p, "127.0.0.1", () => resolve(p));
    };
    tryPort(port, attempts);
  });
}

const requestedPort = Number(opt("--port") ?? process.env.LERADEVELOPER_PORT ?? (flag("--dev") ? 4748 : 4747));
const running = opt("--port") || flag("--dev") ? null : await existingInstance();
if (running) {
  const url = `http://127.0.0.1:${running.port}/`;
  console.log(`leradeveloper is already running at ${url}`);
  if (!flag("--no-open")) openBrowser(url);
  process.exit(0);
}

// --dev: fixed API token so the Vite dev server (npm run dev) can talk to us.
const { server } = createServer(flag("--dev") ? { token: "dev" } : {});
const port = await listen(server, requestedPort);
const url = `http://127.0.0.1:${port}/`;
fs.mkdirSync(path.dirname(lockFile), { recursive: true });
if (!flag("--dev")) fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, port, version: VERSION }));

const cleanup = () => {
  try {
    const info = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    if (info.pid === process.pid) fs.rmSync(lockFile, { force: true });
  } catch {
    /* already gone */
  }
  process.exit(0);
};
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

console.log(`leradeveloper ${VERSION} running at ${url}`);
console.log("Press Ctrl+C to stop.");
if (!flag("--no-open")) openBrowser(url);
