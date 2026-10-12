// App-level commands: version, updates (handled by brew/scoop), and native
// file dialogs for the browser UI (a browser can't hand back real paths, so
// the local server opens the OS picker on the user's behalf).
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { SERVER_DIR } from "./paths.js";
import { AppError } from "./errors.js";

const pkg = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, "..", "package.json"), "utf8"));
export const VERSION = pkg.version;

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 1024 * 1024, ...opts }, (err, stdout) => {
      if (err) resolve({ ok: false, code: err.code, out: "" });
      else resolve({ ok: true, out: stdout.toString() });
    });
  });
}

const psQuote = (s) => `'${String(s ?? "").replaceAll("'", "''")}'`;
const asQuote = (s) => `"${String(s ?? "").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/**
 * Native picker. Returns `{ path }` (or `{ paths }` for multiple), `{ path: null }`
 * when cancelled, or `{ unsupported: true }` when no picker exists (headless
 * Linux) so the UI can fall back to typing a path.
 */
async function dialog({ mode = "open", directory = false, multiple = false, title, defaultPath, filters } = {}) {
  const exts = (filters ?? []).flatMap((f) => f.extensions ?? []);

  if (process.platform === "darwin") {
    let script;
    if (mode === "save") {
      script = `POSIX path of (choose file name with prompt ${asQuote(title ?? "Save")}${defaultPath ? ` default name ${asQuote(path.basename(defaultPath))}` : ""})`;
    } else if (directory) {
      script = `POSIX path of (choose folder with prompt ${asQuote(title ?? "Choose a folder")})`;
    } else {
      const types = exts.length ? ` of type {${exts.map(asQuote).join(", ")}}` : "";
      script = `POSIX path of (choose file with prompt ${asQuote(title ?? "Choose a file")}${types})`;
    }
    const r = await run("osascript", ["-e", script]);
    const p = r.ok ? r.out.trim().replace(/\/$/, "") || "/" : null;
    return multiple ? { paths: p ? [p] : null } : { path: p };
  }

  if (process.platform === "win32") {
    let ps;
    if (mode === "save") {
      ps = `$d=New-Object System.Windows.Forms.SaveFileDialog;$d.Title=${psQuote(title)};$d.FileName=${psQuote(defaultPath ? path.basename(defaultPath) : "")};${exts.length ? `$d.Filter=${psQuote(`${exts.join(", ")}|${exts.map((e) => `*.${e}`).join(";")}`)};` : ""}if($d.ShowDialog((New-Object System.Windows.Forms.Form -Property @{TopMost=$true})) -eq 'OK'){$d.FileName}`;
    } else if (directory) {
      ps = `$d=New-Object System.Windows.Forms.FolderBrowserDialog;$d.Description=${psQuote(title)};$d.ShowNewFolderButton=$true;if($d.ShowDialog((New-Object System.Windows.Forms.Form -Property @{TopMost=$true})) -eq 'OK'){$d.SelectedPath}`;
    } else {
      ps = `$d=New-Object System.Windows.Forms.OpenFileDialog;$d.Title=${psQuote(title)};${exts.length ? `$d.Filter=${psQuote(`${exts.join(", ")}|${exts.map((e) => `*.${e}`).join(";")}`)};` : ""}if($d.ShowDialog((New-Object System.Windows.Forms.Form -Property @{TopMost=$true})) -eq 'OK'){$d.FileName}`;
    }
    const r = await run("powershell.exe", [
      "-NoProfile",
      "-STA",
      "-Command",
      `Add-Type -AssemblyName System.Windows.Forms;[Console]::OutputEncoding=[Text.Encoding]::UTF8;${ps}`,
    ]);
    if (!r.ok && r.code === "ENOENT") return { unsupported: true };
    const p = r.out.trim() || null;
    return multiple ? { paths: p ? [p] : null } : { path: p };
  }

  // Linux: zenity, then kdialog.
  const z = ["--file-selection", `--title=${title ?? "Choose"}`];
  if (directory) z.push("--directory");
  if (mode === "save") z.push("--save", "--confirm-overwrite", ...(defaultPath ? [`--filename=${defaultPath}`] : []));
  let r = await run("zenity", z);
  if (!r.ok && r.code === "ENOENT") {
    const k = mode === "save" ? ["--getsavefilename", defaultPath ?? "."] : directory ? ["--getexistingdirectory", "."] : ["--getopenfilename", "."];
    r = await run("kdialog", k);
    if (!r.ok && r.code === "ENOENT") return { unsupported: true };
  }
  const p = r.ok ? r.out.trim() || null : null;
  return multiple ? { paths: p ? [p] : null } : { path: p };
}

const managedByPackageManager = () =>
  new AppError("invalid_argument", {
    message: "leradeveloper is updated by your package manager: run `brew upgrade leradeveloper` or `scoop update leradeveloper`.",
  });

export const commands = {
  app_version: () => VERSION,
  // Updates arrive through brew/scoop, so the in-app updater always reports up to date.
  update_check_now: () => ({ kind: "upToDate" }),
  update_install: () => {
    throw managedByPackageManager();
  },
  update_skip: () => null,
  update_relaunch: () => null,
  dialog,
};
