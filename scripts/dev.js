// `npm run dev`: backend in --dev mode (port 4748) + Vite with hot reload (port 1430).
import { spawn } from "node:child_process";

const opts = { stdio: "inherit", shell: process.platform === "win32" };
const backend = spawn(process.execPath, ["bin/leradeveloper.js", "--dev", "--no-open"], opts);
const vite = spawn("npx", ["vite", "dev", "--open"], opts);

const stop = () => {
  backend.kill();
  vite.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
backend.on("exit", stop);
vite.on("exit", stop);
