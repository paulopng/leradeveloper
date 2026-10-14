// Servidor MCP "decisor": expõe o Jev para Claude Code, Codex e Cursor.
// Protocolo: JSON-RPC 2.0 por stdio, uma mensagem por linha. Sem dependências.
import readline from "node:readline";
import { decidir, escolher, avaliar, consultar, revisarMudanca, registrarResultado, history, record, config, JevError } from "./lib/jev.js";
import { VERSION } from "./lib/system.js";
import { registrar, STATUS } from "./lib/atividades.js";

const PROTOCOL = "2025-06-18";

const IDIOMA =
  " Escreva a pergunta, as opções e os níveis em INGLÊS: o Jev é mais preciso em inglês (com o usuário, continue em português).";
const CONTEXTO = {
  description:
    "Fatos para a decisão (texto ou objeto JSON). Só o que importa para a pergunta; contas, contagens e datas já calculadas. " +
    "Num objeto, cite os campos na pergunta entre crases, por exemplo `change`.",
  anyOf: [{ type: "string" }, { type: "object" }],
};
const AGENTE = { type: "string", description: "Seu nome de agente (o mesmo de registrar_atividade), para o Escritório ligar a validação à sua mesa." };
const OPCOES = {
  description: "Lista de opções (textos) ou objeto { rótulo: descrição }. Descreva cada opção como para um colega novo.",
  anyOf: [{ type: "array", items: { type: "string" }, minItems: 2 }, { type: "object" }],
};
const NIVEIS = {
  type: "array",
  items: { type: "string" },
  minItems: 2,
  maxItems: 10,
  description: "De 2 a 10 níveis, do MENOR para o MAIOR, cada um descrito em palavras (não use só números).",
};

