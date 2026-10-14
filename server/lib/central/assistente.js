// Assistente de briefing: conversa com você antes de o time começar.
//
//   1. Você escreve a ideia. Uma ferramenta (Claude Code por padrão, só leitura) lê o projeto e
//      faz só as perguntas que importam, com respostas sugeridas.
//   2. Com as respostas, ela devolve o briefing: objetivo, premissas, critérios de aceite,
//      validações iniciais, riscos, fora do escopo e a EQUIPE (tarefas com ferramenta e
//      agentes do catálogo de cada uma, distribuídas pelos pontos fortes de cada ferramenta).
//   3. O Jev valida o briefing (clareza, critérios testáveis, cobertura, sobreposição,
//      fidelidade à ideia, prontidão) e sugere a ferramenta de cada tarefa. Se reprovar, o
//      assistente corrige uma vez sozinho.
//   4. Você ajusta o que quiser (ferramenta, agentes, pedir mudanças) e toca em "Começar":
//      vira uma coordenação já aprovada, com as escolhas do briefing.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { appDataDir } from "../paths.js";
import { load } from "../lera-config.js";
import { invalidArgument } from "../errors.js";
import { consultar, record, config as jevConfig } from "../jev.js";
import { commands as corpus } from "../corpus.js";
import { FERRAMENTAS, detectar } from "./ferramentas.js";
import { candidatos, resolverAgentes, agentesDoPapel } from "./agentes.js";
import { conhecimentoJev } from "../rag.js";
import { limitesAtuais } from "./contas.js";
import { validarPlano, criarDoPlano, commands as coordCmds } from "./coordenador.js";
import { textoDaRodada, arquivosDoProjeto, resumoArquivos } from "./mapa-projeto.js";
import * as central from "./index.js";
import { normTestes } from "./testes.js";

const MAX_PERGUNTAS_RODADAS = 2;
const CATEGORIAS_BASE = new Set(["engineering", "design", "testing", "security", "product", "project-management", "coordenacao"]);
const TIPOS_TAREFA = ["frontend", "backend", "testes", "docs", "infra", "dados", "outro"];
const ATIVOS = new Set(["pensando", "validando"]);

// ---------- estado ----------

const sessoes = new Map();
let carregado = false;
const arq = () => path.join(appDataDir(), "state", "central", "assistentes.json");
function carregar() {
  if (carregado) return;
  carregado = true;
  try {
    for (const s of JSON.parse(fs.readFileSync(arq(), "utf8"))) {
      if (ATIVOS.has(s.status)) {
        s.status = "erro";
        s.erro = "O leradev foi fechado enquanto o assistente trabalhava. Mande uma mensagem para continuar.";
      }
      sessoes.set(s.id, s);
    }
  } catch {
    /* primeira vez */
  }
}
let timer = null;
function salvar() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(arq()), { recursive: true });
      const tmp = `${arq()}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...sessoes.values()]));
      fs.renameSync(tmp, arq());
    } catch {
      /* tenta de novo */
    }
  }, 150);
}
function sessao(id) {
  carregar();
  const s = sessoes.get(id);
  if (!s) throw invalidArgument(`Conversa com o assistente não encontrada: ${id}`);
  return s;
}
function mudar(s, patch) {
  Object.assign(s, patch, { atualizado: new Date().toISOString() });
  salvar();
  return s;
}

// ---------- contexto para o assistente ----------

function usoTexto(id) {
  const j = limitesAtuais(id);
  const partes = Object.entries(j).map(([k, v]) => `${k === "five_hour" ? "5h window" : k === "seven_day" ? "week" : k} ${Math.round((Number(v.uso) || 0) * 100)}% used`);
  return partes.length ? partes.join(", ") : "usage unknown";
}

async function ferramentasDisponiveis() {
  const det = await detectar();
  return Object.values(det)
    .filter((d) => d.ok)
    .map((d) => ({ id: d.id, nome: d.nome, perfil: FERRAMENTAS[d.id].perfil, uso: usoTexto(d.id), perto: central.pertoDoLimite(d.id) }));
}

async function catalogoParaPrompt(ideia) {
  let lista = [];
  try {
    lista = await corpus.corpus_list({});
  } catch {
    return [];
  }
  const base = lista.filter((a) => CATEGORIAS_BASE.has(a.category));
  const extras = (await candidatos(ideia, 20).catch(() => [])).filter((a) => !CATEGORIAS_BASE.has(a.category));
  const vistos = new Set();
  return [...base, ...extras].filter((a) => !vistos.has(a.slug) && vistos.add(a.slug));
}

function resumoProjeto(p) {
  try {
    const r = resumoArquivos(arquivosDoProjeto(p.pasta), 120);
    if (!r.total) return "The project folder is empty (new project).";
    return `${r.total} files. By folder: ${Object.entries(r.porPasta).map(([k, v]) => `${k} ${v}`).join(", ")}.`;
  } catch {
    return "Unknown.";
  }
}

const FORMATO = `Reply with a short message to the user in Brazilian Portuguese, then ONLY one JSON object inside a \`\`\`json code block, in one of these two shapes:

A) Questions (only when essential information is missing):
{"tipo": "perguntas", "mensagem": "...", "perguntas": [{"id": "q1", "pergunta": "...", "opcoes": ["...", "..."], "multipla": false}]}

B) The brief:
{"tipo": "briefing", "titulo": "...", "objetivo": "...", "premissas": ["..."], "criterios_aceite": ["..."], "validacoes_iniciais": [{"descricao": "...", "como": "..."}], "riscos": ["..."], "fora_do_escopo": ["..."], "equipe": [{"id": "kebab-case-id", "titulo": "...", "descricao": "...", "tipo": "frontend|backend|testes|docs|infra|dados|outro", "depende_de": [], "arquivos": ["..."], "ferramenta": "<tool id>", "agentes": ["<catalog slug>"], "porque": "...", "testes_minimos": [{"id": "kebab-id", "descricao": "...", "tipo": "automatico|manual", "comando": "npm test"}]}]}

Write every text field in Brazilian Portuguese.`;

