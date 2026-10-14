// Coordenador: transforma um objetivo em plano, escolhe a ferramenta de cada tarefa com o
// Jev, roda as tarefas em paralelo (cada uma na sua cópia do projeto, um git worktree),
// revisa cada resultado com o Jev e junta tudo numa branch de integração. No fim, você
// leva o resultado para a sua branch com um botão.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { appDataDir } from "../paths.js";
import { load } from "../lera-config.js";
import { invalidArgument } from "../errors.js";
import { registrar } from "../atividades.js";
import { consultar, revisarMudanca, record, JevError } from "../jev.js";
import { FERRAMENTAS, detectar, ignorarLera } from "./ferramentas.js";
import { git, hasCommits, status as gitStatus, branchAtual } from "./git.js";
import * as central from "./index.js";
import { normTestes, instrucaoTestes, relatorioDoAgente, conferir, resumoTestes, automaticosFalhando, manuaisPendentes } from "./testes.js";
import { textoDaRodada } from "./mapa-projeto.js";
import { resolverAgentes, agentesDoPapel } from "./agentes.js";
import { conhecimentoJev } from "../rag.js";
import { pararPasta } from "../previa.js";

const ESTADOS_FINAIS = new Set(["juntada", "sem_mudancas", "descartada"]);
const coords = new Map();
let carregado = false;
const file = () => path.join(appDataDir(), "state", "central", "coordenacoes.json");

