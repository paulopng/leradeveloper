// Central, parte 2: agentes ligados pelo Jev, Antigravity, contas e limites, projetos unificados.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lera-c2-"));
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "lera-c2-home-"));
process.env.LERADEVELOPER_DATA_DIR = dataDir;
process.env.LERADEVELOPER_HOME = homeDir;
const fake = (n) => JSON.stringify([process.execPath, path.join(root, "test", "fakes", `fake-${n}.mjs`)]);
for (const [k, n] of [["CLAUDE", "claude"], ["CODEX", "codex"], ["CURSOR", "cursor"], ["ANTIGRAVITY", "antigravity"]]) process.env[`LERA_CMD_${k}`] = fake(n);
process.env.JEV_BACKOFF_MS = "5";
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "Teste";
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "teste@example.com";
delete process.env.DEFAPI_API_KEY;

// Jev falso: diz "sim" para o agente cujo nome contém FRONTEND e para a ferramenta 'codex'.
let alvoAgente = "Frontend Developer";
const jev = http.createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const b = JSON.parse(body);
  const answers = {};
  for (const [k, q] of Object.entries(b.questions)) {
    if (q.type === "noul") answers[k] = { type: "noul", noul: q.instructions.includes(`"${alvoAgente}"`) ? 0.95 : 0.1 };
    else if (q.type === "choice") {
      const keys = Object.keys(q.criteria);
      const alvo = keys.includes("codex") ? "codex" : keys[0];
      answers[k] = { type: "choice", probabilities: Object.fromEntries(keys.map((o) => [o, o === alvo ? 0.9 : 0.1 / (keys.length - 1)])), confidence: 0.8 };
    } else answers[k] = { type: "score", probabilities: { 0: 1 } };
  }
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ model: "jev-falso", answers, usage: { cost: 0.00001 } }));
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
async function esperar(id, pred, ms = 25000) {
  const limite = Date.now() + ms;
  for (;;) {
    const r = await call("tarefa_eventos", { id });
    if (pred(r)) return r;
    if (Date.now() > limite) throw new Error(`tempo esgotado; ${r.tarefa.status}; ${r.eventos.map((e) => e.t).join(",")}`);
    await sleep(100);
  }
}
const terminou = (r) => !r.tarefa.rodando && ["concluida", "erro", "parada"].includes(r.tarefa.status);

test("pastas da interface do catálogo aparecem na Central", async () => {
  pasta = fs.mkdtempSync(path.join(homeDir, "do-catalogo-"));
  const lista = await call("projetos_sincronizar", { pastas: [pasta, "relativo", path.join(homeDir, "nao-existe")] });
  const p = lista.find((x) => x.pasta === pasta);
  assert.ok(p, "registrou a pasta");
  assert.ok(!fs.existsSync(path.join(pasta, ".git")), "sincronizar não roda git init");
  projetoId = p.id;
  // agente instalado pela interface antiga em outra pasta também aparece
  const outra = fs.mkdtempSync(path.join(homeDir, "com-agente-"));
  await call("install_agent", { slug: (await call("corpus_list", {}))[0].slug, tool: "claudeCode", projectPath: outra });
  const est = await call("central_estado");
  assert.ok(est.projetos.some((x) => x.pasta === outra));
});

test("o Jev liga um agente do catálogo só durante a tarefa", async () => {
  const slugFront = (await call("corpus_list", {})).find((a) => a.name === alvoAgente)?.slug;
  assert.ok(slugFront, "o catálogo tem o Frontend Developer");
  const t = await call("tarefa_criar", { projetoId, ferramenta: "claude", prompt: "Criar a tela da lista de tarefas no frontend, bonita no celular" });
  assert.deepEqual(t.agentes.map((a) => a.slug), [slugFront]);
  const fim = await esperar(t.id, terminou);
  assert.equal(fim.tarefa.status, "concluida", fim.tarefa.ultimaMensagem);
  const txt = fim.eventos.find((e) => e.t === "texto").texto;
  assert.match(txt, new RegExp(`agentes=\\[${slugFront}\\.md\\]`), "o agente estava instalado durante a tarefa");
  assert.match(txt, /especialistas=sim/, "a ferramenta foi avisada");
  const ag = fim.eventos.find((e) => e.t === "agentes");
  assert.equal(ag.itens[0].temporario, true);
  await sleep(300);
  assert.ok(!fs.existsSync(path.join(pasta, ".claude", "agents", `${slugFront}.md`)), "e foi tirado no fim");
  const exclude = fs.readFileSync(path.join(pasta, ".git", "info", "exclude"), "utf8");
  assert.doesNotMatch(exclude, /agentes ligados pela Central/);
  // sem agentes quando você pede
  const t2 = await call("tarefa_criar", { projetoId, ferramenta: "claude", prompt: "Criar a tela do frontend", agentes: "nenhum" });
  assert.deepEqual(t2.agentes ?? [], []);
  await esperar(t2.id, terminou);
});

