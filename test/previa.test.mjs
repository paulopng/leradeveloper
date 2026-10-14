// Prévias: estática (arquivos) e por script do package.json (repasse, inclusive WebSocket),
// com o cookie de escolha e as mesmas regras de acesso remoto do servidor principal.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lera-previa-"));
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "lera-previa-home-"));
process.env.LERADEVELOPER_DATA_DIR = dataDir;
process.env.LERADEVELOPER_HOME = homeDir;
process.env.LERA_PREVIA_PORTA = "0";
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "Teste";
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "teste@example.com";

const { createServer } = await import("../server/index.js");
const { _paraTestes } = await import("../server/lib/previa.js");
let server, base, token;
before(async () => {
  ({ server, token } = createServer({ staticDir: path.join(dataDir, "ui") }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
  _paraTestes.fechar();
});

async function call(cmd, args = {}) {
  const r = await fetch(`${base}/api/invoke/${cmd}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Leradeveloper-Token": token }, body: JSON.stringify(args) });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(body?.message ?? `HTTP ${r.status}`);
  return body;
}
async function entrar(p) {
  const r = await fetch(`http://127.0.0.1:${p.porta}${p.caminho}`, { redirect: "manual" });
  assert.equal(r.status, 303);
  const cookie = r.headers.get("set-cookie").split(";")[0];
  assert.match(cookie, /^lera_previa=/);
  return cookie;
}

test("prévia estática: index.html, caminhos absolutos, SPA e nada fora da pasta", async () => {
  const pasta = fs.mkdtempSync(path.join(homeDir, "site-"));
  fs.writeFileSync(path.join(pasta, "index.html"), '<script src="/app.js"></script><h1>Lista</h1>');
  fs.writeFileSync(path.join(pasta, "app.js"), "console.log(1)");
  fs.writeFileSync(path.join(homeDir, "segredo.txt"), "não pode");
  const { id: projetoId } = await call("projeto_adicionar", { pasta });
  const cfg = await call("projeto_previa_config", { projetoId });
  assert.equal(cfg.detectado.modo, "estatico");
  const p = await call("previa_abrir", { projetoId });
  assert.equal(p.status, "pronta");
  assert.ok(p.porta > 0);
  const de_novo = await call("previa_abrir", { projetoId });
  assert.equal(de_novo.id, p.id, "reaproveita a prévia aberta");
  const cookie = await entrar(p);
  const html = await (await fetch(`http://127.0.0.1:${p.porta}/`, { headers: { cookie } })).text();
  assert.match(html, /<h1>Lista<\/h1>/);
  const js = await fetch(`http://127.0.0.1:${p.porta}/app.js`, { headers: { cookie } });
  assert.match(js.headers.get("content-type"), /javascript/);
  const spa = await (await fetch(`http://127.0.0.1:${p.porta}/tarefas/1`, { headers: { cookie } })).text();
  assert.match(spa, /Lista/, "rota sem extensão cai no index.html");
  const fora = await fetch(`http://127.0.0.1:${p.porta}/..%2fsegredo.txt`, { headers: { cookie } });
  assert.ok([403, 404].includes(fora.status));
  assert.doesNotMatch(await fora.text(), /não pode/);
  const sem = await (await fetch(`http://127.0.0.1:${p.porta}/`)).text();
  assert.match(sem, /Prévias do leradev/, "sem cookie mostra a lista");
  // pedido remoto sem acesso remoto ligado
  const remoto = await new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: p.porta, path: "/", headers: { cookie, host: "pc.tail.ts.net" } }, (r) => { r.resume(); resolve(r.statusCode); }).on("error", reject);
  });
  assert.equal(remoto, 403);
  await call("previa_parar", { id: p.id });
});

test("prévia por script: roda o dev do package.json e repassa HTTP e WebSocket", async () => {
  const pasta = fs.mkdtempSync(path.join(homeDir, "app-"));
  fs.mkdirSync(path.join(pasta, "node_modules"));
  fs.writeFileSync(path.join(pasta, "package.json"), JSON.stringify({ name: "app", scripts: { dev: "node server.cjs", build: "echo build" } }));
  fs.writeFileSync(path.join(pasta, "server.cjs"), `
const http = require("http");
const s = http.createServer((req, res) => {
  if (req.url === "/ir") { res.writeHead(302, { Location: "http://localhost:" + process.env.PORT + "/chegou" }); return res.end(); }
  res.end("ola dev " + req.url + " host=" + req.headers.host + " cookie=" + (req.headers.cookie || ""));
});
s.on("upgrade", (req, sock) => {
  sock.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n\\r\\n");
  sock.on("data", (d) => sock.write("eco:" + d));
});
s.listen(Number(process.env.PORT), "127.0.0.1");
`);
  const { id: projetoId } = await call("projeto_adicionar", { pasta });
  let p = await call("previa_abrir", { projetoId });
  assert.equal(p.modo, "script");
  assert.equal(p.script, "dev");
  for (let i = 0; i < 100 && p.status !== "pronta" && p.status !== "erro"; i++) {
    await new Promise((r) => setTimeout(r, 150));
    p = await call("previa_status", { id: p.id });
  }
  assert.equal(p.status, "pronta", `${p.erro} ${p.log}`);
  const cookie = await entrar(p);
  const txt = await (await fetch(`http://127.0.0.1:${p.porta}/x?y=1`, { headers: { cookie: `${cookie}; tema=escuro; lera_sessao=segredo` } })).text();
  assert.match(txt, /^ola dev \/x\?y=1 host=localhost:\d+/);
  assert.match(txt, /cookie=tema=escuro$/, "o app recebe os cookies dele, não os do leradev");
  const ir = await fetch(`http://127.0.0.1:${p.porta}/ir`, { headers: { cookie }, redirect: "manual" });
  assert.equal(ir.headers.get("location"), "/chegou", "redirecionamento absoluto vira relativo");

  const eco = await new Promise((resolve, reject) => {
    const s = net.connect(p.porta, "127.0.0.1", () => {
      s.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${p.porta}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nCookie: ${cookie}\r\n\r\n`);
    });
    let buf = "";
    s.on("data", (d) => {
      buf += d;
      if (buf.includes("101") && !buf.includes("eco:")) s.write("oi");
      if (buf.includes("eco:oi")) { s.destroy(); resolve(buf); }
    });
    s.on("error", reject);
    setTimeout(() => reject(new Error(`sem eco: ${buf}`)), 5000);
  });
  assert.match(eco, /101 Switching Protocols/);

  const cfg = await call("projeto_previa_definir", { projetoId, modo: "script", script: "build" });
  assert.equal(cfg.detectado.script, "build");
  await assert.rejects(call("projeto_previa_definir", { projetoId, script: "rm -rf /" }), /inválido/);
  await assert.rejects(call("projeto_previa_definir", { projetoId, pasta: "../fora" }), /relativa/);
  await call("previa_parar", { id: p.id });
});
