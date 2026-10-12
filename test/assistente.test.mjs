// Assistente de briefing: perguntas → respostas → briefing com equipe → Jev valida (e pede
// correção uma vez) → você ajusta → vira uma coordenação com as escolhas do briefing.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lera-assist-"));
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "lera-assist-home-"));
process.env.LERADEVELOPER_DATA_DIR = dataDir;
process.env.LERADEVELOPER_HOME = homeDir;
const fake = (n) => JSON.stringify([process.execPath, path.join(root, "test", "fakes", `fake-${n}.mjs`)]);
for (const [k, n] of [["CLAUDE", "claude"], ["CODEX", "codex"], ["CURSOR", "cursor"], ["ANTIGRAVITY", "antigravity"]]) process.env[`LERA_CMD_${k}`] = fake(n);
process.env.JEV_BACKOFF_MS = "5";
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "Teste";
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "teste@example.com";
delete process.env.DEFAPI_API_KEY;

// Jev falso: o briefing só passa na versão "v2" (a corrigida); nas rotas, prefere o Cursor.
let validacoes = 0;
const jev = http.createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const b = JSON.parse(body);
  const brief = b.state?.brief;
  if (brief) validacoes++;
  const bom = brief?.title?.includes("v2");
  const answers = {};
  for (const [k, q] of Object.entries(b.questions)) {
    if (q.type === "score") answers[k] = { type: "score", probabilities: bom ? { 0: 0, 1: 0.05, 2: 0.15, 3: 0.8 } : { 0: 0.1, 1: 0.6, 2: 0.3, 3: 0 } };
    else if (q.type === "choice") {
      const keys = Object.keys(q.criteria);
      answers[k] = { type: "choice", probabilities: Object.fromEntries(keys.map((o) => [o, o === "cursor" ? 0.85 : 0.15 / (keys.length - 1)])) };
    } else if (k === "sobreposicao") answers[k] = { type: "noul", noul: 0.05 };
    else if (brief) answers[k] = { type: "noul", noul: bom ? 0.93 : k === "cobertura" ? 0.4 : 0.9 };
    else answers[k] = { type: "noul", noul: 0.1 };
  }
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ model: "jev-falso", answers, usage: { cost: 0.00002 } }));
});