test("agente que você já tinha instalado continua instalado", async () => {
  const slugFront = (await call("corpus_list", {})).find((a) => a.name === alvoAgente).slug;
  await call("install_agent", { slug: slugFront, tool: "claudeCode", projectPath: pasta });
  const t = await call("tarefa_criar", { projetoId, ferramenta: "claude", prompt: "Ajustar a tela do frontend" });
  const fim = await esperar(t.id, terminou);
  assert.equal(fim.eventos.find((e) => e.t === "agentes").itens[0].temporario, false);
  await sleep(300);
  assert.ok(fs.existsSync(path.join(pasta, ".claude", "agents", `${slugFront}.md`)));
});

test("Antigravity: eventos no estilo Gemini, sessão e arquivo do pedido", async () => {
  const t = await call("tarefa_criar", { projetoId, ferramenta: "antigravity", prompt: 'Pedido com "aspas" e % sinais', agentes: "nenhum" });
  const fim = await esperar(t.id, terminou);
  assert.equal(fim.tarefa.status, "concluida", fim.tarefa.ultimaMensagem);
  assert.match(fim.tarefa.sessao, /^conv-/);
  assert.equal(fim.tarefa.tokens, 99);
  assert.ok(fim.eventos.some((e) => e.t === "ferramenta" && e.nome === "write_file"));
  assert.ok(fim.eventos.some((e) => e.t === "ferramenta_fim" && e.ok));
  assert.match(fim.tarefa.ultimaMensagem, /Pronto \(agy\)/);
  assert.equal(fs.readFileSync(path.join(pasta, "feito-agy-1.txt"), "utf8"), 'Pedido com "aspas" e % sinais');
  const sessao = fim.tarefa.sessao;
  await call("tarefa_enviar", { id: t.id, prompt: "mais" });
  const f2 = await esperar(t.id, (r) => terminou(r) && r.eventos.filter((e) => e.t === "fim").length === 2);
  assert.equal(f2.tarefa.sessao, sessao, "continuou a mesma conversa");
});

test("contas e limites; o Jev evita ferramenta perto do limite", async () => {
  process.env.FAKE_CLAUDE_LIMITE = "0.97";
  const t = await call("tarefa_criar", { projetoId, ferramenta: "claude", prompt: "Algo simples", agentes: "nenhum" });
  await esperar(t.id, terminou);
  delete process.env.FAKE_CLAUDE_LIMITE;
  const c = await call("central_contas", { atualizar: true });
  assert.equal(c.claude.logado, true);
  assert.match(c.claude.descricao, /assinatura/);
  assert.equal(c.claude.email, "paulo@example.com");
  assert.ok(c.claude.janelas.five_hour.uso >= 0.97);
  assert.equal(c.claude.perto, true);
  assert.equal(c.codex.email, "paulo@example.com");
  assert.match(c.codex.descricao, /ChatGPT \(plus\)/);
  assert.equal(c.codex.janelas.five_hour.uso, 0.42);
  assert.equal(c.codex.janelas.seven_day.uso, 0.1);
  assert.equal(c.cursor.email, "paulo@example.com");
  assert.ok(c.claude.uso.dia >= 4);

  await call("central_limite_definir", { ferramenta: "cursor", mensal: 1 });
  const c2 = await call("central_contas", {});
  assert.equal(c2.cursor.limiteMensal, 1);
  await assert.rejects(call("central_limite_definir", { ferramenta: "cursor", mensal: -3 }), /número/);

  // 'auto': Claude está a 97% → fica fora; o Jev (falso) escolhe o Codex
  const t2 = await call("tarefa_criar", { projetoId, ferramenta: "auto", prompt: "Qualquer coisa", agentes: "nenhum" });
  assert.equal(t2.ferramenta, "codex");
  const f2 = await esperar(t2.id, terminou);
  assert.match(f2.eventos.find((e) => e.t === "aviso").texto, /Claude Code.*perto do limite/);

  // chave de API vira alerta
  process.env.FAKE_CLAUDE_AUTH = "api_key";
  const c3 = await call("central_contas", { atualizar: true });
  assert.match(c3.claude.alerta, /chave de API/);
  delete process.env.FAKE_CLAUDE_AUTH;
});
