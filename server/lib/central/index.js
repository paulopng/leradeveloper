// Central de comando: o leradeveloper manda tarefas para Claude Code, Codex e Cursor,
// acompanha ao vivo, leva os pedidos de permissão para você (inclusive no celular),
// avalia o risco dos comandos com o Jev e atualiza o Escritório sozinho.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { appDataDir, home } from "../paths.js";
import { load, update } from "../lera-config.js";
import { invalidArgument, io } from "../errors.js";
import { registrar } from "../atividades.js";
import { escolher, revisarMudanca, record, config as jevConfig, JevError, publicConfig as jevPublico } from "../jev.js";
import { isRisky, avaliarComando } from "../guarda.js";
import { FERRAMENTAS, detectar, ignorarLera } from "./ferramentas.js";
import { iniciarClaude } from "./claude.js";
import { iniciarCodex } from "./codex.js";
import { iniciarCursor } from "./cursor.js";
import { iniciarAntigravity } from "./antigravity.js";
import { escolherAgentes, ligar, desligar, instrucao } from "./agentes.js";
import { contas, registrarLimite, limitesAtuais, usoProprio } from "./contas.js";
import { commands as installCmds } from "../install.js";
import { git, isRepo, hasCommits, diffTrabalho, status as gitStatus, branchAtual } from "./git.js";

export const eventos = new EventEmitter();
eventos.setMaxListeners(50);

const AUTONOMIAS = ["editar", "perguntar", "jev"];
const MAX_EVENTOS_MEM = 4000;

// ---------- servidor (para o hook de permissão do Claude) ----------

let servidor = { token: null, porta: () => null };
export function configurar({ token, porta }) {
  servidor = { token, porta };
}

// ---------- persistência ----------

const dir = () => path.join(appDataDir(), "state", "central");
const indexFile = () => path.join(dir(), "tarefas.json");
const eventosFile = (id) => path.join(dir(), `${id}.jsonl`);

const tarefas = new Map(); // id → tarefa
const runs = new Map(); // id → { adapter }
const cancelados = new Set(); // paradas enquanto ainda preparavam (ligando agentes)
let carregado = false;

function carregar() {
  if (carregado) return;
  carregado = true;
  try {
    const arr = JSON.parse(fs.readFileSync(indexFile(), "utf8"));
    for (const t of arr) {
      if (t.status === "rodando" || t.status === "aguardando") {
        t.status = "interrompida";
        t.ultimaMensagem = "O leradeveloper foi fechado enquanto esta tarefa rodava. Mande uma mensagem para continuar.";
      }
      for (const p of Object.values(t.pedidos ?? {})) if (p.status === "pendente") p.status = "expirado";
      t.eventos = null; // carrega sob demanda
      tarefas.set(t.id, t);
    }
  } catch {
    /* primeira vez */
  }
}

