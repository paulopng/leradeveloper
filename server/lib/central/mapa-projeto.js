// Mapa de arquitetura de cada projeto: telas, APIs, banco, MCP/automações, IA e RAG...
//
// Fluxo de "Gerar mapa":
//   1. Uma tarefa da Central (ferramenta e agente do catálogo configuráveis por projeto) lê o
//      projeto sem alterar nada e responde com o mapa em JSON (formato de server/lib/mapas.js).
//   2. O leradeveloper valida o formato. O Jev confere o mapa contra a lista de arquivos do
//      projeto: cada camada, partes importantes faltando, ligações entre camadas e completude.
//   3. Se o Jev reprovar ou ficar em dúvida, a mesma conversa recebe uma rodada de correção.
//   4. O mapa vai para <projeto>/.lera/mapa.json com o resultado do Jev e aparece no Mapas 3D.
//
// Configuração por projeto (lera.json → central.projetos[i].mapa):
//   { camadas: [{ id, rotulo, descricao }], ferramenta: "claude"|"codex"|..., agente: slug|"nenhum"|null }
import fs from "node:fs";
import path from "node:path";
import { load, update } from "../lera-config.js";
import { appDataDir } from "../paths.js";
import { invalidArgument } from "../errors.js";
import { consultar, record } from "../jev.js";
import { validate, arquivoMapaProjeto, PREFIXO_PROJETO, TIPOS } from "../mapas.js";
import { commands as corpus } from "../corpus.js";
import { FERRAMENTAS } from "./ferramentas.js";
import { git, isRepo } from "./git.js";
import * as central from "./index.js";

// Camadas sugeridas. "descricao" vai para a ferramenta e para o Jev (você pode editar).
export const CAMADAS_PADRAO = [
  { id: "tela", rotulo: "Telas", descricao: "Telas, páginas, componentes, botões e formulários, navegação e como cada tela é renderizada (SSR, SSG, CSR, pré-renderização, hidratação)." },
  { id: "api", rotulo: "APIs", descricao: "Endpoints HTTP/RPC, método e rota, síncrono ou assíncrono, filas e workers, eventos e webhooks, health checks e serviços externos chamados." },
  { id: "dados", rotulo: "Banco", descricao: "Tabelas ou coleções do banco, colunas principais, relações entre elas e quais APIs ou jobs leem e gravam cada uma." },
  { id: "mcp", rotulo: "MCP e automações", descricao: "Servidores e ferramentas MCP, scripts, jobs agendados, pipelines de CI, bots e outras automações." },
  { id: "ia", rotulo: "IA e RAG", descricao: "Chamadas e provedores de LLM, prompts, agentes, embeddings, índices vetoriais, pipelines de recuperação (RAG) e avaliação." },
];
export const CAMADAS_EXTRAS = [
  { id: "infra", rotulo: "Infra", descricao: "Hospedagem, containers, ambientes, segredos e configuração, observabilidade (logs, métricas, alertas)." },
  { id: "testes", rotulo: "Testes", descricao: "Testes unitários, de integração e ponta a ponta, e que parte do sistema cada suíte cobre." },
];
const ID_CAMADA = /^[a-z][a-z0-9-]{0,23}$/;

// ---------- estado (por projeto) ----------

const arqEstado = () => path.join(appDataDir(), "state", "central", "mapas.json");
let estado = null;
function est() {
  if (!estado) {
    try {
      estado = JSON.parse(fs.readFileSync(arqEstado(), "utf8"));
    } catch {
      estado = {};
    }
    // Se o app fechou no meio, a geração não continua sozinha.
    for (const s of Object.values(estado)) {
      if (["gerando", "validando", "corrigindo"].includes(s.status)) {
        s.status = "erro";
        s.erro = "O leradeveloper foi fechado durante a geração. Gere de novo.";
      }
    }
  }
  return estado;
}
function salvar() {
  try {
    fs.mkdirSync(path.dirname(arqEstado()), { recursive: true });
    fs.writeFileSync(arqEstado(), JSON.stringify(estado ?? {}, null, 2));
  } catch {
    /* segue em memória */
  }
}
function setEstado(projetoId, patch) {
  const s = (est()[projetoId] = { ...(est()[projetoId] ?? {}), ...patch, atualizado: new Date().toISOString() });
  salvar();
  return s;
}

