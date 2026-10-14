/**
 * Projects store — the registered project directories used for project-scoped
 * installs. Backs the Projects nav section (the 4th pillar).
 *
 * A project shows up here if EITHER you've registered its folder OR an agent is
 * deployed into it. We can't lean on the backend `projects_list` alone — that's
 * derived purely from the install ledger, so a freshly-added empty folder would
 * vanish until something is installed. So we persist the registered roots in
 * localStorage and UNION them with every path the live ledger
 * (`install.installed`) knows about. Counts/labels come from the same ledger so
 * the header number always matches the expanded roster.
 *
 * Singleton: import `projects` everywhere.
 */

import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { i18n } from "$lib/stores/i18n.svelte";
import { install } from "$lib/stores/install.svelte";
import type { ProjectInfo } from "$lib/types";

const STORAGE_KEY = "agency-agents:projects:v1";

function basename(p: string): string {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
}

class ProjectsStore {
  /** User-registered project roots, persisted so a project is listed even
      before anything is installed into it. */
  private registered: string[] = $state([]);
  private hydrated = false;

  hydrate(): void {
    if (this.hydrated || typeof window === "undefined") return;
    this.hydrated = true;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const arr = JSON.parse(raw) as unknown;
        if (Array.isArray(arr)) this.registered = arr.filter((x): x is string => typeof x === "string");
      }
    } catch {
      /* ignore corrupt entry */
    }
    void this.syncWithServer();
  }

  /** leradev: one project list for the catalog UI and the Central.
      Sends the folders this browser knows to the server and adds the ones the
      Central knows (created there or on another device). */
  private async syncWithServer(): Promise<void> {
    try {
      const list = await invoke<{ pasta: string }[]>("projetos_sincronizar", { pastas: this.registered });
      const merged = [...new Set([...this.registered, ...list.map((p) => p.pasta)])];
      if (merged.length !== this.registered.length) {
        this.registered = merged;
        this.persist();
      }
    } catch {
      /* server without the Central: keep the local list */
    }
  }

  private persist(): void {
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.registered));
    } catch {
      /* private mode / quota */
    }
  }

  /** Registered roots ∪ every path the ledger has a (non-removed) install in.
      Count = distinct agents in that project; label = folder basename. */
  list: ProjectInfo[] = $derived.by(() => {
    const slugs = new Map<string, Set<string>>(); // path -> distinct agent slugs
    const ensure = (p: string) => slugs.get(p) ?? (slugs.set(p, new Set()), slugs.get(p)!);
    for (const p of this.registered) ensure(p);
    for (const r of install.installed) {
      if (r.state === "removed") continue;
      const p = r.projectPath;
      if (p == null) continue; // global lives in Teams/Tools, not here
      ensure(p).add(r.slug);
    }
    return [...slugs.entries()]
      .map(([path, set]) => ({ path, label: basename(path), installedCount: set.size }))
      .sort((a, b) => a.label.localeCompare(b.label));
  });

  /** Ensure the registered set + ledger are loaded (panel calls on mount). */
  async refresh(): Promise<void> {
    this.hydrate();
    await install.reconcile();
  }

  register(path: string): void {
    if (!this.registered.includes(path)) {
      this.registered = [...this.registered, path];
      this.persist();
    }
    void invoke("projetos_sincronizar", { pastas: [path] }).catch(() => {});
  }

  /** Forget a project root. Any agents installed into it remain on disk (and
      keep the project visible via the ledger) until they're removed. */
  unregister(path: string): void {
    this.registered = this.registered.filter((p) => p !== path);
    this.persist();
    void invoke("projeto_remover_pasta", { pasta: path }).catch(() => {});
  }

  /** Native folder picker → registers and returns the chosen path (or null). */
  async addViaPicker(): Promise<string | null> {
    const picked = await openDialog({ directory: true, title: i18n.t("projects.chooseFolderTitle") });
    const path = typeof picked === "string" ? picked : Array.isArray(picked) ? (picked[0] ?? null) : null;
    if (path) this.register(path);
    return path;
  }
}

export const projects = new ProjectsStore();
