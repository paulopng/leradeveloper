# leradeveloper — guide for working on this repo

Fork of Agency Agents (Tauri desktop app) turned into a browser app served by a
local Node server. The Svelte UI is kept as close to upstream as possible so
upstream UI changes can be merged.

## Layout

- `src/` — SvelteKit SPA (upstream UI). Tauri APIs are replaced at build time
  by aliases in `svelte.config.js` → `src/lib/shims/*`:
  - `tauri-core.ts` — `invoke(cmd, args)` → `POST /api/invoke/<cmd>`
  - `tauri-dialog.ts` — native file/folder pickers via the server
  - `tauri-opener.ts` — external links in a new tab
- `server/` — zero-dependency Node backend (port of the original Rust):
  - `index.js` — HTTP server, static UI, per-launch API token, Host check
  - `lib/corpus.js` — catalog source, seeding, index, refresh, git pull, runbooks
  - `lib/render.js` — per-tool renderers (byte parity with upstream `convert.sh`)
  - `lib/install.js` — install ledger, backups, reconcile (5 states), tools, Agentfiles
  - `lib/auth.js` — phone access: remote detection, allowed Host suffixes, scrypt password, sessions, login page
  - `lib/lera-config.js` — leradeveloper's own config (`lera.json`: projetosDir, remoto); reloads on file change
  - `lib/mapas.js` — 3D project maps (JSON schema in pt-BR) + `mapas_*` commands
  - `web/mapas.html` — standalone 3D map viewer served at `/mapas` (no build step)
  - `lib/jev.js`, `mcp-decisor.js`, `lib/mcp-setup.js` — Jev decisor (defapi) as an MCP server
  - `lib/settings.js`, `lib/github.js`, `lib/system.js` (version, dialogs, updater stubs)
  - `lib/yaml-lite.js`, `lib/tar.js` — tiny parsers so the server needs no npm deps
  - `data/tools.json`, `data/agency-categories.json` — bundled registry floors
  - `corpus-baseline/` — bundled catalog snapshot (seeded on first run)
- `bin/leradeveloper.js` — CLI: starts the server, opens the browser, single instance
- `test/server.test.mjs` — end-to-end API tests (`npm test`)
- `test/parity.mjs` — byte-parity check against upstream `convert.sh`
- `packaging/` — Homebrew formula + Scoop manifest templates used by the release workflow

## Rules of thumb

- Command names and JSON shapes must match `src/lib/types.ts` (camelCase,
  errors as `{ code, ...fields }`). Add a command = add it to a `commands`
  object in `server/lib/*` and it is exposed automatically.
- Renderer output must stay byte-identical to upstream; run `test/parity.mjs`
  after touching `render.js` or `tools.json`.
- Every destructive write goes through `backupIfDiffers` first.
- Paths must work on Windows: use `path.join`, never hardcode `/`.
- The server binds to 127.0.0.1 only. Keep the token + Host checks. Remote
  requests (non-loopback Host or proxy headers) must pass `auth.js`: remote on,
  allowed Host, password session.
- Agents and user-facing text for the custom parts speak pt-BR.
- No corporate (Renault/Geely) data anywhere in this repo or the examples.
