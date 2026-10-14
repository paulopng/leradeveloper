// Equipe e conhecimento: agentes por função do leradev, RAG por agente e por função
// (entra no pedido da ferramenta e no contexto do Jev) e o mapa 3D "leradev · equipe".
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lera-equipe-"));
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "lera-equipe-home-"));
process.env.LERADEVELOPER_DATA_DIR = dataDir;
process.env.LERADEVELOPER_HOME = homeDir;
const fake = (n) => JSON.stringify([process.execPath, path.join(root, "test", "fakes", `fake-${n}.mjs`)]);
for (const [k, n] of [["CLAUDE", "claude"], ["CODEX", "codex"], ["CURSOR", "cursor"], ["ANTIGRAVITY", "antigravity"]]) process.env[`LERA_CMD_${k}`] = fake(n);
process.env.JEV_BACKOFF_MS = "5";
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "Teste";
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "teste@example.com";
delete process.env.DEFAPI_API_KEY;

let estados = [];
const jev = http.createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const b = JSON.parse(body);
  estados.push(b.state);
  const answers = {};
  for (const [k, q] of Object.entries(b.questions)) {
    if (q.type === "score") answers[k] = { type: "score", probabilities: { 0: 0, 1: 0, 2: 0.1, 3: 0.9 } };
    else if (q.type === "choice") answers[k] = { type: "choice", probabilities: Object.fromEntries(Object.keys(q.criteria).map((o, i) => [o, i === 0 ? 0.9 : 0.1 / (Object.keys(q.criteria).length - 1)])) };
    else answers[k] = { type: "noul", noul: k === "sobreposicao" ? 0.05 : 0.95 };
  }
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ model: "jev-falso", answers }));
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
  pasta = fs.mkdtempSync(path.join(homeDir, "loja-"));
  fs.mkdirSync(path.join(pasta, "docs"));
  fs.writeFileSync(path.join(pasta, "docs", "pagamentos.md"), "# Pagamentos\n\nO checkout usa a fila pedidos-pagos e o webhook /api/pix confirma o pagamento PIX.\n");
  fs.writeFileSync(path.join(pasta, "docs", "estilo.md"), "# Estilo\n\nBotões arredondados e tema escuro.\n");
  projetoId = (await call("projeto_adicionar", { pasta })).id;
});
after(() => {
  server.closeAllConnections();
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

test("agentes por função, conhecimento por agente e por função, e a busca", async () => {
  const cat = await call("corpus_list", {});
  const front = cat.find((a) => a.name === "Frontend Developer").slug;
  const back = cat.find((a) => a.name === "Backend Architect").slug;
  const r = await call("papel_agentes_definir", { papel: "assistente", agentes: [front] });
  assert.deepEqual(r.agentes.map((a) => a.slug), [front]);
  await assert.rejects(call("papel_agentes_definir", { papel: "jev", agentes: [front] }), /não usa agentes/);
  await assert.rejects(call("papel_agentes_definir", { papel: "chefe", agentes: [] }), /desconhecida/);

  await call("rag_fonte_adicionar", { dono: `agente:${front}`, tipo: "pasta", caminho: "docs", titulo: "Docs do projeto" });
  await call("rag_fonte_adicionar", { dono: "papel:assistente", tipo: "nota", texto: "Sempre incluir um teste manual no celular." });
  await call("rag_fonte_adicionar", { dono: "papel:jev", tipo: "nota", texto: "Regra da equipe: nada de segredo no código." });
  await assert.rejects(call("rag_fonte_adicionar", { dono: "qualquer", tipo: "nota", texto: "x" }), /inválido/);
  await assert.rejects(call("rag_fonte_adicionar", { dono: "papel:jev", tipo: "url", url: "file:///etc/passwd" }), /http/);

  const achados = await call("rag_testar", { dono: `agente:${front}`, consulta: "como funciona o pagamento pix no checkout?", projetoId });
  assert.match(achados[0].origem, /pagamentos\.md/);
  assert.match(achados[0].texto, /webhook \/api\/pix/);

  const est = await call("equipe_estado", { projetoId });
  const asst = est.papeis.find((p) => p.id === "assistente");
  assert.deepEqual(asst.agentes.map((a) => a.slug), [front]);
  assert.equal(asst.fontes.length, 1);
  const ag = est.agentes.find((a) => a.slug === front);
  assert.equal(ag.fontes[0].existe, true);
  assert.equal(ag.fontes[0].contagem, 2, "2 arquivos na pasta docs");
  assert.ok(ag.onde.some((o) => o.tipo === "papel"));
  void back;
});

test("o conhecimento entra no pedido do assistente e no contexto do Jev", async () => {
  estados = [];
  const s = await call("assistente_criar", { projetoId, ideia: "Melhorar o checkout com pagamento PIX" });
  let a;
  for (let i = 0; i < 200; i++) {
    a = await call("assistente_obter", { id: s.id });
    if (!["pensando", "validando"].includes(a.status)) break;
    await sleep(100);
  }
  assert.equal(a.status, "pronto", a.erro);
  const ev = await call("tarefa_eventos", { id: a.tarefaId });
  const pedido = ev.eventos.find((e) => e.t === "voce").texto;
  assert.doesNotMatch(pedido, /Conhecimento recuperado/, "o que a pessoa vê é o pedido sem o bloco; o bloco vai para a ferramenta");
  const rag = ev.eventos.find((e) => e.t === "rag");
  assert.ok(rag, "registrou o conhecimento usado");
  assert.ok(rag.itens.some((x) => /pagamentos\.md/.test(x.origem)), "o agente do assistente trouxe a doc de pagamentos");
  assert.ok(rag.itens.some((x) => x.dono === "papel:assistente"), "a nota da função sempre entra");
  assert.match(a.briefing.objetivo, /\[com-rag\]/, "o bloco de conhecimento chegou à ferramenta");
  const jevBrief = estados.find((s2) => s2?.brief);
  assert.match(jevBrief.team_knowledge, /nada de segredo/, "o Jev recebeu as regras da equipe");
});

test("mapa 3D da equipe: funções, agentes, conhecimento e links para editar", async () => {
  const lista = await call("mapas_listar");
  assert.ok(lista.mapas.some((m) => m.id === "leradev-equipe" && m.virtual));
  const m = await call("mapa_obter", { id: "leradev-equipe" });
  assert.deepEqual(m.camadas.map((c) => c.id), ["funcoes", "trabalho", "agentes", "conhecimento"]);
  const jevNo = m.nos.find((n) => n.rotulo === "Jev (validação)");
  assert.equal(jevNo.tipo, "decisao");
  assert.equal(jevNo.links[0].href, "/central#/k/papel:jev");
  const fonteJev = m.nos.find((n) => n.camada === "conhecimento" && /segredo/.test(n.descricao));
  assert.ok(m.ligacoes.some((l) => l.de === jevNo.id && l.para === fonteJev.id), "o Jev liga ao conhecimento dele");
  const agente = m.nos.find((n) => n.camada === "agentes" && /Frontend Developer/.test(n.rotulo));
  assert.ok(m.ligacoes.some((l) => l.para === agente.id && l.relacao === "usa"), "a função liga ao agente alocado");
  assert.ok(m.nos.some((n) => n.camada === "trabalho"), "o briefing aparece como trabalho em andamento");
});
