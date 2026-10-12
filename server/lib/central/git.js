// Git sem shell (execFile com lista de argumentos): seguro com qualquer texto.
import { spawnSync } from "node:child_process";

export function git(cwd, args, { input, allowFail = true } = {}) {
  const r = spawnSync("git", args, { cwd, input, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  const out = { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: (r.stderr ?? "") + (r.error ? r.error.message : "") };
  if (!allowFail && out.code !== 0) throw new Error(out.stderr.trim() || `git ${args[0]} falhou`);
  return out;
}

export const isRepo = (cwd) => git(cwd, ["rev-parse", "--is-inside-work-tree"]).stdout.trim() === "true";
export const hasCommits = (cwd) => git(cwd, ["rev-parse", "--verify", "HEAD"]).code === 0;
export const branchAtual = (cwd) => git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim() || null;

/** Arquivos alterados (inclui novos), sem a pasta .lera. */
export function status(cwd) {
  return git(cwd, ["status", "--porcelain", "-uall"])
    .stdout.split("\n")
    .filter(Boolean)
    .map((l) => ({ x: l.slice(0, 2).trim() || "?", caminho: l.slice(3).replace(/^"|"$/g, "") }))
    .filter((f) => !f.caminho.startsWith(".lera/"));
}

/** Diff do que mudou desde o último commit, incluindo arquivos novos (limitado). */
export function diffTrabalho(cwd, { max = 200000 } = {}) {
  let d = hasCommits(cwd) ? git(cwd, ["diff", "HEAD", "--", ".", ":(exclude).lera"]).stdout : git(cwd, ["diff", "--cached"]).stdout;
  const novos = git(cwd, ["ls-files", "--others", "--exclude-standard"]).stdout.split("\n").filter((f) => f && !f.startsWith(".lera/"));
  for (const f of novos.slice(0, 40)) {
    const r = git(cwd, ["diff", "--no-index", "--", "/dev/null", f]);
    d += r.stdout;
    if (d.length > max) break;
  }
  const cortado = d.length > max;
  return { diff: cortado ? d.slice(0, max) + "\n[... cortado ...]\n" : d, cortado, arquivos: status(cwd) };
}
