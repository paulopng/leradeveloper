// Mapas de arquitetura por projeto: configuração, geração (só leitura), validação do Jev,
// rodada de correção e o mapa aparecendo no Mapas 3D.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lera-mapa-"));
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "lera-mapa-home-"));
process.env.LERADEVELOPER_DATA_DIR = dataDir;
process.env.LERADEVELOPER_HOME = homeDir;
const fake = (n) => JSON.stringify([process.execPath, path.join(root, "test", "fakes", `fake-${n}.mjs`)]);
for (const [k, n] of [["CLAUDE", "claude"], ["CODEX", "codex"], ["CURSOR", "cursor"], ["ANTIGRAVITY", "antigravity"]]) process.env[`LERA_CMD_${k}`] = fake(n);
process.env.JEV_BACKOFF_MS = "5";
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "Teste";
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "teste@example.com";
delete process.env.DEFAPI_API_KEY;

// Jev falso: o mapa só passa quando já tem o "Botão salvar" (vem na rodada de correção).
let chamadas = [];
const jev = http.createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const b = JSON.parse(body);
  chamadas.push(b);
  const bom = JSON.stringify(b.state).includes("Botão salvar");
  const answers = {};
  for (const [k, q] of Object.entries(b.questions)) {
    if (q.type === "score") answers[k] = { type: "score", probabilities: bom ? { 0: 0, 1: 0.05, 2: 0.15, 3: 0.8 } : { 0: 0.1, 1: 0.7, 2: 0.2, 3: 0 } };
    else if (q.type === "choice") answers[k] = { type: "choice", probabilities: Object.fromEntries(Object.keys(q.criteria).map((o, i) => [o, i === 0 ? 0.9 : 0.1])) };
    else if (k === "faltando") answers[k] = { type: "noul", noul: bom ? 0.05 : 0.9 };
    else answers[k] = { type: "noul", noul: bom ? 0.95 : 0.5 };
  }
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ model: "jev-falso", answers, usage: { cost: 0.00002 } }));
});

