/**
 * Browser stand-in for `@tauri-apps/api/event`.
 *
 * Upstream only listens for native menu events (`menu:about`,
 * `menu:settings`). A browser tab has no native menu, so listeners never
 * fire; About and Settings stay reachable from the sidebar and title bar.
 */
export type UnlistenFn = () => void;

export async function listen<T = unknown>(_event: string, _handler: (event: { payload: T }) => void): Promise<UnlistenFn> {
  return () => {};
}

export async function emit(_event: string, _payload?: unknown): Promise<void> {}
