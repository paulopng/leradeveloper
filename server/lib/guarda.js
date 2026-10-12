// Guarda do Claude Code: hook PreToolUse que pergunta ao Jev antes de comandos arriscados.
//
// Regras de segurança do próprio guarda:
//  - Só olha comandos Bash que batem com padrões arriscados; o resto passa sem custo.
//  - Nunca libera nada ("allow") nem bloqueia sozinho ("deny"): no máximo pede a sua
//    confirmação ("ask"). O Jev não é barreira de segurança; as permissões do Claude
//    Code continuam valendo.
//  - Qualquer erro (sem chave, sem rede) = sem opinião, o fluxo normal segue.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { consultar, record, config } from "./jev.js";

export const RISCO = new RegExp(
  [
    String.raw`\brm\s+(-\w*[rf]|--recursive|--force)`,
    String.raw`\b(rmdir|shred|mkfs|dd\s+if=)`,
    String.raw`\bRemove-Item\b`,
    String.raw`\bdel\s+/[sq]`,
    String.raw`\bgit\s+(push|reset\s+--hard|clean\s+-\w*f|checkout\s+--\s|restore\s|branch\s+-D|rebase|filter-(branch|repo)|tag\s+-d|stash\s+(drop|clear)|update-ref\s+-d)`,
    String.raw`--force(-with-lease)?\b`,
    String.raw`\b(npm|pnpm|yarn)\s+(publish|unpublish|deprecate)`,
    String.raw`\b(cargo\s+publish|twine\s+upload|gem\s+push|dotnet\s+nuget\s+push)`,
    String.raw`\bdocker\s+(rm|rmi|push|system\s+prune|volume\s+(rm|prune))`,
    String.raw`\bkubectl\s+(delete|apply|scale|drain|rollout)`,
    String.raw`\b(terraform|tofu)\s+(apply|destroy|import|state\s+rm)`,
    String.raw`\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)|\bDELETE\s+FROM\b|\bALTER\s+TABLE\b`,
    String.raw`\b(chmod|chown)\s+-R\b`,
    String.raw`\b(shutdown|reboot|Stop-Computer|Restart-Computer)\b`,
    String.raw`\b(curl|wget|iwr|Invoke-WebRequest)\b[^|]*\|\s*(sh|bash|zsh|iex|Invoke-Expression)\b`,
    String.raw`\bgh\s+(release\s+(create|delete)|repo\s+(delete|archive|edit)|pr\s+merge|secret\s+(set|delete)|api\s+.*-X\s*(DELETE|PUT|PATCH|POST))`,
    String.raw`\b(scoop|brew|winget|choco)\s+(uninstall|remove)`,
    String.raw`\bsetx?\s+\w*(KEY|TOKEN|SECRET|PASS)`,
  ].join("|"),
  "i",
);

export function isRisky(command) {
  return typeof command === "string" && RISCO.test(command);
}

/** Recebe o JSON do hook e devolve o JSON de saída (ou null = sem opinião). */
export async function guardar(input, cfg = config(), fetchImpl = fetch) {
  if (input?.tool_name !== "Bash") return null;
  const command = input?.tool_input?.command;
  if (!isRisky(command)) return null;
  if (!cfg.key) return null;
  let r;
  try {
    r = await consultar(
      {
        contexto: { command: String(command).slice(0, 4000), working_directory: input.cwd ?? null, stated_purpose: input.tool_input?.description ?? null },
        perguntas: {
          destrutivo: {
            tipo: "decidir",
            pergunta: "Does running `command` delete, overwrite or irreversibly change files, data or history that may not be recoverable?",
          },
          externo: {
            tipo: "decidir",
            pergunta: "Does running `command` affect something outside the local working copy, such as a remote repository, a package registry, a production system, cloud resources or other people?",
          },
        },
      },
      cfg,
      fetchImpl,
    );
  } catch {
    return null;
  }
  const pd = r.respostas.destrutivo.probabilidade_sim;
  const pe = r.respostas.externo.probabilidade_sim;
  const pmax = Math.max(pd, pe);
  const precisa = pmax >= cfg.low;
  record({
    tipo: "guarda",
    pergunta: `Comando: ${String(command).slice(0, 160)}`,
    probabilidade_sim: pmax,
    zona: pmax > cfg.high ? "sim" : pmax < cfg.low ? "nao" : "duvida",
    precisa_humano: precisa,
    detalhes: { destrutivo: pd, externo: pe },
    agente: input.agent_type ? `Guarda (${input.agent_type})` : "Guarda do Claude Code",
    ferramenta: "claude-code",
    modelo: r.modelo,
    custo_usd: r.custo_usd,
    latencia_ms: r.latencia_ms,
    ref: r.ref,
  });
  if (!precisa) return null;
  const pct = (p) => `${Math.round(p * 100)}%`;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: `Jev: ${pct(pd)} de chance de ser destrutivo e ${pct(pe)} de afetar algo fora da sua cópia local. Confirme antes de rodar.`,
    },
  };
}

// ---------- instalação no ~/.claude/settings.json ----------

const MARK = "lera-decisor";
function hookCommand() {
  if (process.platform !== "win32") return "lera-decisor --guarda";
  // No Windows, caminho estável do Scoop (pasta "current") e node direto, sem depender do shell.
  let script = fileURLToPath(new URL("../../bin/lera-decisor.js", import.meta.url));
  script = script.replace(/([\\/]apps[\\/]leradeveloper[\\/])[^\\/]+([\\/])/i, "$1current$2").replace(/\\/g, "/");
  return `node "${script}" --guarda`;
}

function settingsFile(home) {
  return path.join(home, ".claude", "settings.json");
}

export function instalarGuarda(home = os.homedir()) {
  const file = settingsFile(home);
  let cfg = {};
  let original = null;
  if (fs.existsSync(file)) {
    original = fs.readFileSync(file, "utf8");
    try {
      cfg = JSON.parse(original);
    } catch {
      throw new Error(`${file} não é um JSON válido; corrija antes de instalar o guarda.`);
    }
  }
  cfg.hooks ??= {};
  cfg.hooks.PreToolUse ??= [];
  const ja = cfg.hooks.PreToolUse.some((g) => (g.hooks ?? []).some((h) => String(h.command ?? "").includes(MARK)));
  if (ja) return { arquivo: file, detalhe: "já instalado" };
  cfg.hooks.PreToolUse.push({ matcher: "Bash", hooks: [{ type: "command", command: hookCommand(), timeout: 20 }] });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (original != null) fs.writeFileSync(`${file}.bak-lera`, original);
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  return { arquivo: file, detalhe: "instalado" };
}

export function removerGuarda(home = os.homedir()) {
  const file = settingsFile(home);
  if (!fs.existsSync(file)) return { arquivo: file, detalhe: "não estava instalado" };
  const original = fs.readFileSync(file, "utf8");
  const cfg = JSON.parse(original);
  const before = JSON.stringify(cfg.hooks?.PreToolUse ?? []);
  if (cfg.hooks?.PreToolUse) {
    cfg.hooks.PreToolUse = cfg.hooks.PreToolUse
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !String(h.command ?? "").includes(MARK)) }))
      .filter((g) => g.hooks.length);
    if (!cfg.hooks.PreToolUse.length) delete cfg.hooks.PreToolUse;
    if (!Object.keys(cfg.hooks).length) delete cfg.hooks;
  }
  if (JSON.stringify(cfg.hooks?.PreToolUse ?? []) === before) return { arquivo: file, detalhe: "não estava instalado" };
  fs.writeFileSync(`${file}.bak-lera`, original);
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  return { arquivo: file, detalhe: "removido" };
}