async function promptInicial(s, p) {
  const tools = await ferramentasDisponiveis();
  const cat = await catalogoParaPrompt(s.ideia);
  s.ferramentasVistas = tools.map((t) => t.id);
  return `You are the briefing assistant of leradev, a command center that coordinates a team of AI coding tools working in parallel (each task in its own git worktree, merged at the end) on the project in the current directory. Do NOT modify, create or delete any file, and do not run commands that change anything.

Your job: turn the user's idea into a clear brief and a team plan, asking only what is really needed.

Project: "${p.nome}". ${resumoProjeto(p)}

Coding tools installed on this computer (use only these ids in "ferramenta"):
${tools.map((t) => `- ${t.id}: ${t.nome}. ${t.perfil} Current usage: ${t.uso}${t.perto ? " — NEAR ITS LIMIT, avoid it" : ""}.`).join("\n")}

Specialist agents from the catalog that can be attached to a task (use the slug; at most 3 per task; only when they materially help that task; an empty list is fine):
${cat.map((a) => `- ${a.slug} — ${a.name}: ${String(a.description ?? "").replace(/\s+/g, " ").slice(0, 110)}`).join("\n")}

The user's idea (in Portuguese):
"""
${s.ideia}
"""

How to work:
1. Look at the project quickly to understand what already exists.
2. If essential information is missing — things you cannot reasonably decide yourself, such as who the users are, the platform, must-have features, data and integrations, hard constraints — ask at most 5 short questions, each with 2 to 4 suggested answers. Do not ask about anything you can decide with a good default: state it as an assumption ("premissas") instead. You can ask questions at most ${MAX_PERGUNTAS_RODADAS} times in this conversation.
3. Otherwise, write the brief.

Rules for the team ("equipe"):
- 1 to 8 tasks, each one a concrete piece of implementation another agent can do alone, with acceptance criteria and how to validate it inside "descricao".
- Distribute the work across the installed tools according to their strengths. When several tools are installed and the tasks differ, do not give everything to the same tool. Explain the choice in "porque".
- Minimize file overlap between tasks; use "depende_de" when a task needs another task's result. If the project is empty, the first task creates the base structure.
- "testes_minimos" (per task): 1 to 4 checks that must pass for that step to count as done. "automatico" has a non-destructive shell command that exits 0 on success (tests, build, lint); "manual" is what a person checks by looking at the running result in the preview (open the screen, click, see the data). Every task needs at least one; prefer automatic ones when the project can run them.
- "validacoes_iniciais": the checks that prove the work is done — commands (tests, build, lint) or quick manual checks on screen, each with "como" (how to run or check it).

${FORMATO}`;
}