let salvarTimer = null;
function salvar() {
  clearTimeout(salvarTimer);
  salvarTimer = setTimeout(salvarAgora, 300);
}
export function salvarAgora() {
  clearTimeout(salvarTimer);
  try {
    fs.mkdirSync(dir(), { recursive: true });
    const arr = [...tarefas.values()].map(({ eventos: _e, ...t }) => t);
    const tmp = `${indexFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(arr));
    fs.renameSync(tmp, indexFile());
  } catch {
    /* tenta de novo no próximo evento */
  }
}

function eventosDe(t) {
  if (!t.eventos) {
    try {
      t.eventos = fs.readFileSync(eventosFile(t.id), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).slice(-MAX_EVENTOS_MEM);
    } catch {
      t.eventos = [];
    }
  }
  return t.eventos;
}

function addEvento(t, evt) {
  const list = eventosDe(t);
  const e = { n: (t.nEventos = (t.nEventos ?? 0) + 1), quando: new Date().toISOString(), ...evt };
  list.push(e);
  if (list.length > MAX_EVENTOS_MEM) list.splice(0, list.length - MAX_EVENTOS_MEM);
  try {
    fs.mkdirSync(dir(), { recursive: true });
    fs.appendFileSync(eventosFile(t.id), JSON.stringify(e) + "\n");
  } catch {
    /* segue em memória */
  }
  t.atualizado = e.quando;
  salvar();
  eventos.emit("evento", t, e);
  return e;
}

// ---------- projetos ----------

const slug = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

export function projetos() {
  return load().central.projetos ?? [];
}
export function projeto(id) {
  const p = projetos().find((x) => x.id === id);
  if (!p) throw invalidArgument(`Projeto não encontrado: ${id}`);
  return p;
}
const raiz = () => load().central.raiz || path.join(home(), "projetos");

function registrarProjeto(nome, pasta) {
  const abs = path.resolve(pasta);
  const existente = projetos().find((p) => path.resolve(p.pasta).toLowerCase() === abs.toLowerCase());
  if (existente) return existente;
  let id = slug(nome) || "projeto";
  const ids = new Set(projetos().map((p) => p.id));
  for (let i = 2; ids.has(id); i++) id = `${slug(nome) || "projeto"}-${i}`;
  const p = { id, nome: String(nome).trim().slice(0, 80) || id, pasta: abs, criado: new Date().toISOString() };
  update((c) => {
    c.central.projetos = [...(c.central.projetos ?? []), p];
  });
  return p;
}

const ehWorktree = (p) => /[\\/]\.lera[\\/]wt[\\/]/.test(p);
/** Pastas que a interface do catálogo conhece (onde há agentes instalados) entram na Central. */
async function sincronizarLedger() {
  try {
    const lista = await installCmds.projects_list();
    for (const x of lista) {
      if (!x.path || ehWorktree(x.path) || !fs.existsSync(x.path)) continue;
      registrarProjeto(path.basename(x.path), x.path);
    }
  } catch {
    /* ledger indisponível */
  }
}

function garantirGit(pasta) {
  if (!isRepo(pasta)) git(pasta, ["init"], { allowFail: false });
  ignorarLera(pasta);
}

// ---------- ferramentas e permissões ----------

const scriptDecisor = () => fileURLToPath(new URL("../../../bin/lera-decisor.js", import.meta.url));

function hookCommand() {
  const script = scriptDecisor().replace(/\\/g, "/");
  if (process.platform === "win32") return `node "${script}" --permissao`;
  return `"${process.execPath}" "${script}" --permissao`;
}

function claudeSettingsFile() {
  const f = path.join(dir(), "claude-settings.json");
  const conteudo = JSON.stringify(
    { hooks: { PermissionRequest: [{ matcher: "*", hooks: [{ type: "command", command: hookCommand(), timeout: 3600 }] }] } },
    null,
    2,
  );
  try {
    if (!fs.existsSync(f) || fs.readFileSync(f, "utf8") !== conteudo) {
      fs.mkdirSync(dir(), { recursive: true });
      fs.writeFileSync(f, conteudo);
    }
  } catch {
    /* sem settings, o Claude nega o que precisaria de permissão */
  }
  return f;
}

function nomeAgente(t) {
  const nome = FERRAMENTAS[t.ferramenta]?.nome ?? t.ferramenta;
  if (t.agente) return t.agente;
  let p = "";
  try {
    p = projeto(t.projetoId).nome;
  } catch {
    /* projeto removido */
  }
  return `${nome} · ${p || t.titulo}`.slice(0, 60);
}

/** Mantém a mesa da tarefa no Escritório. */
let ultimoOffice = new Map();
function office(t, { forcar = false } = {}) {
  const agora = Date.now();
  if (!forcar && agora - (ultimoOffice.get(t.id) ?? 0) < 2500) return;
  ultimoOffice.set(t.id, agora);
  const statusOffice = { rodando: "trabalhando", aguardando: "aguardando", concluida: "concluido", erro: "erro", parada: "bloqueado", interrompida: "bloqueado" }[t.status] ?? "trabalhando";
  try {
    registrar({
      agente: nomeAgente(t),
      tarefa: t.titulo,
      progresso: progresso(t),
      status: statusOffice,
      mensagem: t.ultimaMensagem?.slice(0, 200) ?? null,
      ferramenta: t.ferramenta,
      projeto: t.projetoId,
    });
  } catch {
    /* Escritório é só acompanhamento */
  }
}

function progresso(t) {
  if (t.status === "concluida") return 100;
  if (t.plano?.length) {
    const feitos = t.plano.filter((x) => x.status === "completed").length;
    return Math.min(95, Math.round((feitos / t.plano.length) * 100));
  }
  return Math.min(90, Math.round(100 * (1 - Math.exp(-(t.nFerramentas ?? 0) / 12))));
}

/** Regras "sempre permitir" da tarefa: comando começa com, ou nome da ferramenta. */
function casaRegra(t, { ferramenta, comando }) {
  for (const r of t.sempre ?? []) {
    if (r.comando && comando && comando.trim().startsWith(r.comando)) return true;
    if (!r.comando && r.ferramenta && r.ferramenta === ferramenta) return true;
  }
  return false;
}
const prefixoDe = (cmd) => String(cmd ?? "").trim().split(/\s+/).slice(0, 2).join(" ");

/**
 * Um pedido de permissão chegou (do hook do Claude ou do Codex). Decide sozinho quando
 * pode, senão deixa pendente para você. Devolve o pedido.
 */
async function novoPedido(t, { pedidoId, ferramenta, comando, detalhe }) {
  const p = { id: pedidoId, ferramenta, comando: comando ?? null, detalhe: detalhe ?? null, status: "pendente", quando: new Date().toISOString(), risco: null };
  t.pedidos ??= {};
  t.pedidos[p.id] = p;
  if (casaRegra(t, p)) return resolverPedido(t, p, "permitir", "regra 'sempre permitir' desta tarefa");
  const arriscado = comando ? isRisky(comando) : false;
  if (t.autonomia === "jev" && comando && !arriscado) return resolverPedido(t, p, "permitir", "comando comum (autonomia com o Jev)");
  t.status = "aguardando";
  addEvento(t, { t: "permissao", pedidoId: p.id, ferramenta, comando: p.comando, detalhe: p.detalhe, arriscado });
  t.ultimaMensagem = comando ? `Quer rodar: ${comando.slice(0, 120)}` : `Pede permissão: ${ferramenta}`;
  office(t, { forcar: true });
  eventos.emit("permissao", t, p);
  if (arriscado) {
    avaliarComando(comando, { cwd: t.cwd }).then((a) => {
      if (!a) return;
      p.risco = { destrutivo: a.destrutivo, externo: a.externo, ref: a.ref };
      record({
        tipo: "guarda",
        pergunta: `Comando: ${comando.slice(0, 160)}`,
        probabilidade_sim: a.max,
        zona: a.max > jevConfig().high ? "sim" : a.max < jevConfig().low ? "nao" : "duvida",
        precisa_humano: true,
        detalhes: { destrutivo: a.destrutivo, externo: a.externo },
        agente: nomeAgente(t),
        ferramenta: t.ferramenta,
        modelo: a.modelo,
        custo_usd: a.custo_usd,
        latencia_ms: a.latencia_ms,
        ref: a.ref,
      });
      addEvento(t, { t: "risco", pedidoId: p.id, destrutivo: a.destrutivo, externo: a.externo });
    });
  }
  return p;
}

function resolverPedido(t, p, decisao, motivo = null) {
  if (p.status !== "pendente") return p;
  p.status = decisao === "negar" ? "negado" : "permitido";
  p.decisao = decisao;
  p.resolvido = new Date().toISOString();
  if (decisao === "sempre") {
    t.sempre ??= [];
    t.sempre.push(p.comando ? { comando: prefixoDe(p.comando) } : { ferramenta: p.ferramenta });
  }
  runs.get(t.id)?.adapter?.responder(p.id, decisao);
  addEvento(t, { t: "permissao_resolvida", pedidoId: p.id, decisao, motivo, comando: p.comando, ferramenta: p.ferramenta });
  if (t.status === "aguardando" && !Object.values(t.pedidos).some((x) => x.status === "pendente")) {
    t.status = "rodando";
    office(t, { forcar: true });
  }
  return p;
}

// ---------- executar ----------

function onEvento(t, e) {
  switch (e.t) {
    case "sessao":
      if (e.id) t.sessao = e.id;
      if (e.modelo) t.modelo = e.modelo;
      break;
    case "texto":
      if (!e.sub) t.ultimaMensagem = e.texto.slice(0, 400);
      break;
    case "ferramenta":
      t.nFerramentas = (t.nFerramentas ?? 0) + 1;
      if (e.arquivo) {
        t.arquivos ??= [];
        if (!t.arquivos.includes(e.arquivo)) t.arquivos.push(e.arquivo);
      }
      break;
    case "plano":
      t.plano = e.itens;
      break;
    case "limite": {
      const renova = e.renova == null ? null : Number(e.renova) < 1e12 ? Number(e.renova) * 1000 : Number(e.renova);
      registrarLimite(t.ferramenta, { tipo: e.tipo, uso: e.uso, renova, status: e.status });
      return; // não polui a conversa
    }
    case "permissao":
      // Codex: o pedido vem do adaptador.
      novoPedido(t, { pedidoId: e.pedidoId, ferramenta: e.ferramenta, comando: e.comando, detalhe: e.detalhe });
      return; // novoPedido grava o evento
    case "fim":
      t.status = e.parada ? "parada" : e.ok ? "concluida" : "erro";
      if (e.custoUsd != null) t.custoUsd = Math.round(((t.custoUsd ?? 0) + Number(e.custoUsd)) * 1e6) / 1e6;
      if (e.tokens != null) t.tokens = e.tokens;
      if (e.sessao) t.sessao = e.sessao;
      if (e.texto) t.ultimaMensagem = e.texto.slice(0, 400);
      if (!e.ok && e.erro) t.ultimaMensagem = e.erro.slice(0, 400);
      for (const p of Object.values(t.pedidos ?? {})) if (p.status === "pendente") p.status = "expirado";
      t.resultado = e.estruturado ?? null;
      runs.delete(t.id);
      if (t.ligados?.some((a) => a.temporario)) {
        const lig = t.ligados;
        desligar(t.cwd, t.ferramenta, lig).catch(() => {});
        t.ligados = lig.map((a) => ({ ...a, desligado: true }));
      }
      break;
    default:
  }
  const { estruturado: _x, ...semEstruturado } = e;
  addEvento(t, semEstruturado);
  office(t, { forcar: e.t === "fim" || e.t === "plano" });
  if (e.t === "fim") eventos.emit("fim", t, e);
}

async function rodar(t, prompt, { extras = [] } = {}) {
  if (runs.has(t.id)) throw invalidArgument("Esta tarefa já está rodando.");
  runs.set(t.id, { adapter: { parar() {}, responder() {} }, preparando: true });
  t.status = "rodando";
  t.prompts ??= [];
  t.prompts.push({ quando: new Date().toISOString(), texto: prompt });
  addEvento(t, { t: "voce", texto: prompt });
  office(t, { forcar: true });
  let textoFinal = prompt;
  if (t.agentes?.length) {
    try {
      t.ligados = await ligar(t.cwd, t.ferramenta, t.agentes);
      if (t.prompts.length === 1) textoFinal += instrucao(t.ferramenta, t.ligados);
      addEvento(t, { t: "agentes", itens: t.ligados.map(({ slug, nome, emoji, prob, erro, temporario }) => ({ slug, nome, emoji, prob, erro: erro ?? null, temporario })) });
    } catch (e) {
      addEvento(t, { t: "aviso", texto: `Não consegui ligar os agentes: ${e.message}` });
    }
  }
  prompt = textoFinal;
  if (cancelados.delete(t.id)) return t; // você parou enquanto preparava
  const emit = (e) => onEvento(t, e);
  const env = {
    LERA_CENTRAL_URL: servidor.porta() ? `http://127.0.0.1:${servidor.porta()}` : "",
    LERA_TOKEN: servidor.token ?? "",
    LERA_TAREFA: t.id,
  };
  let adapter;
  try {
    if (t.ferramenta === "claude") {
      const modo = t.modoClaude ?? (t.autonomia === "perguntar" ? "default" : "acceptEdits");
      adapter = iniciarClaude({ cwd: t.cwd, prompt, sessao: t.sessao, modo, settingsFile: claudeSettingsFile(), env, emit, extras });
    } else if (t.ferramenta === "codex") {
      adapter = iniciarCodex({ cwd: t.cwd, prompt, sessao: t.sessao, politica: "untrusted", sandbox: t.autonomia === "perguntar" ? "read-only" : "workspace-write", env, emit });
    } else if (t.ferramenta === "cursor") {
      adapter = iniciarCursor({ cwd: t.cwd, prompt, sessao: t.sessao, tarefaId: t.id, env, emit });
    } else if (t.ferramenta === "antigravity") {
      adapter = iniciarAntigravity({ cwd: t.cwd, prompt, sessao: t.sessao, tarefaId: t.id, env, emit });
    } else throw new Error(`Ferramenta desconhecida: ${t.ferramenta}`);
  } catch (e) {
    runs.delete(t.id);
    onEvento(t, { t: "fim", ok: false, erro: e.message });
    return t;
  }
  runs.set(t.id, { adapter });
  return t;
}

