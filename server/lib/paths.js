// Where leradeveloper keeps its own state, and where bundled data lives.
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const APP_ID = "leradeveloper";

const here = path.dirname(fileURLToPath(import.meta.url));
/** `server/` — holds `data/` and `corpus-baseline/`. */
export const SERVER_DIR = path.resolve(here, "..");
export const DATA_DIR = path.join(SERVER_DIR, "data");
export const BASELINE_DIR = path.join(SERVER_DIR, "corpus-baseline");

export function home() {
  return process.env.LERADEVELOPER_HOME || os.homedir();
}

/**
 * Per-user app data root (settings, ledger, corpus copy, backups).
 * macOS: ~/Library/Application Support/leradeveloper
 * Linux: $XDG_DATA_HOME/leradeveloper (default ~/.local/share)
 * Windows: %APPDATA%\leradeveloper
 * Override with LERADEVELOPER_DATA_DIR (used by tests).
 */
export function appDataDir() {
  if (process.env.LERADEVELOPER_DATA_DIR) return process.env.LERADEVELOPER_DATA_DIR;
  const h = os.homedir();
  if (process.platform === "darwin") return path.join(h, "Library", "Application Support", APP_ID);
  if (process.platform === "win32")
    return path.join(process.env.APPDATA || path.join(h, "AppData", "Roaming"), APP_ID);
  return path.join(process.env.XDG_DATA_HOME || path.join(h, ".local", "share"), APP_ID);
}

export const stateDir = (adir) => path.join(adir, "state");
export const corpusDir = (adir) => path.join(adir, "corpus");
