// Prévias: o link para testar a entrega atual sem sair do leradev.
//
// Um segundo servidor, só em 127.0.0.1 (porta 4750 por padrão), mostra o projeto como ele
// está numa pasta: a do projeto, a cópia de uma tarefa (worktree) ou a integração de um
// objetivo. Dois jeitos de mostrar:
//   estatico — serve os arquivos (index.html na raiz, ou em dist/, build/, public/);
//   script   — roda um script do package.json (dev, start ou preview) numa porta livre e
//              repassa tudo para ele, inclusive WebSocket (recarregar ao vivo).
// O link traz ?__previa=<id>; o servidor guarda a escolha num cookie e repassa os pedidos
// seguintes, então caminhos absolutos (/assets/x.js) funcionam.
//
// Celular: as mesmas regras do servidor principal (Tailscale, Host permitido, sessão com
// senha). Uma vez: `tailscale serve --bg --https=8443 4750`.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { load } from "./lera-config.js";
import * as auth from "./auth.js";
import { invalidArgument } from "./errors.js";
import { killTree } from "./central/ferramentas.js";

const COOKIE = "lera_previa";
const OCIOSA_MS = 30 * 60 * 1000;
const MIME = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".txt": "text/plain; charset=utf-8", ".map": "application/json", ".wasm": "application/wasm", ".webmanifest": "application/manifest+json",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".pdf": "application/pdf", ".xml": "application/xml",
};

const previas = new Map(); // id → prévia
let servidor = null;
let portaAtual = null;
let iniciando = null;

// ---------- detecção ----------

const SCRIPTS = ["dev", "start", "preview", "serve"];
const RAIZES = [".", "dist", "build", "public", "out", "www", "site"];

/** O que dá para abrir nesta pasta. */
export function detectar(dir, cfg = {}) {
  const base = cfg.pasta ? path.resolve(dir, cfg.pasta) : dir;
  if (path.relative(dir, base).startsWith("..")) throw invalidArgument("A subpasta da prévia precisa ficar dentro do projeto.");
  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(base, "package.json"), "utf8"));
  } catch {
    /* sem package.json */
  }
  const scripts = Object.keys(pkg?.scripts ?? {}).filter((s) => /^[\w:.-]{1,40}$/.test(s));
  const raizes = RAIZES.filter((r) => fs.existsSync(path.join(base, r, "index.html")));
  const modo = cfg.modo && cfg.modo !== "auto" ? cfg.modo : null;
  if ((modo === "script" || !modo) && scripts.length) {
    const script = cfg.script && scripts.includes(cfg.script) ? cfg.script : SCRIPTS.find((s) => scripts.includes(s));
    if (script) return { modo: "script", base, script, scripts, raizes };
  }
  if (modo === "script") throw invalidArgument(cfg.script ? `O package.json não tem o script "${cfg.script}".` : "Não achei script dev, start, preview ou serve no package.json.");
  const raiz = cfg.raiz && raizes.includes(cfg.raiz) ? cfg.raiz : raizes[0];
  if (raiz) return { modo: "estatico", base, raiz: path.join(base, raiz), raizRel: raiz, scripts, raizes };
  throw invalidArgument("Não achei o que abrir: nenhum index.html (na raiz, dist/, build/ ou public/) nem script dev/start no package.json.");
}

// ---------- processos ----------

function portaLivre() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function conecta(host, porta) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port: porta });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
    s.setTimeout(800, () => { s.destroy(); resolve(false); });
  });
}