/** Escolhe a ferramenta com o Jev quando o pedido vem com "auto". */
/** Ferramentas perto do limite (≥ 90% numa janela, bloqueadas, ou no limite mensal que você definiu). */
export function pertoDoLimite(id) {
  const j = limitesAtuais(id);
  if (Object.values(j).some((x) => x.status === "rejected" || Number(x.uso) >= 0.9)) return true;
  const mensal = load().central.limites?.[id]?.mensal;
  if (mensal) {
    const u = usoProprio([...tarefas.values()])[id];
    if (u && u.mes >= mensal * 0.95) return true;
  }
  return false;
}
function resumoUso(id) {
  const j = limitesAtuais(id);
  const partes = Object.entries(j).map(([k, v]) => `${k === "five_hour" ? "5h" : k === "seven_day" ? "week" : k} ${Math.round((Number(v.uso) || 0) * 100)}% used`);
  return partes.join(", ") || "unknown";
}

async function escolherFerramenta(prompt, todas, contexto = {}) {
  const livres = todas.filter((id) => !pertoDoLimite(id));
  const disponiveis = livres.length ? livres : todas;
  const avisoLimite = livres.length < todas.length ? ` (${todas.filter((id) => !livres.includes(id)).map((id) => FERRAMENTAS[id].nome).join(", ")} perto do limite, fora da escolha)` : "";
  if (disponiveis.length === 1) return { ferramenta: disponiveis[0], motivo: `única ferramenta disponível${avisoLimite}` };
  contexto = { ...contexto, tools_usage: Object.fromEntries(disponiveis.map((id) => [id, resumoUso(id)])) };
  const opcoes = Object.fromEntries(disponiveis.map((id) => [id, `${FERRAMENTAS[id].nome}: ${FERRAMENTAS[id].perfil}`]));
  try {
    const r = await escolher({ pergunta: "Which coding tool is the best fit to carry out `task`?", contexto: { task: prompt, ...contexto }, opcoes, incluir_outra: false });
    record({ ...r, agente: "Central (escolha de ferramenta)", ferramenta: "leradeveloper", contexto: prompt.slice(0, 400) });
    if (r.escolha && r.zona === "clara") return { ferramenta: r.escolha, motivo: `Jev escolheu com ${Math.round(r.ranking[0].probabilidade * 100)}%${avisoLimite}`, decisao: r };
    const fallback = disponiveis.includes("claude") ? "claude" : disponiveis[0];
    return { ferramenta: fallback, motivo: `Jev ficou em dúvida (${r.ranking.map((x) => `${x.rotulo} ${Math.round(x.probabilidade * 100)}%`).join(", ")}); usei ${FERRAMENTAS[fallback].nome}`, decisao: r };
  } catch (e) {
    const fallback = disponiveis.includes("claude") ? "claude" : disponiveis[0];
    return { ferramenta: fallback, motivo: `Jev indisponível (${e.message}); usei ${FERRAMENTAS[fallback].nome}` };
  }
}

