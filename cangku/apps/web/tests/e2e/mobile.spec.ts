import { expect, test } from "@playwright/test";

test("mobile workbench keeps primary actions reachable without page overflow @mobile", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "库存总览" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "移动端主导航" })).toBeVisible();
  const inventoryLink = page.getByRole("navigation", { name: "移动端主导航" }).getByRole("link", { name: "库存" });
  await inventoryLink.tap();
  await expect(page.getByRole("heading", { name: "库存" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  const dailyLink = page.getByRole("navigation", { name: "移动端主导航" }).getByRole("link", { name: "今日出库" });
  await dailyLink.tap();
  await expect(page.getByRole("heading", { name: "今日出库" })).toBeVisible();
  await expect(page.getByLabel("今日自动结算时间")).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await page.getByRole("button", { name: "打开菜单" }).tap();
  const nav = page.getByRole("navigation", { name: "主导航", exact: true });
  await expect(nav).toBeVisible();
  await nav.getByRole("link", { name: "AI 导入" }).tap();
  await expect(page.getByRole("heading", { name: "AI 导入" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("mobile goods order matrix keeps fixed actions reachable @mobile", async ({ page }) => {
  await page.goto("/documents/new?type=INBOUND");
  await expect(page.getByRole("heading", { name: "新建货单" })).toBeVisible();
  await expect(page.locator(".goods-order-matrix")).toBeVisible();
  const previewButton = page.getByRole("button", { name: "进入预览" });
  await expect(previewButton).toBeVisible();
  await previewButton.scrollIntoViewIfNeeded();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expect(page.locator(".goods-order-footer")).toHaveCSS("position", "fixed");
});
