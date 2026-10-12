/**
 * Browser stand-in for `@tauri-apps/api/core`.
 *
 * The UI was written against Tauri's `invoke()`; here every call becomes a
 * POST to the local leradeveloper server (`server/index.js`), which runs the
 * same command set. Errors are rethrown as the server's `{ code, ... }`
 * payload, matching what Tauri delivered, so `isAppError()` keeps working.
 *
 * Aliased in `svelte.config.js` (`kit.alias`), so the components' imports
 * stay exactly as upstream wrote them.
 */

function apiToken(): string {
  const meta = document.querySelector('meta[name="leradeveloper-token"]');
  // In `npm run dev` the page comes from Vite, which has no token to inject;
  // the backend runs with `--dev` and accepts the fixed token "dev".
  return meta?.getAttribute("content") ?? (import.meta.env.DEV ? "dev" : "");
}

export async function invoke<T = unknown>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/invoke/${encodeURIComponent(cmd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Leradeveloper-Token": apiToken() },
      body: JSON.stringify(args ?? {}),
    });
  } catch (e) {
    // The local server stopped (terminal closed / Ctrl+C).
    throw {
      code: "network",
      url: `/api/invoke/${cmd}`,
      message: "leradeveloper server is not running — start it again with `leradeveloper`.",
    };
  }
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (body && typeof body === "object" && "code" in body) throw body;
    throw { code: "internal", message: `HTTP ${res.status} from ${cmd}` };
  }
  return body as T;
}
