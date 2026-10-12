#!/usr/bin/env node
// `lera-decisor`: servidor MCP do decisor Jev (stdio).
//   lera-decisor              inicia o servidor (é assim que as ferramentas o chamam)
//   lera-decisor --testar     faz uma decisão de teste e mostra o resultado
//   lera-decisor --instalar   liga o decisor ao Claude Code, Codex e Cursor
//   lera-decisor --config     mostra a configuração (sem revelar a chave)
import { start } from "../server/mcp-decisor.js";
import { decidir, config } from "../server/lib/jev.js";
import { installAll } from "../server/lib/mcp-setup.js";

const arg = (f) => process.argv.includes(f);

if (arg("--testar")) {
  try {
    const r = await decidir({
      pergunta: "Este deploy deve correr sem incidentes?",
      contexto: "O time quer subir o serviço de pagamentos na sexta à tarde. Dois deploys anteriores na sexta tiveram incidentes.",
      criterio_sim: "Janela padrão, todas as verificações passaram",
      criterio_nao: "Histórico de incidentes na mesma janela",
    });
    console.log(JSON.stringify(r, null, 2));
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
  console.log("lera-decisor [--testar | --instalar | --config]\nSem opções, inicia o servidor MCP por stdio.");
} else {
  start();
}