const { createServer } = await import("../server/index.js");
let server, base, token, projetoId, pasta;
before(async () => {
  await new Promise((r) => jev.listen(0, "127.0.0.1", r));
  process.env.TYPESAFE_API_KEY = "x";
  process.env.JEV_ENDPOINT = `http://127.0.0.1:${jev.address().port}/decisions`;
  ({ server, token } = createServer({ staticDir: path.join(dataDir, "ui") }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  pasta = fs.mkdtempSync(path.join(homeDir, "app-"));
  fs.mkdirSync(path.join(pasta, "src", "routes"), { recursive: true });
  fs.writeFileSync(path.join(pasta, "src", "routes", "+page.svelte"), "<button>Salvar</button>");
  fs.writeFileSync(path.join(pasta, "schema.sql"), "create table tarefas (id int);");
  projetoId = (await call("projeto_adicionar", { pasta })).id;
});
after(() => {
  server.close();
  jev.close();
});

async function call(cmd, args = {}) {
  const r = await fetch(`${base}/api/invoke/${cmd}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Leradeveloper-Token": token }, body: JSON.stringify(args) });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(body?.message ?? `HTTP ${r.status}`);
  return body;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function esperar(pred, ms = 25000) {
  const limite = Date.now() + ms;
  for (;;) {
    const s = await call("projeto_mapa_status", { projetoId });
    if (pred(s)) return s;
    if (Date.now() > limite) throw new Error(`tempo esgotado: ${JSON.stringify(s.geracao)}`);
    await sleep(120);
  }
}
const terminou = (s) => ["pronto", "erro", "parado"].includes(s.geracao?.status);

test("configuração do mapa: camadas padrão, agente padrão e personalização", async () => {
  const c = await call("projeto_mapa_config_obter", { projetoId });
  assert.deepEqual(c.camadas.map((x) => x.id), ["tela", "api", "dados", "mcp", "ia"]);
  assert.equal(c.ferramenta, "claude");
  assert.equal(c.agente, "engineering-software-architect", "sem o gerador de mapas no catálogo, usa o arquiteto");
  assert.ok(c.extras.some((x) => x.id === "infra"));
  assert.equal(c.mapa, null);

  const d = await call("projeto_mapa_config_definir", { projetoId, camadas: [...c.camadas, { rotulo: "Testes e qualidade" }], ferramenta: "claude", agente: "nenhum" });
  assert.equal(d.camadas.at(-1).id, "testes-e-qualidade");
  assert.equal(d.agente, "nenhum");
  await assert.rejects(call("projeto_mapa_config_definir", { projetoId, camadas: [{ id: "a", rotulo: "A" }, { id: "a", rotulo: "B" }] }), /repetida/);
  await assert.rejects(call("projeto_mapa_config_definir", { projetoId, ferramenta: "vim" }), /desconhecida/);
  await assert.rejects(call("projeto_mapa_config_definir", { projetoId, agente: "nao-existe" }), /não encontrado/);
  const r = await call("projeto_mapa_config_definir", { projetoId, restaurar: true });
  assert.equal(r.personalizado, false);
});

test("gera só lendo, o Jev pede correção, e o mapa corrigido aparece no Mapas 3D", async () => {
  chamadas = [];
  const g = await call("projeto_mapa_gerar", { projetoId, instrucoes: "Destaque a fila de tarefas" });
  assert.equal(g.status, "gerando");
  await assert.rejects(call("projeto_mapa_gerar", { projetoId }), /já está sendo gerado/);
  const fim = await esperar(terminou);
  assert.equal(fim.geracao.status, "pronto", fim.geracao.erro);
  assert.equal(fim.geracao.rodada, 2, "teve uma rodada de correção");
  assert.equal(fim.geracao.validacao.aprovado, true);
  assert.equal(fim.geracao.validacao.completude.nivel, 3);
  assert.equal(chamadas.length, 2, "o Jev validou as duas versões");
  const ctx = chamadas[0].state;
  assert.match(ctx.project_files.list, /schema\.sql/, "o Jev viu os arquivos do projeto");
  assert.deepEqual(Object.keys(chamadas[0].questions).sort(), ["camada_api", "camada_dados", "camada_ia", "camada_mcp", "camada_tela", "completude", "faltando", "ligacoes"].sort());

  // a tarefa foi só leitura (Claude em dontAsk), oculta, e recebeu a correção na mesma conversa
  const t = await call("tarefa_eventos", { id: fim.geracao.tarefaId });
  assert.equal(t.tarefa.oculta, true);
  const voce = t.eventos.filter((e) => e.t === "voce");
  assert.equal(voce.length, 2);
  assert.match(voce[0].texto, /do NOT modify/);
  assert.match(voce[0].texto, /Destaque a fila de tarefas/);
  assert.match(voce[1].texto, /missing from the map/);
  assert.ok(!fs.readdirSync(pasta).some((f) => f.startsWith("feito-")), "não escreveu nada no projeto");
  const est = await call("central_estado");
  assert.ok(!est.tarefas.some((x) => x.id === fim.geracao.tarefaId), "não polui a lista de tarefas");

  // salvo no projeto e listado no Mapas 3D
  const arq = JSON.parse(fs.readFileSync(path.join(pasta, ".lera", "mapa.json"), "utf8"));
  assert.equal(arq.validacao.aprovado, true);
  assert.equal(arq.subtitulo, "corrigido");
  assert.ok(!arq.ligacoes.some((l) => l.para === "nao-existe"), "ligação quebrada foi tirada");
  const lista = await call("mapas_listar");
  const item = lista.mapas.find((m) => m.id === `projeto-${projetoId}`);
  assert.ok(item, "aparece na lista");
  assert.equal(item.validado, true);
  assert.ok(!lista.mapas.some((m) => m.exemplo), "com mapa de projeto, os exemplos somem");
  const m = await call("mapa_obter", { id: `projeto-${projetoId}` });
  assert.deepEqual(m.camadas.map((c) => c.rotulo), ["Telas", "APIs", "Banco", "MCP e automações", "IA e RAG"], "rótulos das camadas configuradas");
  const api = m.nos.find((n) => n.camada === "api");
  assert.equal(api.tipo, "api");
  assert.equal(api.atributos.modo, "assincrono");
  assert.equal(m.nos.find((n) => n.id === "extra").tipo, "botao");
});

test("resposta sem JSON: corrige uma vez; Jev fora do ar: salva sem validação", async () => {
  process.env.FAKE_MAPA_SEM_JSON = "1";
  delete process.env.TYPESAFE_API_KEY;
  await call("projeto_mapa_gerar", { projetoId });
  const fim = await esperar(terminou);
  delete process.env.FAKE_MAPA_SEM_JSON;
  process.env.TYPESAFE_API_KEY = "x";
  assert.equal(fim.geracao.status, "pronto", fim.geracao.erro);
  assert.equal(fim.geracao.rodada, 2);
  assert.equal(fim.geracao.validacao.semJev, true);
  assert.match(fim.geracao.validacao.erro, /Jev indisponível/);
});
