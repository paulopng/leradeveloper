// Browser smoke test (run in CI after `npm run build`):
//   npm i --no-save playwright && npx playwright install chromium
//   node test/ui-smoke.mjs <screenshot-dir>
// Starts the real server against throwaway dirs, opens the UI in Chromium,
// walks the main sections, saves screenshots, and fails on page errors or
// failed API calls.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const outDir = path.resolve(process.argv[2] ?? "screenshots");
fs.mkdirSync(outDir, { recursive: true });
process.env.LERADEVELOPER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lera-ui-data-"));
process.env.LERADEVELOPER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lera-ui-home-"));

const { createServer } = await import("../server/index.js");
const { chromium } = await import("playwright");

const { server } = createServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

const problems = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") problems.push(`console: ${m.text()}`);
});
page.on("response", async (r) => {
  if (r.url().includes("/api/invoke/") && r.status() >= 400) {
    // Typed errors (400) are expected for some UI probes; anything else is a bug.
    if (r.status() !== 400) problems.push(`api ${r.status()}: ${r.url()}`);
  }
});

const shot = async (name) => {
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
  console.log(`saved ${name}.png`);
};

await page.goto(url, { waitUntil: "networkidle" });
await shot("01-first-launch");

// First run asks where the catalog lives: keep the bundled snapshot.
const bundled = page.getByRole("button", { name: /just use the bundled/i }).first();
if (await bundled.isVisible().catch(() => false)) {
  await bundled.click();
  await page.waitForLoadState("networkidle");
}
await shot("02-home");

// Visit every sidebar section.
const nav = page.locator("nav button");
const count = await nav.count();
for (let i = 0; i < Math.min(count, 10); i++) {
  const item = nav.nth(i);
  const label = ((await item.innerText().catch(() => "")) || `section-${i}`).trim().split("\n")[0];
  await item.click().catch(() => {});
  await page.waitForLoadState("networkidle");
  await shot(`03-${String(i).padStart(2, "0")}-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30)}`);
}

// Dark mode render.
await page.emulateMedia({ colorScheme: "dark" });
await shot("04-dark");

// Mapas 3D: link na barra lateral, depois o visualizador em tamanho de celular.
await page.emulateMedia({ colorScheme: "light" });
await page.locator('nav a[href="/mapas"]').click();
await page.waitForURL(/\/mapas$/);
await page.waitForLoadState("networkidle");
await shot("05-mapas-desktop");
const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
phone.on("pageerror", (e) => problems.push(`mapas pageerror: ${e.message}`));
phone.on("console", (m) => {
  if (m.type() === "error") problems.push(`mapas console: ${m.text()}`);
});
await phone.goto(url + "mapas", { waitUntil: "networkidle" });
await phone.waitForTimeout(1200);
await phone.screenshot({ path: path.join(outDir, "06-mapas-celular.png") });
console.log("saved 06-mapas-celular.png");
// Toca no centro (cai em algum nó na visão geral ou não; só não pode quebrar).
await phone.touchscreen.tap(195, 420);
await phone.waitForTimeout(800);
await phone.screenshot({ path: path.join(outDir, "07-mapas-toque.png") });
console.log("saved 07-mapas-toque.png");

await browser.close();
server.close();

const text = problems.join("\n");
fs.writeFileSync(path.join(outDir, "problems.txt"), text || "none\n");
if (problems.length) {
  console.error(`UI smoke found ${problems.length} problem(s):\n${text}`);
  process.exit(1);
}
console.log("UI smoke passed");