// ---------- configuração ----------

async function agentePadrao() {
  try {
    const lista = await corpus.corpus_list({});
    const slugs = new Set(lista.map((a) => a.slug));
    return lista.find((a) => /gerador-de-mapas/.test(a.slug))?.slug ?? (slugs.has("engineering-software-architect") ? "engineering-software-architect" : null);
  } catch {
    return null;
  }
}

export async function configDe(projetoId) {
  const p = central.projeto(projetoId);
  const c = p.mapa ?? {};
  const camadas = Array.isArray(c.camadas) && c.camadas.length ? c.camadas : CAMADAS_PADRAO;
  const agente = c.agente === undefined || c.agente === null ? await agentePadrao() : c.agente;
  return { camadas, ferramenta: c.ferramenta ?? "claude", agente, personalizado: !!p.mapa };
}

function normCamadas(lista) {
  if (!Array.isArray(lista) || !lista.length) throw invalidArgument("Escolha pelo menos uma camada.");
  if (lista.length > 10) throw invalidArgument("No máximo 10 camadas.");
  const ids = new Set();
  return lista.map((c) => {
    const rotulo = String(c?.rotulo ?? "").trim().slice(0, 40);
    let id = String(c?.id ?? rotulo).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
    if (!/^[a-z]/.test(id)) id = `c-${id}`.slice(0, 24);
    if (!rotulo || !ID_CAMADA.test(id)) throw invalidArgument(`Camada inválida: ${JSON.stringify(c)}`);
    if (ids.has(id)) throw invalidArgument(`Camada repetida: ${id}`);
    ids.add(id);
    return { id, rotulo, descricao: String(c?.descricao ?? "").trim().slice(0, 400) };
  });
}

// ---------- pedido para a ferramenta ----------

const TIPOS_ARQ = "tela (screen/page), componente (UI component), botao (button/action), api (endpoint), fila (queue/topic/event bus), servico (service/worker/module), tabela (table/collection), automacao (script/job/CI), mcp (MCP server or tool), modelo (LLM/model call), indice (vector index/embeddings store), prompt (prompt/template), teste (test suite), infra (hosting/config), fonte (external data source), sistema (external system), risco (risk), ideia (other)";

export function promptMapa({ projeto, camadas, instrucoes }) {
  return `This is the architecture-map step of leradeveloper, for the project "${projeto}" in the current directory.

Read the project (do NOT modify, create or delete any file; do not run commands that change anything). Then describe its architecture as a layered graph with these layers, top to bottom:
${camadas.map((c) => `- "${c.id}" (${c.rotulo}): ${c.descricao || c.rotulo}`).join("\n")}

Rules:
- One node per real, important part found in the code (screens, key components and buttons, endpoints, queues, tables, MCP tools, automations, prompts, indexes...). Group trivial things; at most about 25 nodes per layer.
- Only describe what exists in the code. If a layer has nothing yet, add a single node with "status": "confirmar" saying it does not exist yet. If the project is empty, map what the files and docs say is planned and mark those nodes "confirmar".
- "atributos" holds short key/value facts. Use the ones that apply: screens → "rota", "renderizacao" (SSR/SSG/CSR/pre-render), "arquivo"; buttons → "acao", "chama"; APIs → "metodo", "rota", "modo" (sincrono/assincrono), "fila", "saude" (health check endpoint or "sem health check"), "auth"; tables → "colunas", "chave", "relacoes"; MCP/automations → "gatilho", "ferramentas"; AI → "provedor", "modelo", "embeddings", "indice", "top_k".
- Links ("ligacoes") go from caller to callee or from reader to data: screen → API, button → API, API → table, API → queue, worker → table, AI step → index, MCP tool → API... Use "relacao" with a short Portuguese verb ("chama", "lê", "grava", "publica em", "consome", "indexa", "consulta"). Cross-layer links are the most important part of the map. Set "fluxo": true on async paths (queues/events), "alerta": true on links with a known problem.
- "status": "ok" (works), "atencao" (partial or risky), "bloqueado" (broken), "confirmar" (not sure / planned).
- "tipo" must be one of: ${TIPOS_ARQ}.
- "peso" 1–3: how central the node is.
- Write "titulo", "subtitulo", "rotulo", "descricao" and "relacao" in Brazilian Portuguese.
${instrucoes ? `\nExtra instructions from the user:\n"""\n${instrucoes}\n"""\n` : ""}
End your reply with ONLY a JSON object inside a \`\`\`json code block, with exactly this shape:
{"titulo": "...", "subtitulo": "...", "camadas": [${camadas.map((c) => `{"id": "${c.id}", "rotulo": "${c.rotulo}"}`).join(", ")}], "nos": [{"id": "kebab-case", "camada": "<layer id>", "rotulo": "...", "tipo": "...", "status": "ok", "descricao": "...", "peso": 2, "atributos": {"chave": "valor"}}], "ligacoes": [{"de": "<node id>", "para": "<node id>", "relacao": "...", "fluxo": false, "alerta": false}]}`;
}