function gerenciador(base) {
  if (fs.existsSync(path.join(base, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(base, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(base, "bun.lockb")) || fs.existsSync(path.join(base, "bun.lock"))) return "bun";
  return "npm";
}

function rodarShell(p, linha, envExtra = {}) {
  // Linha montada só com partes controladas: gerenciador, nome de script validado e números.
  const grupo = process.platform !== "win32";
  const child = spawn(linha, { cwd: p.base, shell: true, windowsHide: true, detached: grupo, env: { ...process.env, BROWSER: "none", FORCE_COLOR: "0", ...envExtra }, stdio: ["ignore", "pipe", "pipe"] });
  child.lera_grupo = grupo;
  const add = (d) => {
    p.log = (p.log + d).slice(-8000);
    // descobre a porta real se o servidor ignorou a nossa
    const m = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(\d{2,5})/.exec(String(d));
    if (m && !p.portaVista) p.portaVista = Number(m[1]);
  };
  child.stdout.on("data", add);
  child.stderr.on("data", add);
  return child;
}

async function iniciarScript(p) {
  const pm = gerenciador(p.base);
  if (!fs.existsSync(path.join(p.base, "node_modules"))) {
    p.status = "instalando";
    p.etapa = `${pm} install`;
    const ok = await new Promise((resolve) => {
      const c = rodarShell(p, pm === "npm" ? "npm install --no-audit --no-fund" : `${pm} install`);
      p.processo = c;
      c.on("close", (code) => resolve(code === 0));
      c.on("error", () => resolve(false));
    });
    if (p.status === "parada") return;
    if (!ok) {
      p.status = "erro";
      p.erro = "A instalação das dependências falhou. Veja o registro.";
      return;
    }
  }
  p.status = "iniciando";
  p.etapa = `${pm} run ${p.script}`;
  p.porta = await portaLivre();
  const extra = pm === "npm" ? ` -- --port ${p.porta}` : ` --port ${p.porta}`;
  const c = rodarShell(p, `${pm} run ${p.script}${extra}`, { PORT: String(p.porta) });
  p.processo = c;
  c.on("close", (code) => {
    if (p.status !== "parada") {
      p.status = "erro";
      p.erro = `O servidor da prévia saiu (código ${code}). Veja o registro.`;
    }
  });
  const limite = Date.now() + Number(process.env.LERA_PREVIA_ESPERA_MS ?? 120000);
  while (Date.now() < limite && p.status === "iniciando") {
    for (const porta of [p.porta, p.portaVista].filter(Boolean)) {
      for (const host of ["127.0.0.1", "::1"]) {
        if (await conecta(host, porta)) {
          p.alvo = { host, porta };
          p.status = "pronta";
          p.etapa = null;
          return;
        }
      }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (p.status === "iniciando") {
    p.status = "erro";
    p.erro = "O servidor da prévia não respondeu a tempo. Veja o registro.";
  }
}

function parar(p) {
  if (!p) return;
  p.status = "parada";
  if (p.processo) killTree(p.processo);
  p.processo = null;
}
process.on("exit", () => {
  for (const p of previas.values()) if (p.processo) killTree(p.processo);
});

// ---------- servidor de prévias ----------

const htmlHead = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" };
const pagina = (titulo, corpo) => `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${titulo} · prévia leradev</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#120d09;color:#f3e9d8;max-width:640px;margin:40px auto;padding:0 16px}a{color:#7cc8ff}code{background:#2a1d14;padding:1px 5px;border-radius:4px}li{margin:6px 0}</style>
<h1>${titulo}</h1>${corpo}</html>`;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function cookieDe(req) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([\\w-]+)`).exec(req.headers.cookie ?? "");
  return m ? m[1] : null;
}

function portao(req, res) {
  if (!auth.isRemote(req)) return true;
  const cfg = load();
  if (!cfg.remoto.ativo || !cfg.remoto.senha || !auth.hostAllowed(auth.hostOf(req))) {
    res.writeHead(403, htmlHead).end(pagina("Sem acesso", "<p>O acesso pelo celular está desligado ou este endereço não é permitido.</p>"));
    return false;
  }
  if (!auth.hasSession(req)) {
    res.writeHead(401, htmlHead).end(pagina("Entre primeiro", `<p>Entre no leradev com a senha e abra a prévia de novo pela Central.</p><p><a href="https://${esc(auth.hostOf(req))}/entrar">Entrar</a></p>`));
    return false;
  }
  return true;
}

function servirEstatico(p, req, res, url) {
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    return void res.writeHead(400).end();
  }
  let file = path.join(p.raiz, rel);
  const dentro = path.relative(p.raiz, file);
  if (dentro.startsWith("..") || path.isAbsolute(dentro)) return void res.writeHead(403).end();
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!fs.existsSync(file)) {
    // SPA: caminho sem extensão cai no index.html
    if (!path.extname(rel) && fs.existsSync(path.join(p.raiz, "index.html"))) file = path.join(p.raiz, "index.html");
    else return void res.writeHead(404, htmlHead).end(pagina("Não encontrado", `<p><code>${esc(rel)}</code> não existe nesta prévia.</p>`));
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream", "Cache-Control": "no-store" });
  if (req.method === "HEAD") return void res.end();
  fs.createReadStream(file).pipe(res);
}

function cabecalhosAlvo(req, p) {
  const h = { ...req.headers, host: `localhost:${p.alvo.porta}` };
  delete h.cookie; // a sessão do leradev não vai para o app do projeto
  for (const k of Object.keys(h)) if (/^(x-forwarded-|tailscale-|cf-)/i.test(k)) delete h[k];
  // devolve os cookies do próprio app (todos menos os do leradev)
  const proprios = String(req.headers.cookie ?? "").split(/;\s*/).filter((c) => c && !c.startsWith(`${COOKIE}=`) && !c.startsWith("lera_sessao=")).join("; ");
  if (proprios) h.cookie = proprios;
  return h;
}

function repassar(p, req, res) {
  const alvo = http.request({ host: p.alvo.host, port: p.alvo.porta, method: req.method, path: req.url, headers: cabecalhosAlvo(req, p) }, (r) => {
    const h = { ...r.headers };
    if (h.location) h.location = String(h.location).replace(/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+/, "");
    res.writeHead(r.statusCode ?? 502, h);
    r.pipe(res);
  });
  alvo.on("error", (e) => {
    if (!res.headersSent) res.writeHead(502, htmlHead).end(pagina("Prévia fora do ar", `<p>${esc(e.message)}</p><p>Abra de novo pela Central.</p>`));
    else res.destroy();
  });
  req.pipe(alvo);
}

function lista() {
  const ativas = [...previas.values()].filter((p) => p.status !== "parada");
  return pagina("Prévias do leradev", ativas.length
    ? `<ul>${ativas.map((p) => `<li><a href="/?__previa=${esc(p.id)}">${esc(p.rotulo)}</a> · ${esc(p.status)}</li>`).join("")}</ul>`
    : "<p>Nenhuma prévia aberta. Abra pela Central (botão <b>Abrir prévia</b>).</p>");
}

function criarServidor() {
  const s = http.createServer((req, res) => {
    if (!portao(req, res)) return;
    const url = new URL(req.url ?? "/", "http://x");
    const escolhida = url.searchParams.get("__previa");
    if (escolhida) {
      if (!previas.has(escolhida)) return void res.writeHead(404, htmlHead).end(lista());
      url.searchParams.delete("__previa");
      const destino = url.pathname + (url.searchParams.size ? `?${url.searchParams}` : "");
      const seguro = auth.isRemote(req) ? "; Secure" : "";
      return void res.writeHead(303, { Location: destino, "Set-Cookie": `${COOKIE}=${escolhida}; Path=/; HttpOnly; SameSite=Lax${seguro}`, "Cache-Control": "no-store" }).end();
    }
    const p = previas.get(cookieDe(req));
    if (!p || p.status === "parada") return void res.writeHead(200, htmlHead).end(lista());
    p.ultimoAcesso = Date.now();
    if (p.modo === "estatico") return servirEstatico(p, req, res, url);
    if (p.status !== "pronta") {
      return void res.writeHead(503, { ...htmlHead, Refresh: "2" }).end(pagina(esc(p.rotulo), `<p>${p.status === "erro" ? `Erro: ${esc(p.erro)}` : `Preparando (${esc(p.etapa ?? p.status)})… esta página recarrega sozinha.`}</p><pre style="white-space:pre-wrap;font-size:12px;opacity:.7">${esc(p.log.slice(-1500))}</pre>`));
    }
    repassar(p, req, res);
  });
  // WebSocket (recarregar ao vivo do Vite, Next etc.)
  s.on("upgrade", (req, sock, head) => {
    if (auth.isRemote(req) && (!load().remoto.ativo || !auth.hostAllowed(auth.hostOf(req)) || !auth.hasSession(req))) return void sock.destroy();
    const p = previas.get(cookieDe(req));
    if (!p || p.modo !== "script" || p.status !== "pronta") return void sock.destroy();
    const up = net.connect({ host: p.alvo.host, port: p.alvo.porta }, () => {
      const h = cabecalhosAlvo(req, p);
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
      if (head?.length) up.write(head);
      sock.pipe(up).pipe(sock);
    });
    up.on("error", () => sock.destroy());
    sock.on("error", () => up.destroy());
  });
  return s;
}

async function garantirServidor() {
  if (servidor) return portaAtual;
  if (iniciando) return iniciando;
  iniciando = (async () => {
    const s = criarServidor();
    const pedida = Number(process.env.LERA_PREVIA_PORTA ?? load().previa?.porta ?? 4750);
    portaAtual = await new Promise((resolve, reject) => {
      const tentar = (p, resta) => {
        s.once("error", (e) => (e.code === "EADDRINUSE" && resta > 0 && p !== 0 ? tentar(p + 1, resta - 1) : reject(e)));
        s.listen(p, "127.0.0.1", () => resolve(s.address().port));
      };
      tentar(pedida, 10);
    });
    servidor = s;
    setInterval(() => {
      for (const p of previas.values()) if (p.modo === "script" && p.status !== "parada" && Date.now() - p.ultimoAcesso > OCIOSA_MS) parar(p);
    }, 60000).unref();
    return portaAtual;
  })();
  try {
    return await iniciando;
  } finally {
    iniciando = null;
  }
}
export const _paraTestes = {
  fechar: () => {
    for (const p of previas.values()) parar(p);
    servidor?.closeAllConnections?.();
    servidor?.close();
    servidor = null;
  },
};

// ---------- API ----------

export function publica(p) {
  if (!p) return null;
  const { processo: _p, ...resto } = p;
  return { ...resto, log: p.log.slice(-3000), caminho: `/?__previa=${p.id}`, porta: portaAtual, urlRemota: load().previa?.urlRemota ?? null };
}

/** Abre (ou reaproveita) a prévia de uma pasta. */
export async function abrir({ dir, rotulo, origem = {}, cfg = {} }) {
  if (!dir || !fs.existsSync(dir)) throw invalidArgument("A pasta desta prévia não existe mais.");
  const det = detectar(dir, cfg);
  await garantirServidor();
  const chave = `${path.resolve(dir)}|${det.modo}|${det.script ?? det.raizRel}`;
  const existente = [...previas.values()].find((p) => p.chave === chave && p.status !== "parada" && p.status !== "erro");
  if (existente) {
    existente.ultimoAcesso = Date.now();
    return publica(existente);
  }
  const p = {
    id: crypto.randomBytes(5).toString("hex"),
    chave,
    rotulo: String(rotulo ?? path.basename(dir)).slice(0, 120),
    dir: path.resolve(dir),
    base: det.base,
    modo: det.modo,
    script: det.script ?? null,
    raiz: det.raiz ?? null,
    raizRel: det.raizRel ?? null,
    scripts: det.scripts,
    origem,
    status: det.modo === "estatico" ? "pronta" : "iniciando",
    etapa: null,
    erro: null,
    log: "",
    criada: new Date().toISOString(),
    ultimoAcesso: Date.now(),
  };
  previas.set(p.id, p);
  if (p.modo === "script") iniciarScript(p).catch((e) => { p.status = "erro"; p.erro = e.message; });
  return publica(p);
}

/** Para as prévias de uma pasta (antes de apagar uma cópia de trabalho). */
export function pararPasta(dir) {
  const alvo = path.resolve(dir);
  for (const p of previas.values()) if (p.dir === alvo && p.status !== "parada") parar(p);
}

export const commands = {
  previa_status({ id }) {
    const p = previas.get(id);
    if (!p) throw invalidArgument("Prévia não encontrada.");
    return publica(p);
  },
  previa_listar() {
    return [...previas.values()].filter((p) => p.status !== "parada").map(publica);
  },
  previa_parar({ id }) {
    const p = previas.get(id);
    if (!p) throw invalidArgument("Prévia não encontrada.");
    parar(p);
    return publica(p);
  },
};