function carregar() {
  if (carregado) return;
  carregado = true;
  try {
    for (const c of JSON.parse(fs.readFileSync(file(), "utf8"))) {
      if (c.status === "planejando") {
        c.status = "erro";
        c.erro = "O leradev foi fechado durante o planejamento. Crie de novo.";
      }
      for (const e of Object.values(c.execucao ?? {})) {
        if (["rodando", "ajustando", "revisando", "resolvendo"].includes(e.status)) {
          e.status = "erro";
          e.motivo = "O leradev foi fechado enquanto esta tarefa rodava. Use 'tentar de novo'.";
        }
      }
      coords.set(c.id, c);
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
      fs.mkdirSync(path.dirname(file()), { recursive: true });
      const tmp = `${file()}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...coords.values()]));
      fs.renameSync(tmp, file());
    } catch {
      /* tenta de novo */
    }
  }, 200);
}
function log(c, texto) {
  c.log ??= [];
  c.log.push({ quando: new Date().toISOString(), texto });
  if (c.log.length > 200) c.log.shift();
  c.atualizado = new Date().toISOString();
  salvar();
}
function coord(id) {
  carregar();
  const c = coords.get(id);
  if (!c) throw invalidArgument(`Coordenação não encontrada: ${id}`);
  return c;
}

// ---------- plano ----------

const TIPOS = ["frontend", "backend", "testes", "docs", "infra", "dados", "outro"];

function promptPlanejamento(objetivo) {
  return `You are the planning step of a software coordinator. Do NOT change any file and do not run commands that modify anything.

Goal from the user (in Portuguese):
"""
${objetivo}
"""

Explore the project in the current directory as needed. Then split the goal into 2 to 8 concrete implementation tasks that different coding agents will carry out in separate git worktrees, to be merged later. Minimize overlap of files between tasks, and use "depende_de" when a task needs another task's result. If the project is empty, the first task should create the base structure the others build on.

End your reply with ONLY a JSON object inside a \`\`\`json code block, with exactly this shape:
{"resumo": "...", "tarefas": [{"id": "kebab-case-id", "titulo": "...", "descricao": "...", "depende_de": [], "tipo": "frontend|backend|testes|docs|infra|dados|outro", "arquivos": ["..."], "testes_minimos": [{"id": "kebab-id", "descricao": "...", "tipo": "automatico|manual", "comando": "npm test"}]}]}

Write "resumo", "titulo", "descricao" and the tests' "descricao" in Brazilian Portuguese. Each "descricao" must be self-contained: what to build, the acceptance criteria and the files likely involved.
"testes_minimos": 1 to 4 checks that must pass for that task to count as done. Use "automatico" with a non-destructive shell command that exits 0 on success (tests, build, lint, a script) whenever the project can have one; use "manual" for what a person must check by looking at the result (for example in the preview: open the screen, click the button, see the data).`;
}

export function extrairPlano(texto) {
  const blocos = [...String(texto ?? "").matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const candidatos = blocos.length ? blocos.reverse() : [String(texto ?? "").slice(String(texto ?? "").indexOf("{"))];
  for (const c of candidatos) {
    try {
      return validarPlano(JSON.parse(c.trim()));
    } catch (e) {
      if (e instanceof PlanoInvalido) throw e;
    }
  }
  throw new PlanoInvalido("A resposta do planejamento não trouxe um plano em JSON.");
}
class PlanoInvalido extends Error {}

export function validarPlano(p) {
  const lista = Array.isArray(p?.tarefas) ? p.tarefas : null;
  if (!lista?.length) throw new PlanoInvalido("O plano não tem tarefas.");
  if (lista.length > 12) throw new PlanoInvalido("O plano tem tarefas demais (máximo 12).");
  const tarefas = lista.map((t, i) => {
    const id = String(t.id ?? `t${i + 1}`).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || `t${i + 1}`;
    return {
      id,
      titulo: String(t.titulo ?? id).trim().slice(0, 90),
      descricao: String(t.descricao ?? "").trim().slice(0, 4000),
      depende_de: Array.isArray(t.depende_de) ? t.depende_de.map(String) : [],
      tipo: TIPOS.includes(t.tipo) ? t.tipo : "outro",
      arquivos: Array.isArray(t.arquivos) ? t.arquivos.map(String).slice(0, 30) : [],
      testes_minimos: normTestes(t.testes_minimos, id),
    };
  });
  const ids = new Set();
  for (const t of tarefas) {
    if (ids.has(t.id)) throw new PlanoInvalido(`Tarefa repetida no plano: ${t.id}`);
    ids.add(t.id);
  }
  for (const t of tarefas) {
    t.depende_de = t.depende_de.filter((d) => d !== t.id);
    for (const d of t.depende_de) if (!ids.has(d)) throw new PlanoInvalido(`A tarefa ${t.id} depende de ${d}, que não existe.`);
  }
  // sem ciclos
  const visit = new Map();
  const byId = new Map(tarefas.map((t) => [t.id, t]));
  const dfs = (id) => {
    if (visit.get(id) === 1) throw new PlanoInvalido("O plano tem dependências em círculo.");
    if (visit.get(id) === 2) return;
    visit.set(id, 1);
    for (const d of byId.get(id).depende_de) dfs(d);
    visit.set(id, 2);
  };
  tarefas.forEach((t) => dfs(t.id));
  return { resumo: String(p.resumo ?? "").slice(0, 1000), tarefas };
}

// ---------- rotas ----------

function rotaPadrao(tipo, ok) {
  const pref = { frontend: ["cursor", "claude", "codex", "antigravity"], testes: ["codex", "claude", "cursor", "antigravity"], docs: ["claude", "antigravity", "codex", "cursor"] }[tipo] ?? ["claude", "codex", "cursor", "antigravity"];
  return pref.find((f) => ok.includes(f)) ?? ok[0];
}

async function rotear(c) {
  const det = await detectar();
  const instaladas = Object.values(det).filter((d) => d.ok).map((d) => d.id);
  if (!instaladas.length) throw invalidArgument("Nenhuma ferramenta de código encontrada.");
  const livres = instaladas.filter((id) => !central.pertoDoLimite(id));
  const ok = livres.length ? livres : instaladas;
  c.rotas = {};
  for (const t of c.plano.tarefas) c.rotas[t.id] = { ferramenta: rotaPadrao(t.tipo, ok), motivo: "padrão pelo tipo da tarefa", jev: null };
  if (ok.length === 1) {
    for (const r of Object.values(c.rotas)) r.motivo = "única ferramenta instalada";
    return;
  }
  const opcoes = Object.fromEntries(ok.map((id) => [id, `${FERRAMENTAS[id].nome}: ${FERRAMENTAS[id].perfil}`]));
  try {
    const r = await consultar({
      contexto: {
        goal: c.objetivo,
        tasks: Object.fromEntries(c.plano.tarefas.map((t) => [t.id, { title: t.titulo, description: t.descricao.slice(0, 1500), kind: t.tipo, depends_on: t.depende_de }])),
      },
      perguntas: c.plano.tarefas.map((t) => ({
        id: `rota_${t.id}`.replace(/[^\w-]/g, "_"),
        tipo: "escolher",
        pergunta: `Which coding tool is the best fit to carry out the task \`tasks.${t.id}\`?`,
        opcoes,
        incluir_outra: false,
      })),
    });
    record({ ...r, pergunta: `Rotas do plano: ${c.objetivo.slice(0, 120)}`, agente: "Coordenador", ferramenta: "leradev", contexto: c.objetivo.slice(0, 400) });
    for (const t of c.plano.tarefas) {
      const a = r.respostas[`rota_${t.id}`.replace(/[^\w-]/g, "_")];
      if (!a) continue;
      const top = a.ranking[0];
      c.rotas[t.id] = {
        // Na dúvida, fica com a mais provável do Jev (se tiver pelo menos 40%) em vez de cair
        // sempre no padrão do tipo, que manda quase tudo para o Claude Code.
        ferramenta: a.zona === "clara" && a.escolha ? a.escolha : top && top.probabilidade >= 0.4 && FERRAMENTAS[top.rotulo] ? top.rotulo : c.rotas[t.id].ferramenta,
        motivo: a.zona === "clara"
          ? `Jev: ${Math.round(top.probabilidade * 100)}%`
          : `Jev em dúvida (${a.ranking.map((x) => `${FERRAMENTAS[x.rotulo]?.nome ?? x.rotulo} ${Math.round(x.probabilidade * 100)}%`).join(", ")}); ${top && top.probabilidade >= 0.4 ? "usando a mais provável" : "usando o padrão do tipo"}`,
        jev: { ranking: a.ranking, zona: a.zona },
      };
    }
  } catch (e) {
    for (const r of Object.values(c.rotas)) r.motivo = `padrão pelo tipo (Jev indisponível: ${e instanceof JevError ? e.message.split(".")[0] : e.message})`;
  }
}

// ---------- escritório ----------

function office(c) {
  const total = c.plano?.tarefas?.length ?? 0;
  const feitas = Object.values(c.execucao ?? {}).filter((e) => ESTADOS_FINAIS.has(e.status)).length;
  const pendVoce = Object.values(c.execucao ?? {}).some((e) => ["aguardando_voce", "conflito", "erro"].includes(e.status));
  const status = { planejando: "trabalhando", plano_pronto: "aguardando", executando: pendVoce ? "aguardando" : "trabalhando", concluida: "concluido", entregue: "concluido", erro: "erro", parada: "bloqueado", descartada: "bloqueado" }[c.status] ?? "trabalhando";
  let projeto = c.projetoId;
  try {
    projeto = central.projeto(c.projetoId).nome;
  } catch {
    /* removido */
  }
  try {
    registrar({
      agente: `Coordenador · ${projeto}`.slice(0, 60),
      tarefa: c.objetivo.split("\n")[0].slice(0, 120),
      progresso: c.status === "planejando" ? 5 : c.status === "plano_pronto" ? 10 : total ? Math.round(10 + (90 * feitas) / total) : 0,
      status,
      mensagem: c.log?.at(-1)?.texto?.slice(0, 200) ?? null,
      ferramenta: "leradev",
      projeto: c.projetoId,
    });
  } catch {
    /* só acompanhamento */
  }
}

// ---------- execução ----------

const wtDir = (c, nome) => path.join(central.projeto(c.projetoId).pasta, ".lera", "wt", `${c.id}-${nome}`);
const branchTarefa = (c, tid) => `lera/c-${c.id}/t-${tid}`;

function promptTarefa(c, t) {
  const outras = c.plano.tarefas.filter((x) => x.id !== t.id).map((x) => `- ${x.titulo}`).join("\n");
  return `Você faz parte de um time de agentes coordenado pelo leradev.

Objetivo geral do projeto:
${c.objetivo}

Sua tarefa: ${t.titulo}
${t.descricao}
${t.arquivos?.length ? `\nArquivos prováveis: ${t.arquivos.join(", ")}` : ""}

Outras tarefas do plano, feitas por outros agentes em paralelo (não faça o trabalho delas):
${outras || "- nenhuma"}

Regras:
- Trabalhe só nesta pasta.
- Não faça commit, push nem crie branches: o leradev cuida disso e junta o trabalho de todos.
- Se o projeto tiver testes, rode e corrija o que quebrar por causa da sua mudança.
- Termine com um resumo curto, em português, do que fez e de como testar.${instrucaoTestes(t.testes_minimos)}`;
}

function contaRodando(c) {
  return Object.values(c.execucao).filter((e) => ["rodando", "ajustando", "revisando", "resolvendo"].includes(e.status)).length;
}

async function tick(c) {
  if (c.status !== "executando") return;
  const limite = load().central.paralelo ?? 3;
  for (const t of c.plano.tarefas) {
    const e = c.execucao[t.id];
    if (e.status !== "esperando") continue;
    const deps = t.depende_de.map((d) => c.execucao[d]);
    if (deps.some((d) => d.status === "descartada")) {
      e.status = "aguardando_voce";
      e.motivo = `Depende de uma tarefa descartada (${t.depende_de.filter((d) => c.execucao[d].status === "descartada").join(", ")}). Inicie mesmo assim ou descarte.`;
      log(c, `${t.titulo}: esperando você (dependência descartada).`);
      continue;
    }
    if (!deps.every((d) => d.status === "juntada" || d.status === "sem_mudancas")) continue;
    if (contaRodando(c) >= limite) break;
    await iniciarTarefaPlano(c, t);
  }
  const todos = Object.values(c.execucao);
  if (todos.every((e) => ESTADOS_FINAIS.has(e.status))) {
    c.status = todos.some((e) => e.status === "juntada") ? "concluida" : "erro";
    if (c.status === "erro") c.erro = "Nenhuma tarefa foi juntada.";
    log(c, c.status === "concluida" ? "Tudo pronto na branch de integração. Revise e leve para a sua branch." : c.erro);
  }
  salvar();
  office(c);
}

async function iniciarTarefaPlano(c, t, { ignorarDeps = false } = {}) {
  const e = c.execucao[t.id];
  const pasta = central.projeto(c.projetoId).pasta;
  const wt = wtDir(c, t.id);
  const branch = branchTarefa(c, t.id);
  if (!fs.existsSync(wt)) {
    const r = git(pasta, ["worktree", "add", "-b", branch, wt, c.integracao]);
    if (r.code !== 0) {
      e.status = "erro";
      e.motivo = `Não consegui criar a cópia de trabalho: ${r.stderr.trim().slice(0, 300)}`;
      log(c, `${t.titulo}: erro ao criar a cópia de trabalho.`);
      return;
    }
  }
  e.worktree = wt;
  e.branch = branch;
  e.status = "rodando";
  e.motivo = null;
  try {
    const ferr = c.rotas[t.id].ferramenta;
    const tarefa = await central.criarTarefa({
      projetoId: c.projetoId,
      cwd: wt,
      ferramenta: ferr,
      prompt: promptTarefa(c, t) + (ignorarDeps ? "\n\nObs.: uma tarefa de que esta dependia foi descartada; faça o necessário para esta funcionar sozinha." : ""),
      autonomia: c.autonomia,
      titulo: t.titulo,
      agente: `${FERRAMENTAS[ferr].nome} · ${t.titulo}`.slice(0, 60),
      coordId: c.id,
      coordTarefa: t.id,
      textoAgentes: `${t.titulo}\n${t.descricao}`,
      // agentes escolhidos no briefing (por tarefa) têm prioridade sobre o modo geral
      agentes: c.agentesTarefa?.[t.id] ?? c.agentes ?? "auto",
    });
    e.tarefaId = tarefa.id;
    log(c, `${t.titulo}: começou com ${FERRAMENTAS[ferr].nome}.`);
  } catch (err) {
    e.status = "erro";
    e.motivo = err.payload?.message ?? err.message;
    log(c, `${t.titulo}: não começou (${e.motivo}).`);
  }
}

function testesCapturados(tarefaId) {
  try {
    const t = central.tarefa(tarefaId);
    return central
      .eventosDe(t)
      .filter((e) => e.t === "ferramenta_fim" && /test|spec|passed|failed|vitest|jest|pytest/i.test(e.saida ?? ""))
      .slice(-3)
      .map((e) => e.saida.slice(-800))
      .join("\n---\n");
  } catch {
    return "";
  }
}

async function revisarEJuntar(c, t) {
  const e = c.execucao[t.id];
  e.status = "revisando";
  salvar();
  // commit na cópia da tarefa
  let r;
  try {
    r = central.commitTudo(e.worktree, `lera: ${t.titulo}`);
  } catch (err) {
    e.status = "erro";
    e.motivo = err.payload?.message ?? err.message;
    log(c, `${t.titulo}: erro no commit (${e.motivo}).`);
    return;
  }
  const temMudanca = git(e.worktree, ["rev-list", "--count", `${c.integracao}..${e.branch}`]).stdout.trim() !== "0";
  if (!temMudanca) {
    e.status = "sem_mudancas";
    log(c, `${t.titulo}: terminou sem mudar arquivos.`);
    removerWorktree(c, t.id);
    return;
  }
  if (r.commit) e.commit = r.commit;
  // testes mínimos: relato do agente + execução do leradev na cópia da tarefa
  let relato = {};
  try {
    relato = relatorioDoAgente(textoDaRodada(central.tarefa(e.tarefaId), null));
  } catch {
    /* sem relato */
  }
  if (t.testes_minimos?.length) {
    log(c, `${t.titulo}: conferindo ${t.testes_minimos.length} teste(s) mínimo(s)…`);
    e.testes = await conferir(e.worktree, t.testes_minimos, { relato, anteriores: e.testes ?? {}, rodar: load().central.testes?.rodar !== false });
    salvar();
    const falhando = automaticosFalhando(t.testes_minimos, e.testes);
    if (falhando.length) {
      const lista = falhando.map((x) => `[${x.id}] ${x.descricao}${x.comando ? ` (\`${x.comando}\`)` : ""}: ${e.testes[x.id]?.status}\n${cortarMeio(e.testes[x.id]?.evidencia ?? "", 900)}`).join("\n\n");
      if ((e.tentativas ?? 0) < 1) {
        e.tentativas = (e.tentativas ?? 0) + 1;
        e.status = "ajustando";
        log(c, `${t.titulo}: ${falhando.length} teste(s) mínimo(s) não passaram; voltou para ${FERRAMENTAS[c.rotas[t.id].ferramenta].nome}.`);
        try {
          await central.enviar(e.tarefaId, `Os testes mínimos desta etapa não passaram quando o leradev rodou na sua pasta:\n\n${lista}\n\nCorrija, rode de novo e termine com o bloco json dos testes. Não faça commit.`);
        } catch (err) {
          e.status = "erro";
          e.motivo = err.payload?.message ?? err.message;
        }
        return;
      }
      e.status = "aguardando_voce";
      e.motivo = `Testes mínimos não passaram: ${falhando.map((x) => x.descricao).join("; ")}. Abra a prévia, rode de novo, peça ajuste ou junte mesmo assim.`;
      log(c, `${t.titulo}: esperando você (testes mínimos).`);
      return;
    }
  }
  const diff = git(e.worktree, ["diff", `${c.integracao}...${e.branch}`]).stdout;
  const arquivos = git(e.worktree, ["diff", "--name-only", `${c.integracao}...${e.branch}`]).stdout.split("\n").filter(Boolean);
  let rev;
  try {
    rev = await revisarMudanca({
      objetivo: `${c.objetivo}\n\nThis change is the task: ${t.titulo}. ${t.descricao}`,
      mudanca: diff,
      testes: [t.testes_minimos?.length ? `Minimum tests for this step (run by leradev in the task's folder):\n${resumoTestes(t.testes_minimos, e.testes)}` : "", testesCapturados(e.tarefaId)].filter(Boolean).join("\n\n") || "No test output was captured.",
      arquivos,
      conhecimento: await conhecimentoJev(`${t.titulo} ${t.descricao}`, e.worktree),
    });
    record({ ...rev, agente: `Revisor · ${t.titulo}`.slice(0, 60), ferramenta: "leradev", contexto: t.titulo });
  } catch (err) {
    rev = { veredito: "humano", motivos: [`Jev indisponível: ${err.message}`], ref: null };
  }
  e.revisao = { veredito: rev.veredito, motivos: rev.motivos, ref: rev.ref ?? null, risco: rev.respostas?.risco?.nivel_texto ?? null };
  if (rev.veredito === "aprovar") return juntar(c, t);
  if ((rev.veredito === "ajustar" || rev.veredito === "refazer") && (e.tentativas ?? 0) < 1) {
    e.tentativas = (e.tentativas ?? 0) + 1;
    e.status = "ajustando";
    log(c, `${t.titulo}: o Jev pediu ajustes; voltou para ${FERRAMENTAS[c.rotas[t.id].ferramenta].nome}.`);
    try {
      await central.enviar(e.tarefaId, `O revisor (Jev) pediu ajustes antes de juntar este trabalho:\n- ${rev.motivos.join("\n- ")}\n\nFaça os ajustes, rode os testes e termine com um resumo curto. Não faça commit.`);
    } catch (err) {
      e.status = "erro";
      e.motivo = err.payload?.message ?? err.message;
    }
    return;
  }
  e.status = "aguardando_voce";
  e.motivo = `Revisão do Jev: ${rev.veredito}. ${rev.motivos.join(" ")}`;
  log(c, `${t.titulo}: esperando você (${rev.veredito}).`);
}

function juntar(c, t) {
  const e = c.execucao[t.id];
  const r = git(c.integWt, ["merge", "--no-ff", "--no-edit", "-m", `lera: juntar ${t.titulo}`, e.branch]);
  if (r.code !== 0) {
    git(c.integWt, ["merge", "--abort"]);
    e.status = "conflito";
    e.motivo = "As mudanças desta tarefa conflitam com o que já foi juntado. Peça para resolver ou descarte.";
    log(c, `${t.titulo}: conflito ao juntar.`);
    return;
  }
  e.status = "juntada";
  e.motivo = null;
  log(c, `${t.titulo}: juntada na integração.`);
  removerWorktree(c, t.id);
}

function removerWorktree(c, tid) {
  const e = c.execucao[tid];
  if (!e?.worktree) return;
  pararPasta(e.worktree);
  try {
    git(central.projeto(c.projetoId).pasta, ["worktree", "remove", "--force", e.worktree]);
  } catch {
    /* fica para a limpeza final */
  }
}

async function onFim(t, evt) {
  if (!t.coordId) return;
  carregar();
  const c = coords.get(t.coordId);
  if (!c) return;
  if (t.coordTarefa === "__plano__") return onPlano(c, t, evt);
  if (t.coordTarefa?.startsWith("__conflito__:")) return onConflitoResolvido(c, t.coordTarefa.slice(13), evt);
  const tp = c.plano?.tarefas.find((x) => x.id === t.coordTarefa);
  const e = c.execucao?.[t.coordTarefa];
  if (!tp || !e || e.tarefaId !== t.id) return;
  if (evt.parada) {
    e.status = "erro";
    e.motivo = "Parada.";
  } else if (!evt.ok) {
    e.status = "erro";
    e.motivo = evt.erro ?? "A ferramenta não terminou.";
    log(c, `${tp.titulo}: erro (${e.motivo.slice(0, 120)}).`);
  } else {
    await revisarEJuntar(c, tp);
  }
  await tick(c);
}

async function onPlano(c, t, evt) {
  if (!evt.ok) {
    c.status = "erro";
    c.erro = `O planejamento falhou: ${evt.erro ?? "sem resposta"}`;
    log(c, c.erro);
    office(c);
    return;
  }
  try {
    c.plano = extrairPlano(evt.texto ?? t.ultimaMensagem);
  } catch (e) {
    c.status = "erro";
    c.erro = e.message;
    log(c, c.erro);
    office(c);
    return;
  }
  log(c, `Plano com ${c.plano.tarefas.length} tarefas. Escolhendo as ferramentas…`);
  await rotear(c);
  c.status = "plano_pronto";
  log(c, "Plano pronto. Revise e aprove para começar.");
  office(c);
  salvar();
}

async function onConflitoResolvido(c, tid, evt) {
  const t = c.plano.tarefas.find((x) => x.id === tid);
  const e = c.execucao[tid];
  if (!t || !e) return;
  const juntou = git(c.integWt, ["merge-base", "--is-ancestor", e.branch, "HEAD"]).code === 0;
  const mergeHead = git(c.integWt, ["rev-parse", "--git-path", "MERGE_HEAD"]).stdout.trim();
  const meio = !!mergeHead && fs.existsSync(path.resolve(c.integWt, mergeHead));
  if (evt.ok && juntou && !meio) {
    e.status = "juntada";
    e.motivo = null;
    log(c, `${t.titulo}: conflito resolvido e juntado.`);
    removerWorktree(c, tid);
  } else {
    if (meio) git(c.integWt, ["merge", "--abort"]);
    e.status = "conflito";
    e.motivo = "A resolução do conflito não terminou. Tente de novo ou descarte.";
    log(c, `${t.titulo}: conflito continua.`);
  }
  await tick(c);
}

central.eventos.on("fim", (t, e) => {
  onFim(t, e).catch((err) => console.error("[coordenador]", err));
});

// ---------- comandos ----------

function publica(c) {
  const exec = {};
  for (const [k, e] of Object.entries(c.execucao ?? {})) {
    let tarefa = null;
    if (e.tarefaId) {
      try {
        const t = central.tarefa(e.tarefaId);
        tarefa = { id: t.id, status: t.status, progresso: central.publica(t).progresso, pendentes: central.publica(t).pendentes.length, ultimaMensagem: t.ultimaMensagem, ferramenta: t.ferramenta };
      } catch {
        /* sem tarefa */
      }
    }
    exec[k] = { ...e, tarefa };
  }
  let projeto = null;
  try {
    projeto = central.projeto(c.projetoId);
  } catch {
    /* removido */
  }
  return { ...c, execucao: exec, projeto, pendenciasTestes: pendenciasTestes(c) };
}

/**
 * Cria uma coordenação a partir de um plano pronto (o briefing do assistente), com a
 * ferramenta e os agentes de cada tarefa já escolhidos. Fica em "plano_pronto"; quem chama
 * aprova em seguida (coord_aprovar).
 */
export function criarDoPlano({ projetoId, objetivo, plano, rotas, agentesTarefa, autonomia, origem }) {
  carregar();
  const p = central.projeto(projetoId);
  let valido;
  try {
    valido = validarPlano(plano);
  } catch (e) {
    throw invalidArgument(e.message);
  }
  const c = {
    id: crypto.randomBytes(4).toString("hex"),
    projetoId: p.id,
    objetivo: String(objetivo).trim(),
    autonomia: autonomia ?? load().central.autonomia ?? "editar",
    agentes: "nenhum",
    agentesTarefa: agentesTarefa ?? {},
    origem: origem ?? null,
    status: "plano_pronto",
    criado: new Date().toISOString(),
    atualizado: new Date().toISOString(),
    plano: valido,
    rotas: {},
    execucao: {},
    log: [],
  };
  for (const t of valido.tarefas) {
    const r = rotas?.[t.id];
    if (!r?.ferramenta || !FERRAMENTAS[r.ferramenta]) throw invalidArgument(`Escolha a ferramenta da tarefa ${t.titulo}.`);
    c.rotas[t.id] = { ferramenta: r.ferramenta, motivo: r.motivo ?? "escolhida no briefing", jev: r.jev ?? null };
  }
  coords.set(c.id, c);
  log(c, `Plano do briefing com ${valido.tarefas.length} tarefa(s).`);
  office(c);
  salvar();
  return c;
}

/** Mantém o começo (status, código de saída) e o fim (o erro) de uma saída longa. */
function cortarMeio(t, n) {
  return t.length <= n ? t : `${t.slice(0, 160)}\n[…]\n${t.slice(-(n - 160))}`;
}

/** Testes mínimos sem "passou" nas tarefas juntadas (o que vai para a sua branch). */
function pendenciasTestes(c) {
  const out = [];
  for (const t of c.plano?.tarefas ?? []) {
    const e = c.execucao?.[t.id];
    if (!e || e.status !== "juntada") continue;
    for (const x of [...automaticosFalhando(t.testes_minimos, e.testes), ...manuaisPendentes(t.testes_minimos, e.testes)]) {
      out.push({ tarefaId: t.id, tarefa: t.titulo, testeId: x.id, descricao: x.descricao, tipo: x.tipo, status: e.testes?.[x.id]?.status ?? "pendente" });
    }
  }
  return out;
}

/** Pasta onde o trabalho da tarefa está agora: a cópia dela, ou a integração depois de juntada. */
export function pastaDaTarefa(c, tid) {
  const e = c.execucao?.[tid];
  if (e?.worktree && fs.existsSync(e.worktree)) return e.worktree;
  if (c.integWt && fs.existsSync(c.integWt)) return c.integWt;
  return null;
}

export const commands = {
  async coord_testes_rodar({ id, tarefa: tid }) {
    const c = coord(id);
    const t = c.plano?.tarefas.find((x) => x.id === tid);
    const e = c.execucao?.[tid];
    if (!t || !e) throw invalidArgument("Tarefa não encontrada.");
    if (!t.testes_minimos?.length) throw invalidArgument("Esta etapa não tem testes mínimos.");
    const pasta = pastaDaTarefa(c, tid);
    if (!pasta) throw invalidArgument("A cópia desta tarefa não existe mais.");
    e.testes = await conferir(pasta, t.testes_minimos, { anteriores: e.testes ?? {}, relato: Object.fromEntries(Object.entries(e.testes ?? {}).filter(([, r]) => r.fonte === "agente")) });
    log(c, `${t.titulo}: testes mínimos rodados de novo (${t.testes_minimos.filter((x) => e.testes[x.id]?.status === "passou").length}/${t.testes_minimos.length} passaram).`);
    salvar();
    return publica(c);
  },
  /** Agrega ou desagrega agentes de uma etapa (vale para a próxima rodada dela). */
  async coord_agentes_definir({ id, tarefa: tid, agentes }) {
    const c = coord(id);
    const t = c.plano?.tarefas.find((x) => x.id === tid);
    if (!t) throw invalidArgument("Tarefa não encontrada.");
    const lista = await resolverAgentes(agentes);
    c.agentesTarefa ??= {};
    c.agentesTarefa[tid] = lista;
    const e = c.execucao?.[tid];
    if (e?.tarefaId) {
      try {
        await central.commands.tarefa_agentes_definir({ id: e.tarefaId, agentes: lista.map((a) => a.slug) });
      } catch {
        /* tarefa antiga */
      }
    }
    log(c, `${t.titulo}: agentes ${lista.length ? lista.map((a) => a.nome).join(", ") : "nenhum"}.`);
    salvar();
    return publica(c);
  },
  coord_teste_marcar({ id, tarefa: tid, teste, status, nota }) {
    const c = coord(id);
    const t = c.plano?.tarefas.find((x) => x.id === tid);
    const e = c.execucao?.[tid];
    if (!t || !e) throw invalidArgument("Tarefa não encontrada.");
    const x = t.testes_minimos?.find((y) => y.id === teste);
    if (!x) throw invalidArgument("Teste não encontrado.");
    if (!["passou", "falhou", "pendente"].includes(status)) throw invalidArgument(`Status inválido: ${status}`);
    e.testes ??= {};
    e.testes[teste] = { ...(e.testes[teste] ?? {}), status, evidencia: String(nota ?? e.testes[teste]?.evidencia ?? "").slice(0, 600), fonte: "voce", quando: new Date().toISOString() };
    log(c, `${t.titulo}: você marcou "${x.descricao}" como ${status}.`);
    salvar();
    return publica(c);
  },
  async coord_criar({ projetoId, objetivo, autonomia, agentes }) {
    carregar();
    const p = central.projeto(projetoId);
    const texto = String(objetivo ?? "").trim();
    if (texto.length < 10) throw invalidArgument("Descreva o objetivo com um pouco mais de detalhe.");
    const det = await detectar();
    if (!det.claude?.ok) throw invalidArgument("O planejamento usa o Claude Code, que não foi encontrado neste computador.");
    const c = {
      id: crypto.randomBytes(4).toString("hex"),
      projetoId: p.id,
      objetivo: texto,
      autonomia: autonomia ?? load().central.autonomia ?? "editar",
      agentes: agentes === "nenhum" ? "nenhum" : "auto",
      status: "planejando",
      criado: new Date().toISOString(),
      atualizado: new Date().toISOString(),
      plano: null,
      rotas: {},
      execucao: {},
      log: [],
    };
    coords.set(c.id, c);
    log(c, "Planejando com o Claude Code (só leitura, sem alterar nada)…");
    office(c);
    const t = await central.criarTarefa({
      projetoId: p.id,
      ferramenta: "claude",
      prompt: promptPlanejamento(texto),
      autonomia: "perguntar",
      // dontAsk: só leitura e comandos somente-leitura; nunca pede nada a você.
      modoClaude: "dontAsk",
      titulo: `Planejar: ${texto.split("\n")[0].slice(0, 70)}`,
      agente: `Coordenador · ${p.nome}`.slice(0, 60),
      coordId: c.id,
      coordTarefa: "__plano__",
      oculta: true,
      agentes: await agentesDoPapel("planejador"),
      papel: "planejador",
      consultaRag: texto,
    });
    c.tarefaPlano = t.id;
    salvar();
    return publica(c);
  },
  coord_listar({ projetoId } = {}) {
    carregar();
    return [...coords.values()]
      .filter((c) => !projetoId || c.projetoId === projetoId)
      .filter((c) => c.status !== "descartada")
      .sort((a, b) => String(b.atualizado).localeCompare(String(a.atualizado)))
      .map(publica);
  },
  coord_obter({ id }) {
    return publica(coord(id));
  },
  coord_ajustar({ id, tarefa, ferramenta }) {
    const c = coord(id);
    if (c.status !== "plano_pronto") throw invalidArgument("Só dá para mudar a ferramenta antes de aprovar o plano.");
    if (!c.rotas[tarefa]) throw invalidArgument("Tarefa não encontrada no plano.");
    if (!FERRAMENTAS[ferramenta]) throw invalidArgument("Ferramenta desconhecida.");
    c.rotas[tarefa] = { ...c.rotas[tarefa], ferramenta, motivo: "escolhida por você" };
    salvar();
    return publica(c);
  },
  async coord_aprovar({ id }) {
    const c = coord(id);
    if (c.status !== "plano_pronto") throw invalidArgument("O plano não está esperando aprovação.");
    const pasta = central.projeto(c.projetoId).pasta;
    ignorarLera(pasta);
    const sujos = gitStatus(pasta);
    if (sujos.length) {
      throw invalidArgument(`Há ${sujos.length} arquivo(s) com mudanças sem commit no projeto. Faça um commit antes, para os agentes partirem da versão atual.`);
    }
    if (!hasCommits(pasta)) {
      const r = git(pasta, ["commit", "--allow-empty", "-m", "lera: início do projeto"]);
      if (r.code !== 0) throw invalidArgument(/user\.(name|email)|who you are/i.test(r.stderr) ? 'O git ainda não sabe seu nome. No PowerShell: git config --global user.name "Seu Nome" e git config --global user.email "voce@exemplo.com".' : r.stderr.trim());
    }
    c.branchBase = branchAtual(pasta);
    c.base = git(pasta, ["rev-parse", "HEAD"]).stdout.trim();
    c.integracao = `lera/c-${c.id}/integracao`;
    c.integWt = wtDir(c, "integracao");
    const r = git(pasta, ["worktree", "add", "-b", c.integracao, c.integWt, c.base]);
    if (r.code !== 0) throw invalidArgument(`Não consegui criar a branch de integração: ${r.stderr.trim()}`);
    c.execucao = Object.fromEntries(c.plano.tarefas.map((t) => [t.id, { status: "esperando", tentativas: 0 }]));
    c.status = "executando";
    log(c, `Aprovado. Integração em ${c.integracao}, a partir de ${c.branchBase}.`);
    await tick(c);
    return publica(c);
  },
  async coord_decidir({ id, tarefa: tid, acao, mensagem }) {
    const c = coord(id);
    const t = c.plano?.tarefas.find((x) => x.id === tid);
    const e = c.execucao?.[tid];
    if (!t || !e) throw invalidArgument("Tarefa não encontrada.");
    const msg = String(mensagem ?? "").trim();
    switch (acao) {
      case "juntar":
        if (!["aguardando_voce"].includes(e.status)) throw invalidArgument("Esta tarefa não está esperando sua aprovação.");
        juntar(c, t);
        break;
      case "ajustar":
        if (!["aguardando_voce", "erro"].includes(e.status) || !e.tarefaId) throw invalidArgument("Não dá para pedir ajuste agora.");
        if (!msg) throw invalidArgument("Escreva o que precisa mudar.");
        e.status = "ajustando";
        await central.enviar(e.tarefaId, `${msg}\n\nNão faça commit. Termine com um resumo curto.`);
        log(c, `${t.titulo}: você pediu ajustes.`);
        break;
      case "tentar_de_novo":
        if (!["erro", "aguardando_voce"].includes(e.status)) throw invalidArgument("Esta tarefa não está com erro.");
        if (e.tarefaId) {
          e.status = "rodando";
          await central.enviar(e.tarefaId, msg || "Continue a tarefa de onde parou. Não faça commit.");
        } else await iniciarTarefaPlano(c, t);
        log(c, `${t.titulo}: tentando de novo.`);
        break;
      case "iniciar":
        if (e.status !== "aguardando_voce" || e.tarefaId) throw invalidArgument("Esta tarefa não está esperando para começar.");
        await iniciarTarefaPlano(c, t, { ignorarDeps: true });
        break;
      case "resolver_conflito": {
        if (e.status !== "conflito") throw invalidArgument("Esta tarefa não está em conflito.");
        e.status = "resolvendo";
        const ferr = (await detectar()).claude?.ok ? "claude" : c.rotas[tid].ferramenta;
        const rt = await central.criarTarefa({
          projetoId: c.projetoId,
          cwd: c.integWt,
          ferramenta: ferr,
          prompt: `Nesta pasta está a branch de integração de um time de agentes. Rode \`git merge --no-ff ${e.branch}\`, resolva os conflitos preservando as duas intenções (a tarefa "${t.titulo}" e o que já foi juntado), rode os testes do projeto e conclua o merge com commit. Não faça push.`,
          autonomia: "editar",
          titulo: `Resolver conflito: ${t.titulo}`.slice(0, 90),
          agente: `${FERRAMENTAS[ferr].nome} · conflito`.slice(0, 60),
          coordId: c.id,
          coordTarefa: `__conflito__:${tid}`,
        });
        e.tarefaConflito = rt.id;
        log(c, `${t.titulo}: ${FERRAMENTAS[ferr].nome} vai resolver o conflito (os comandos pedem sua aprovação).`);
        break;
      }
      case "descartar":
        if (["rodando", "ajustando", "revisando", "resolvendo"].includes(e.status) && e.tarefaId) {
          try { central.parar(e.tarefaId); } catch { /* já parou */ }
        }
        e.status = "descartada";
        removerWorktree(c, tid);
        log(c, `${t.titulo}: descartada por você.`);
        break;
      default:
        throw invalidArgument("Ação desconhecida.");
    }
    await tick(c);
    return publica(c);
  },
  coord_parar({ id }) {
    const c = coord(id);
    for (const e of Object.values(c.execucao ?? {})) {
      if (e.tarefaId) {
        try { central.parar(e.tarefaId); } catch { /* não estava rodando */ }
      }
    }
    if (c.tarefaPlano && c.status === "planejando") {
      try { central.parar(c.tarefaPlano); } catch { /* ok */ }
    }
    c.status = "parada";
    log(c, "Parada por você.");
    office(c);
    salvar();
    return publica(c);
  },
  coord_retomar({ id }) {
    const c = coord(id);
    if (c.status !== "parada" || !c.integracao) throw invalidArgument("Só dá para retomar uma coordenação parada depois de aprovada.");
    c.status = "executando";
    for (const e of Object.values(c.execucao)) if (["rodando", "ajustando", "revisando", "resolvendo"].includes(e.status)) { e.status = "erro"; e.motivo = "Parada; use tentar de novo."; }
    log(c, "Retomada.");
    tick(c);
    return publica(c);
  },
  coord_diff({ id }) {
    const c = coord(id);
    if (!c.integracao) throw invalidArgument("Ainda não há nada juntado.");
    const pasta = central.projeto(c.projetoId).pasta;
    const d = git(pasta, ["diff", c.base, c.integracao]).stdout;
    return { diff: d.length > 300000 ? d.slice(0, 300000) + "\n[... cortado ...]\n" : d, arquivos: git(pasta, ["diff", "--name-status", c.base, c.integracao]).stdout.split("\n").filter(Boolean) };
  },
  coord_entregar({ id, forcar }) {
    const c = coord(id);
    if (c.status !== "concluida") throw invalidArgument("A coordenação ainda não terminou.");
    const pend = pendenciasTestes(c);
    if (pend.length && !forcar) {
      throw invalidArgument(`Faltam ${pend.length} teste(s) mínimo(s) para conferir antes de levar para a sua branch:\n- ${pend.map((x) => `${x.tarefa}: ${x.descricao}`).join("\n- ")}`);
    }
    if (pend.length) log(c, `Levado com ${pend.length} teste(s) mínimo(s) sem conferir (você escolheu).`);
    const pasta = central.projeto(c.projetoId).pasta;
    if (gitStatus(pasta).length) throw invalidArgument("Há mudanças sem commit na pasta do projeto. Faça commit ou desfaça antes de levar o resultado.");
    const atual = branchAtual(pasta);
    if (atual !== c.branchBase) throw invalidArgument(`O projeto está na branch ${atual}; volte para ${c.branchBase} antes.`);
    const r = git(pasta, ["merge", "--no-ff", "-m", `lera: ${c.objetivo.split("\n")[0].slice(0, 70)}`, c.integracao]);
    if (r.code !== 0) {
      git(pasta, ["merge", "--abort"]);
      throw invalidArgument(`A sua branch mudou e conflita com o resultado: ${r.stderr.trim().slice(0, 300)}`);
    }
    limpar(c);
    c.status = "entregue";
    log(c, `Levado para ${c.branchBase}.`);
    office(c);
    salvar();
    return publica(c);
  },
  coord_descartar({ id }) {
    const c = coord(id);
    commands.coord_parar({ id });
    limpar(c, { apagarBranches: true });
    c.status = "descartada";
    log(c, "Descartada.");
    salvar();
    return { ok: true };
  },
};

function limpar(c, { apagarBranches = false } = {}) {
  let pasta;
  try {
    pasta = central.projeto(c.projetoId).pasta;
  } catch {
    return;
  }
  for (const tid of Object.keys(c.execucao ?? {})) removerWorktree(c, tid);
  if (c.integWt) {
    pararPasta(c.integWt);
    git(pasta, ["worktree", "remove", "--force", c.integWt]);
  }
  git(pasta, ["worktree", "prune"]);
  for (const tid of Object.keys(c.execucao ?? {})) git(pasta, ["branch", "-D", branchTarefa(c, tid)]);
  if (apagarBranches && c.integracao) git(pasta, ["branch", "-D", c.integracao]);
}

export const _paraTestes = { coords, tick };
