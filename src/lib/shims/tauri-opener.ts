/** Browser stand-in for `@tauri-apps/plugin-opener`: external links open in a new tab. */
export async function openUrl(url: string): Promise<void> {
  window.open(url, "_blank", "noopener,noreferrer");
}
