// Equipe e conhecimento: as funções do leradev (gerador do mapa 3D, assistente de briefing,
// planejador, Jev), os agentes do catálogo alocados em cada função e em cada etapa/tarefa,
// e o conhecimento (RAG) de cada um. Também monta o mapa 3D "leradev · equipe" na hora.
import { update } from "../lera-config.js";
import { invalidArgument } from "../errors.js";
import { commands as corpus } from "../corpus.js";
import { registrarMapaVirtual } from "../mapas.js";
import { PAPEIS, TIPOS_FONTE, adicionarFonte, removerFonte, recuperar, resumoFontes, todosDonos, validarDono } from "../rag.js";
import { resolverAgentes, agentesDoPapel } from "./agentes.js";
import * as central from "./index.js";
import { commands as coordCmds } from "./coordenador.js";
import { commands as assistCmds } from "./assistente.js";

export const MAPA_EQUIPE = "leradev-equipe";
const ATIVAS = new Set(["planejando", "plano_pronto", "executando", "parada", "concluida"]);

async function catalogoMap() {
  try {
    return new Map((await corpus.corpus_list({})).map((a) => [a.slug, a]));
  } catch {
    return new Map();
  }
}

/** Onde cada agente está alocado agora. */
async function alocacoes(projetoId) {
  const out = [];
  for (const [id, p] of Object.entries(PAPEIS)) {
    if (!p.agentes) continue;
    out.push({ tipo: "papel", id: `papel:${id}`, rotulo: p.nome, link: `#/k/papel:${id}`, agentes: await agentesDoPapel(id) });
  }
  for (const c of coordCmds.coord_listar({ projetoId })) {
    if (!ATIVAS.has(c.status)) continue;
    for (const t of c.plano?.tarefas ?? []) {
      const e = c.execucao?.[t.id];
      let ags = c.agentesTarefa?.[t.id] ?? null;
      if (!ags && e?.tarefaId) {
        try {
          ags = central.tarefa(e.tarefaId).ligados?.filter((a) => !a.erro) ?? null;
        } catch {
          /* tarefa sumiu */
        }
      }
      out.push({ tipo: "etapa", id: `etapa:${c.id}:${t.id}`, rotulo: t.titulo, contexto: c.objetivo.split("\n")[0].slice(0, 80), status: e?.status ?? c.status, link: `#/c/${c.id}`, coordId: c.id, etapa: t.id, ferramenta: c.rotas?.[t.id]?.ferramenta ?? null, agentes: ags ?? [], testes: t.testes_minimos?.length ?? 0 });
    }
  }
  for (const s of assistCmds.assistente_listar({ projetoId })) {
    if (s.coordId) continue;
    const full = assistCmds.assistente_obter({ id: s.id });
    for (const t of full.briefing?.equipe ?? []) {
      out.push({ tipo: "briefing", id: `briefing:${s.id}:${t.id}`, rotulo: t.titulo, contexto: `Briefing: ${s.titulo}`, status: s.status, link: `#/a/${s.id}`, ferramenta: t.ferramenta, agentes: t.agentes ?? [] });
    }
  }
  for (const t of central.listarTarefas()) {
    if (t.oculta || t.arquivada || t.coordId || (projetoId && t.projetoId !== projetoId)) continue;
    if (!Array.isArray(t.agentes) || !t.agentes.length) continue;
    out.push({ tipo: "tarefa", id: `tarefa:${t.id}`, rotulo: t.titulo, status: t.status, link: `#/t/${t.id}`, ferramenta: t.ferramenta, agentes: t.agentes });
  }
  return out;
}