function promptCorrecao(problemas) {
  return `The architecture map needs another pass. Problems found:
${problemas.map((p) => `- ${p}`).join("\n")}

Re-read the relevant parts of the project (still without modifying anything), fix these problems and answer again with the COMPLETE corrected map as ONLY a JSON object inside a \`\`\`json code block, same shape and same layers as before.`;
}

// ---------- leitura da resposta ----------

function textoDaRodada(t, evt) {
  if (evt?.texto && /```/.test(evt.texto)) return evt.texto;
  const evs = central.eventosDe(t);
  let i = evs.length - 1;
  while (i >= 0 && evs[i].t !== "voce") i--;
  const textos = evs.slice(i + 1).filter((e) => e.t === "texto" && !e.sub).map((e) => e.texto);
  return [evt?.texto, ...textos.reverse()].filter(Boolean).join("\n\n");
}

/** Extrai o JSON do mapa (último bloco ```json válido) e limpa o que dá para limpar sozinho. */
export function extrairMapa(texto, camadas) {
  const s = String(texto ?? "");
  const blocos = [...s.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]).reverse();
  if (!blocos.length && s.includes("{")) blocos.push(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1));
  let raw = null;
  for (const b of blocos) {
    try {
      raw = JSON.parse(b.trim());
      if (raw && typeof raw === "object" && Array.isArray(raw.nos)) break;
      raw = null;
    } catch {
      /* tenta o próximo */
    }
  }
  if (!raw) return { problemas: ["The reply did not contain the map as a JSON object in a ```json block."] };
  const avisos = [];
  const problemas = [];
  // As camadas são as configuradas, na ordem configurada (com o rótulo em português).
  raw.camadas = camadas.map((c) => ({ id: c.id, rotulo: c.rotulo }));
  const ids = new Set(camadas.map((c) => c.id));
  const fora = (raw.nos ?? []).filter((n) => !ids.has(n?.camada));
  if (fora.length) problemas.push(`These nodes use a layer that does not exist (${[...ids].join(", ")}): ${fora.slice(0, 8).map((n) => `${n?.id} (camada "${n?.camada}")`).join(", ")}`);
  const nos = new Set((raw.nos ?? []).map((n) => n?.id));
  const antes = (raw.ligacoes ?? []).length;
  raw.ligacoes = (Array.isArray(raw.ligacoes) ? raw.ligacoes : []).filter((l) => nos.has(l?.de) && nos.has(l?.para));
  if (raw.ligacoes.length < antes) avisos.push(`${antes - raw.ligacoes.length} ligação(ões) apontavam para nós inexistentes e foram tiradas.`);
  if (problemas.length) return { problemas, avisos };
  try {
    const v = validate(raw, "mapa gerado");
    return { mapa: v.mapa, avisos: [...avisos, ...v.avisos], problemas: [] };
  } catch (e) {
    return { problemas: [String(e.payload?.message ?? e.message)], avisos };
  }
}