/** Cria e inicia uma tarefa (também usado pelo coordenador). */
export async function criarTarefa({ projetoId, cwd, ferramenta = "auto", prompt, autonomia, titulo, agente, coordId, coordTarefa, extras, modoClaude, oculta, agentes, textoAgentes }) {
  carregar();
  const texto = String(prompt ?? "").trim();
  if (!texto) throw invalidArgument("Escreva o que a ferramenta deve fazer.");
  const p = projeto(projetoId);
  const pasta = cwd ?? p.pasta;
  if (!fs.existsSync(pasta)) throw invalidArgument(`A pasta do projeto não existe mais: ${pasta}`);
  const aut = autonomia ?? load().central.autonomia ?? "editar";
  if (!AUTONOMIAS.includes(aut)) throw invalidArgument(`Autonomia inválida: ${aut}`);
  const det = await detectar();
  const disponiveis = Object.values(det).filter((d) => d.ok).map((d) => d.id);
  if (!disponiveis.length) throw invalidArgument("Nenhuma ferramenta encontrada. Instale o Claude Code, o Codex ou o Cursor CLI.");
  let escolha = null;
  let ferr = ferramenta;
  if (ferr === "auto") {
    escolha = await escolherFerramenta(texto, disponiveis, { project: p.nome });
    ferr = escolha.ferramenta;
  }
  if (!FERRAMENTAS[ferr]) throw invalidArgument(`Ferramenta desconhecida: ${ferr}`);
  if (!det[ferr]?.ok) throw invalidArgument(`${FERRAMENTAS[ferr].nome} não está instalado. ${FERRAMENTAS[ferr].instalar}`);
  if (pasta === p.pasta) garantirGit(pasta);
  const t = {
    id: crypto.randomBytes(5).toString("hex"),
    projetoId: p.id,
    cwd: pasta,
    ferramenta: ferr,
    autonomia: aut,
    titulo: String(titulo ?? texto.split("\n")[0]).trim().slice(0, 90),
    agente: agente ?? null,
    coordId: coordId ?? null,
    coordTarefa: coordTarefa ?? null,
    modoClaude: modoClaude ?? null,
    oculta: !!oculta,
    status: "rodando",
    criado: new Date().toISOString(),
    atualizado: new Date().toISOString(),
    custoUsd: 0,
    pedidos: {},
    eventos: [],
  };
  tarefas.set(t.id, t);
  if (escolha) addEvento(t, { t: "aviso", texto: `Ferramenta: ${FERRAMENTAS[ferr].nome}. ${escolha.motivo}.` });
  const modoAgentes = agentes ?? load().central.agentes ?? "auto";
  if (Array.isArray(modoAgentes)) t.agentes = modoAgentes;
  else if (modoAgentes === "auto" && !oculta) {
    try {
      const r = await escolherAgentes(textoAgentes ?? texto);
      t.agentes = r.agentes;
      if (!r.agentes.length) addEvento(t, { t: "aviso", texto: r.motivo });
    } catch (e) {
      addEvento(t, { t: "aviso", texto: `Não consegui escolher agentes: ${e.message}` });
    }
  }
  return rodar(t, texto, { extras });
}