async function estado({ projetoId } = {}) {
  const cwd = projetoId ? central.projeto(projetoId).pasta : null;
  const papeis = [];
  for (const [id, p] of Object.entries(PAPEIS)) {
    papeis.push({ id, dono: `papel:${id}`, nome: p.nome, descricao: p.descricao, aceitaAgentes: p.agentes, agentes: p.agentes ? await agentesDoPapel(id) : [], fontes: await resumoFontes(`papel:${id}`, cwd) });
  }
  const aloc = await alocacoes(projetoId);
  const cat = await catalogoMap();
  const slugs = new Set();
  for (const a of aloc) for (const x of a.agentes) slugs.add(x.slug);
  for (const dono of Object.keys(todosDonos())) if (dono.startsWith("agente:")) slugs.add(dono.slice(7));
  const agentes = [];
  for (const slug of slugs) {
    const a = cat.get(slug);
    agentes.push({
      slug,
      dono: `agente:${slug}`,
      nome: a?.name ?? slug,
      emoji: a?.emoji ?? null,
      descricao: a?.description ? String(a.description).slice(0, 240) : null,
      noCatalogo: !!a,
      fontes: await resumoFontes(`agente:${slug}`, cwd),
      onde: aloc.filter((x) => x.agentes.some((y) => y.slug === slug)).map((x) => ({ tipo: x.tipo, rotulo: x.rotulo, link: x.link })),
    });
  }
  agentes.sort((a, b) => b.onde.length - a.onde.length || a.nome.localeCompare(b.nome));
  return { papeis, alocacoes: aloc, agentes, tiposFonte: TIPOS_FONTE, mapaId: MAPA_EQUIPE };
}

// ---------- mapa 3D da equipe ----------

const idNo = (s) => String(s).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "x";

export async function mapaEquipe() {
  const e = await estado({});
  const nos = [];
  const ligacoes = [];
  const ja = new Set();
  const add = (n) => {
    if (ja.has(n.id)) return;
    ja.add(n.id);
    nos.push(n);
  };
  const liga = (de, para, relacao, extra = {}) => {
    if (ja.has(de) && ja.has(para)) ligacoes.push({ de, para, relacao, ...extra });
  };
  const fontesNos = (dono, fontes) => {
    for (const f of fontes) {
      const id = `f-${idNo(dono)}-${f.id}`;
      add({
        id, camada: "conhecimento", rotulo: f.titulo, tipo: f.tipo === "url" ? "fonte" : f.tipo === "nota" ? "entregavel" : "dado",
        status: f.existe ? "ok" : "atencao", peso: 1,
        descricao: f.tipo === "nota" ? f.texto ?? "" : f.tipo === "url" ? `Página: ${f.url}` : `${f.tipo === "pasta" ? "Pasta" : "Arquivo"}: ${f.caminho}${f.existe ? "" : " (não encontrado agora; caminho relativo vale dentro da pasta de cada tarefa)"}`,
        atributos: { tipo: f.tipo, ...(f.caminho ? { caminho: f.caminho } : {}), ...(f.url ? { url: f.url } : {}), ...(f.contagem != null ? { [f.tipo === "pasta" ? "arquivos" : "trechos"]: f.contagem } : {}) },
        links: [{ rotulo: "Editar conhecimento", href: `/central#/k/${dono}` }],
      });
    }
  };
  for (const p of e.papeis) {
    add({
      id: `n-${idNo(p.dono)}`, camada: "funcoes", rotulo: p.nome, tipo: p.id === "jev" ? "decisao" : p.id === "mapa" ? "ferramenta" : "agente", status: "ok", peso: 3,
      descricao: p.descricao,
      atributos: { agentes: p.aceitaAgentes ? p.agentes.map((a) => a.nome).join(", ") || "nenhum" : "não usa agentes", conhecimento: `${p.fontes.length} fonte(s)` },
      links: [{ rotulo: p.aceitaAgentes ? "Agentes e conhecimento" : "Conhecimento do Jev", href: `/central#/k/${p.dono}` }],
    });
  }
  add({ id: "n-etapas", camada: "funcoes", rotulo: "Etapas dos objetivos", tipo: "tarefa", status: "ok", peso: 2, descricao: "Cada etapa de um objetivo roda numa ferramenta, com os agentes que você ou o assistente escolheram, os testes mínimos e a revisão do Jev.", links: [{ rotulo: "Abrir a Central", href: "/central" }] });
  for (const a of e.agentes) {
    add({
      id: `n-${idNo(a.dono)}`, camada: "agentes", rotulo: `${a.emoji ? `${a.emoji} ` : ""}${a.nome}`, tipo: "agente", status: a.noCatalogo ? "ok" : "atencao", peso: Math.min(3, 1 + Math.floor(a.onde.length / 2)),
      descricao: a.descricao ?? "Agente do catálogo.",
      atributos: { slug: a.slug, alocado: a.onde.map((x) => x.rotulo).join("; ") || "em nenhum lugar agora", conhecimento: `${a.fontes.length} fonte(s)` },
      links: [{ rotulo: "Agentes e conhecimento", href: `/central#/k/${a.dono}` }],
    });
  }
  const trabalho = e.alocacoes.filter((x) => x.tipo !== "papel").slice(0, 40);
  for (const w of trabalho) {
    const id = `n-${idNo(w.id)}`;
    add({
      id, camada: "trabalho", rotulo: w.rotulo, tipo: "tarefa", status: ["erro", "conflito"].includes(w.status) ? "bloqueado" : ["aguardando_voce", "aguardando", "perguntas"].includes(w.status) ? "atencao" : w.status === "juntada" || w.status === "concluida" ? "ok" : "confirmar", peso: 1,
      descricao: [w.contexto, w.ferramenta ? `Ferramenta: ${w.ferramenta}` : null, w.testes ? `${w.testes} teste(s) mínimo(s)` : null].filter(Boolean).join(" · ") || w.rotulo,
      atributos: { tipo: w.tipo, status: w.status ?? "", agentes: w.agentes.map((a) => a.nome).join(", ") || "nenhum" },
      links: [{ rotulo: w.tipo === "briefing" ? "Abrir o briefing" : w.tipo === "tarefa" ? "Abrir a tarefa" : "Abrir o objetivo", href: `/central${w.link}` }],
    });
    for (const a of w.agentes) liga(id, `n-${idNo(`agente:${a.slug}`)}`, "com");
    if (w.tipo === "etapa") {
      liga("n-etapas", id, "executa");
      liga(`n-${idNo("papel:jev")}`, id, "valida", { fluxo: true });
    } else if (w.tipo === "briefing") liga(`n-${idNo("papel:assistente")}`, id, "propõe", { pendente: true });
  }
  for (const p of e.papeis) for (const a of p.agentes) liga(`n-${idNo(p.dono)}`, `n-${idNo(`agente:${a.slug}`)}`, "usa");
  for (const p of e.papeis) fontesNos(p.dono, p.fontes);
  for (const a of e.agentes) fontesNos(a.dono, a.fontes);
  // cada fonte liga ao dono dela (função ou agente)
  for (const n of nos.filter((x) => x.camada === "conhecimento")) {
    const dono = n.links[0].href.split("#/k/")[1];
    liga(`n-${idNo(dono)}`, n.id, "consulta");
  }
  return {
    titulo: "leradev · equipe",
    subtitulo: "Funções, trabalho em andamento, agentes alocados e o conhecimento (RAG) de cada um",
    atualizado: new Date().toISOString().slice(0, 16).replace("T", " "),
    camadas: [
      { id: "funcoes", rotulo: "Funções do leradev" },
      { id: "trabalho", rotulo: "Trabalho em andamento" },
      { id: "agentes", rotulo: "Agentes alocados" },
      { id: "conhecimento", rotulo: "Conhecimento (RAG)" },
    ],
    nos,
    ligacoes: ligacoes.filter((l) => l.de && l.para),
  };
}
registrarMapaVirtual(MAPA_EQUIPE, { titulo: "leradev · equipe", gerar: mapaEquipe });

