#!/usr/bin/env node
// `lera-decisor`: servidor MCP do decisor Jev (stdio).
//   lera-decisor              inicia o servidor (é assim que as ferramentas o chamam)
//   lera-decisor --testar     faz uma decisão de teste e mostra o resultado
//   lera-decisor --instalar   liga o decisor ao Claude Code, Codex e Cursor
//   lera-decisor --config     mostra a configuração (sem revelar a chave)
//   lera-decisor --guarda     hook PreToolUse do Claude Code (lê o JSON do stdin)
//   lera-decisor --instalar-guarda / --remover-guarda   liga ou desliga o guarda no Claude Code
import { start } from "../server/mcp-decisor.js";
import { decidir, consultar, config } from "../server/lib/jev.js";
import { guardar, instalarGuarda, removerGuarda } from "../server/lib/guarda.js";
import { installAll } from "../server/lib/mcp-setup.js";

const arg = (f) => process.argv.includes(f);

if (arg("--guarda")) {
  // Hook: nunca falha nem trava o Claude Code; sem opinião = sem saída.
  let raw = "";
  for await (const c of process.stdin) raw += c;
  try {
    const out = await guardar(JSON.parse(raw || "{}"));
    if (out) process.stdout.write(JSON.stringify(out));
  } catch {
    /* sem opinião */
  }
  process.exit(0);
} else if (arg("--instalar-guarda") || arg("--remover-guarda")) {
  try {
    const r = arg("--remover-guarda") ? removerGuarda() : instalarGuarda();
    console.log(`Guarda do Claude Code: ${r.detalhe} (${r.arquivo})`);
    if (r.detalhe === "instalado") console.log("Antes de comandos arriscados (push, reset --hard, rm -rf, publish...), o Jev avalia e, se houver risco, o Claude Code pede sua confirmação.");
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
} else if (arg("--testar")) {
  try {
    const r = await decidir({
      pergunta: "Will this deploy run without incidents?",
      contexto: "The team wants to ship the payments service on Friday afternoon. The two previous Friday deploys had incidents.",
      criterio_sim: "Standard window, all checks passed",
      criterio_nao: "History of incidents in the same window",
    });
    console.log(`✔ noul (sim/não): ${Math.round(r.probabilidade_sim * 100)}% · ${r.latencia_ms} ms · modelo ${r.modelo}`);
    const t = await consultar({
      contexto: "Login fails with error 500 for every user since this morning's release. No workaround.",
      perguntas: [
        { id: "area", tipo: "escolher", pergunta: "Which area should handle this?", opcoes: { backend: "Server-side code and APIs", frontend: "User interface", infra: "Servers, deploys, networking" } },
        { id: "severidade", tipo: "avaliar", pergunta: "How severe is this issue?", niveis: ["Cosmetic", "Minor, has a workaround", "Major, no workaround", "Critical, blocks everyone"] },
      ],
    });
    console.log(`${t.tipos_nativos ? "✔" : "≈"} choice + score numa chamada: área ${t.respostas.area.escolha ?? "?"}, severidade ${t.respostas.severidade.nivel_texto} · ${t.latencia_ms} ms`);
    if (!t.tipos_nativos) console.log("  (o provedor não aceitou choice/score nativos; o decisor emula com perguntas sim/não e segue funcionando)");
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
} else if (arg("--instalar")) {
  for (const r of installAll()) console.log(`${r.ok ? "✔" : "✖"} ${r.ferramenta}: ${r.detalhe}`);
  console.log("\nReinicie as ferramentas abertas para elas carregarem o decisor.");
} else if (arg("--config")) {
  const c = config();
  console.log(JSON.stringify({ ...c, key: c.key ? `definida (${c.key.length} caracteres)` : "(não definida)" }, null, 2));
} else if (arg("--help") || arg("-h")) {
  console.log("lera-decisor [--testar | --instalar | --config | --instalar-guarda | --remover-guarda]\nSem opções, inicia o servidor MCP por stdio.");
} else {
  start();
}