function promptRespostas(s, respostas, extra) {
  const perguntas = s.perguntas ?? [];
  const linhas = perguntas.map((q) => {
    const r = respostas?.[q.id];
    const v = Array.isArray(r) ? r.join("; ") : r;
    return `- ${q.pergunta}\n  Answer: ${v && String(v).trim() ? String(v).trim().slice(0, 1000) : "(no answer — decide with a sensible default and list it as an assumption)"}`;
  });
  const ultima = s.rodadasPerguntas >= MAX_PERGUNTAS_RODADAS;
  return `Answers from the user:
${linhas.join("\n") || "- (none)"}
${extra ? `\nMore from the user:\n"""\n${String(extra).slice(0, 4000)}\n"""\n` : ""}
${ultima ? "Do not ask more questions: write the brief now (tipo \"briefing\"), deciding any open point yourself and listing it in \"premissas\"." : "Ask again only if something essential is still missing; otherwise write the brief."}

${FORMATO}`;
}

const promptPular = () => `The user wants to skip the questions. Decide every open point yourself with sensible defaults, list them in "premissas", and write the brief now (tipo "briefing").

${FORMATO}`;

const promptMudancas = (texto) => `The user wants changes to the brief:
"""
${String(texto).slice(0, 4000)}
"""
Reply with the COMPLETE updated brief (tipo "briefing"), keeping what the user did not ask to change.

${FORMATO}`;

const promptCorrecaoJev = (problemas) => `The Jev (the decision model that validates the brief) found these problems:
${problemas.map((p) => `- ${p}`).join("\n")}

Fix them and reply with the COMPLETE corrected brief (tipo "briefing"). Do not ask questions now.

${FORMATO}`;

// ---------- leitura da resposta ----------

export function extrairResposta(texto) {
  const s = String(texto ?? "");
  const blocos = [...s.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]).reverse();
  if (!blocos.length && s.includes("{")) blocos.push(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1));
  for (const b of blocos) {
    try {
      const o = JSON.parse(b.trim());
      if (o && (o.tipo === "perguntas" || o.tipo === "briefing")) {
        const fora = s.replace(/```(?:json)?[\s\S]*?```/g, "").trim();
        return { ...o, _texto: fora };
      }
    } catch {
      /* próximo */
    }
  }
  return null;
}

const lista = (v, max = 20, tam = 600) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => String(typeof x === "object" ? (x.descricao ?? JSON.stringify(x)) : x).trim().slice(0, tam)).filter(Boolean).slice(0, max);

function normPerguntas(o) {
  const perguntas = (Array.isArray(o.perguntas) ? o.perguntas : []).slice(0, 6).map((q, i) => ({
    id: String(q?.id ?? `q${i + 1}`).replace(/[^\w-]/g, "_").slice(0, 24) || `q${i + 1}`,
    pergunta: String(q?.pergunta ?? "").trim().slice(0, 400),
    opcoes: lista(q?.opcoes, 6, 200),
    multipla: !!q?.multipla,
  })).filter((q) => q.pergunta);
  const ids = new Set();
  for (const q of perguntas) {
    while (ids.has(q.id)) q.id += "_";
    ids.add(q.id);
  }
  return perguntas;
}