// ---------- comandos ----------

export const commands = {
  equipe_estado({ projetoId } = {}) {
    return estado({ projetoId });
  },
  async papel_agentes_definir({ papel, agentes }) {
    if (!PAPEIS[papel]) throw invalidArgument(`Função desconhecida: ${papel}`);
    if (!PAPEIS[papel].agentes) throw invalidArgument("Esta função não usa agentes do catálogo; ela usa só o conhecimento.");
    const lista = await resolverAgentes(agentes);
    update((c) => {
      c.papeis ??= {};
      c.papeis[papel] = { ...(c.papeis[papel] ?? {}), agentes: lista.map((a) => a.slug) };
    });
    return { papel, agentes: lista };
  },
  rag_fonte_adicionar({ dono, tipo, caminho, texto, url, titulo }) {
    return adicionarFonte({ dono, tipo, caminho, texto, url, titulo });
  },
  rag_fonte_remover({ dono, id }) {
    return removerFonte({ dono, id });
  },
  async rag_testar({ dono, consulta, projetoId }) {
    validarDono(dono);
    if (!String(consulta ?? "").trim()) throw invalidArgument("Escreva o que buscar.");
    const cwd = projetoId ? central.projeto(projetoId).pasta : null;
    const achados = await recuperar({ donos: [dono], consulta, cwd, k: 5 });
    return achados.map((a) => ({ origem: a.origem, linha: a.linha, score: a.score, texto: a.texto.slice(0, 600) }));
  },
};
