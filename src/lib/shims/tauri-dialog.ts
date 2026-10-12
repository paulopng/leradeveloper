/**
 * Browser stand-in for `@tauri-apps/plugin-dialog`.
 *
 * A browser file picker never reveals real filesystem paths, but the backend
 * needs them (project folders, catalog clones, Agentfiles). So the local
 * server opens the OS's own picker (Finder, Explorer, zenity/kdialog) and
 * returns the chosen path. Where no picker exists (headless Linux, SSH), we
 * fall back to asking for the path in a prompt.
 */
import { invoke } from "./tauri-core";

interface DialogFilter {
  name: string;
  extensions: string[];
}

interface OpenDialogOptions {
  title?: string;
  directory?: boolean;
  multiple?: boolean;
  defaultPath?: string;
  filters?: DialogFilter[];
}

interface SaveDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: DialogFilter[];
}

type DialogResult = { path?: string | null; paths?: string[] | null; unsupported?: boolean };

function promptForPath(title: string | undefined, fallback = ""): string | null {
  const value = window.prompt(title ?? "Path", fallback);
  return value && value.trim() ? value.trim() : null;
}

export async function open(options: OpenDialogOptions = {}): Promise<string | string[] | null> {
  const r = await invoke<DialogResult>("dialog", { mode: "open", ...options });
  if (r.unsupported) {
    const p = promptForPath(options.title, options.defaultPath);
    return options.multiple ? (p ? [p] : null) : p;
  }
  return options.multiple ? (r.paths ?? null) : (r.path ?? null);
}

export async function save(options: SaveDialogOptions = {}): Promise<string | null> {
  const r = await invoke<DialogResult>("dialog", { mode: "save", ...options });
  if (r.unsupported) return promptForPath(options.title, options.defaultPath);
  return r.path ?? null;
}
