// Servidor MCP "decisor": expõe o Jev para Claude Code, Codex e Cursor.
// Protocolo: JSON-RPC 2.0 por stdio, uma mensagem por linha. Sem dependências.
import readline from "node:readline";
import { decidir, escolher, history, record, config, JevError } from "./lib/jev.js";
import { VERSION } from "./lib/system.js";
import { registrar, STATUS } from "./lib/atividades.js";

const PROTOCOL = "2025-06-18";

const TOOLS = [
  {
    name: "decidir",
    title: "Decidir (sim/não) com o Jev",
    description:
      "Use ANTES de rotear uma tarefa, aprovar uma entrega ou seguir um caminho arriscado. " +
      "Faz uma pergunta de sim/não ao Jev e devolve a probabilidade de 'sim' e a zona: " +
      "'sim' ou 'nao' (confiante, siga a recomendação) ou 'duvida' (pare e pergunte ao usuário). " +
      "O Jev não faz contas nem compara datas: calcule esses fatos antes e coloque no contexto.",
    inputSchema: {
      type: "object",
      properties: {
        pergunta: { type: "string", description: "A pergunta de sim/não, clara e específica." },
        contexto: { description: "Fatos relevantes para a decisão (texto ou objeto JSON).", anyOf: [{ type: "string" }, { type: "object" }] },
        criterio_sim: { type: "string", description: "Opcional: o que caracteriza 'sim'." },
        criterio_nao: { type: "string", description: "Opcional: o que caracteriza 'não'." },
        agente: { type: "string", description: "Seu nome de agente (o mesmo de registrar_atividade), para o Escritório ligar a validação à sua mesa." },
      },
      required: ["pergunta", "contexto"],
    },
  },
  {
    name: "escolher",
    title: "Escolher entre opções com o Jev",
    description:
      "Use quando houver 2 a 20 caminhos possíveis (qual agente recebe a tarefa, qual abordagem seguir). " +
      "Devolve o ranking com probabilidades. Se a zona vier 'duvida', pare e pergunte ao usuário.",
    inputSchema: {
      type: "object",
      properties: {
        pergunta: { type: "string", description: "O que está sendo escolhido." },
        contexto: { description: "Fatos relevantes (texto ou objeto JSON).", anyOf: [{ type: "string" }, { type: "object" }] },
        opcoes: {
          description: "Lista de opções (textos) ou objeto { rótulo: descrição }.",
          anyOf: [{ type: "array", items: { type: "string" }, minItems: 2 }, { type: "object" }],
        },
        agente: { type: "string", description: "Seu nome de agente (o mesmo de registrar_atividade), para o Escritório ligar a validação à sua mesa." },
      },
      required: ["pergunta", "contexto", "opcoes"],
    },
  },
  {
    name: "registrar_atividade",
    title: "Registrar atividade no Escritório",
    description:
      "Atualiza a sua mesa no Escritório do leradeveloper, onde o usuário acompanha os agentes. " +
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
    description: "Lista as últimas decisões tomadas pelo Jev nesta máquina (mais recentes primeiro).",
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

async function callTool(name, args) {
  if (name === "decidir") {
    const r = await decidir(args ?? {});
    record({ ...r, agente: args?.agente ?? null, ferramenta: clientName, contexto: summarize(args?.contexto) });
    return asText(r);
  }
  if (name === "escolher") {
    const r = await escolher(args ?? {});
    record({ ...r, agente: args?.agente ?? null, ferramenta: clientName, contexto: summarize(args?.contexto) });
    return asText(r);
  }
  if (name === "registrar_atividade") {
    const e = registrar({ ...(args ?? {}), ferramenta: args?.ferramenta ?? clientName });
    return asText({ ok: true, registrado: e });
  }
  if (name === "historico_decisoes") return asText({ decisoes: history(Number(args?.limite) || 20) });
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
          serverInfo: { name: "lera-decisor", title: "Decisor Jev (leradeveloper)", version: VERSION },
          instructions:
            "Decisor baseado no Jev (TypeSafe). Antes de rotear, aprovar ou escolher caminhos, chame 'decidir' ou 'escolher'. " +
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
