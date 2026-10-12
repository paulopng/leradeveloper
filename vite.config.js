import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";

// `npm run dev` serves the UI with hot reload on :1430 and proxies the API to
// a backend started with `node bin/leradeveloper.js --dev` (port 4748).
export default defineConfig({
  plugins: [sveltekit()],
  server: {
    port: 1430,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:4748", changeOrigin: false },
    },
  },
});
