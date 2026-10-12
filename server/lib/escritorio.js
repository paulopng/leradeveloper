// Comandos da tela Escritório: mesas dos agentes, validações do Jev e configuração do Jev.
import { invalidArgument, io } from "./errors.js";
import { mesas, registrar, AtividadeError } from "./atividades.js";
import { history, publicConfig, setConfig, saldo, calibracao, registrarResultado, JevError } from "./jev.js";

const wrap = (fn) => (args) => {
  try {
    const r = fn(args ?? {});
    return r instanceof Promise ? r.catch(rethrow) : r;
  } catch (e) {
    rethrow(e);
  }
};
function rethrow(e) {
  if (e instanceof AtividadeError || e instanceof JevError) throw invalidArgument(e.message);
  throw e;
}

function resumoDecisoes(decisoes) {
  const hoje = new Date().toISOString().slice(0, 10);
  const deHoje = decisoes.filter((d) => String(d.quando ?? "").startsWith(hoje));
  const duvida = deHoje.filter((d) => d.zona === "duvida").length;
  const nao = deHoje.filter((d) => d.zona === "nao" || d.zona === "acima").length;
  return {
    hoje: deHoje.length,
    sim: deHoje.length - duvida - nao,
    nao,
    duvida,
    custoUsd: deHoje.reduce((a, d) => a + (Number(d.custo_usd) || 0), 0),
  };
}

export const commands = {
  escritorio_estado: wrap(() => {
    const decisoes = history(200);
    return {
      agora: new Date().toISOString(),
      mesas: mesas(),
      decisoes: decisoes.slice(0, 60),
      resumo: resumoDecisoes(decisoes),
      jev: publicConfig(),
    };
  }),
  escritorio_registrar: wrap((evt) => registrar(evt)),
  jev_config_obter: wrap(() => publicConfig()),
  jev_calibracao: wrap(() => calibracao()),
  jev_registrar_resultado: wrap((args) => registrarResultado(args)),
  jev_config_definir: wrap((args) => setConfig(args)),
  jev_saldo: wrap(async () => {
    try {
      return await saldo();
    } catch (e) {
      if (e instanceof JevError) throw io(e.message);
      throw e;
    }
  }),
};
