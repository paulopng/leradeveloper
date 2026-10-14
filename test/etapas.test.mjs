// Etapas de um objetivo: testes mínimos (o leradev roda os automáticos e pede ajuste se
// falharem; os manuais você marca antes de entregar), prévia da etapa e agentes por etapa.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lera-etapas-"));
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "lera-etapas-home-"));
process.env.LERADEVELOPER_DATA_DIR = dataDir;
process.env.LERADEVELOPER_HOME = homeDir;
process.env.LERA_PREVIA_PORTA = "0";
const fake = (n) => JSON.stringify([process.execPath, path.join(root, "test", "fakes", `fake-${n}.mjs`)]);
for (const [k, n] of [["CLAUDE", "claude"], ["CODEX", "codex"], ["CURSOR", "cursor"], ["ANTIGRAVITY", "antigravity"]]) process.env[`LERA_CMD_${k}`] = fake(n);
process.env.JEV_BACKOFF_MS = "5";
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "Teste";
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "teste@example.com";
delete process.env.DEFAPI_API_KEY;

// Jev falso: rota sempre Claude Code; revisões aprovando.
const jev = http.createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const b = JSON.parse(body);
  const answers = {};
  for (const [k, q] of Object.entries(b.questions)) {
    if (k.startsWith("rota_")) answers[k] = { type: "choice", probabilities: Object.fromEntries(Object.keys(q.criteria).map((o) => [o, o === "claude" ? 0.9 : 0.1 / (Object.keys(q.criteria).length - 1)])) };
    else if (q.type === "score") answers[k] = { type: "score", probabilities: { 0: 0.1, 1: 0.8, 2: 0.1, 3: 0, 4: 0 } };
    else if (q.type === "choice") answers[k] = { type: "choice", probabilities: { merge: 0.9, ajustar: 0.05, revisao_humana: 0.03, refazer: 0.02 } };
    else answers[k] = { type: "noul", noul: { cumpre_objetivo: 0.95, testes_adequados: 0.9, quebra_compatibilidade: 0.05, seguranca: 0.05 }[k] ?? 0.5 };
  }
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ model: "jev-falso", answers }));
});