// ---------- validação pelo Jev ----------

function arquivosDoProjeto(pasta) {
  let lista = [];
  if (isRepo(pasta)) {
    const r = git(pasta, ["ls-files", "--cached", "--others", "--exclude-standard"]);
    lista = r.stdout.split("\n").filter(Boolean);
  }
  if (!lista.length) {
    // sem git: um passeio raso
    const pular = new Set([".git", ".lera", "node_modules", "dist", "build", ".venv", "venv", "__pycache__", ".next", "target"]);
    const andar = (dir, rel, nivel) => {
      if (nivel > 4 || lista.length > 3000) return;
      let itens = [];
      try {
        itens = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const it of itens) {
        if (pular.has(it.name)) continue;
        const r = rel ? `${rel}/${it.name}` : it.name;
        if (it.isDirectory()) andar(path.join(dir, it.name), r, nivel + 1);
        else lista.push(r);
      }
    };
    andar(pasta, "", 0);
  }
  return lista.filter((f) => !f.startsWith(".lera/"));
}

function resumoArquivos(lista, max = 400) {
  const porPasta = {};
  for (const f of lista) {
    const top = f.includes("/") ? f.split("/")[0] + "/" : "(root)";
    porPasta[top] = (porPasta[top] ?? 0) + 1;
  }
  const relevantes = lista.filter((f) => !/\.(png|jpe?g|gif|svg|ico|webp|woff2?|ttf|lock|map)$/i.test(f) && !/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(f));
  return {
    total: lista.length,
    porPasta,
    amostra: relevantes.slice(0, max).join("\n") + (relevantes.length > max ? `\n... (+${relevantes.length - max} files)` : ""),
  };
}

function resumoMapa(mapa) {
  const linhas = [];
  for (const c of mapa.camadas) {
    const nos = mapa.nos.filter((n) => n.camada === c.id);
    linhas.push(`## Layer ${c.id} (${c.rotulo}) — ${nos.length} nodes`);
    for (const n of nos) {
      const at = n.atributos ? " {" + Object.entries(n.atributos).map(([k, v]) => `${k}: ${v}`).join("; ").slice(0, 240) + "}" : "";
      linhas.push(`- ${n.id} [${n.tipo}, ${n.status}] ${n.rotulo}: ${n.descricao.slice(0, 160)}${at}`);
    }
  }
  const camadaDe = new Map(mapa.nos.map((n) => [n.id, n.camada]));
  const cruz = mapa.ligacoes.filter((l) => camadaDe.get(l.de) !== camadaDe.get(l.para));
  linhas.push(`## Links (${mapa.ligacoes.length}, ${cruz.length} cross-layer)`);
  for (const l of mapa.ligacoes.slice(0, 160)) linhas.push(`- ${l.de} --${l.relacao}${l.fluxo ? " (async)" : ""}--> ${l.para}`);
  return linhas.join("\n");
}

export const NIVEIS_COMPLETUDE = [
  "Very incomplete: most important parts of the project are missing or wrong.",
  "Partial: the main structure is there, but several important parts or connections are missing.",
  "Mostly complete: only minor parts or attributes are missing.",
  "Complete: every important part and connection in the project is represented correctly.",
];

const COMPLETUDE_PT = ["muito incompleto", "parcial", "quase completo", "completo"];

