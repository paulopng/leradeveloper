// leradeveloper serves the UI as a static SPA from its local Node server
// (server/index.js), so adapter-static with an index.html fallback.
import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      fallback: "index.html",
    }),
    // The UI was written for Tauri. These aliases swap Tauri's APIs for
    // browser shims that talk to the local server, so upstream component
    // code can stay untouched (and future upstream merges stay easy).
    alias: {
      "@tauri-apps/api/core": "src/lib/shims/tauri-core.ts",
      "@tauri-apps/api/event": "src/lib/shims/tauri-event.ts",
      "@tauri-apps/plugin-dialog": "src/lib/shims/tauri-dialog.ts",
      "@tauri-apps/plugin-opener": "src/lib/shims/tauri-opener.ts",
    },
  },
};

export default config;
