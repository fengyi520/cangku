import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
import "dotenv/config";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  outputDir: "test-results",
  globalSetup: resolve(import.meta.dirname, "tests/global-setup.ts"),
  use: {
    baseURL: "http://127.0.0.1:5173",
    storageState: resolve(import.meta.dirname, ".auth/owner.json"),
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, testIgnore: /mobile\.spec\.ts/ },
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: /mobile\.spec\.ts/ },
  ],
  webServer: [
    { command: "pnpm --filter @cangku/api dev", url: "http://127.0.0.1:4000/api/v1/health", reuseExistingServer: true, timeout: 60_000 },
    { command: "pnpm --filter @cangku/web dev", url: "http://127.0.0.1:5173", reuseExistingServer: true, timeout: 60_000 },
  ],
});
