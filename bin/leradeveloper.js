#!/usr/bin/env node
// `leradeveloper` — start the local server and open the UI in the browser.
// A second launch reuses the running instance and just opens a new tab.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "../server/index.js";
import { appDataDir } from "../server/lib/paths.js";
import { VERSION } from "../server/lib/system.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i < 0) return undefined;
  return args[i].includes("=") ? args[i].split("=")[1] : args[i + 1];
};

if (flag("--version") || flag("-v")) {
  console.log(VERSION);
  process.exit(0);
}
if (flag("--help") || flag("-h")) {
  console.log(`leradeveloper ${VERSION}

Browse, install and track AI agent personas for Claude Code, Codex, Cursor,
Gemini CLI, Copilot, Qwen, opencode and more — in your browser.

Usage: leradeveloper [--port N] [--no-open]

  --port N     Port to listen on (default: 4747, or the next free one)
  --no-open    Don't open the browser automatically
  --version    Print the version`);
  process.exit(0);
}

const lockFile = path.join(appDataDir(), "state", "server.json");

function openBrowser(url) {
  const [cmd, cmdArgs] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, cmdArgs, { detached: true, stdio: "ignore", windowsHide: true }).on("error", () => {}).unref();
  } catch {
    /* no browser available — the URL is printed anyway */
  }
}

async function existingInstance() {
  try {
    const info = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    process.kill(info.pid, 0); // throws if the process is gone
    const r = await fetch(`http://127.0.0.1:${info.port}/`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? info : null;
  } catch {
    return null;
  }
}

function listen(server, port, attempts = 20) {
  return new Promise((resolve, reject) => {
    const tryPort = (p, left) => {
      server.once("error", (e) => {
        if (e.code === "EADDRINUSE" && left > 0) tryPort(p + 1, left - 1);
        else reject(e);
      });
      server.listen(p, "127.0.0.1", () => resolve(p));
    };
    tryPort(port, attempts);
  });
}

const requestedPort = Number(opt("--port") ?? process.env.LERADEVELOPER_PORT ?? (flag("--dev") ? 4748 : 4747));
const running = opt("--port") || flag("--dev") ? null : await existingInstance();
if (running) {
  const url = `http://127.0.0.1:${running.port}/`;
  console.log(`leradeveloper is already running at ${url}`);
  if (!flag("--no-open")) openBrowser(url);
  process.exit(0);
}

// --dev: fixed API token so the Vite dev server (npm run dev) can talk to us.
const { server } = createServer(flag("--dev") ? { token: "dev" } : {});
const port = await listen(server, requestedPort);
const url = `http://127.0.0.1:${port}/`;
fs.mkdirSync(path.dirname(lockFile), { recursive: true });
if (!flag("--dev")) fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, port, version: VERSION }));

const cleanup = () => {
  try {
    const info = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    if (info.pid === process.pid) fs.rmSync(lockFile, { force: true });
  } catch {
    /* already gone */
  }
  process.exit(0);
};
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

console.log(`leradeveloper ${VERSION} running at ${url}`);
console.log("Press Ctrl+C to stop.");
if (!flag("--no-open")) openBrowser(url);