const { createServer } = await import("../server/index.js");
let server, base, token, projetoId;
before(async () => {
  await new Promise((r) => jev.listen(0, "127.0.0.1", r));
  process.env.TYPESAFE_API_KEY = "x";
  process.env.JEV_ENDPOINT = `http://127.0.0.1:${jev.address().port}/decisions`;
  ({ server, token } = createServer({ staticDir: path.join(dataDir, "ui") }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const pasta = fs.mkdtempSync(path.join(homeDir, "lista-"));
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
async function esperar(id, pred, ms = 25000) {
  const limite = Date.now() + ms;
  for (;;) {
    const s = await call("assistente_obter", { id });
    if (pred(s)) return s;
    if (Date.now() > limite) throw new Error(`tempo esgotado: ${s.status} ${s.erro ?? ""}`);
    await sleep(100);
  }
}
const parado = (s) => !["pensando", "validando"].includes(s.status);

let sessaoId;
test("pergunta o que importa, monta o briefing com equipe e o Jev pede uma correção", async () => {
  const s0 = await call("assistente_criar", { projetoId, ideia: "Quero um app de lista de tarefas bonito no celular [perguntar]" });
  sessaoId = s0.id;
  assert.equal(s0.status, "pensando");
  assert.equal(s0.ferramenta, "claude");
  const s1 = await esperar(sessaoId, parado);
  assert.equal(s1.status, "perguntas", s1.erro);
  assert.deepEqual(s1.perguntas.map((q) => q.id), ["q1", "q2"]);
  assert.deepEqual(s1.perguntas[0].opcoes, ["Só eu", "Minha equipe"]);

  // o pedido inicial vai com as ferramentas instaladas e o catálogo, e é só leitura
  const t = await call("tarefa_eventos", { id: s1.tarefaId });
  const pedido = t.eventos.find((e) => e.t === "voce").texto;
  assert.match(pedido, /- codex: Codex/);
  assert.match(pedido, /engineering-frontend-developer/);
  assert.match(pedido, /Do NOT modify/);
  assert.equal(t.tarefa.oculta, true);

  await call("assistente_responder", { id: sessaoId, respostas: { q1: "Só eu", q2: ["Não"] }, texto: "Tema escuro" });
  const s2 = await esperar(sessaoId, (s) => s.status === "pronto" || s.status === "erro");
  assert.equal(s2.status, "pronto", s2.erro);
  assert.equal(validacoes, 2, "validou a primeira versão e a corrigida");
  assert.ok(s2.mensagens.some((m) => m.de === "jev" && /não cobrem/.test(m.texto)), "o Jev apontou a cobertura");
  assert.equal(s2.briefing.titulo, "Lista de tarefas v2");
  assert.equal(s2.validacao.aprovado, true);
  assert.equal(s2.validacao.prontidao.texto, "pronto");
  assert.equal(s2.validacao.sugestoes.tela.ferramenta, "cursor", "o Jev sugere a ferramenta de cada tarefa");
  const [baseT, tela] = s2.briefing.equipe;
  assert.equal(baseT.id, "base", "ids normalizados");
  assert.equal(baseT.ferramenta, "claude");
  assert.equal(tela.ferramenta, "codex", "a equipe usa mais de uma ferramenta");
  assert.deepEqual(baseT.agentes.map((a) => a.slug), ["engineering-backend-architect"], "agente inexistente foi tirado");
  assert.ok(s2.avisos.some((a) => /nao-existe/.test(a)));
  assert.equal(s2.briefing.validacoes_iniciais[1].descricao, "Abrir no celular e adicionar uma tarefa");
  const conversa = (await call("tarefa_eventos", { id: s2.tarefaId })).eventos.filter((e) => e.t === "voce").map((e) => e.texto);
  assert.match(conversa[1], /Quem vai usar\?\n  Answer: Só eu/, "as respostas chegaram ao assistente");
  assert.match(conversa[1], /Tema escuro/);
  assert.match(conversa[2], /found these problems/, "a correção do Jev foi na mesma conversa");

  const lista = await call("assistente_listar", { projetoId });
  assert.equal(lista[0].id, sessaoId);
  assert.equal(lista[0].aprovado, true);
});

test("você ajusta a equipe e começa: vira coordenação com as escolhas do briefing", async () => {
  await assert.rejects(call("assistente_ajustar", { id: sessaoId, tarefa: "tela", ferramenta: "vim" }), /desconhecida/);
  await assert.rejects(call("assistente_ajustar", { id: sessaoId, tarefa: "x", ferramenta: "cursor" }), /não encontrada/);
  const aj = await call("assistente_ajustar", { id: sessaoId, tarefa: "tela", ferramenta: "cursor", agentes: [] });
  assert.equal(aj.briefing.equipe[1].ferramenta, "cursor");

  const r = await call("assistente_lancar", { id: sessaoId, autonomia: "editar" });
  assert.equal(r.aviso, null, r.aviso);
  const c = await call("coord_obter", { id: r.coordId });
  assert.equal(c.status, "executando");
  assert.equal(c.rotas.base.ferramenta, "claude");
  assert.equal(c.rotas.tela.ferramenta, "cursor");
  assert.match(c.rotas.base.motivo, /briefing/);
  assert.match(c.objetivo, /Critérios de aceite:\n- Adicionar e marcar tarefas/);
  assert.match(c.objetivo, /Validações:\n- Testes passam \(npm test\)/);
  assert.equal(c.origem.assistente, sessaoId);

  // a primeira tarefa roda com o agente escolhido no briefing (sem o Jev escolher de novo)
  let tid;
  for (let i = 0; i < 100 && !tid; i++) {
    tid = (await call("coord_obter", { id: r.coordId })).execucao.base.tarefaId;
    if (!tid) await sleep(50);
  }
  let ev;
  for (let i = 0; i < 100; i++) {
    ev = await call("tarefa_eventos", { id: tid });
    if (ev.eventos.some((e) => e.t === "agentes")) break;
    await sleep(50);
  }
  assert.deepEqual(ev.eventos.find((e) => e.t === "agentes").itens.map((a) => a.slug), ["engineering-backend-architect"]);
  await call("coord_parar", { id: r.coordId });

  await assert.rejects(call("assistente_lancar", { id: sessaoId }), /já virou/);
  const s = await call("assistente_obter", { id: sessaoId });
  assert.equal(s.status, "lancado");
});

test("pular as perguntas e pedir mudanças no briefing", async () => {
  const s0 = await call("assistente_criar", { projetoId, ideia: "Um site simples de receitas [perguntar]" });
  await esperar(s0.id, (s) => s.status === "perguntas");
  await call("assistente_pular", { id: s0.id });
  const s1 = await esperar(s0.id, (s) => s.status === "pronto" || s.status === "erro");
  assert.equal(s1.status, "pronto", s1.erro);
  assert.ok(s1.mensagens.some((m) => m.de === "voce" && /decidir o resto/.test(m.texto)));
  await call("assistente_mensagem", { id: s0.id, texto: "Troque o tema para claro" });
  const s2 = await esperar(s0.id, (s) => s.status === "pronto" && s.briefing.titulo.includes("v2"));
  assert.equal(s2.validacao.aprovado, true);
  await assert.rejects(call("assistente_responder", { id: s0.id, respostas: {} }), /não está esperando/);
  await call("assistente_descartar", { id: s0.id });
  assert.ok(!(await call("assistente_listar", { projetoId })).some((x) => x.id === s0.id));
});