/** Normaliza o briefing: plano válido, ferramentas instaladas, agentes que existem. */
async function normBriefing(o, instaladas) {
  const avisos = [];
  const plano = validarPlano({ resumo: o.objetivo, tarefas: o.equipe });
  let catalogo = new Map();
  try {
    catalogo = new Map((await corpus.corpus_list({})).map((a) => [a.slug, a]));
  } catch {
    /* sem catálogo */
  }
  const brutos = new Map((Array.isArray(o.equipe) ? o.equipe : []).map((t, i) => [plano.tarefas[i]?.id, t]));
  const equipe = plano.tarefas.map((t) => {
    const b = brutos.get(t.id) ?? {};
    let ferramenta = String(b.ferramenta ?? "").toLowerCase();
    if (!instaladas.includes(ferramenta)) {
      const pref = { frontend: ["cursor", "claude", "codex", "antigravity"], testes: ["codex", "claude", "cursor", "antigravity"] }[t.tipo] ?? ["claude", "codex", "cursor", "antigravity"];
      const nova = pref.find((f) => instaladas.includes(f)) ?? instaladas[0];
      if (ferramenta) avisos.push(`${t.titulo}: "${ferramenta}" não está instalado; usei ${FERRAMENTAS[nova]?.nome ?? nova}.`);
      ferramenta = nova;
    }
    const agentes = [];
    for (const slug of lista(b.agentes, 6, 120)) {
      const a = catalogo.get(slug);
      if (!a) {
        avisos.push(`${t.titulo}: agente "${slug}" não existe no catálogo e foi tirado.`);
        continue;
      }
      if (agentes.length < 3 && !agentes.some((x) => x.slug === slug)) agentes.push({ slug, nome: a.name, emoji: a.emoji ?? null });
    }
    return { ...t, ferramenta, agentes, porque: String(b.porque ?? "").trim().slice(0, 400) };
  });
  return {
    briefing: {
      titulo: String(o.titulo ?? plano.tarefas[0]?.titulo ?? "Briefing").trim().slice(0, 120),
      objetivo: String(o.objetivo ?? "").trim().slice(0, 4000),
      premissas: lista(o.premissas),
      criterios_aceite: lista(o.criterios_aceite),
      validacoes_iniciais: (Array.isArray(o.validacoes_iniciais) ? o.validacoes_iniciais : []).slice(0, 15).map((v) => (typeof v === "string" ? { descricao: v.slice(0, 400), como: "" } : { descricao: String(v?.descricao ?? "").slice(0, 400), como: String(v?.como ?? "").slice(0, 400) })).filter((v) => v.descricao),
      riscos: lista(o.riscos),
      fora_do_escopo: lista(o.fora_do_escopo),
      equipe,
    },
    avisos,
  };
}

// ---------- validação do Jev ----------

export const NIVEIS_PRONTIDAO = [
  "Not ready: the goal or the tasks are too vague or wrong for agents to start.",
  "Needs work: agents could start, but important decisions or criteria are missing.",
  "Ready with minor gaps: agents can start; small details can be settled along the way.",
  "Ready: clear goal, testable criteria and a well-split team plan.",
];
const PRONTIDAO_PT = ["não está pronto", "precisa de ajustes", "pronto com pequenas lacunas", "pronto"];