const { createServer } = await import("../server/index.js");
const { _paraTestes } = await import("../server/lib/previa.js");
let server, base, token;
before(async () => {
  await new Promise((r) => jev.listen(0, "127.0.0.1", r));
  process.env.TYPESAFE_API_KEY = "x";
  process.env.JEV_ENDPOINT = `http://127.0.0.1:${jev.address().port}/decisions`;
  ({ server, token } = createServer({ staticDir: path.join(dataDir, "ui") }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
  jev.close();
  _paraTestes.fechar();
});

async function call(cmd, args = {}) {
  const r = await fetch(`${base}/api/invoke/${cmd}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Leradeveloper-Token": token }, body: JSON.stringify(args) });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(body?.message ?? `HTTP ${r.status}`);
  return body;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function esperar(id, pred, ms = 30000) {
  const limite = Date.now() + ms;
  for (;;) {
    const c = await call("coord_obter", { id });
    if (pred(c)) return c;
    if (Date.now() > limite) throw new Error(`tempo esgotado: ${c.status} ${JSON.stringify(c.log.map((l) => l.texto))}`);
    await sleep(120);
  }
}

test("testes mínimos: falha → ajuste → passa; manual pendente segura a entrega; prévia e agentes da etapa", async () => {
  process.env.FAKE_PLANO = JSON.stringify({
    resumo: "Uma etapa com testes",
    tarefas: [{
      id: "base", titulo: "Criar a base", descricao: "Arquivos", tipo: "backend", depende_de: [],
      testes_minimos: [
        // só passa na segunda rodada, quando o fake já escreveu o segundo arquivo
        { id: "Segundo Arquivo", descricao: "O segundo arquivo existe", tipo: "automatico", comando: `node -e "require('fs').accessSync('feito-claude-2.txt')"` },
        { descricao: "Abrir a prévia e ver a página", tipo: "manual" },
        { descricao: "Sem comando vira manual", tipo: "automatico" },
      ],
    }],
  });
  const p = await call("projeto_criar", { nome: "Com Testes" });
  fs.writeFileSync(path.join(p.pasta, "index.html"), "<h1>Página da etapa</h1>");
  await call("projeto_commit", { id: p.id, mensagem: "início" });
  const c0 = await call("coord_criar", { projetoId: p.id, objetivo: "Fazer a base com testes mínimos" });
  const c1 = await esperar(c0.id, (c) => c.status !== "planejando");
  delete process.env.FAKE_PLANO;
  assert.equal(c1.status, "plano_pronto", c1.erro);
  const testes = c1.plano.tarefas[0].testes_minimos;
  assert.deepEqual(testes.map((t) => [t.id, t.tipo]), [["segundo-arquivo", "automatico"], ["base-2", "manual"], ["base-3", "manual"]]);

  // agentes da etapa: agrega e desagrega antes de começar
  const slug = (await call("corpus_list", {})).find((a) => a.name === "Backend Architect").slug;
  const ca = await call("coord_agentes_definir", { id: c0.id, tarefa: "base", agentes: [slug] });
  assert.deepEqual(ca.agentesTarefa.base.map((a) => a.slug), [slug]);
  await assert.rejects(call("coord_agentes_definir", { id: c0.id, tarefa: "base", agentes: ["nao-existe"] }), /não encontrado/);

  await call("coord_aprovar", { id: c0.id });
  const fim = await esperar(c0.id, (c) => ["concluida", "erro"].includes(c.status));
  assert.equal(fim.status, "concluida", JSON.stringify(fim.log));
  const e = fim.execucao.base;
  assert.equal(e.status, "juntada");
  assert.equal(e.tentativas, 1, "voltou uma vez para a ferramenta");
  assert.equal(e.testes["segundo-arquivo"].status, "passou");
  assert.equal(e.testes["segundo-arquivo"].fonte, "leradev", "o leradev rodou o comando");
  assert.equal(e.testes["base-2"].status, "pendente");
  assert.ok(fim.log.some((l) => /não passaram; voltou/.test(l.texto)));
  const conversa = await call("tarefa_eventos", { id: e.tarefaId });
  const pedidos = conversa.eventos.filter((x) => x.t === "voce").map((x) => x.texto);
  assert.match(pedidos[0], /Testes mínimos desta etapa/);
  assert.match(pedidos[1], /Saiu com código 1/, "a ferramenta recebeu a saída do teste que falhou");
  assert.deepEqual(conversa.eventos.find((x) => x.t === "agentes").itens.map((a) => a.slug), [slug], "o agente escolhido entrou");

  // prévia da etapa (já juntada: mostra a integração)
  const pv = await call("previa_abrir", { coordId: c0.id, etapa: "base" });
  assert.equal(pv.status, "pronta");
  const r = await fetch(`http://127.0.0.1:${pv.porta}${pv.caminho}`, { redirect: "manual" });
  const cookie = r.headers.get("set-cookie").split(";")[0];
  assert.match(await (await fetch(`http://127.0.0.1:${pv.porta}/`, { headers: { cookie } })).text(), /Página da etapa/);

  // manual pendente segura a entrega; marcar libera
  assert.equal(fim.pendenciasTestes.length, 2);
  await assert.rejects(call("coord_entregar", { id: c0.id }), /Faltam 2 teste/);
  await call("coord_teste_marcar", { id: c0.id, tarefa: "base", teste: "base-2", status: "passou", nota: "vi no celular" });
  await assert.rejects(call("coord_teste_marcar", { id: c0.id, tarefa: "base", teste: "base-2", status: "talvez" }), /inválido/);
  const rod = await call("coord_testes_rodar", { id: c0.id, tarefa: "base" });
  assert.equal(rod.execucao.base.testes["base-2"].fonte, "voce", "rodar de novo mantém o que você marcou");
  await assert.rejects(call("coord_entregar", { id: c0.id }), /Faltam 1 teste/);
  const ent = await call("coord_entregar", { id: c0.id, forcar: true });
  assert.equal(ent.status, "entregue");
  assert.ok(ent.log.some((l) => /sem conferir/.test(l.texto)));
  const st = await call("previa_status", { id: pv.id });
  assert.equal(st.status, "parada", "a prévia da cópia apagada parou");
});
