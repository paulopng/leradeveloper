// Central de comando com ferramentas falsas: tarefas, permissões, continuação, diff, commit.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lera-central-"));
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "lera-central-home-"));
process.env.LERADEVELOPER_DATA_DIR = dataDir;
process.env.LERADEVELOPER_HOME = homeDir;
const fake = (n) => JSON.stringify([process.execPath, path.join(root, "test", "fakes", `fake-${n}.mjs`)]);
process.env.LERA_CMD_CLAUDE = fake("claude");
process.env.LERA_CMD_CODEX = fake("codex");
process.env.LERA_CMD_CURSOR = fake("cursor");
delete process.env.TYPESAFE_API_KEY;
delete process.env.DEFAPI_API_KEY;
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "Teste";
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "teste@example.com";

const { createServer } = await import("../server/index.js");
let server, base, token;
before(async () => {
  ({ server, token } = createServer({ staticDir: path.join(dataDir, "ui") }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
});

async function call(cmd, args = {}) {
  const r = await fetch(`${base}/api/invoke/${cmd}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Leradeveloper-Token": token },
    body: JSON.stringify(args),
  });
  const body = await r.json().catch(() => null);
  if (!r.ok) {
    const e = new Error(body?.message ?? `HTTP ${r.status}`);
    e.payload = body;
    throw e;
  }
  return body;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function esperar(id, pred, ms = 20000) {
  const limite = Date.now() + ms;
  for (;;) {
    const r = await call("tarefa_eventos", { id });
    if (pred(r)) return r;
    if (Date.now() > limite) throw new Error(`tempo esgotado; status ${r.tarefa.status}; eventos ${r.eventos.map((e) => e.t).join(",")}`);
    await sleep(100);
  }
}
const terminou = (r) => !r.tarefa.rodando && ["concluida", "erro", "parada"].includes(r.tarefa.status);

let projetoId;

test("detecta as ferramentas e cria um projeto com git", async () => {
  const est = await call("central_estado");
  assert.equal(est.ferramentas.claude.ok, true);
  assert.match(est.ferramentas.claude.versao, /falso/);
  assert.equal(est.ferramentas.codex.ok, true);
  assert.equal(est.ferramentas.cursor.ok, true);
  const p = await call("projeto_criar", { nome: "Minha Primeira App" });
  assert.equal(p.id, "minha-primeira-app");
  assert.equal(p.pasta, path.join(homeDir, "projetos", "minha-primeira-app"));
  assert.ok(fs.existsSync(path.join(p.pasta, ".git")));
  assert.match(fs.readFileSync(path.join(p.pasta, ".git", "info", "exclude"), "utf8"), /^\.lera\/$/m);
  projetoId = p.id;
  await assert.rejects(call("projeto_adicionar", { pasta: "relativo" }), /caminho completo/);
});

test("Claude: tarefa ao vivo, plano, permissão pelo leradeveloper, continuação", async () => {
  const t = await call("tarefa_criar", { projetoId, ferramenta: "claude", prompt: "Criar arquivo [cmd:npm test]" });
  // o hook pede permissão; respondemos pela API
  const r1 = await esperar(t.id, (r) => r.tarefa.pendentes.length > 0);
  assert.equal(r1.tarefa.status, "aguardando");
  const ped = r1.tarefa.pendentes[0];
  assert.equal(ped.comando, "npm test");
  await call("tarefa_responder", { id: t.id, pedidoId: ped.id, decisao: "permitir" });
  const fim = await esperar(t.id, terminou);
  assert.equal(fim.tarefa.status, "concluida");
  assert.ok(fim.tarefa.sessao);
  assert.equal(fim.tarefa.custoUsd, 0.01);
  assert.equal(fim.tarefa.progresso, 100);
  const tipos = fim.eventos.map((e) => e.t);
  for (const k of ["voce", "sessao", "texto", "plano", "ferramenta", "ferramenta_fim", "permissao", "permissao_resolvida", "fim"]) assert.ok(tipos.includes(k), k);
  const resultadoBash = fim.eventos.find((e) => e.t === "ferramenta_fim" && /passed/.test(e.saida));
  assert.ok(resultadoBash, "o comando rodou depois da permissão");

  // continuação na mesma sessão
  await call("tarefa_enviar", { id: t.id, prompt: "Agora outro arquivo" });
  const fim2 = await esperar(t.id, (r) => terminou(r) && r.eventos.filter((e) => e.t === "fim").length === 2);
  assert.equal(fim2.tarefa.sessao, fim.tarefa.sessao);
  assert.equal(fim2.tarefa.custoUsd, 0.02);
  assert.equal(fim2.tarefa.prompts.length, 2);

  // o Escritório ganhou a mesa
  const est = await call("escritorio_estado");
  const mesa = est.mesas.find((m) => m.agente.startsWith("Claude Code"));
  assert.equal(mesa.status, "concluido");
  assert.equal(mesa.progresso, 100);
});

test("Claude: negar permissão e 'sempre permitir'", async () => {
  const t = await call("tarefa_criar", { projetoId, ferramenta: "claude", prompt: "Outro [cmd:rm -rf build]" });
  const r1 = await esperar(t.id, (r) => r.tarefa.pendentes.length > 0);
  assert.equal(r1.eventos.find((e) => e.t === "permissao").arriscado, true);
  await call("tarefa_responder", { id: t.id, pedidoId: r1.tarefa.pendentes[0].id, decisao: "negar" });
  const fim = await esperar(t.id, terminou);
  assert.ok(fim.eventos.some((e) => e.t === "ferramenta_fim" && e.ok === false));
  await assert.rejects(call("tarefa_responder", { id: t.id, pedidoId: r1.tarefa.pendentes[0].id, decisao: "permitir" }), /já foi respondido/);

  const t2 = await call("tarefa_criar", { projetoId, ferramenta: "claude", prompt: "Teste [cmd:npm run build]" });
  const p2 = await esperar(t2.id, (r) => r.tarefa.pendentes.length > 0);
  await call("tarefa_responder", { id: t2.id, pedidoId: p2.tarefa.pendentes[0].id, decisao: "sempre" });
  await esperar(t2.id, terminou);
  await call("tarefa_enviar", { id: t2.id, prompt: "De novo [cmd:npm run build -- --prod]" });
  const f2 = await esperar(t2.id, (r) => terminou(r) && r.eventos.filter((e) => e.t === "fim").length === 2);
  const auto = f2.eventos.filter((e) => e.t === "permissao_resolvida").at(-1);
  assert.match(auto.motivo, /sempre permitir/);
});

test("autonomia com o Jev: comando comum passa sozinho", async () => {
  const t = await call("tarefa_criar", { projetoId, ferramenta: "claude", autonomia: "jev", prompt: "Rodar [cmd:npm test]" });
  const fim = await esperar(t.id, terminou);
  assert.equal(fim.tarefa.status, "concluida");
  const res = fim.eventos.find((e) => e.t === "permissao_resolvida");
  assert.match(res.motivo, /comando comum/);
  assert.ok(!fim.eventos.some((e) => e.t === "permissao"), "não pediu nada a você");
});

test("Codex: app-server com aprovação de comando", async () => {
  const t = await call("tarefa_criar", { projetoId, ferramenta: "codex", prompt: "Fazer [cmd:npm test]" });
  const r1 = await esperar(t.id, (r) => r.tarefa.pendentes.length > 0);
  assert.match(r1.tarefa.pendentes[0].id, /^codex-/);
  await call("tarefa_responder", { id: t.id, pedidoId: r1.tarefa.pendentes[0].id, decisao: "permitir" });
  const fim = await esperar(t.id, terminou);
  assert.equal(fim.tarefa.status, "concluida", fim.tarefa.ultimaMensagem);
  assert.equal(fim.tarefa.tokens, 1234);
  assert.ok(fim.eventos.some((e) => e.t === "ferramenta_fim" && e.saida === "2 passed"));
  assert.match(fim.tarefa.ultimaMensagem, /Pronto \(codex\)/);
  // continuação retoma a mesma thread
  const sessao = fim.tarefa.sessao;
  await call("tarefa_enviar", { id: t.id, prompt: "Mais um" });
  const fim2 = await esperar(t.id, (r) => terminou(r) && r.eventos.filter((e) => e.t === "fim").length === 2);
  assert.equal(fim2.tarefa.sessao, sessao);
});

test("Codex: parar no meio", async () => {
  const t = await call("tarefa_criar", { projetoId, ferramenta: "codex", prompt: "Longa [demorar]" });
  await esperar(t.id, (r) => r.eventos.some((e) => e.t === "sessao"));
  await call("tarefa_parar", { id: t.id });
  const fim = await esperar(t.id, terminou);
  assert.equal(fim.tarefa.status, "parada");
});

test("Cursor: modo automático com o pedido em arquivo", async () => {
  const t = await call("tarefa_criar", { projetoId, ferramenta: "cursor", prompt: 'Texto com "aspas" & símbolos % especiais' });
  const fim = await esperar(t.id, terminou);
  assert.equal(fim.tarefa.status, "concluida", fim.tarefa.ultimaMensagem);
  const p = (await call("central_estado")).projetos.find((x) => x.id === projetoId);
  const arq = fs.readdirSync(p.pasta).find((f) => f.startsWith("feito-cursor"));
  assert.equal(fs.readFileSync(path.join(p.pasta, arq), "utf8"), 'Texto com "aspas" & símbolos % especiais');
  assert.deepEqual(fs.readdirSync(path.join(p.pasta, ".lera", "prompts")), [], "o arquivo do pedido é apagado no fim");
});

test("diff, commit e erros de git", async () => {
  const est = await call("central_estado");
  const t = est.tarefas.find((x) => x.ferramenta === "claude" && x.status === "concluida");
  const d = await call("tarefa_diff", { id: t.id });
  assert.ok(d.arquivos.length >= 3);
  assert.match(d.diff, /feito-claude-1\.txt/);
  assert.ok(!d.arquivos.some((a) => a.caminho.startsWith(".lera")));
  await assert.rejects(call("tarefa_revisar", { id: t.id }), /Chave do Jev/);
  const c = await call("tarefa_commit", { id: t.id, mensagem: 'Primeiro commit com "aspas"' });
  assert.match(c.commit, /^[0-9a-f]{7,}$/);
  const log = execFileSync("git", ["log", "-1", "--format=%s"], { cwd: t.cwd, encoding: "utf8" }).trim();
  assert.equal(log, 'Primeiro commit com "aspas"');
  await assert.rejects(call("tarefa_commit", { id: t.id }), /Não há mudanças/);
  await assert.rejects(call("tarefa_push", { id: t.id }), /repositório remoto/);
});

test("falha da ferramenta vira erro legível; ferramenta ausente", async () => {
  const t = await call("tarefa_criar", { projetoId, ferramenta: "claude", prompt: "x [falhar]" });
  const fim = await esperar(t.id, terminou);
  assert.equal(fim.tarefa.status, "erro");
  assert.match(fim.tarefa.ultimaMensagem, /Falhei de propósito/);
  process.env.LERA_CMD_CURSOR = JSON.stringify([path.join(dataDir, "nao-existe")]);
  await call("central_ferramentas", { atualizar: true });
  await assert.rejects(call("tarefa_criar", { projetoId, ferramenta: "cursor", prompt: "x" }), /não está instalado/);
  process.env.LERA_CMD_CURSOR = fake("cursor");
  await call("central_ferramentas", { atualizar: true });
});

test("'auto' sem chave do Jev cai no Claude e avisa", async () => {
  const t = await call("tarefa_criar", { projetoId, ferramenta: "auto", prompt: "Qualquer coisa" });
  assert.equal(t.ferramenta, "claude");
  const fim = await esperar(t.id, terminou);
  assert.match(fim.eventos.find((e) => e.t === "aviso").texto, /Jev indisponível/);
});