/** Pergunta ao Jev se o mapa representa o projeto. Devolve { aprovado, duvida, problemas, camadas, ... }. */
export async function validarComJev({ projeto, pasta, mapa, camadas }) {
  const arqs = resumoArquivos(arquivosDoProjeto(pasta));
  const contexto = {
    project: projeto,
    task: "An AI coding tool read this project and produced a layered architecture map. Check the map against the project's file list.",
    layers_requested: Object.fromEntries(camadas.map((c) => [c.id, c.descricao || c.rotulo])),
    project_files: { total: arqs.total, by_folder: arqs.porPasta, list: arqs.amostra },
    map: resumoMapa(mapa),
  };
  const perguntas = {};
  for (const c of camadas) {
    perguntas[`camada_${c.id}`] = {
      tipo: "decidir",
      pergunta: `Is layer "${c.id}" of the map a faithful picture of the project for its scope (${c.descricao || c.rotulo})?`,
      criterio_sim: "The nodes in this layer match parts that exist in the file list (or are correctly marked as missing/planned), and nothing important for this layer is left out.",
      criterio_nao: "The layer invents parts that are not in the project, mislabels them, or leaves out important files that clearly belong to this layer.",
    };
  }
  perguntas.faltando = {
    tipo: "decidir",
    pergunta: "Is an important part of the project (visible in the file list) missing from the map?",
    criterio_sim: "There are files or folders that clearly implement a screen, endpoint, table, automation, MCP tool or AI component and none of the nodes covers them.",
    criterio_nao: "Every important part visible in the file list is covered by some node.",
  };
  perguntas.ligacoes = {
    tipo: "decidir",
    pergunta: "Do the cross-layer links correctly connect the layers (screens to the APIs they call, APIs to the tables and queues they use, AI steps to their indexes and models)?",
    criterio_sim: "The main paths through the system are linked across layers and the directions make sense.",
    criterio_nao: "Important cross-layer connections are missing or point the wrong way, so the layers look disconnected.",
  };
  perguntas.completude = { tipo: "avaliar", pergunta: "How complete is this architecture map for this project?", niveis: NIVEIS_COMPLETUDE };
  const r = await consultar({ contexto, perguntas });
  record({ ...r, agente: `Mapa · ${projeto}`.slice(0, 60), ferramenta: "leradeveloper", contexto: `Validação do mapa de arquitetura de ${projeto}` });
  const R = r.respostas;
  const problemas = [];
  const porCamada = camadas.map((c) => {
    const x = R[`camada_${c.id}`];
    if (x.zona === "nao") problemas.push(`Layer "${c.id}" does not match the project: re-check which files belong to it and remove invented nodes.`);
    else if (x.zona === "duvida") problemas.push(`Layer "${c.id}" may be inaccurate or incomplete: re-check it against the files.`);
    return { id: c.id, rotulo: c.rotulo, probabilidade: x.probabilidade_sim, zona: x.zona };
  });
  if (R.faltando.zona !== "nao") problemas.push("Important parts of the project seem to be missing from the map: compare the file list with the nodes and add what is missing.");
  if (R.ligacoes.zona !== "sim") problemas.push("Cross-layer links are weak: link screens/buttons to the APIs they call, APIs to the tables/queues they use, and AI steps to their models and indexes.");
  const comp = R.completude;
  if (comp.nivel < 2) problemas.push(`Completeness was rated "${NIVEIS_COMPLETUDE[comp.nivel].split(":")[0]}". Add the missing parts and attributes.`);
  const reprovado = porCamada.some((c) => c.zona === "nao") || R.faltando.zona === "sim" || R.ligacoes.zona === "nao" || comp.nivel < 2;
  const aprovado = !problemas.length;
  return {
    aprovado,
    reprovado,
    duvida: !aprovado && !reprovado,
    problemas,
    camadas: porCamada,
    faltando: R.faltando.probabilidade_sim,
    ligacoes: R.ligacoes.probabilidade_sim,
    completude: { nivel: comp.nivel, texto: COMPLETUDE_PT[comp.nivel], score: comp.score, maximo: comp.maximo },
    ref: r.ref,
    modelo: r.modelo,
    custoUsd: r.custo_usd ?? null,
    quando: new Date().toISOString(),
  };
}

// ---------- geração ----------

const emAndamento = new Map(); // tarefaId → projetoId

function salvarMapa(pasta, projetoId, mapa, validacao) {
  const file = arquivoMapaProjeto(pasta);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const conteudo = { ...mapa, atualizado: new Date().toISOString().slice(0, 16).replace("T", " "), projetoId, validacao };
  fs.writeFileSync(file, JSON.stringify(conteudo, null, 2));
  return file;
}

