// Prévias a partir da Central: do projeto, de uma tarefa, de uma etapa de um objetivo
// (a cópia dela, ou a integração depois de juntada) ou do resultado do objetivo inteiro.
import { update } from "../lera-config.js";
import { invalidArgument } from "../errors.js";
import { abrir, detectar } from "../previa.js";
import * as central from "./index.js";
import { commands as coordCmds, pastaDaTarefa } from "./coordenador.js";

const MODOS = ["auto", "estatico", "script"];

function cfgProjeto(projetoId) {
  return central.projeto(projetoId).previa ?? {};
}

export const commands = {
  async previa_abrir({ projetoId, tarefaId, coordId, etapa }) {
    if (coordId) {
      const c = coordCmds.coord_obter({ id: coordId });
      let dir, rotulo;
      if (etapa) {
        const t = c.plano?.tarefas.find((x) => x.id === etapa);
        if (!t) throw invalidArgument("Etapa não encontrada.");
        dir = pastaDaTarefa(c, etapa);
        rotulo = `${t.titulo} · ${c.projeto?.nome ?? ""}`;
      } else {
        dir = c.integWt;
        rotulo = `Resultado · ${c.objetivo.split("\n")[0].slice(0, 60)}`;
      }
      if (!dir) throw invalidArgument("Ainda não há cópia de trabalho para mostrar (o objetivo não começou ou já foi entregue).");
      return abrir({ dir, rotulo, origem: { coordId, etapa: etapa ?? null }, cfg: cfgProjeto(c.projetoId) });
    }
    if (tarefaId) {
      const t = central.tarefa(tarefaId);
      return abrir({ dir: t.cwd, rotulo: `${t.titulo}`, origem: { tarefaId }, cfg: cfgProjeto(t.projetoId) });
    }
    const p = central.projeto(projetoId);
    return abrir({ dir: p.pasta, rotulo: p.nome, origem: { projetoId }, cfg: p.previa ?? {} });
  },
  projeto_previa_config({ projetoId }) {
    const p = central.projeto(projetoId);
    let det = null;
    let erro = null;
    try {
      det = detectar(p.pasta, p.previa ?? {});
    } catch (e) {
      erro = e.payload?.message ?? e.message;
    }
    return { config: p.previa ?? { modo: "auto" }, detectado: det && { modo: det.modo, script: det.script ?? null, raiz: det.raizRel ?? null, scripts: det.scripts, raizes: det.raizes }, erro };
  },
  projeto_previa_definir({ projetoId, modo = "auto", script = null, raiz = null, pasta = null }) {
    central.projeto(projetoId);
    if (!MODOS.includes(modo)) throw invalidArgument(`Modo inválido: ${modo}`);
    if (script != null && !/^[\w:.-]{1,40}$/.test(script)) throw invalidArgument("Nome de script inválido.");
    if (pasta != null && (typeof pasta !== "string" || pasta.includes("..") || /^([a-z]:|[\\/])/i.test(pasta))) throw invalidArgument("A subpasta precisa ser relativa ao projeto.");
    update((c) => {
      const p = c.central.projetos.find((x) => x.id === projetoId);
      if (p) p.previa = { modo, script: script || null, raiz: raiz || null, pasta: pasta || null };
    });
    return commands.projeto_previa_config({ projetoId });
  },
};
