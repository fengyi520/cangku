import { expect, test } from "@playwright/test";
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

loadEnv({ path: resolve(import.meta.dirname, "../../../../.env"), quiet: true });

test.use({ storageState: { cookies: [], origins: [] } });

test("owner can sign in through the visible login form @smoke @auth", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "进入主仓" })).toBeVisible();
  await page.getByLabel("登录邮箱").fill(process.env.BOOTSTRAP_OWNER_EMAIL!);
  await page.getByLabel("密码").fill(process.env.BOOTSTRAP_OWNER_PASSWORD!);
  await page.getByRole("button", { name: "登录系统" }).click();
  await expect(page.getByRole("heading", { name: "库存总览" })).toBeVisible();
  await expect(page.getByText("款色尺码矩阵")).toBeVisible();
});