async function gerar({ projetoId, instrucoes }) {
  const p = central.projeto(projetoId);
  if (!fs.existsSync(p.pasta)) throw invalidArgument(`A pasta do projeto não existe mais: ${p.pasta}`);
  const atual = est()[projetoId];
  if (atual && ["gerando", "validando", "corrigindo"].includes(atual.status)) throw invalidArgument("O mapa deste projeto já está sendo gerado.");
  const cfg = await configDe(projetoId);
  const agentes = cfg.agente && cfg.agente !== "nenhum" ? [await infoAgente(cfg.agente)].filter(Boolean) : "nenhum";
  const t = await central.criarTarefa({
    projetoId,
    ferramenta: cfg.ferramenta,
    prompt: promptMapa({ projeto: p.nome, camadas: cfg.camadas, instrucoes: String(instrucoes ?? "").trim().slice(0, 2000) }),
    // só leitura: Claude em dontAsk (nunca pede nada), Codex com sandbox read-only
    autonomia: "perguntar",
    modoClaude: "dontAsk",
    titulo: `Mapa de arquitetura: ${p.nome}`,
    agente: `Mapa · ${p.nome}`.slice(0, 60),
    agentes,
    oculta: true,
  });
  emAndamento.set(t.id, projetoId);
  return setEstado(projetoId, { status: "gerando", tarefaId: t.id, ferramenta: t.ferramenta, rodada: 1, erro: null, problemas: [], avisos: [], camadas: cfg.camadas.map((c) => c.id), agente: Array.isArray(agentes) ? agentes[0]?.slug ?? null : null });
}

async function infoAgente(slug) {
  try {
    const a = (await corpus.corpus_list({})).find((x) => x.slug === slug);
    return a ? { slug: a.slug, nome: a.name, emoji: a.emoji ?? null, prob: null } : null;
  } catch {
    return null;
  }
}

async function onFim(t, evt) {
  const projetoId = emAndamento.get(t.id);
  if (!projetoId) return;
  emAndamento.delete(t.id);
  const s = est()[projetoId];
  if (!s || s.tarefaId !== t.id) return;
  if (!evt.ok) {
    setEstado(projetoId, { status: evt.parada ? "parado" : "erro", erro: evt.parada ? "Parado por você." : `A ferramenta não terminou: ${evt.erro ?? "sem resposta"}` });
    return;
  }
  let p, cfg;
  try {
    p = central.projeto(projetoId);
    cfg = await configDe(projetoId);
  } catch (e) {
    setEstado(projetoId, { status: "erro", erro: e.message });
    return;
  }
  const camadas = cfg.camadas.filter((c) => s.camadas?.includes(c.id) ?? true);
  const ex = extrairMapa(textoDaRodada(t, evt), camadas.length ? camadas : cfg.camadas);
  if (!ex.mapa) return corrigirOuFalhar(t, projetoId, s, ex.problemas, null, `O mapa veio com problemas de formato: ${ex.problemas.join(" ")}`);
  setEstado(projetoId, { status: "validando", avisos: ex.avisos ?? [] });
  let val;
  try {
    val = await validarComJev({ projeto: p.nome, pasta: p.pasta, mapa: ex.mapa, camadas });
  } catch (e) {
    val = { aprovado: false, semJev: true, problemas: [], erro: `Jev indisponível: ${e.message}`, quando: new Date().toISOString() };
  }
  if (!val.aprovado && !val.semJev && s.rodada < 2) {
    salvarMapa(p.pasta, projetoId, ex.mapa, { ...val, rodada: s.rodada, provisorio: true });
    return corrigirOuFalhar(t, projetoId, s, val.problemas, val);
  }
  const file = salvarMapa(p.pasta, projetoId, ex.mapa, { ...val, rodada: s.rodada });
  setEstado(projetoId, { status: "pronto", validacao: val, arquivo: file, mapaId: PREFIXO_PROJETO + projetoId, nos: ex.mapa.nos.length, ligacoes: ex.mapa.ligacoes.length, erro: null });
}

