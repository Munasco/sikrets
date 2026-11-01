// Screenshots of every screen from the dev server's demo data: `bun run dev`, then
// `bun scripts/shots.ts <out dir>`. Uses the installed Chrome; downloads nothing.
import { chromium } from "playwright-core";
import { mkdir } from "node:fs/promises";

const out = process.argv[2] ?? "shots";
const base = process.env.URL ?? "http://localhost:1430";
const routes = ["keys", "approvals", "agents", "logins", "import", "agent", "settings"];

await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1080, height: 700 }, deviceScaleFactor: 2 });
for (const [i, r] of routes.entries()) {
  await page.goto(`${base}/#${r}`);
  await page.reload();
  await page.waitForTimeout(600);
  if (r === "import") {
    await page.getByText("Choose .env, CSV, JSON or .1pux").click();
    await page.waitForTimeout(500);
  }
  await page.screenshot({ path: `${out}/${i + 1}-${r}.png` });
  console.log(`${out}/${i + 1}-${r}.png`);
}
await browser.close();
