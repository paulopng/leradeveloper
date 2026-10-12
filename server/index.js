// leradeveloper local server: serves the built Svelte UI and exposes every
// backend command at POST /api/invoke/<command> (the browser replacement for
// Tauri's IPC). Binds to 127.0.0.1 only and requires a per-launch token, so
// other sites open in the browser can't drive it.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SERVER_DIR } from "./lib/paths.js";
import { toPayload } from "./lib/errors.js";
import { commands as corpus } from "./lib/corpus.js";
import { commands as install } from "./lib/install.js";
import { commands as settings } from "./lib/settings.js";
import { commands as github } from "./lib/github.js";
import { commands as system } from "./lib/system.js";
import { commands as mapas } from "./lib/mapas.js";
import * as auth from "./lib/auth.js";
import { load as loadLera } from "./lib/lera-config.js";

const COMMANDS = { ...corpus, ...install, ...settings, ...github, ...system, ...mapas };
const WEB_DIR = path.join(SERVER_DIR, "web");
export const commandNames = Object.keys(COMMANDS);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

export function createServer({ staticDir = path.join(SERVER_DIR, "..", "build"), token = crypto.randomBytes(24).toString("hex") } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");

    // Local requests (loopback Host, no proxy headers) go straight through.
    // Remote ones (phone via Tailscale/tunnel) need remote access switched on, an
    // allowed Host (blocks DNS rebinding) and a password session.
    if (auth.isRemote(req)) {
      const html = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" };
      if (!loadLera().remoto.ativo || !loadLera().remoto.senha) return void res.writeHead(403, html).end(auth.remoteOffPage());
      if (!auth.hostAllowed(auth.hostOf(req))) return void res.writeHead(403).end("forbidden host");
      if (url.pathname === "/entrar") {
        if (req.method === "GET") return void res.writeHead(200, html).end(auth.loginPage());
        if (req.method !== "POST") return void res.writeHead(405).end();
        const who = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "?").split(",")[0].trim();
        if (auth.tooManyAttempts(who)) return void res.writeHead(429, html).end(auth.loginPage("Muitas tentativas. Espere 15 minutos."));
        let body = "";
        for await (const chunk of req) { body += chunk; if (body.length > 4096) break; }
        const senha = new URLSearchParams(body).get("senha") ?? "";
        if (!auth.checkPassword(senha)) {
          auth.noteFailure(who);
          return void res.writeHead(401, html).end(auth.loginPage("Senha incorreta."));
        }
        auth.clearAttempts(who);
        const { token: sess, maxAge } = auth.newSession();
        return void res.writeHead(303, { Location: "/", "Set-Cookie": auth.sessionCookie(sess, maxAge) }).end();
      }
      if (url.pathname === "/sair") {
        auth.dropSession(req);
        return void res.writeHead(303, { Location: "/entrar", "Set-Cookie": auth.clearCookie() }).end();
      }
      if (!auth.hasSession(req)) {
        if (url.pathname.startsWith("/api/")) return void res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ code: "auth_required", message: "Entre com a senha." }));
        return void res.writeHead(303, { Location: "/entrar" }).end();
      }
    }

    if (url.pathname.startsWith("/api/invoke/")) {
      if (req.method !== "POST") return void res.writeHead(405).end();
      if (req.headers["x-leradeveloper-token"] !== token) return void res.writeHead(401).end("bad token");
      const name = decodeURIComponent(url.pathname.slice("/api/invoke/".length));
      const fn = Object.prototype.hasOwnProperty.call(COMMANDS, name) ? COMMANDS[name] : null;
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 8 * 1024 * 1024) return void res.writeHead(413).end();
      }
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      if (!fn) {
        res.writeHead(404).end(JSON.stringify({ code: "invalid_argument", message: `unknown command ${name}` }));
        return;
      }
      try {
        const args = body ? JSON.parse(body) : {};
        const result = await fn(args ?? {});
        res.writeHead(200).end(JSON.stringify(result === undefined ? null : result));
      } catch (e) {
        const payload = toPayload(e);
        if (payload.code === "internal") console.error(`[${name}]`, e);
        res.writeHead(400).end(JSON.stringify(payload));
      }
      return;
    }

    // Static SPA. The page gets the token injected so only it can call the API.
    if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405).end();
    let rel = decodeURIComponent(url.pathname);
    let file = path.join(staticDir, rel);
    if (rel === "/mapas" || rel === "/mapas/") file = path.join(WEB_DIR, "mapas.html");
    else
    {
      const within = path.relative(staticDir, file);
      if (within.startsWith("..") || path.isAbsolute(within)) return void res.writeHead(403).end();
    }
    if (!file.startsWith(WEB_DIR) && (!fs.existsSync(file) || fs.statSync(file).isDirectory())) file = path.join(staticDir, "index.html");
    if (!fs.existsSync(file)) {
      res.writeHead(500, { "Content-Type": "text/plain" }).end("UI not built. Run `npm run build` first.");
      return;
    }
    const ext = path.extname(file);
    const headers = {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    };
    if (ext === ".html") {
      const html = fs
        .readFileSync(file, "utf8")
        .replace("<head>", `<head><meta name="leradeveloper-token" content="${token}">`);
      headers["Cache-Control"] = "no-store";
      res.writeHead(200, headers).end(html);
    } else {
      if (rel.includes("/_app/immutable/")) headers["Cache-Control"] = "public, max-age=31536000, immutable";
      res.writeHead(200, headers);
      fs.createReadStream(file).pipe(res);
    }
  });
  return { server, token };
}