async function corrigirOuFalhar(t, projetoId, s, problemas, validacao, erroFinal) {
  if (s.rodada >= 2) {
    setEstado(projetoId, { status: "erro", erro: erroFinal ?? "O mapa não passou depois da correção.", problemas, validacao: validacao ?? s.validacao ?? null });
    return;
  }
  setEstado(projetoId, { status: "corrigindo", rodada: s.rodada + 1, problemas, validacao: validacao ?? null });
  try {
    emAndamento.set(t.id, projetoId);
    await central.enviar(t.id, promptCorrecao(problemas));
  } catch (e) {
    emAndamento.delete(t.id);
    setEstado(projetoId, { status: "erro", erro: `Não consegui pedir a correção: ${e.message}` });
  }
}

central.eventos.on("fim", (t, e) => {
  onFim(t, e).catch((err) => {
    const projetoId = emAndamento.get(t.id) ?? Object.entries(est()).find(([, s]) => s.tarefaId === t.id)?.[0];
    if (projetoId) setEstado(projetoId, { status: "erro", erro: err.message });
    console.error("[mapa-projeto]", err);
  });
});

// ---------- comandos ----------

function statusPublico(projetoId) {
  const p = central.projeto(projetoId);
  const s = est()[projetoId] ?? null;
  const file = arquivoMapaProjeto(p.pasta);
  let mapa = null;
  if (fs.existsSync(file)) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      mapa = { id: PREFIXO_PROJETO + projetoId, atualizado: raw.atualizado ?? null, nos: raw.nos?.length ?? 0, ligacoes: raw.ligacoes?.length ?? 0, validacao: raw.validacao ?? null };
    } catch {
      mapa = { id: PREFIXO_PROJETO + projetoId, erro: "arquivo inválido" };
    }
  }
  return { projetoId, geracao: s, mapa };
}

export const commands = {
  async projeto_mapa_config_obter({ projetoId }) {
    const cfg = await configDe(projetoId);
    const ferramentas = Object.entries(FERRAMENTAS).map(([id, f]) => ({ id, nome: f.nome }));
    let agentes = [];
    try {
      agentes = (await corpus.corpus_list({})).map((a) => ({ slug: a.slug, nome: a.name, emoji: a.emoji ?? null, categoria: a.category ?? null }));
    } catch {
      /* catálogo indisponível */
    }
    return { ...cfg, padrao: CAMADAS_PADRAO, extras: CAMADAS_EXTRAS, ferramentas, agentes, tipos: TIPOS, ...statusPublico(projetoId) };
  },
  async projeto_mapa_config_definir({ projetoId, camadas, ferramenta, agente, restaurar }) {
    central.projeto(projetoId);
    if (ferramenta != null && !FERRAMENTAS[ferramenta]) throw invalidArgument(`Ferramenta desconhecida: ${ferramenta}`);
    const novas = camadas != null ? normCamadas(camadas) : undefined;
    if (agente != null && agente !== "nenhum" && !(await infoAgente(agente))) throw invalidArgument(`Agente não encontrado no catálogo: ${agente}`);
    update((c) => {
      const p = c.central.projetos.find((x) => x.id === projetoId);
      if (!p) return;
      if (restaurar) {
        delete p.mapa;
        return;
      }
      p.mapa = { ...(p.mapa ?? {}) };
      if (novas) p.mapa.camadas = novas;
      if (ferramenta != null) p.mapa.ferramenta = ferramenta;
      if (agente !== undefined) p.mapa.agente = agente || null;
    });
    return configDe(projetoId);
  },
  projeto_mapa_gerar({ projetoId, instrucoes }) {
    return gerar({ projetoId, instrucoes });
  },
  projeto_mapa_status({ projetoId }) {
    return statusPublico(projetoId);
  },
  projeto_mapa_parar({ projetoId }) {
    const s = est()[projetoId];
    if (!s?.tarefaId || !["gerando", "validando", "corrigindo"].includes(s.status)) throw invalidArgument("Não há geração em andamento.");
    try {
      central.parar(s.tarefaId);
    } catch {
      /* já tinha parado */
    }
    emAndamento.delete(s.tarefaId);
    return setEstado(projetoId, { status: "parado", erro: "Parado por você." });
  },
};
