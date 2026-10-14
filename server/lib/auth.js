// Acesso remoto (celular via Tailscale ou outro túnel HTTPS).
//
// Regras:
//  - Pedido local: Host 127.0.0.1/localhost/[::1] e sem cabeçalhos de proxy. Entra direto.
//  - Pedido remoto: qualquer outro Host, ou que chegou por proxy (X-Forwarded-*,
//    Tailscale-User-*). Só passa se o acesso remoto estiver ativo, o Host estiver na
//    lista permitida (defesa contra DNS rebinding) e houver sessão válida (senha).
import crypto from "node:crypto";
import { load, update } from "./lera-config.js";

const COOKIE = "lera_sessao";
const SESSION_DAYS = 30;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function hostOf(req) {
  return (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
}

export function isRemote(req) {
  const proxied = ["x-forwarded-for", "x-forwarded-host", "tailscale-user-login", "cf-connecting-ip"].some((h) => req.headers[h]);
  return proxied || !LOCAL_HOSTS.has(hostOf(req));
}

export function hostAllowed(host) {
  const list = load().remoto.hostsPermitidos ?? [];
  return list.some((p) => (p.startsWith(".") ? host.endsWith(p) : host === p.toLowerCase()));
}

// ---------- senha ----------

export function hashPassword(pw, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(pw, salt, 64).toString("hex");
  return { salt, hash };
}

export function checkPassword(pw) {
  const s = load().remoto.senha;
  if (!s) return false;
  const { hash } = hashPassword(pw, s.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(s.hash, "hex"));
}

export function setPassword(pw) {
  if (typeof pw !== "string" || pw.length < 8) throw new Error("A senha precisa ter pelo menos 8 caracteres.");
  update((c) => {
    c.remoto.senha = hashPassword(pw);
    c.remoto.sessoes = []; // trocar a senha derruba as sessões abertas
    c.remoto.ativo = true;
  });
}

export function setRemote(ativo) {
  update((c) => {
    c.remoto.ativo = !!ativo;
    if (!ativo) c.remoto.sessoes = [];
  });
}

// ---------- sessões ----------

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

export function newSession() {
  const token = crypto.randomBytes(32).toString("base64url");
  const expira = Date.now() + SESSION_DAYS * 864e5;
  update((c) => {
    c.remoto.sessoes = (c.remoto.sessoes ?? []).filter((s) => s.expira > Date.now()).slice(-20);
    c.remoto.sessoes.push({ hash: sha(token), expira });
  });
  return { token, maxAge: SESSION_DAYS * 86400 };
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function hasSession(req) {
  const t = cookies(req)[COOKIE];
  if (!t) return false;
  const h = sha(t);
  return (load().remoto.sessoes ?? []).some((s) => s.hash === h && s.expira > Date.now());
}

export function dropSession(req) {
  const t = cookies(req)[COOKIE];
  if (!t) return;
  const h = sha(t);
  update((c) => {
    c.remoto.sessoes = (c.remoto.sessoes ?? []).filter((s) => s.hash !== h);
  });
}

export function sessionCookie(token, maxAge) {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

// ---------- limite de tentativas ----------

const attempts = new Map(); // chave -> [timestamps]
export function tooManyAttempts(key) {
  const now = Date.now();
  const list = (attempts.get(key) ?? []).filter((t) => now - t < 15 * 60e3);
  attempts.set(key, list);
  return list.length >= 5;
}
export function noteFailure(key) {
  const list = attempts.get(key) ?? [];
  list.push(Date.now());
  attempts.set(key, list);
}
export const clearAttempts = (key) => attempts.delete(key);

// ---------- página de login ----------

export function loginPage(message = "") {
  const msg = message ? `<p class="err" role="alert">${message.replace(/[<>&]/g, "")}</p>` : "";
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Entrar · leradev</title><meta name="color-scheme" content="dark">
<style>
:root{--bg:#070b18;--panel:#131b36;--line:#2a3561;--ink:#e7ebf7;--muted:#8f99bb;--accent:#9be7ff;--err:#ff5c7a}
*{box-sizing:border-box}html,body{height:100%}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 "Segoe UI",system-ui,sans-serif;display:grid;place-items:center;padding:16px}
form{width:100%;max-width:360px;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:24px;display:flex;flex-direction:column;gap:14px}
h1{margin:0;font-size:1.2rem;letter-spacing:.04em;text-transform:uppercase}p{margin:0;color:var(--muted);font-size:.9rem}
label{font-size:.8rem;color:var(--muted)}input{width:100%;padding:12px;border-radius:10px;border:1px solid var(--line);background:#0f1630;color:var(--ink);font-size:16px}
input:focus{outline:2px solid var(--accent);outline-offset:1px}button{padding:12px;border:0;border-radius:10px;background:var(--accent);color:#070b18;font-weight:700;font-size:1rem;cursor:pointer}
.err{color:var(--err)}
</style></head><body>
<form method="post" action="/entrar">
<h1>leradev</h1><p>Acesso remoto ao seu PC. Digite a senha definida com <code>leradev --senha</code>.</p>${msg}
<div><label for="senha">Senha</label><input id="senha" name="senha" type="password" autocomplete="current-password" required autofocus></div>
<button type="submit">Entrar</button>
</form></body></html>`;
}

export function remoteOffPage() {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Acesso remoto desligado</title></head>
<body style="background:#070b18;color:#e7ebf7;font:15px system-ui;padding:24px"><h1>Acesso remoto desligado</h1>
<p>No PC, rode <code>leradev --senha</code> para definir uma senha e ligar o acesso pelo celular.</p></body></html>`;
}