export function tarefa(id) {
  carregar();
  const t = tarefas.get(id);
  if (!t) throw invalidArgument(`Tarefa não encontrada: ${id}`);
  return t;
}

export async function enviar(id, prompt) {
  const t = tarefa(id);
  const texto = String(prompt ?? "").trim();
  if (!texto) throw invalidArgument("Mensagem vazia.");
  return rodar(t, texto);
}

export function parar(id) {
  const t = tarefa(id);
  const r = runs.get(id);
  if (!r) throw invalidArgument("Esta tarefa não está rodando.");
  if (r.preparando) {
    cancelados.add(id);
    onEvento(t, { t: "fim", ok: false, parada: true, erro: "Parada por você." });
    return publica(t);
  }
  for (const p of Object.values(t.pedidos ?? {})) if (p.status === "pendente") resolverPedido(t, p, "negar", "tarefa parada");
  r.adapter.parar();
  return publica(t);
}

export const _paraTestes = { tarefas, runs };
export { eventosDe, nomeAgente, publica };

/** Resumo sem eventos, para listas. */
function publica(t) {
  const { eventos: _e, ...rest } = t;
  return {
    ...rest,
    nomeFerramenta: FERRAMENTAS[t.ferramenta]?.nome ?? t.ferramenta,
    progresso: progresso(t),
    rodando: runs.has(t.id),
    pendentes: Object.values(t.pedidos ?? {}).filter((p) => p.status === "pendente"),
  };
}