const TOOLS = [
  {
    name: "decidir",
    title: "Decidir (sim/não) com o Jev",
    description:
      "Use ANTES de aprovar uma entrega, seguir um caminho arriscado ou confirmar um fato semântico. " +
      "Uma pergunta de sim/não, específica. Devolve a probabilidade de 'sim' e a zona: 'sim' ou 'nao' (confiante, siga) " +
      "ou 'duvida' (pare e pergunte ao usuário). Guarde o 'ref' para depois registrar o resultado real." + IDIOMA,
    inputSchema: {
      type: "object",
      properties: {
        pergunta: { type: "string", description: "A pergunta de sim/não, clara e específica." },
        contexto: CONTEXTO,
        criterio_sim: { type: "string", description: "Opcional: o que caracteriza 'sim'." },
        criterio_nao: { type: "string", description: "Opcional: o que caracteriza 'não'." },
        agente: AGENTE,
      },
      required: ["pergunta", "contexto"],
    },
  },
  {
    name: "escolher",
    title: "Escolher entre opções com o Jev",
    description:
      "Use quando houver 2 ou mais caminhos (qual agente recebe a tarefa, qual abordagem, qual categoria). " +
      "Uma pergunta 'choice' nativa do Jev: probabilidades calibradas entre as opções. Inclui por padrão 'nenhuma das opções'. " +
      "Zona 'duvida' ou escolha nula: pare e pergunte ao usuário." + IDIOMA,
    inputSchema: {
      type: "object",
      properties: {
        pergunta: { type: "string", description: "O que está sendo escolhido." },
        contexto: CONTEXTO,
        opcoes: OPCOES,
        incluir_outra: { type: "boolean", description: "Inclui a opção 'nenhuma das opções' (padrão: true)." },
        agente: AGENTE,
      },
      required: ["pergunta", "contexto", "opcoes"],
    },
  },
  {
    name: "avaliar",
    title: "Avaliar numa escala com o Jev",
    description:
      "Use para medir algo em níveis descritos: severidade de um bug, risco de uma mudança, prontidão para entregar, " +
      "qualidade de um texto contra uma rubrica. Pergunta 'score' nativa do Jev: devolve o nível, a distribuição e a confiança. " +
      "Com 'limite_humano' (índice do nível a partir do qual o usuário precisa ver), devolve precisa_humano." + IDIOMA,
    inputSchema: {
      type: "object",
      properties: {
        pergunta: { type: "string", description: "O que está sendo medido." },
        contexto: CONTEXTO,
        niveis: NIVEIS,
        limite_humano: { type: "integer", minimum: 1, description: "Opcional: a partir deste nível (índice, começando em 0), leve ao usuário." },
        agente: AGENTE,
      },
      required: ["pergunta", "contexto", "niveis"],
    },
  },
  {
    name: "consultar",
    title: "Várias perguntas ao Jev numa chamada",
    description:
      "Decomponha uma decisão em perguntas INDEPENDENTES sobre o mesmo contexto e mande todas juntas: mais rápido, mais barato " +
      "e cada uma responde sozinha (uma não vê a resposta da outra). Combine as respostas você mesmo. " +
      "Ex.: triagem de um problema = avaliar severidade + escolher área + decidir se é reproduzível. Até 40 perguntas." + IDIOMA,
    inputSchema: {
      type: "object",
      properties: {
        contexto: CONTEXTO,
        perguntas: {
          type: "array",
          minItems: 1,
          maxItems: 40,
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Nome curto da pergunta (não é enviado ao Jev; o sentido fica na pergunta)." },
              tipo: { type: "string", enum: ["decidir", "escolher", "avaliar"] },
              pergunta: { type: "string" },
              criterio_sim: { type: "string" },
              criterio_nao: { type: "string" },
              opcoes: OPCOES,
              incluir_outra: { type: "boolean" },
              niveis: NIVEIS,
              limite_humano: { type: "integer", minimum: 1 },
            },
            required: ["id", "tipo", "pergunta"],
          },
        },
        agente: AGENTE,
      },
      required: ["contexto", "perguntas"],
    },
  },
  {
    name: "revisar_mudanca",
    title: "Revisar uma mudança de código com o Jev",
    description:
      "Portão antes de merge/commit/entrega: seis perguntas prontas numa chamada (risco em 5 níveis, cumpre o objetivo, " +
      "testes adequados, quebra compatibilidade, toca segurança, próximo passo) e um veredito: aprovar, ajustar, refazer ou humano. " +
      "Rode os testes ANTES e descreva o resultado em 'testes'. Veredito 'humano': pare e mostre os motivos ao usuário.",
    inputSchema: {
      type: "object",
      properties: {
        objetivo: { type: "string", description: "O que a mudança deveria fazer (de preferência em inglês)." },
        mudanca: { type: "string", description: "O diff (git diff) ou um resumo fiel. Até 60 mil caracteres." },
        testes: { type: "string", description: "Quais testes rodaram e o resultado (ex.: '42 passed, 0 failed; new test for X')." },
        arquivos: { type: "array", items: { type: "string" }, description: "Arquivos alterados." },
        agente: AGENTE,
      },
      required: ["objetivo", "mudanca"],
    },
  },
  {
    name: "registrar_resultado",
    title: "Registrar o que aconteceu depois de uma decisão",
    description:
      "Quando souber o desfecho real de uma decisão do Jev (o teste passou, o usuário escolheu outra opção, o bug era mesmo crítico), " +
      "registre com o 'ref' da decisão. Isso mede o acerto do Jev e calibra a zona de dúvida no Escritório.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "O 'ref' devolvido pela decisão." },
        resposta_real: { description: "decidir: 'sim' ou 'nao'; escolher: o rótulo certo; avaliar: o índice do nível certo.", anyOf: [{ type: "string" }, { type: "integer" }] },
        correta: { type: "boolean", description: "Alternativa: só dizer se o Jev acertou." },
        observacao: { type: "string" },
      },
      required: ["ref"],
    },
  },
  {
    name: "registrar_atividade",
    title: "Registrar atividade no Escritório",
    description:
      "Atualiza a sua mesa no Escritório do leradev, onde o usuário acompanha os agentes. " +
      "Chame ao começar uma tarefa (progresso 0), a cada etapa importante (progresso de 0 a 100), " +
      "quando estiver esperando o usuário (status 'aguardando'), quando travar ('bloqueado' ou 'erro') " +
      "e ao terminar ('concluido'). Use sempre o mesmo nome de agente. Mensagens curtas, em português do Brasil.",
    inputSchema: {
      type: "object",
      properties: {
        agente: { type: "string", description: "Seu nome de agente, por exemplo 'Coordenador Jev'." },
        tarefa: { type: "string", description: "A tarefa atual, em poucas palavras. Mudar o texto começa uma tarefa nova." },
        progresso: { type: "number", minimum: 0, maximum: 100, description: "Quanto da tarefa já foi feito, de 0 a 100." },
        status: { type: "string", enum: STATUS, description: "Padrão: trabalhando." },
        mensagem: { type: "string", description: "O que acabou de acontecer ou o que falta, em uma frase." },
        projeto: { type: "string", description: "Opcional: id do projeto/mapa relacionado." },
      },
      required: ["agente", "tarefa"],
    },
  },
  {
    name: "historico_decisoes",
    title: "Histórico de decisões",
    description: "Lista as últimas decisões tomadas pelo Jev nesta máquina (mais recentes primeiro), com o 'ref' e o resultado, se registrado.",
    inputSchema: { type: "object", properties: { limite: { type: "number", description: "Quantas (padrão 20)." } } },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
const result = (id, r) => send({ jsonrpc: "2.0", id, result: r });
const error = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

function asText(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }], structuredContent: obj };
}

