// Coordenador com ferramentas falsas e um Jev falso: plano → rotas → worktrees →
// revisão → integração → entrega. E o caminho sem Jev: você decide, conflito, resolução.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lera-coord-"));
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "lera-coord-home-"));
process.env.LERADEVELOPER_DATA_DIR = dataDir;
process.env.LERADEVELOPER_HOME = homeDir;
const fake = (n) => JSON.stringify([process.execPath, path.join(root, "test", "fakes", `fake-${n}.mjs`)]);
process.env.LERA_CMD_CLAUDE = fake("claude");
process.env.LERA_CMD_CODEX = fake("codex");
process.env.LERA_CMD_CURSOR = fake("cursor");
process.env.JEV_BACKOFF_MS = "5";
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "Teste";
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "teste@example.com";
delete process.env.DEFAPI_API_KEY;

// Jev falso: rotas pelo id da tarefa e revisões sempre aprovando.
const ROTAS = { base: "claude", tela: "codex" };
const jevFake = http.createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const b = JSON.parse(body);
  const answers = {};
  for (const [k, q] of Object.entries(b.questions)) {
    if (k.startsWith("rota_")) {
      const tid = /tasks\.([\w-]+)/.exec(q.instructions)?.[1];
      const alvo = ROTAS[tid] ?? "claude";
      const probabilities = Object.fromEntries(Object.keys(q.criteria).map((o) => [o, o === alvo ? 0.9 : 0.1 / (Object.keys(q.criteria).length - 1)]));
      answers[k] = { type: "choice", choice: alvo, probabilities, confidence: 0.8 };
    } else if (q.type === "score") answers[k] = { type: "score", probabilities: { 0: 0.1, 1: 0.8, 2: 0.1, 3: 0, 4: 0 }, confidence: 0.6 };
    else if (q.type === "choice") answers[k] = { type: "choice", probabilities: { merge: 0.9, ajustar: 0.05, revisao_humana: 0.03, refazer: 0.02 }, confidence: 0.8 };
    else answers[k] = { type: "noul", noul: { cumpre_objetivo: 0.95, testes_adequados: 0.9, quebra_compatibilidade: 0.05, seguranca: 0.05 }[k] ?? 0.5 };
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ model: "jev-falso", answers, usage: { cost: 0.00001 } }));
});

