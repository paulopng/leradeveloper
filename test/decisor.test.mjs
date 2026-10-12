// Testes do decisor Jev: cliente (com servidor falso) e protocolo MCP por stdio.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.LERADEVELOPER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lera-jev-"));

// Servidor falso no formato do defapi: responde cada pergunta noul com uma probabilidade
// tirada do texto ("[p=0.85]"), para os testes controlarem o resultado.
let lastBody = null;
let lastAuth = null;
const fake = http.createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  lastBody = JSON.parse(body);
  lastAuth = req.headers.authorization;
  if (req.headers.authorization !== "Bearer chave-teste") {
    res.writeHead(401).end(JSON.stringify({ detail: "bad key" }));
    return;
  }
  const answers = {};
  for (const [k, q] of Object.entries(lastBody.questions)) {
    const m = /\[p=([\d.]+)\]/.exec(q.instructions);
    answers[k] = { type: "noul", noul: m ? Number(m[1]) : 0.5 };
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ model: "typesafe/jev-1.13-20260917", answers, usage: { cost: 0.00002 }, id: "gen-test" }));
});

let jev;
before(async () => {
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  process.env.JEV_ENDPOINT = `http://127.0.0.1:${fake.address().port}/api/v1/decisions`;
  process.env.TYPESAFE_API_KEY = "chave-teste";
  jev = await import("../server/lib/jev.js");
});
after(() => fake.close());

test("decidir: zona confiante e zona de dúvida", async () => {
  const sim = await jev.decidir({ pergunta: "Aprovar? [p=0.91]", contexto: "tudo ok" });
  assert.equal(sim.zona, "sim");
  assert.equal(sim.precisa_humano, false);
  assert.equal(lastBody.model, "typesafe/jev-1.13");
  assert.equal(lastBody.state, "tudo ok");

  const duvida = await jev.decidir({ pergunta: "Aprovar? [p=0.4]", contexto: { riscos: 2 } });
  assert.equal(duvida.zona, "duvida");
  assert.equal(duvida.precisa_humano, true);
  assert.deepEqual(lastBody.state, { riscos: 2 });

  const nao = await jev.decidir({ pergunta: "Aprovar? [p=0.1]", contexto: "x", criterio_sim: "A", criterio_nao: "B" });
  assert.equal(nao.zona, "nao");
  assert.deepEqual(lastBody.questions.decisao.criteria, { true: "A", false: "B" });
});

test("escolher: ranking normalizado e escolha clara vs dúvida", async () => {
  const clara = await jev.escolher({ pergunta: "Quem faz?", contexto: "c", opcoes: { "Data Engineer [p=0.9]": "dados", "Architect [p=0.2]": "arq" } });
  assert.equal(clara.escolha, "Data Engineer [p=0.9]");
  assert.equal(clara.zona, "clara");
  assert.ok(Math.abs(clara.ranking.reduce((a, r) => a + r.probabilidade, 0) - 1) < 1e-9);
  assert.equal(Object.keys(lastBody.questions).length, 2);

  const empate = await jev.escolher({ pergunta: "Qual?", contexto: "c", opcoes: ["A [p=0.6]", "B [p=0.55]"] });
  assert.equal(empate.zona, "duvida");
  await assert.rejects(jev.escolher({ pergunta: "Qual?", contexto: "c", opcoes: ["só uma"] }));
});

test("chave errada vira mensagem clara", async () => {
  const cfg = { ...jev.config(), key: "errada" };
  await assert.rejects(jev.decidir({ pergunta: "x", contexto: "y" }, cfg), /recusou a chave/);
  await assert.rejects(jev.decidir({ pergunta: "x", contexto: "y" }, { ...cfg, key: "" }), /Chave do Jev não encontrada/);
});

test("servidor MCP: initialize, tools/list e tools/call por stdio", async () => {
  const child = spawn(process.execPath, [path.join(root, "bin", "lera-decisor.js")], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
    }
  });
  let n = 0;
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const id = ++n;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "teste", version: "1" } });
  assert.equal(init.result.serverInfo.name, "lera-decisor");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const list = await rpc("tools/list", {});
  assert.deepEqual(list.result.tools.map((t) => t.name), ["decidir", "escolher", "historico_decisoes"]);

  const call = await rpc("tools/call", { name: "decidir", arguments: { pergunta: "Seguir? [p=0.35]", contexto: "c" } });
  assert.equal(call.result.structuredContent.zona, "duvida");

  const hist = await rpc("tools/call", { name: "historico_decisoes", arguments: {} });
  assert.ok(hist.result.structuredContent.decisoes.length >= 1);

  const bad = await rpc("tools/call", { name: "nada", arguments: {} });
  assert.equal(bad.result.isError, true);

  const unknown = await rpc("metodo/inexistente", {});
  assert.equal(unknown.error.code, -32601);
  child.kill();
});

test("--instalar escreve Codex e Cursor sem duplicar e com backup", async () => {
  const { installAll } = await import("../server/lib/mcp-setup.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lera-home-"));
  fs.mkdirSync(path.join(home, ".codex"));
  fs.writeFileSync(path.join(home, ".codex", "config.toml"), 'model = "gpt-5"\n');
  const r1 = installAll(home);
  assert.equal(r1.find((r) => r.ferramenta === "Codex").ok, true);
  const toml = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
  assert.match(toml, /model = "gpt-5"/);
  assert.match(toml, /\[mcp_servers\.jev\]/);
  assert.ok(fs.existsSync(path.join(home, ".codex", "config.toml.bak-lera")));
  const cur = JSON.parse(fs.readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8"));
  assert.ok(cur.mcpServers.jev.command);
  const r2 = installAll(home);
  assert.equal(r2.find((r) => r.ferramenta === "Codex").detalhe, "já configurado");
  assert.equal((fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8").match(/mcp_servers\.jev/g) || []).length, 1);
});