// ---------- git ----------

function commitTudo(cwd, mensagem) {
  ignorarLera(cwd);
  git(cwd, ["add", "-A"], { allowFail: false }); // .lera/ já está em info/exclude
  if (!git(cwd, ["diff", "--cached", "--quiet"]).code) return { commit: null, vazio: true };
  const r = git(cwd, ["commit", "-F", "-"], { input: mensagem });
  if (r.code !== 0) {
    const msg = r.stderr.trim();
    if (/user\.(name|email)|Please tell me who you are/i.test(msg)) {
      throw invalidArgument('O git ainda não sabe seu nome. No PowerShell: git config --global user.name "Seu Nome" e git config --global user.email "voce@exemplo.com".');
    }
    throw io(msg || "git commit falhou");
  }
  return { commit: git(cwd, ["rev-parse", "--short", "HEAD"]).stdout.trim(), vazio: false };
}
export { commitTudo };

// ---------- comandos ----------

export const commands = {
  async central_estado() {
    carregar();
    await sincronizarLedger();
    const ferramentas = await detectar();
    return {
      ferramentas,
      projetos: projetos(),
      raiz: raiz(),
      autonomia: load().central.autonomia,
      agentes: load().central.agentes ?? "auto",
      jevAtivo: jevPublico().chaveDefinida,
      tarefas: [...tarefas.values()].filter((t) => !t.arquivada && !t.oculta).sort((a, b) => String(b.atualizado).localeCompare(String(a.atualizado))).slice(0, 80).map(publica),
    };
  },
  async central_ferramentas({ atualizar } = {}) {
    return detectar({ atualizar: !!atualizar });
  },
  central_config_definir({ autonomia, raiz: novaRaiz, paralelo, agentes }) {
    update((c) => {
      if (autonomia !== undefined) {
        if (!AUTONOMIAS.includes(autonomia)) throw invalidArgument("Autonomia inválida.");
        c.central.autonomia = autonomia;
      }
      if (novaRaiz !== undefined) {
        if (novaRaiz && !path.isAbsolute(novaRaiz)) throw invalidArgument("Informe um caminho absoluto.");
        c.central.raiz = novaRaiz || null;
      }
      if (paralelo !== undefined) c.central.paralelo = Math.max(1, Math.min(6, Number(paralelo) || 3));
      if (agentes !== undefined) c.central.agentes = agentes === "nenhum" ? "nenhum" : "auto";
    });
    return { autonomia: load().central.autonomia, raiz: raiz(), paralelo: load().central.paralelo };
  },
  projeto_criar({ nome }) {
    const s = slug(nome);
    if (!s) throw invalidArgument("Dê um nome ao projeto.");
    const pasta = path.join(raiz(), s);
    if (fs.existsSync(pasta) && fs.readdirSync(pasta).length) throw invalidArgument(`Já existe uma pasta com arquivos em ${pasta}. Use "Adicionar pasta existente".`);
    fs.mkdirSync(pasta, { recursive: true });
    garantirGit(pasta);
    return registrarProjeto(nome, pasta);
  },
  projeto_adicionar({ pasta, nome }) {
    if (typeof pasta !== "string" || !path.isAbsolute(pasta)) throw invalidArgument("Informe o caminho completo da pasta.");
    if (!fs.existsSync(pasta) || !fs.statSync(pasta).isDirectory()) throw invalidArgument(`Pasta não encontrada: ${pasta}`);
    garantirGit(pasta);
    return registrarProjeto(nome || path.basename(pasta), pasta);
  },
  /** A interface do catálogo manda as pastas que ela conhece e recebe todas as da Central. */
  async projetos_sincronizar({ pastas = [] } = {}) {
    for (const p of Array.isArray(pastas) ? pastas : []) {
      if (typeof p === "string" && path.isAbsolute(p) && !ehWorktree(p) && fs.existsSync(p) && fs.statSync(p).isDirectory()) registrarProjeto(path.basename(p), p);
    }
    await sincronizarLedger();
    return projetos();
  },
  projeto_remover_pasta({ pasta }) {
    const abs = path.resolve(String(pasta ?? ""));
    update((c) => {
      c.central.projetos = (c.central.projetos ?? []).filter((p) => path.resolve(p.pasta).toLowerCase() !== abs.toLowerCase());
    });
    return { ok: true };
  },
  async central_contas({ atualizar } = {}) {
    carregar();
    return contas({ atualizar: !!atualizar, tarefas: [...tarefas.values()] });
  },
  central_limite_definir({ ferramenta, mensal }) {
    if (!FERRAMENTAS[ferramenta]) throw invalidArgument("Ferramenta desconhecida.");
    const n = mensal === null || mensal === "" ? null : Number(mensal);
    if (n !== null && !(Number.isFinite(n) && n > 0)) throw invalidArgument("Informe um número de pedidos por mês, ou deixe vazio para tirar o limite.");
    update((c) => {
      c.central.limites ??= {};
      if (n === null) delete c.central.limites[ferramenta];
      else c.central.limites[ferramenta] = { mensal: Math.round(n) };
    });
    return load().central.limites;
  },
  projeto_remover({ id }) {
    projeto(id);
    update((c) => {
      c.central.projetos = c.central.projetos.filter((p) => p.id !== id);
    });
    return { ok: true, nota: "O projeto saiu da lista; a pasta e os arquivos continuam no seu PC." };
  },
  async tarefa_criar(args) {
    return publica(await criarTarefa(args));
  },
  async tarefa_enviar({ id, prompt }) {
    return publica(await enviar(id, prompt));
  },
  tarefa_parar({ id }) {
    return parar(id);
  },
  tarefa_eventos({ id, desde = 0 }) {
    const t = tarefa(id);
    const evs = eventosDe(t).filter((e) => e.n > Number(desde || 0));
    return { tarefa: publica(t), eventos: evs.slice(0, 500) };
  },
  tarefa_responder({ id, pedidoId, decisao }) {
    const t = tarefa(id);
    if (!["permitir", "negar", "sempre"].includes(decisao)) throw invalidArgument("Decisão inválida.");
    const p = t.pedidos?.[pedidoId];
    if (!p) throw invalidArgument("Pedido não encontrado.");
    if (p.status !== "pendente") throw invalidArgument("Este pedido já foi respondido ou expirou.");
    resolverPedido(t, p, decisao, "você");
    return publica(t);
  },
  tarefa_diff({ id }) {
    const t = tarefa(id);
    return diffTrabalho(t.cwd);
  },
  async tarefa_revisar({ id }) {
    const t = tarefa(id);
    const { diff, arquivos } = diffTrabalho(t.cwd, { max: 60000 });
    if (!diff.trim()) throw invalidArgument("Não há mudanças para revisar.");
    const objetivo = (t.prompts ?? []).map((p) => p.texto).join("\n\nFollow-up: ");
    const testes = eventosDe(t)
      .filter((e) => e.t === "ferramenta_fim" && /test|spec|jest|vitest|pytest|npm (run )?test/i.test(e.saida ?? ""))
      .slice(-3)
      .map((e) => e.saida.slice(-800))
      .join("\n---\n");
    let r;
    try {
      r = await revisarMudanca({
        objetivo,
        mudanca: diff,
        testes: testes || `No test output was captured. Last message from the tool: ${t.ultimaMensagem ?? ""}`,
        arquivos: arquivos.map((a) => a.caminho),
      });
    } catch (e) {
      if (e instanceof JevError) throw invalidArgument(e.message);
      throw e;
    }
    record({ ...r, agente: nomeAgente(t), ferramenta: t.ferramenta, contexto: objetivo.slice(0, 400) });
    addEvento(t, { t: "revisao", veredito: r.veredito, motivos: r.motivos, ref: r.ref, risco: r.respostas?.risco?.nivel_texto ?? null });
    return r;
  },
  tarefa_commit({ id, mensagem }) {
    const t = tarefa(id);
    if (runs.has(id)) throw invalidArgument("Espere a tarefa terminar antes do commit.");
    const msg = String(mensagem ?? "").trim() || t.titulo;
    const r = commitTudo(t.cwd, msg);
    if (r.vazio) throw invalidArgument("Não há mudanças para commit.");
    addEvento(t, { t: "git", acao: "commit", commit: r.commit, mensagem: msg });
    return r;
  },
  tarefa_push({ id }) {
    const t = tarefa(id);
    const remotos = git(t.cwd, ["remote"]).stdout.trim();
    if (!remotos) throw invalidArgument("Este projeto ainda não tem repositório remoto. Peça à ferramenta: \"crie o repositório no GitHub e configure o origin\", ou rode git remote add origin <url>.");
    const r = git(t.cwd, ["push", "-u", "origin", "HEAD"]);
    if (r.code !== 0) throw io(r.stderr.trim() || "git push falhou");
    addEvento(t, { t: "git", acao: "push", saida: (r.stderr || r.stdout).trim().slice(-500) });
    return { ok: true, saida: (r.stderr || r.stdout).trim().slice(-500), branch: branchAtual(t.cwd) };
  },
  tarefa_arquivar({ id }) {
    const t = tarefa(id);
    if (runs.has(id)) throw invalidArgument("Pare a tarefa antes de arquivar.");
    t.arquivada = true;
    salvar();
    return { ok: true };
  },
  projeto_commit({ id, mensagem }) {
    const p = projeto(id);
    const r = commitTudo(p.pasta, String(mensagem ?? "").trim() || "Mudanças antes da coordenação");
    if (r.vazio) throw invalidArgument("Não há mudanças para commit.");
    return r;
  },
  projeto_status({ id }) {
    const p = projeto(id);
    return { arquivos: gitStatus(p.pasta), branch: branchAtual(p.pasta), temCommits: hasCommits(p.pasta) };
  },

  // ----- usados pelo hook do Claude (lera-decisor --permissao) -----
  async central_permissao_pedir({ tarefa: id, ferramenta, entrada }) {
    const t = tarefa(id);
    const comando = ferramenta === "Bash" || ferramenta === "PowerShell" ? String(entrada?.command ?? "") : null;
    const detalhe = comando ? entrada?.description ?? null : JSON.stringify(entrada ?? {}).slice(0, 400);
    const p = await novoPedido(t, { pedidoId: `p${crypto.randomBytes(4).toString("hex")}`, ferramenta, comando, detalhe });
    return { pedidoId: p.id, status: p.status };
  },
  central_permissao_status({ tarefa: id, pedidoId }) {
    const t = tarefa(id);
    const p = t.pedidos?.[pedidoId];
    if (!p) throw invalidArgument("Pedido não encontrado.");
    return { status: p.status, decisao: p.decisao ?? null };
  },
};
