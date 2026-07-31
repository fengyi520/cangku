import { request, type FullConfig } from "@playwright/test";
import { config as loadEnv } from "dotenv";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

loadEnv({ path: resolve(import.meta.dirname, "../../../.env"), quiet: true });

export default async function globalSetup(config: FullConfig) {
  const baseURL = String(config.projects[0].use.baseURL);
  const context = await request.newContext({ baseURL });
  const response = await context.post("/api/v1/auth/login", {
    data: {
      email: process.env.BOOTSTRAP_OWNER_EMAIL,
      password: process.env.BOOTSTRAP_OWNER_PASSWORD,
    },
  });
  if (!response.ok()) throw new Error(`E2E login failed: ${response.status()} ${await response.text()}`);
  const statePath = resolve(import.meta.dirname, "../.auth/owner.json");
  await mkdir(dirname(statePath), { recursive: true });
  await context.storageState({ path: statePath });
  await context.dispose();
}
