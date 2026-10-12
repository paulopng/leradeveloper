// Agentes do catálogo ligados por tarefa: o Jev escolhe os especialistas úteis para o
// pedido, a Central instala só eles no projeto (no formato da ferramenta) antes de rodar e
// tira depois. Agentes que já estavam instalados por você ficam como estavam.
import fs from "node:fs";
import path from "node:path";
import { commands as corpus } from "../corpus.js";
import { commands as install } from "../install.js";
import { consultar, record, config as jevConfig } from "../jev.js";
import { git } from "./git.js";

export const TOOL_ID = { claude: "claudeCode", codex: "codex", cursor: "cursor", antigravity: "antigravity" };

const STOP = new Set(
  "a o e de da do das dos em no na nos nas um uma uns umas para por com sem que se ao aos como mais menos muito pouco ser ter fazer faz feito the and for with from into that this your you are use using make create build add new app apps de del la el los las un una para com".split(" "),
);
const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const palavras = (s) => norm(s).split(/[^a-z0-9+#.]+/).filter((w) => w.length >= 3 && !STOP.has(w));

// sinônimos curtos pt → en, porque o catálogo está em inglês
const SIN = {
  tela: ["ui", "frontend", "interface"], interface: ["ui", "frontend"], celular: ["mobile", "responsive"], visual: ["design", "ui"],
  bonita: ["design", "ui"], teste: ["test", "testing", "qa"], testes: ["test", "testing", "qa"], banco: ["database", "sql"], dados: ["data", "database"],
  seguranca: ["security"], login: ["auth", "authentication", "security"], api: ["backend", "api"], servidor: ["backend", "server", "devops"],
  deploy: ["devops", "deployment", "infrastructure"], publicar: ["devops", "deployment"], documentacao: ["documentation", "docs", "writer"],
  readme: ["documentation", "writer"], desempenho: ["performance"], acessibilidade: ["accessibility"], jogo: ["game"], mapa: ["gis", "map"],
  revisar: ["review", "reviewer"], revisao: ["review", "reviewer"], arquitetura: ["architecture", "architect"], pagina: ["web", "frontend"],
  site: ["web", "frontend", "seo"], app: ["app", "mobile", "frontend"], ia: ["ai", "ml"], dashboard: ["dashboard", "data", "frontend"],
};

/** Até `n` agentes do catálogo com mais palavras em comum com o pedido. */
export async function candidatos(texto, n = 24) {
  const lista = await corpus.corpus_list({});
  const termos = new Set();
  for (const w of palavras(texto)) {
    termos.add(w);
    for (const s of SIN[w] ?? []) termos.add(s);
  }
  if (!termos.size) return [];
  const pont = lista
    .map((a) => {
      const nome = new Set(palavras(a.name));
      const resto = new Set(palavras(`${a.description} ${a.vibe ?? ""} ${a.category}`));
      let s = 0;
      for (const t of termos) {
        if (nome.has(t)) s += 3;
        else if (resto.has(t)) s += 1;
      }
      return { a, s };
    })
    .filter((x) => x.s > 0)
    .sort((x, y) => y.s - x.s || x.a.name.localeCompare(y.a.name));
  return pont.slice(0, n).map((x) => x.a);
}

/** O Jev escolhe os especialistas úteis (até `max`). Sem chave do Jev, não liga nenhum. */
export async function escolherAgentes(texto, { max = 3 } = {}) {
  const cfg = jevConfig();
  if (!cfg.key) return { agentes: [], motivo: "Jev indisponível; nenhum agente ligado automaticamente." };
  const cands = await candidatos(texto);
  if (!cands.length) return { agentes: [], motivo: "Nenhum agente do catálogo tem relação com o pedido." };
  const ids = new Map(cands.map((a, i) => [`a${i}`, a]));
  const r = await consultar({
    contexto: { task: String(texto).slice(0, 6000) },
    perguntas: [...ids.entries()].map(([id, a]) => ({
      id,
      tipo: "decidir",
      pergunta: `Would the specialist agent "${a.name}" (${String(a.description).slice(0, 300)}) materially help a coding assistant carry out \`task\`?`,
    })),
  });
  const escolhidos = [...ids.entries()]
    .map(([id, a]) => ({ slug: a.slug, nome: a.name, emoji: a.emoji ?? null, prob: r.respostas[id].probabilidade_sim }))
    .filter((x) => x.prob > cfg.high)
    .sort((x, y) => y.prob - x.prob)
    .slice(0, max);
  record({
    ...r,
    pergunta: `Agentes para: ${String(texto).split("\n")[0].slice(0, 120)}`,
    agente: "Central (agentes)",
    ferramenta: "leradeveloper",
    contexto: String(texto).slice(0, 400),
  });
  return {
    agentes: escolhidos,
    motivo: escolhidos.length ? `O Jev ligou ${escolhidos.length} de ${cands.length} candidatos.` : `O Jev avaliou ${cands.length} candidatos e nenhum ajudaria o bastante.`,
  };
}

// ---------- ligar e desligar ----------

const MARCA = "# lera: agentes ligados pela Central";

function excludeFile(cwd) {
  const r = git(cwd, ["rev-parse", "--git-path", "info/exclude"]);
  return r.code === 0 ? path.resolve(cwd, r.stdout.trim()) : null;
}
function ajustarExclude(cwd, rel, adicionar) {
  const f = excludeFile(cwd);
  if (!f) return;
  let txt = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
  const linha = `/${rel.replace(/\\/g, "/")} ${MARCA}`;
  const linhas = txt.split("\n").filter((l) => l !== linha);
  if (adicionar) linhas.push(linha);
  txt = linhas.join("\n").replace(/\n*$/, "\n");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, txt);
}

/** Instala os agentes na pasta da tarefa. Devolve o que foi ligado. */
export async function ligar(cwd, ferramenta, agentes) {
  const tool = TOOL_ID[ferramenta];
  if (!tool || !agentes?.length) return [];
  const ligados = [];
  for (const a of agentes) {
    const destinos = await install.agent_diff({ slug: a.slug, tool, projectPath: cwd }).catch(() => null);
    const jaTinha = !!destinos?.onDisk;
    try {
      const rec = jaTinha ? null : await install.install_agent({ slug: a.slug, tool, projectPath: cwd });
      const dest = rec?.dest ?? destinos?.dest ?? null;
      if (!jaTinha && dest) ajustarExclude(cwd, path.relative(cwd, dest), true);
      ligados.push({ ...a, dest, temporario: !jaTinha });
    } catch (e) {
      ligados.push({ ...a, erro: e.payload?.message ?? e.message, temporario: false });
    }
  }
  return ligados;
}

/** Tira os agentes que a Central ligou. */
export async function desligar(cwd, ferramenta, ligados) {
  const tool = TOOL_ID[ferramenta];
  if (!tool) return;
  for (const a of ligados ?? []) {
    if (!a.temporario) continue;
    try {
      await install.uninstall_agent({ slug: a.slug, tool, projectPath: cwd });
    } catch {
      /* já removido */
    }
    if (a.dest) ajustarExclude(cwd, path.relative(cwd, a.dest), false);
  }
}

/** Texto que avisa a ferramenta sobre os especialistas disponíveis. */
export function instrucao(ferramenta, ligados) {
  const ok = (ligados ?? []).filter((a) => !a.erro);
  if (!ok.length) return "";
  const nomes = ok.map((a) => `- ${a.nome} (${a.slug})`).join("\n");
  const como = {
    claude: "Eles estão em .claude/agents como subagentes; delegue a eles com a ferramenta Agent quando ajudar.",
    codex: "Eles estão em .codex/agents como agentes do Codex; use-os quando ajudar.",
    cursor: "Eles estão em .cursor/rules como regras; siga as orientações deles.",
    antigravity: "Eles estão em .agents/skills como skills; use-as quando ajudar.",
  }[ferramenta];
  return `\n\nEspecialistas ligados para esta tarefa pelo leradeveloper:\n${nomes}\n${como}`;
}