async function callTool(name, args = {}) {
  args ??= {};
  const meta = () => ({ agente: args.agente ?? null, ferramenta: clientName, contexto: summarize(args.contexto ?? args.objetivo) });
  const DECISOES = { decidir, escolher, avaliar, consultar, revisar_mudanca: revisarMudanca };
  if (DECISOES[name]) {
    const r = await DECISOES[name](args);
    record({ ...r, ...meta() });
    return asText(r);
  }
  if (name === "registrar_resultado") return asText({ ok: true, registrado: registrarResultado(args) });
  if (name === "registrar_atividade") {
    const e = registrar({ ...args, ferramenta: args.ferramenta ?? clientName });
    return asText({ ok: true, registrado: e });
  }
  if (name === "historico_decisoes") return asText({ decisoes: history(Number(args.limite) || 20) });
  throw new JevError(`Ferramenta desconhecida: ${name}`);
}
// Nome do cliente MCP (Claude Code, Codex, Cursor...), guardado no initialize.
let clientName = null;
const summarize = (c) => (typeof c === "string" ? c : JSON.stringify(c ?? "")).slice(0, 400);

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    switch (method) {
      case "initialize":
        clientName = String(params?.clientInfo?.name ?? "").slice(0, 40) || null;
        return result(id, {
          protocolVersion: params?.protocolVersion || PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "lera-decisor", title: "Decisor Jev (leradev)", version: VERSION },
          instructions:
            "Decisor baseado no Jev (TypeSafe), um modelo que só devolve probabilidades calibradas. Antes de rotear, aprovar ou escolher caminhos, " +
            "use 'decidir' (sim/não), 'escolher' (opções), 'avaliar' (escala) ou 'consultar' (várias perguntas independentes de uma vez); " +
            "antes de merge ou entrega, 'revisar_mudanca'. Escreva as perguntas em inglês e calcule contas e datas antes. " +
            "Quando souber o desfecho real, chame 'registrar_resultado' com o 'ref'. " +
            "Se a resposta trouxer precisa_humano=true, pare e pergunte ao usuário, mostrando a probabilidade. " +
            "Mantenha sua mesa no Escritório atualizada com 'registrar_atividade' (início, etapas com progresso, espera, fim). Responda sempre em português do Brasil.",
        });
      case "ping":
        return result(id, {});
      case "tools/list":
        return result(id, { tools: TOOLS });
      case "tools/call":
        try {
          return result(id, await callTool(params?.name, params?.arguments));
        } catch (e) {
          // Erros de ferramenta voltam como resultado com isError, para o agente ler e reagir.
          return result(id, { content: [{ type: "text", text: e instanceof JevError ? e.message : `Erro: ${e.message}` }], isError: true });
        }
      default:
        if (method?.startsWith("notifications/")) return; // sem resposta
        if (isRequest) return error(id, -32601, `Método não suportado: ${method}`);
    }
  } catch (e) {
    if (isRequest) error(id, -32603, e.message);
  }
}

export function start() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return error(null, -32700, "JSON inválido");
    }
    if (Array.isArray(msg)) msg.forEach(handle);
    else handle(msg);
  });
  rl.on("close", () => process.exit(0));
  if (!config().key) process.stderr.write("[lera-decisor] aviso: TYPESAFE_API_KEY não definida; as decisões vão falhar até você definir.\n");
}
