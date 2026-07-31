import { expect, test } from "@playwright/test";

test("administrator can schedule tomorrow's automatic outbound time @critical", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "系统设置" })).toBeVisible();
  const time = page.getByLabel("新的自动出库时间");
  await expect(time).toBeVisible();
  await time.fill("20:00");
  await page.getByRole("button", { name: "保存时间" }).click();
  await expect(page.getByText("自动出库时间已保存，将从次日生效")).toBeVisible();
  await expect(page.getByText(/起改为 20:00/)).toBeVisible();
});

test("fixed-template inbound preview posts stock and remains reversible @critical", async ({ page }) => {
  const inventoryResponse = await page.request.get("/api/v1/inventory/balances");
  await expect(inventoryResponse).toBeOK();
  const firstSku = (await inventoryResponse.json())[0];
  const before = firstSku.onHand;
  const runId = Date.now();
  const fileName = `simple-inbound-${runId}.csv`;

  await page.goto("/documents/INBOUND");
  await page.getByRole("button", { name: "导入并入库" }).click();
  const dialog = page.getByRole("dialog", { name: "导入并增加库存" });
  const downloadPromise = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "下载模板" }).click();
  expect((await downloadPromise).suggestedFilename()).toBe("inbound-template.xlsx");
  await dialog.getByLabel("选择导入文件").setInputFiles({
    name: fileName,
    mimeType: "text/csv",
    buffer: Buffer.from(`款号,颜色,尺码,数量,备注\n${firstSku.style.styleNo},${firstSku.color},${firstSku.size},2,E2E-${runId}`, "utf8"),
  });
  await dialog.getByRole("button", { name: "预览数据" }).click();
  await expect(dialog.getByText("已匹配 1 个商品规格")).toBeVisible();
  await dialog.getByRole("button", { name: "确认并立即入库" }).click();
  await expect(page.getByText("库存已整批增加")).toBeVisible();

  await expect.poll(async () => {
    const response = await page.request.get("/api/v1/inventory/balances");
    const rows = await response.json();
    return rows.find((item: { id: string }) => item.id === firstSku.id)?.onHand;
  }).toBe(before + 2);

  const row = page.getByRole("row").filter({ hasText: fileName });
  await expect(row).toBeVisible();
  await row.getByTitle("冲销").click();
  await expect.poll(async () => {
    const response = await page.request.get("/api/v1/inventory/balances");
    const rows = await response.json();
    return rows.find((item: { id: string }) => item.id === firstSku.id)?.onHand;
  }).toBe(before);
});

test("today outbound supports a posted supplement and whole-batch rollback @critical", async ({ page }) => {
  const inventoryResponse = await page.request.get("/api/v1/inventory/balances");
  const firstSku = (await inventoryResponse.json())[0];
  const before = firstSku.onHand;
  await page.goto("/daily-outbound");
  await expect(page.getByRole("heading", { name: "今日出库" })).toBeVisible();
  await expect(page.getByLabel("今日自动结算时间")).toContainText(/自动出库时间/);

  const supplement = page.getByRole("button", { name: "补充出库" });
  if (!(await supplement.isVisible())) {
    const product = page.getByLabel("第 1 行商品规格");
    await product.selectOption(firstSku.id);
    await page.getByLabel("第 1 行出库数量").fill("1");
    await page.getByRole("button", { name: "保存登记" }).click();
    await expect(page.getByText("今日登记已保存")).toBeVisible();
    const after = await page.request.get("/api/v1/inventory/balances");
    expect((await after.json()).find((item: { id: string }) => item.id === firstSku.id).onHand).toBe(before);
    return;
  }

  await supplement.click();
  const dialog = page.getByRole("dialog", { name: "补充出库" });
  await dialog.getByLabel("第 1 行商品规格").selectOption(firstSku.id);
  await dialog.getByLabel("第 1 行出库数量").fill("1");
  const responsePromise = page.waitForResponse((response) => response.url().includes("/daily-outbound/supplements") && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "保存并立即扣库" }).click();
  const posted = await (await responsePromise).json();
  await expect(page.getByText("补充批次已扣减库存")).toBeVisible();
  await expect.poll(async () => {
    const response = await page.request.get("/api/v1/inventory/balances");
    const rows = await response.json();
    return rows.find((item: { id: string }) => item.id === firstSku.id)?.onHand;
  }).toBe(before - 1);

  const historyRow = page.getByRole("row").filter({ hasText: posted.document.documentNo });
  await expect(historyRow).toBeVisible();
  page.once("dialog", (confirmation) => confirmation.accept());
  await historyRow.getByTitle("整批回退").click();
  await expect(page.getByText("该批次库存已恢复")).toBeVisible();
  await expect.poll(async () => {
    const response = await page.request.get("/api/v1/inventory/balances");
    const rows = await response.json();
    return rows.find((item: { id: string }) => item.id === firstSku.id)?.onHand;
  }).toBe(before);
});
