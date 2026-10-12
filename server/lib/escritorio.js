// Comandos da tela Escritório: mesas dos agentes, validações do Jev e configuração do Jev.
import { invalidArgument, io } from "./errors.js";
import { mesas, registrar, AtividadeError } from "./atividades.js";
import { history, publicConfig, setConfig, saldo, JevError } from "./jev.js";

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
  const conta = (z) => deHoje.filter((d) => d.zona === z).length;
  return {
    hoje: deHoje.length,
    sim: conta("sim") + conta("clara"),
    nao: conta("nao"),
    duvida: conta("duvida"),
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
