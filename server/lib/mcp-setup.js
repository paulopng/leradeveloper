// Liga o decisor (lera-decisor) ao Claude Code, Codex e Cursor.
// Cada arquivo de configuração é copiado para <arquivo>.bak-lera antes de ser alterado.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const NAME = "jev";
const win = process.platform === "win32";
// No Windows o comando é um shim .cmd, que precisa passar pelo cmd.exe.
const command = win ? { command: "cmd", args: ["/c", "lera-decisor"] } : { command: "lera-decisor", args: [] };

function backup(file) {
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-lera`);
}

function cursor(home) {
  const file = path.join(home, ".cursor", "mcp.json");
  let data = {};
  if (fs.existsSync(file)) {
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return { ferramenta: "Cursor", ok: false, detalhe: `${file} não é um JSON válido; não alterei nada.` };
    }
  }
  data.mcpServers ??= {};
  if (data.mcpServers[NAME]) return { ferramenta: "Cursor", ok: true, detalhe: "já configurado" };
  backup(file);
  data.mcpServers[NAME] = command;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  return { ferramenta: "Cursor", ok: true, detalhe: `adicionado em ${file}` };
}

function codex(home) {
  const file = path.join(home, ".codex", "config.toml");
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (/^\[mcp_servers\.jev\]/m.test(text)) return { ferramenta: "Codex", ok: true, detalhe: "já configurado" };
  backup(file);
  const block =
    `\n[mcp_servers.${NAME}]\n` +
    `command = ${JSON.stringify(command.command)}\n` +
    `args = ${JSON.stringify(command.args)}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text.replace(/\s*$/, "\n") + block);
  return { ferramenta: "Codex", ok: true, detalhe: `adicionado em ${file}` };
}

function claudeCode() {
  const args = ["mcp", "add", "--transport", "stdio", "--scope", "user", NAME, "--", command.command, ...command.args];
  const r = spawnSync("claude", args, { encoding: "utf8", shell: win, windowsHide: true });
  if (r.error || r.status === null) {
    return { ferramenta: "Claude Code", ok: false, detalhe: `comando 'claude' não encontrado. Rode depois: claude ${args.join(" ")}` };
  }
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  if (r.status !== 0 && /already exists/i.test(out)) return { ferramenta: "Claude Code", ok: true, detalhe: "já configurado" };
  return { ferramenta: "Claude Code", ok: r.status === 0, detalhe: r.status === 0 ? "adicionado (escopo do usuário)" : out.slice(0, 300) };
}

export function installAll(home = os.homedir()) {
  return [claudeCode(), codex(home), cursor(home)];
}