const { createServer } = await import("../server/index.js");
let server, base, token;
before(async () => {
  await new Promise((r) => jevFake.listen(0, "127.0.0.1", r));
  ({ server, token } = createServer({ staticDir: path.join(dataDir, "ui") }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  jevFake.close();
});

async function call(cmd, args = {}) {
  const r = await fetch(`${base}/api/invoke/${cmd}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Leradeveloper-Token": token },
    body: JSON.stringify(args),
  });
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
    if (Date.now() > limite) throw new Error(`tempo esgotado: ${c.status} ${JSON.stringify(Object.fromEntries(Object.entries(c.execucao).map(([k, e]) => [k, `${e.status} ${e.motivo ?? ""}`])))} log=${c.log.map((l) => l.texto).join(" | ")}`);
    await sleep(150);
  }
}
const ls = (p) => fs.readdirSync(p).filter((f) => !f.startsWith("."));

test("com o Jev: plano, rotas, execução em ordem, revisão aprovando, entrega", async () => {
  process.env.TYPESAFE_API_KEY = "x";
  process.env.JEV_ENDPOINT = `http://127.0.0.1:${jevFake.address().port}/decisions`;
  delete process.env.FAKE_PLANO;
  const p = await call("projeto_criar", { nome: "App Coordenada" });
  const c0 = await call("coord_criar", { projetoId: p.id, objetivo: "Fazer uma lista de tarefas simples" });
  assert.equal(c0.status, "planejando");
  const c1 = await esperar(c0.id, (c) => c.status !== "planejando");
  assert.equal(c1.status, "plano_pronto", c1.erro);
  assert.deepEqual(c1.plano.tarefas.map((t) => t.id), ["base", "tela"]);
  assert.equal(c1.rotas.base.ferramenta, "claude");
  assert.equal(c1.rotas.tela.ferramenta, "codex");
  assert.match(c1.rotas.tela.motivo, /Jev: 90%/);
  // a tarefa de planejamento não aparece na lista da central
  assert.ok(!(await call("central_estado")).tarefas.some((t) => t.titulo.startsWith("Planejar")));

  await call("coord_aprovar", { id: c0.id });
  const fim = await esperar(c0.id, (c) => c.status === "concluida" || c.status === "erro");
  assert.equal(fim.status, "concluida", JSON.stringify(fim.log));
  assert.equal(fim.execucao.base.status, "juntada");
  assert.equal(fim.execucao.tela.status, "juntada");
  assert.equal(fim.execucao.base.revisao.veredito, "aprovar");
  // a tela começou depois da base: a cópia dela já tinha o arquivo da base
  const tela = await call("tarefa_eventos", { id: fim.execucao.tela.tarefa.id });
  assert.equal(tela.tarefa.ferramenta, "codex");
  assert.match(tela.eventos.find((e) => e.t === "voce").texto, /Não faça commit/);

  const d = await call("coord_diff", { id: c0.id });
  assert.ok(d.arquivos.some((a) => a.endsWith("feito-claude-1.txt")));
  assert.ok(d.arquivos.some((a) => a.endsWith("feito-codex-1.txt")));
  assert.deepEqual(ls(p.pasta), [], "nada muda na sua pasta antes de entregar");

  const ent = await call("coord_entregar", { id: c0.id });
  assert.equal(ent.status, "entregue");
  assert.deepEqual(ls(p.pasta).sort(), ["feito-claude-1.txt", "feito-codex-1.txt"]);
  const branches = execFileSync("git", ["branch", "--list", "lera/*"], { cwd: p.pasta, encoding: "utf8" });
  assert.doesNotMatch(branches, /\/t-/, "branches das tarefas apagadas");
  assert.ok(!fs.existsSync(path.join(p.pasta, ".lera", "wt", `${c0.id}-base`)));

  // Escritório: o coordenador tem mesa e terminou
  const est = await call("escritorio_estado");
  const mesa = est.mesas.find((m) => m.agente === "Coordenador · App Coordenada");
  assert.equal(mesa.status, "concluido");
});

test("sem o Jev: você decide, conflito e resolução, descartar", async () => {
  delete process.env.TYPESAFE_API_KEY;
  process.env.FAKE_PLANO = JSON.stringify({
    resumo: "duas partes",
    tarefas: [
      { id: "a", titulo: "Parte A", descricao: "A", depende_de: [], tipo: "backend" },
      { id: "b", titulo: "Parte B", descricao: "B", depende_de: [], tipo: "backend" },
      { id: "c", titulo: "Parte C", descricao: "C", depende_de: ["b"], tipo: "docs" },
    ],
  });
  const p = await call("projeto_criar", { nome: "Sem Jev" });
  fs.writeFileSync(path.join(p.pasta, "sujo.txt"), "x");
  const c0 = await call("coord_criar", { projetoId: p.id, objetivo: "Duas partes que conflitam" });
  const c1 = await esperar(c0.id, (c) => c.status === "plano_pronto");
  assert.match(c1.rotas.a.motivo, /Jev indisponível/);
  await call("coord_ajustar", { id: c0.id, tarefa: "c", ferramenta: "cursor" });
  await assert.rejects(call("coord_aprovar", { id: c0.id }), /sem commit/);
  await call("projeto_commit", { id: p.id, mensagem: "estado inicial" });
  await call("coord_aprovar", { id: c0.id });

  const c2 = await esperar(c0.id, (c) => c.execucao.a.status === "aguardando_voce" && c.execucao.b.status === "aguardando_voce");
  assert.match(c2.execucao.a.motivo, /humano/);
  assert.equal(c2.execucao.c.status, "esperando", "C espera B");
  await call("coord_decidir", { id: c0.id, tarefa: "a", acao: "juntar" });
  const c3 = await call("coord_decidir", { id: c0.id, tarefa: "b", acao: "juntar" });
  assert.equal(c3.execucao.b.status, "conflito", "as duas criaram o mesmo arquivo");
  await call("coord_decidir", { id: c0.id, tarefa: "b", acao: "resolver_conflito" });
  const c4 = await esperar(c0.id, (c) => c.execucao.b.status === "juntada" && c.execucao.c.status === "aguardando_voce");
  assert.equal(c4.rotas.c.ferramenta, "cursor");
  await call("coord_decidir", { id: c0.id, tarefa: "c", acao: "descartar" });
  const fim = await esperar(c0.id, (c) => c.status === "concluida");
  assert.equal(fim.execucao.c.status, "descartada");
  await assert.rejects(call("coord_decidir", { id: c0.id, tarefa: "c", acao: "juntar" }), /não está esperando/);
  await call("coord_descartar", { id: c0.id });
  assert.ok(!(await call("coord_listar", { projetoId: p.id })).some((c) => c.id === c0.id));
  const branches = execFileSync("git", ["branch", "--list", "lera/*"], { cwd: p.pasta, encoding: "utf8" });
  assert.equal(branches.trim(), "", "descartar apaga as branches");
});

test("validação do plano", async () => {
  const { validarPlano, extrairPlano } = await import("../server/lib/central/coordenador.js");
  assert.throws(() => validarPlano({ tarefas: [] }), /não tem tarefas/);
  assert.throws(() => validarPlano({ tarefas: [{ id: "a", depende_de: ["b"] }] }), /não existe/);
  assert.throws(() => validarPlano({ tarefas: [{ id: "a", depende_de: ["b"] }, { id: "b", depende_de: ["a"] }] }), /círculo/);
  const p = extrairPlano('texto\n```json\n{"tarefas":[{"id":"Minha Tarefa!","titulo":"x","tipo":"estranho"}]}\n```');
  assert.equal(p.tarefas[0].id, "minha-tarefa");
  assert.equal(p.tarefas[0].tipo, "outro");
  assert.throws(() => extrairPlano("sem json"), /não trouxe um plano/);
});
