import { chromium, devices } from "../apps/web/node_modules/@playwright/test/index.mjs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const outputDir = resolve(root, "test-results", "visual-smoke");
const storageState = resolve(root, "apps", "web", ".auth", "owner.json");

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });

for (const [name, device] of [["desktop", devices["Desktop Chrome"]], ["mobile", devices["Pixel 7"]]]) {
  const context = await browser.newContext({ ...device, storageState });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("http://127.0.0.1:5173/", { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "库存总览" }).waitFor();
  const viewport = page.viewportSize();
  const metrics = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  const screenshot = await page.screenshot({ path: resolve(outputDir, `${name}-dashboard.png`), fullPage: false });
  console.log(JSON.stringify({ name, viewport, metrics, screenshotBytes: screenshot.length, errors }));
  await context.close();
}

await browser.close();
