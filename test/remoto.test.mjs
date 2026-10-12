// Acesso remoto (senha + sessão + Host permitido) e mapas 3D.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lera-remoto-"));
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "lera-home-"));
process.env.LERADEVELOPER_DATA_DIR = dataDir;
process.env.LERADEVELOPER_HOME = homeDir;

const { createServer } = await import("../server/index.js");
const auth = await import("../server/lib/auth.js");
const config = await import("../server/lib/lera-config.js");

let server, port, token;
const staticDir = path.join(dataDir, "ui");

before(async () => {
  fs.mkdirSync(staticDir, { recursive: true });
  fs.writeFileSync(path.join(staticDir, "index.html"), "<!doctype html><html><head></head><body>ui</body></html>");
  ({ server, token } = createServer({ staticDir }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});
after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

/** Pedido cru (fetch não deixa trocar o Host). */
function req(pathname, { method = "GET", host = `127.0.0.1:${port}`, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: pathname, method, headers: { Host: host, ...headers } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}
const PHONE = "meu-pc.tail1234.ts.net";
const api = (cmd, args = {}, opts = {}) =>
  req(`/api/invoke/${cmd}`, {
    method: "POST",
    ...opts,
    headers: { "Content-Type": "application/json", "X-Leradeveloper-Token": token, ...(opts.headers ?? {}) },
    body: JSON.stringify(args),
  });

test("acesso local continua direto, sem senha", async () => {
  const r = await api("app_version");
  assert.equal(r.status, 200);
});

test("remoto desligado: 403 com instruções", async () => {
  const r = await req("/", { host: PHONE });
  assert.equal(r.status, 403);
  assert.match(r.body, /leradeveloper --senha/);
  // Proxy na frente com Host local também conta como remoto.
  const viaProxy = await api("app_version", {}, { headers: { "X-Forwarded-For": "100.64.0.9" } });
  assert.equal(viaProxy.status, 403);
});

test("senha curta é recusada", () => {
  assert.throws(() => auth.setPassword("curta"), /8 caracteres/);
});

test("login pelo celular: senha, cookie, API e saída", async () => {
  auth.setPassword("senha-de-teste-123");

  // Host fora da lista: barrado mesmo com acesso ligado.
  assert.equal((await req("/", { host: "evil.example" })).status, 403);

  // Sem sessão: páginas vão para /entrar, API devolve 401.
  const page = await req("/", { host: PHONE });
  assert.equal(page.status, 303);
  assert.equal(page.headers.location, "/entrar");
  const noAuth = await api("app_version", {}, { host: PHONE });
  assert.equal(noAuth.status, 401);
  assert.equal(JSON.parse(noAuth.body).code, "auth_required");

  const form = await req("/entrar", { host: PHONE });
  assert.equal(form.status, 200);
  assert.match(form.body, /name="senha"/);

  const wrong = await req("/entrar", { method: "POST", host: PHONE, headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "senha=errada" });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers["set-cookie"], undefined);

  const ok = await req("/entrar", { method: "POST", host: PHONE, headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "senha=senha-de-teste-123" });
  assert.equal(ok.status, 303);
  const cookie = ok.headers["set-cookie"][0];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  const jar = cookie.split(";")[0];

  // O token de sessão não fica salvo em texto puro.
  assert.ok(!fs.readFileSync(path.join(dataDir, "lera.json"), "utf8").includes(jar.split("=")[1]));

  const home = await req("/", { host: PHONE, headers: { Cookie: jar } });
  assert.equal(home.status, 200);
  assert.match(home.body, /leradeveloper-token/);
  const withAuth = await api("app_version", {}, { host: PHONE, headers: { Cookie: jar } });
  assert.equal(withAuth.status, 200);

  // Trocar a senha derruba a sessão.
  auth.setPassword("outra-senha-456");
  assert.equal((await req("/", { host: PHONE, headers: { Cookie: jar } })).status, 303);

  // Desligar o remoto bloqueia tudo de novo.
  auth.setRemote(false);
  assert.equal((await req("/entrar", { host: PHONE })).status, 403);
});

test("config feita em outro processo vale sem reiniciar o servidor", async () => {
  const file = path.join(dataDir, "lera.json");
  const cur = JSON.parse(fs.readFileSync(file, "utf8"));
  cur.remoto.ativo = true;
  await new Promise((r) => setTimeout(r, 20)); // garante mtime diferente
  fs.writeFileSync(file, JSON.stringify(cur));
  assert.equal(config.load().remoto.ativo, true);
  assert.equal((await req("/entrar", { host: PHONE })).status, 200);
});

test("limite de tentativas de senha", async () => {
  auth.setPassword("senha-de-teste-123");
  const ip = { "X-Forwarded-For": "100.64.0.77", "Content-Type": "application/x-www-form-urlencoded" };
  for (let i = 0; i < 5; i++) {
    const r = await req("/entrar", { method: "POST", host: PHONE, headers: ip, body: "senha=nao" });
    assert.equal(r.status, 401);
  }
  const blocked = await req("/entrar", { method: "POST", host: PHONE, headers: ip, body: "senha=senha-de-teste-123" });
  assert.equal(blocked.status, 429);
  auth.setRemote(false);
});

test("/mapas serve o visualizador com o token", async () => {
  const r = await req("/mapas");
  assert.equal(r.status, 200);
  assert.match(r.headers["content-type"], /text\/html/);
  assert.ok(r.body.includes(`content="${token}"`));
  assert.match(r.body, /<canvas/);
});

test("mapas: exemplos até existir o primeiro mapa próprio", async () => {
  const lista = JSON.parse((await api("mapas_listar")).body);
  assert.ok(lista.mapas.length >= 2);
  assert.ok(lista.mapas.every((m) => m.exemplo && !m.erro));
  const um = JSON.parse((await api("mapa_obter", { id: lista.mapas[0].id })).body);
  assert.ok(um.camadas.length >= 2 && um.nos.length > 0);
  // Nenhum dado corporativo nos exemplos.
  const tudo = fs.readdirSync(path.join("server", "data", "mapas-exemplo")).map((f) => fs.readFileSync(path.join("server", "data", "mapas-exemplo", f), "utf8")).join("\n");
  assert.doesNotMatch(tudo, /renault|geely/i);
});

test("mapas: arquivos do usuário, validação e caminhos inválidos", async () => {
  const projetos = path.join(homeDir, "lera-projetos");
  const def = JSON.parse((await api("mapas_config_definir", { projetosDir: projetos })).body);
  assert.equal(def.pastaMapas, path.join(projetos, "mapas"));
  fs.mkdirSync(def.pastaMapas, { recursive: true });
  fs.writeFileSync(
    path.join(def.pastaMapas, "meu.json"),
    JSON.stringify({
      titulo: "Meu",
      camadas: [{ id: "a", rotulo: "A" }, { id: "b", rotulo: "B" }],
      nos: [
        { id: "x", camada: "a", rotulo: "X", tipo: "inventado", peso: 9 },
        { id: "y", camada: "b", rotulo: "Y", status: "ok" },
      ],
      ligacoes: [{ de: "x", para: "y", relacao: "usa" }],
    }),
  );
  fs.writeFileSync(path.join(def.pastaMapas, "quebrado.json"), JSON.stringify({ camadas: [{ id: "a", rotulo: "A" }], nos: [{ id: "x", camada: "zz", rotulo: "X" }] }));

  const lista = JSON.parse((await api("mapas_listar")).body);
  assert.deepEqual(lista.mapas.map((m) => m.id).sort(), ["meu", "quebrado"]); // exemplos somem
  assert.match(lista.mapas.find((m) => m.id === "quebrado").erro, /camada "zz" não existe/);

  const meu = JSON.parse((await api("mapa_obter", { id: "meu" })).body);
  assert.equal(meu.nos[0].tipo, "ideia");
  assert.equal(meu.nos[0].peso, 3);
  assert.equal(meu.avisos.length, 1);

  for (const id of ["../segredo", "A", ""]) {
    const r = await api("mapa_obter", { id });
    assert.equal(r.status, 400);
  }
  assert.equal((await api("mapas_config_definir", { projetosDir: "relativo" })).status, 400);
});

test("escritório: atividades viram mesas, decisões aparecem com o agente", async () => {
  const reg = (a) => api("escritorio_registrar", a);
  assert.equal((await reg({ agente: "Coordenador Jev", tarefa: "Planejar" })).status, 200);
  await reg({ agente: "Coordenador Jev", tarefa: "Planejar", progresso: 55, mensagem: "metade" });
  await reg({ agente: "Code Reviewer", tarefa: "Revisar", progresso: 130 });
  await reg({ agente: "Code Reviewer", tarefa: "Revisar", status: "concluido" });
  await reg({ agente: "Code Reviewer", tarefa: "Outra coisa", progresso: 5 });
  assert.equal((await reg({ agente: "", tarefa: "x" })).status, 400);
  assert.equal((await reg({ agente: "A", tarefa: "x", status: "festa" })).status, 400);

  const { jev } = await import("../server/lib/jev.js").then((m) => ({ jev: m }));
  jev.record({ tipo: "decidir", pergunta: "Seguir?", probabilidade_sim: 0.5, zona: "duvida", agente: "Coordenador Jev", custo_usd: 0.00003 });

  const r = await api("escritorio_estado");
  assert.equal(r.status, 200);
  const s = JSON.parse(r.body);
  const coord = s.mesas.find((m) => m.agente === "Coordenador Jev");
  assert.equal(coord.progresso, 55);
  assert.equal(coord.mensagem, "metade");
  assert.equal(coord.historico.length, 2);
  const rev = s.mesas.find((m) => m.agente === "Code Reviewer");
  assert.equal(rev.tarefa, "Outra coisa");
  assert.equal(rev.progresso, 5);
  assert.equal(rev.concluidas, 1);
  assert.equal(s.decisoes[0].agente, "Coordenador Jev");
  assert.equal(s.resumo.duvida, 1);
  assert.equal(typeof s.jev.chaveDefinida, "boolean");

  const page = await req("/escritorio");
  assert.equal(page.status, 200);
  assert.ok(page.body.includes(`content="${token}"`));
});

test("escritório: mesa parada e configuração do Jev pela tela", async () => {
  const { mesas } = await import("../server/lib/atividades.js");
  const velho = new Date(Date.now() - 45 * 60e3).toISOString();
  const antigo = new Date(Date.now() - 4 * 864e5).toISOString();
  const m = mesas(Date.now(), [
    { quando: velho, agente: "A", tarefa: "t", status: "trabalhando", progresso: 10 },
    { quando: antigo, agente: "B", tarefa: "t", status: "trabalhando", progresso: 10 },
  ]);
  assert.deepEqual(m.map((x) => [x.agente, x.status]), [["A", "parado"]]);

  const ok = await api("jev_config_definir", { limiarBaixo: 0.25, limiarAlto: 0.75 });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).limiarAlto, 0.75);
  const bad = await api("jev_config_definir", { limiarBaixo: 0.9 });
  assert.equal(bad.status, 400);
  assert.match(JSON.parse(bad.body).message, /zona de dúvida/);
});
