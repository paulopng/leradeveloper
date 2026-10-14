// Testes mínimos de cada etapa (tarefa do plano).
//
// Cada tarefa do plano/briefing traz "testes_minimos": o que precisa passar para a etapa
// valer. Há dois tipos:
//   automatico — tem um comando (ex.: `npm test`, `npm run build`). O agente roda e conta o
//                resultado; depois o leradev roda de novo na cópia da tarefa, sem confiar só
//                no relato. Comando da lista de arriscados não roda sozinho: fica para você.
//   manual     — conferência humana (ex.: "abrir a prévia no celular e adicionar uma tarefa").
//                Você marca na Central; o resultado só vai para a sua branch com eles marcados.
//
// Os comandos vêm do plano que você aprovou (não do texto livre de um pedido).
import { spawn } from "node:child_process";
import { isRisky } from "../guarda.js";
import { killTree } from "./ferramentas.js";

export const MAX_TESTES = 8;
export const STATUS_TESTE = ["pendente", "passou", "falhou", "nao_rodou", "precisa_voce"];

const str = (v, n) => String(v ?? "").trim().slice(0, n);

/** Normaliza a lista de testes mínimos de uma tarefa. */
export function normTestes(lista, tarefaId = "t") {
  const arr = Array.isArray(lista) ? lista : lista ? [lista] : [];
  const ids = new Set();
  return arr
    .slice(0, MAX_TESTES)
    .map((x, i) => {
      const o = typeof x === "string" ? { descricao: x } : x ?? {};
      const comando = str(o.comando, 300) || null;
      const tipo = o.tipo === "manual" ? "manual" : o.tipo === "automatico" ? (comando ? "automatico" : "manual") : comando ? "automatico" : "manual";
      let id = str(o.id, 24).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || `${tarefaId}-${i + 1}`.slice(0, 24);
      while (ids.has(id)) id = `${id}x`.slice(-24);
      ids.add(id);
      return { id, descricao: str(o.descricao ?? o.nome ?? comando, 300), comando: tipo === "automatico" ? comando : null, tipo };
    })
    .filter((t) => t.descricao);
}

/** Bloco que vai no pedido de cada tarefa. */
export function instrucaoTestes(testes) {
  if (!testes?.length) return "";
  const linhas = testes.map((t) => `- [${t.id}] ${t.descricao}${t.comando ? ` — comando: \`${t.comando}\`` : " — conferência manual (só descreva como a pessoa deve conferir)"}`);
  return `

Testes mínimos desta etapa (precisam passar para o trabalho ser aceito):
${linhas.join("\n")}

Rode os testes automáticos depois de terminar e corrija o que falhar. Se algum ainda não existir (ex.: o projeto não tem testes), crie o mínimo necessário para ele rodar. No fim da resposta, inclua um bloco \`\`\`json só com:
{"testes": [{"id": "<id>", "status": "passou|falhou|nao_rodou", "evidencia": "resumo curto da saída ou do que conferiu"}]}`;
}

/** Lê o relato do agente (último bloco ```json com "testes"). */
export function relatorioDoAgente(texto) {
  const s = String(texto ?? "");
  const blocos = [...s.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]).reverse();
  for (const b of blocos) {
    try {
      const o = JSON.parse(b.trim());
      if (Array.isArray(o?.testes)) {
        const out = {};
        for (const t of o.testes) {
          const id = str(t?.id, 24);
          if (!id) continue;
          const st = ["passou", "falhou", "nao_rodou"].includes(t.status) ? t.status : "nao_rodou";
          out[id] = { status: st, evidencia: str(t.evidencia, 600) };
        }
        return out;
      }
    } catch {
      /* próximo */
    }
  }
  return {};
}

/** Roda um comando de teste no shell da pasta, com limite de tempo. */
export function rodarComando(cwd, comando, { timeoutMs = Number(process.env.LERA_TESTE_TIMEOUT_MS ?? 300000) } = {}) {
  return new Promise((resolve) => {
    let saida = "";
    let child;
    const inicio = Date.now();
    try {
      const grupo = process.platform !== "win32";
      child = spawn(comando, { cwd, shell: true, windowsHide: true, detached: grupo, env: { ...process.env, CI: "1", FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"] });
      child.lera_grupo = grupo;
    } catch (e) {
      return resolve({ codigo: null, saida: e.message, ms: 0, tempoEsgotado: false });
    }
    const add = (d) => {
      saida = (saida + d).slice(-6000);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    let esgotou = false;
    const t = setTimeout(() => {
      esgotou = true;
      killTree(child);
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(t);
      resolve({ codigo: null, saida: e.message, ms: Date.now() - inicio, tempoEsgotado: false });
    });
    child.on("close", (codigo) => {
      clearTimeout(t);
      resolve({ codigo, saida: saida.trim(), ms: Date.now() - inicio, tempoEsgotado: esgotou });
    });
  });
}

/**
 * Junta o relato do agente com a execução do leradev. Devolve o mapa id → resultado.
 * `anteriores` preserva as marcações manuais que você já fez.
 */
export async function conferir(cwd, testes, { relato = {}, anteriores = {}, rodar = true } = {}) {
  const out = {};
  const quando = new Date().toISOString();
  for (const t of testes ?? []) {
    const ag = relato[t.id];
    if (t.tipo === "manual") {
      const ant = anteriores[t.id];
      out[t.id] = ant?.fonte === "voce" ? ant : { status: "pendente", evidencia: ag?.evidencia ?? "", fonte: ag ? "agente" : null, quando };
      continue;
    }
    if (!rodar || !t.comando) {
      out[t.id] = ag ? { ...ag, fonte: "agente", quando } : { status: "nao_rodou", evidencia: "O agente não relatou este teste.", fonte: null, quando };
      continue;
    }
    if (isRisky(t.comando)) {
      out[t.id] = { status: "precisa_voce", evidencia: `Comando da lista de arriscados; não rodei sozinho. Relato do agente: ${ag ? `${ag.status}. ${ag.evidencia}` : "nenhum"}`, fonte: "leradev", quando };
      continue;
    }
    const r = await rodarComando(cwd, t.comando);
    const passou = r.codigo === 0 && !r.tempoEsgotado;
    out[t.id] = {
      status: passou ? "passou" : "falhou",
      evidencia: (r.tempoEsgotado ? "Tempo esgotado. " : r.codigo == null ? "Não rodou. " : `Saiu com código ${r.codigo}. `) + r.saida.slice(-1500),
      fonte: "leradev",
      agente: ag?.status ?? null,
      ms: r.ms,
      quando,
    };
  }
  return out;
}

/** Resumo para a revisão do Jev e para mensagens. */
export function resumoTestes(testes, resultados) {
  return (testes ?? [])
    .map((t) => {
      const r = resultados?.[t.id];
      return `[${t.id}] ${t.descricao}${t.comando ? ` (\`${t.comando}\`)` : " (manual)"}: ${r?.status ?? "pendente"}${r?.fonte ? ` por ${r.fonte}` : ""}${r?.evidencia ? `\n${r.evidencia.slice(-700)}` : ""}`;
    })
    .join("\n\n");
}

/** Automáticos que não passaram (bloqueiam juntar). */
export const automaticosFalhando = (testes, resultados) =>
  (testes ?? []).filter((t) => t.tipo === "automatico" && resultados?.[t.id]?.status !== "passou");
/** Manuais ainda sem "passou" (bloqueiam entregar). */
export const manuaisPendentes = (testes, resultados) => (testes ?? []).filter((t) => t.tipo === "manual" && resultados?.[t.id]?.status !== "passou");