export async function validarBriefing({ ideia, briefing, projeto, instaladas }) {
  const b = briefing;
  const opcoes = Object.fromEntries(instaladas.map((id) => [id, `${FERRAMENTAS[id].nome}: ${FERRAMENTAS[id].perfil}`]));
  const contexto = {
    project: projeto,
    user_idea: ideia,
    brief: {
      title: b.titulo,
      goal: b.objetivo,
      assumptions: b.premissas,
      acceptance_criteria: b.criterios_aceite,
      checks: b.validacoes_iniciais.map((v) => `${v.descricao}${v.como ? ` (${v.como})` : ""}`),
      out_of_scope: b.fora_do_escopo,
    },
    tasks: Object.fromEntries(b.equipe.map((t) => [t.id, { title: t.titulo, description: t.descricao.slice(0, 1200), kind: t.tipo, depends_on: t.depende_de, files: t.arquivos, tool: t.ferramenta, min_tests: (t.testes_minimos ?? []).map((x) => `${x.tipo === "manual" ? "manual" : `\`${x.comando}\``}: ${x.descricao}`) }])),
  };
  const perguntas = {
    clareza: { tipo: "decidir", pergunta: "Is the goal clear and specific enough for coding agents to start working without asking more questions?" },
    criterios: { tipo: "decidir", pergunta: "Are the acceptance criteria objective and verifiable by tests, commands or a quick manual check?" },
    cobertura: { tipo: "decidir", pergunta: "Do the team's tasks, taken together, cover the whole goal and every acceptance criterion?" },
    sobreposicao: { tipo: "decidir", pergunta: "Do two or more tasks overlap substantially (same files or same responsibility), so that their work is likely to conflict?" },
    testes: { tipo: "decidir", pergunta: "Do each task's minimum tests (`tasks.*.min_tests`) actually prove that task's part of the acceptance criteria, with automatic commands where the project can run them?" },
    fiel: { tipo: "decidir", pergunta: "Does the brief stay faithful to `user_idea`, without dropping what the user asked for or adding large features the user did not ask for?" },
    prontidao: { tipo: "avaliar", pergunta: "How ready is this brief and team plan to hand to the coding agents?", niveis: NIVEIS_PRONTIDAO },
  };
  if (instaladas.length > 1) {
    for (const t of b.equipe) perguntas[`rota_${t.id}`.replace(/[^\w-]/g, "_")] = { tipo: "escolher", pergunta: `Which coding tool is the best fit to carry out the task \`tasks.${t.id}\`?`, opcoes, incluir_outra: false };
  }
  const regras = await conhecimentoJev(`${ideia} ${b.titulo} ${b.objetivo}`);
  if (regras) contexto.team_knowledge = regras;
  const r = await consultar({ contexto, perguntas });
  record({ ...r, pergunta: `Briefing: ${b.titulo}`.slice(0, 160), agente: "Assistente de briefing", ferramenta: "leradev", contexto: ideia.slice(0, 400) });
  const R = r.respostas;
  const problemas = [];
  if (R.clareza.zona !== "sim") problemas.push("O objetivo ainda não está claro o bastante para os agentes começarem sem perguntar.");
  if (R.criterios.zona !== "sim") problemas.push("Os critérios de aceite não são todos verificáveis (por teste, comando ou checagem rápida na tela).");
  if (R.cobertura.zona !== "sim") problemas.push("As tarefas da equipe não cobrem todo o objetivo e todos os critérios de aceite.");
  if (R.sobreposicao.zona !== "nao") problemas.push("Há tarefas que se sobrepõem (mesmos arquivos ou mesma responsabilidade) e podem conflitar.");
  if (R.testes.zona !== "sim") problemas.push("Os testes mínimos de alguma etapa não provam o que ela entrega (ou faltam comandos automáticos onde dá para ter).");
  if (R.fiel.zona !== "sim") problemas.push("O briefing pode ter se afastado da ideia original (faltou algo pedido ou entrou algo não pedido).");
  if (R.prontidao.nivel < 2) problemas.push(`Prontidão avaliada como "${PRONTIDAO_PT[R.prontidao.nivel]}".`);
  const sugestoes = {};
  for (const t of b.equipe) {
    const a = R[`rota_${t.id}`.replace(/[^\w-]/g, "_")];
    if (!a) continue;
    const top = a.ranking[0];
    sugestoes[t.id] = { ferramenta: a.zona === "clara" ? a.escolha : null, probabilidade: top.probabilidade, ranking: a.ranking.slice(0, 4), zona: a.zona };
  }
  return {
    aprovado: !problemas.length,
    problemas,
    itens: {
      clareza: R.clareza.probabilidade_sim,
      criterios: R.criterios.probabilidade_sim,
      cobertura: R.cobertura.probabilidade_sim,
      sobreposicao: R.sobreposicao.probabilidade_sim,
      fiel: R.fiel.probabilidade_sim,
      testes: R.testes.probabilidade_sim,
    },
    prontidao: { nivel: R.prontidao.nivel, texto: PRONTIDAO_PT[R.prontidao.nivel] },
    sugestoes,
    ref: r.ref,
    custoUsd: r.custo_usd ?? null,
    quando: new Date().toISOString(),
  };
}

// ---------- conversa ----------

const porTarefa = new Map(); // tarefaId → sessão id

async function falar(s, texto, { voce, rotulo } = {}) {
  if (ATIVOS.has(s.status)) throw invalidArgument("O assistente ainda está trabalhando. Espere a resposta.");
  if (voce) s.mensagens.push({ de: "voce", texto: voce, quando: new Date().toISOString() });
  mudar(s, { status: "pensando", erro: null, etapa: rotulo ?? "lendo e pensando" });
  porTarefa.set(s.tarefaId, s.id);
  try {
    await central.enviar(s.tarefaId, texto);
  } catch (e) {
    porTarefa.delete(s.tarefaId);
    mudar(s, { status: "erro", erro: e.payload?.message ?? e.message });
    throw e;
  }
  return publica(s);
}

async function onFim(t, evt) {
  const id = porTarefa.get(t.id);
  if (!id) return;
  porTarefa.delete(t.id);
  const s = sessoes.get(id);
  if (!s || s.tarefaId !== t.id) return;
  if (!evt.ok) {
    mudar(s, { status: s.briefing ? "pronto" : "erro", erro: evt.parada ? "Parado por você." : `O assistente não terminou: ${evt.erro ?? "sem resposta"}` });
    return;
  }
  const o = extrairResposta(textoDaRodada(t, evt));
  if (!o) {
    s.mensagens.push({ de: "assistente", texto: (evt.texto ?? t.ultimaMensagem ?? "").slice(0, 3000), quando: new Date().toISOString() });
    mudar(s, { status: s.briefing ? "pronto" : "erro", erro: "A resposta veio sem o bloco JSON esperado. Mande uma mensagem pedindo para ele responder no formato." });
    return;
  }
  if (o.tipo === "perguntas") {
    const perguntas = normPerguntas(o);
    if (perguntas.length && (s.rodadasPerguntas ?? 0) < MAX_PERGUNTAS_RODADAS) {
      s.rodadasPerguntas = (s.rodadasPerguntas ?? 0) + 1;
      s.mensagens.push({ de: "assistente", texto: String(o.mensagem ?? o._texto ?? "").slice(0, 3000), perguntas, quando: new Date().toISOString() });
      mudar(s, { status: "perguntas", perguntas, erro: null });
      return;
    }
    // perguntou demais: pede o briefing
    porTarefa.set(t.id, s.id);
    mudar(s, { status: "pensando", etapa: "montando o briefing" });
    s.rodadasPerguntas = MAX_PERGUNTAS_RODADAS;
    await central.enviar(t.id, promptPular()).catch((e) => mudar(s, { status: "erro", erro: e.message }));
    return;
  }
  // briefing
  const instaladas = Object.values(await detectar()).filter((d) => d.ok).map((d) => d.id);
  let nb;
  try {
    nb = await normBriefing(o, instaladas.length ? instaladas : Object.keys(FERRAMENTAS));
  } catch (e) {
    if (!s.correcaoFormato) {
      s.correcaoFormato = true;
      porTarefa.set(t.id, s.id);
      mudar(s, { status: "pensando", etapa: "corrigindo o plano" });
      await central.enviar(t.id, `The team plan is invalid: ${e.message}\nFix it and reply with the COMPLETE brief.\n\n${FORMATO}`).catch((err) => mudar(s, { status: "erro", erro: err.message }));
      return;
    }
    mudar(s, { status: "erro", erro: `O plano da equipe veio inválido: ${e.message}` });
    return;
  }
  s.versao = (s.versao ?? 0) + 1;
  s.mensagens.push({ de: "assistente", texto: String(o.mensagem ?? o._texto ?? "Montei o briefing.").slice(0, 3000), briefing: s.versao, quando: new Date().toISOString() });
  mudar(s, { briefing: nb.briefing, avisos: nb.avisos, perguntas: null, status: "validando", etapa: "o Jev está validando" });
  let val;
  const p = central.projeto(s.projetoId);
  if (!jevConfig().key) val = { semJev: true, aprovado: null, problemas: [], erro: "Sem a chave do Jev: o briefing não foi validado." };
  else {
    try {
      val = await validarBriefing({ ideia: s.ideia, briefing: nb.briefing, projeto: p.nome, instaladas });
    } catch (e) {
      val = { semJev: true, aprovado: null, problemas: [], erro: `Jev indisponível: ${e.message}` };
    }
  }
  if (val.aprovado === false && !s.correcaoJev) {
    s.correcaoJev = true;
    s.mensagens.push({ de: "jev", texto: `pediu ajustes antes de seguir: ${val.problemas.join(" ")} O assistente está corrigindo.`, quando: new Date().toISOString() });
    porTarefa.set(t.id, s.id);
    mudar(s, { validacao: val, status: "pensando", etapa: "corrigindo o que o Jev apontou" });
    await central.enviar(t.id, promptCorrecaoJev(val.problemas)).catch((e) => mudar(s, { status: "erro", erro: e.message }));
    return;
  }
  mudar(s, { validacao: val, status: "pronto", etapa: null });
}

central.eventos.on("fim", (t, e) => {
  onFim(t, e).catch((err) => {
    const id = porTarefa.get(t.id) ?? [...sessoes.values()].find((s) => s.tarefaId === t.id)?.id;
    const s = id && sessoes.get(id);
    if (s) mudar(s, { status: "erro", erro: err.message });
    console.error("[assistente]", err);
  });
});

// ---------- montar a coordenação ----------

function objetivoCompleto(b) {
  const sec = (titulo, itens) => (itens?.length ? `\n\n${titulo}:\n${itens.map((x) => `- ${x}`).join("\n")}` : "");
  return `${b.titulo}\n\n${b.objetivo}`
    + sec("Premissas", b.premissas)
    + sec("Critérios de aceite", b.criterios_aceite)
    + sec("Validações", b.validacoes_iniciais.map((v) => `${v.descricao}${v.como ? ` (${v.como})` : ""}`))
    + sec("Fora do escopo", b.fora_do_escopo);
}

function publica(s) {
  let tarefa = null;
  try {
    const t = central.tarefa(s.tarefaId);
    tarefa = { id: t.id, rodando: !!t.rodando, ferramenta: t.ferramenta, status: t.status, pendentes: central.publica(t).pendentes?.length ?? 0 };
  } catch {
    /* sem tarefa */
  }
  return { ...s, tarefa };
}

export const commands = {
  async assistente_criar({ projetoId, ideia, ferramenta }) {
    carregar();
    const p = central.projeto(projetoId);
    const texto = String(ideia ?? "").trim();
    if (texto.length < 5) throw invalidArgument("Conte a sua ideia em pelo menos uma frase.");
    const det = await detectar();
    const instaladas = Object.values(det).filter((d) => d.ok).map((d) => d.id);
    if (!instaladas.length) throw invalidArgument("Nenhuma ferramenta de código encontrada.");
    const pref = ferramenta && ferramenta !== "auto" ? ferramenta : load().central.assistente?.ferramenta ?? "claude";
    const ferr = instaladas.includes(pref) ? pref : instaladas.includes("claude") ? "claude" : instaladas.includes("codex") ? "codex" : instaladas[0];
    const s = {
      id: crypto.randomBytes(4).toString("hex"),
      projetoId: p.id,
      ideia: texto.slice(0, 8000),
      ferramenta: ferr,
      status: "pensando",
      etapa: "lendo o projeto",
      criado: new Date().toISOString(),
      atualizado: new Date().toISOString(),
      mensagens: [{ de: "voce", texto: texto.slice(0, 8000), quando: new Date().toISOString() }],
      perguntas: null,
      rodadasPerguntas: 0,
      briefing: null,
      validacao: null,
      coordId: null,
    };
    const prompt = await promptInicial(s, p);
    const t = await central.criarTarefa({
      projetoId: p.id,
      ferramenta: ferr,
      prompt,
      // só leitura: Claude em dontAsk (nunca pede nada), Codex com sandbox read-only
      autonomia: "perguntar",
      modoClaude: "dontAsk",
      titulo: `Briefing: ${texto.split("\n")[0].slice(0, 70)}`,
      agente: `Assistente · ${p.nome}`.slice(0, 60),
      agentes: await agentesDoPapel("assistente"),
      oculta: true,
      papel: "assistente",
      consultaRag: texto,
    });
    s.tarefaId = t.id;
    sessoes.set(s.id, s);
    porTarefa.set(t.id, s.id);
    // a tarefa pode ter terminado (erro ao iniciar) antes de registrarmos
    if (["erro", "parada"].includes(t.status)) await onFim(t, { ok: false, erro: t.ultimaMensagem });
    salvar();
    return publica(s);
  },
  assistente_listar({ projetoId } = {}) {
    carregar();
    return [...sessoes.values()]
      .filter((s) => !s.descartada && (!projetoId || s.projetoId === projetoId))
      .sort((a, b) => String(b.atualizado).localeCompare(String(a.atualizado)))
      .slice(0, 30)
      .map((s) => ({ id: s.id, projetoId: s.projetoId, titulo: s.briefing?.titulo ?? s.ideia.split("\n")[0].slice(0, 90), status: s.status, etapa: s.etapa ?? null, coordId: s.coordId, atualizado: s.atualizado, aprovado: s.validacao?.aprovado ?? null }));
  },
  assistente_obter({ id }) {
    return publica(sessao(id));
  },
  assistente_responder({ id, respostas, texto }) {
    const s = sessao(id);
    if (s.status !== "perguntas") throw invalidArgument("O assistente não está esperando respostas.");
    const resumo = (s.perguntas ?? []).map((q) => `${q.pergunta} → ${[respostas?.[q.id]].flat().filter(Boolean).join("; ") || "(você decide)"}`).join("\n");
    return falar(s, promptRespostas(s, respostas, texto), { voce: [resumo, texto].filter(Boolean).join("\n\n"), rotulo: "montando o briefing" });
  },
  assistente_pular({ id }) {
    const s = sessao(id);
    if (s.status !== "perguntas") throw invalidArgument("O assistente não está esperando respostas.");
    s.rodadasPerguntas = MAX_PERGUNTAS_RODADAS;
    return falar(s, promptPular(), { voce: "Pode decidir o resto você mesmo.", rotulo: "montando o briefing" });
  },
  assistente_mensagem({ id, texto }) {
    const s = sessao(id);
    const msg = String(texto ?? "").trim();
    if (!msg) throw invalidArgument("Escreva o que quer mudar.");
    if (s.coordId) throw invalidArgument("Este briefing já virou uma coordenação.");
    if (s.status === "perguntas") return commands.assistente_responder({ id, respostas: {}, texto: msg });
    s.correcaoJev = false; // nova versão pode ter uma correção automática de novo
    return falar(s, s.briefing ? promptMudancas(msg) : `${msg}\n\n${FORMATO}`, { voce: msg, rotulo: "ajustando o briefing" });
  },
  async assistente_ajustar({ id, tarefa, ferramenta, agentes, testes }) {
    const s = sessao(id);
    if (!s.briefing || s.coordId) throw invalidArgument("Não há briefing para ajustar.");
    const t = s.briefing.equipe.find((x) => x.id === tarefa);
    if (!t) throw invalidArgument("Tarefa não encontrada no briefing.");
    if (ferramenta !== undefined) {
      if (!FERRAMENTAS[ferramenta]) throw invalidArgument(`Ferramenta desconhecida: ${ferramenta}`);
      t.ferramenta = ferramenta;
      t.porque = "escolhida por você";
    }
    if (agentes !== undefined) {
      t.agentes = (await resolverAgentes(agentes)).map(({ prob: _p, ...a }) => a);
    }
    if (testes !== undefined) t.testes_minimos = normTestes(testes, t.id);
    mudar(s, {});
    return publica(s);
  },
  async assistente_catalogo() {
    try {
      return (await corpus.corpus_list({})).map((a) => ({ slug: a.slug, nome: a.name, emoji: a.emoji ?? null, categoria: a.category ?? null }));
    } catch {
      return [];
    }
  },
  async assistente_lancar({ id, autonomia }) {
    const s = sessao(id);
    if (s.coordId) throw invalidArgument("Este briefing já virou uma coordenação.");
    if (s.status !== "pronto" || !s.briefing) throw invalidArgument("O briefing ainda não está pronto.");
    const b = s.briefing;
    const rotas = Object.fromEntries(b.equipe.map((t) => [t.id, {
      ferramenta: t.ferramenta,
      motivo: t.porque ? `briefing: ${t.porque}` : "escolhida no briefing",
      jev: s.validacao?.sugestoes?.[t.id] ? { ranking: s.validacao.sugestoes[t.id].ranking, zona: s.validacao.sugestoes[t.id].zona } : null,
    }]));
    const agentesTarefa = Object.fromEntries(b.equipe.map((t) => [t.id, t.agentes.map((a) => ({ ...a, prob: null }))]));
    const c = criarDoPlano({
      projetoId: s.projetoId,
      objetivo: objetivoCompleto(b),
      plano: { resumo: b.objetivo, tarefas: b.equipe },
      rotas,
      agentesTarefa,
      autonomia,
      origem: { assistente: s.id },
    });
    mudar(s, { coordId: c.id, status: "lancado" });
    try {
      await coordCmds.coord_aprovar({ id: c.id });
      return { coordId: c.id, aviso: null };
    } catch (e) {
      // ex.: mudanças sem commit; a coordenação fica esperando você aprovar na tela dela
      return { coordId: c.id, aviso: e.payload?.message ?? e.message };
    }
  },
  assistente_parar({ id }) {
    const s = sessao(id);
    if (!ATIVOS.has(s.status)) throw invalidArgument("O assistente não está trabalhando agora.");
    try {
      central.parar(s.tarefaId);
    } catch {
      /* já parou */
    }
    porTarefa.delete(s.tarefaId);
    return publica(mudar(s, { status: s.briefing ? "pronto" : s.perguntas ? "perguntas" : "erro", erro: "Parado por você." }));
  },
  assistente_descartar({ id }) {
    const s = sessao(id);
    if (ATIVOS.has(s.status)) commands.assistente_parar({ id });
    mudar(s, { descartada: true });
    return { ok: true };
  },
};
