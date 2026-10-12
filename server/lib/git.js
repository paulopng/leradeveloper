// `git` subprocess helper (hidden console window on Windows).
import { execFile } from "node:child_process";
import { io } from "./errors.js";

export function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || err.message || "").toString().trim();
          reject(io(`git ${JSON.stringify(args)} failed: ${detail}`));
        } else resolve(stdout.toString());
      },
    );
  });
}

let gitOk;
export async function gitAvailable() {
  if (gitOk !== undefined) return gitOk;
  try {
    await runGit(["--version"]);
    gitOk = true;
  } catch {
    gitOk = false;
  }
  return gitOk;
}

/** `owner/repo` from a github.com remote URL (https or ssh), else null. */
export function githubSlug(url) {
  if (!url) return null;
  const m =
    /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i.exec(
      url.trim(),
    );
  return m ? { owner: m[1], repo: m[2] } : null;
}
