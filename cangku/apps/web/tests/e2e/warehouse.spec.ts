import { expect, test } from "@playwright/test";

test("matrix inbound preview posts stock and remains reversible @critical", async ({ page }) => {
  const inventoryBefore = await page.request.get("/api/v1/inventory/balances");
  await expect(inventoryBefore).toBeOK();
  const firstSku = (await inventoryBefore.json())[0];
  const before = firstSku.onHand;

  await page.goto("/documents/INBOUND");
  await expect(page.getByRole("heading", { name: "入库" })).toBeVisible();
  await page.getByRole("link", { name: "新建入库单" }).click();
  await expect(page.getByRole("heading", { name: "新建货单" })).toBeVisible();
  const sourceRef = `E2E-${Date.now()}`;
  await page.getByLabel("来源单号").fill(sourceRef);
  await page.getByLabel(`${firstSku.style.styleNo} ${firstSku.color} ${firstSku.size} 数量`).fill("5");
  await page.getByRole("button", { name: "进入预览" }).click();
  await expect(page.getByRole("heading", { name: "入库预览" })).toBeVisible();
  await expect(page.getByText("可以提交")).toBeVisible();

  await expect.poll(async () => {
    const response = await page.request.get("/api/v1/inventory/balances");
    const rows = await response.json();
    return rows.find((item: { id: string }) => item.id === firstSku.id)?.onHand;
  }).toBe(before);

  await page.getByRole("button", { name: "确认提交入库" }).click();
  await page.goto("/documents/INBOUND");
  let row = page.getByRole("row").filter({ hasText: sourceRef });
  await expect(row).toBeVisible();
  await expect(row.getByText("已过账")).toBeVisible();
  await expect.poll(async () => {
    const response = await page.request.get("/api/v1/inventory/balances");
    const rows = await response.json();
    return rows.find((item: { id: string }) => item.id === firstSku.id)?.onHand;
  }).toBe(before + 5);

  await row.getByTitle("冲销").click();
  await expect(row.getByText("已冲销")).toBeVisible();
  await expect.poll(async () => {
    const response = await page.request.get("/api/v1/inventory/balances");
    const rows = await response.json();
    return rows.find((item: { id: string }) => item.id === firstSku.id)?.onHand;
  }).toBe(before);
});

test("matrix outbound preview rejects duplicate posting and remains reversible @critical", async ({ page }) => {
  const inventoryResponse = await page.request.get("/api/v1/inventory/balances");
  await expect(inventoryResponse).toBeOK();
  const firstSku = (await inventoryResponse.json())[0];
  const before = firstSku.onHand;
  const sourceRef = `E2E-OUT-${Date.now()}`;

  await page.goto("/documents/OUTBOUND");
  await expect(page.getByRole("heading", { name: "出库" })).toBeVisible();
  await page.getByRole("link", { name: "新建出库单" }).click();
  await page.getByLabel("来源单号").fill(sourceRef);
  await page.getByLabel(`${firstSku.style.styleNo} ${firstSku.color} ${firstSku.size} 数量`).fill("2");
  await page.getByRole("button", { name: "进入预览" }).click();
  await expect(page.getByRole("heading", { name: "出库预览" })).toBeVisible();
  await expect(page.getByText("可以提交")).toBeVisible();
  const commitRequestPromise = page.waitForRequest((request) => request.url().includes("/documents/") && request.url().endsWith("/commit") && request.method() === "POST");
  await page.getByRole("button", { name: "确认提交出库" }).click();
  const commitRequest = await commitRequestPromise;
  const idempotencyKey = commitRequest.headers()["idempotency-key"];
  expect(idempotencyKey).toBeTruthy();
  const duplicate = await page.request.post(commitRequest.url(), { headers: { "Idempotency-Key": idempotencyKey }, data: commitRequest.postDataJSON() });
  await expect(duplicate).toBeOK();

  await expect.poll(async () => {
    const response = await page.request.get("/api/v1/inventory/balances");
    const rows = await response.json();
    return rows.find((item: { id: string }) => item.id === firstSku.id)?.onHand;
  }).toBe(before - 2);

  await page.goto("/documents/OUTBOUND");
  const row = page.getByRole("row").filter({ hasText: sourceRef });
  await expect(row).toBeVisible();
  await row.getByTitle("冲销").click();
  await expect.poll(async () => {
    const response = await page.request.get("/api/v1/inventory/balances");
    const rows = await response.json();
    return rows.find((item: { id: string }) => item.id === firstSku.id)?.onHand;
  }).toBe(before);
});

test("outbound preview blocks insufficient stock without changing inventory @critical", async ({ page }) => {
  const inventoryResponse = await page.request.get("/api/v1/inventory/balances");
  const firstSku = (await inventoryResponse.json())[0];
  const before = firstSku.onHand;

  await page.goto("/documents/new?type=OUTBOUND");
  await page.getByLabel(`${firstSku.style.styleNo} ${firstSku.color} ${firstSku.size} 数量`).fill(String(firstSku.available + 1));
  await page.getByRole("button", { name: "进入预览" }).click();
  await expect(page.getByRole("heading", { name: "出库预览" })).toBeVisible();
  await expect(page.getByText("存在库存问题")).toBeVisible();
  await expect(page.getByRole("button", { name: "确认提交出库" })).toBeDisabled();
  const after = await page.request.get("/api/v1/inventory/balances");
  expect((await after.json()).find((item: { id: string }) => item.id === firstSku.id).onHand).toBe(before);
  await page.getByRole("button", { name: "返回编辑" }).click();
  await page.getByRole("button", { name: "取消草稿" }).click();
});

test("AI recognition fills a draft but inventory changes only after preview commit @critical", async ({ page }) => {
  const inventoryResponse = await page.request.get("/api/v1/inventory/balances");
  const firstSku = (await inventoryResponse.json())[0];
  const before = firstSku.onHand;
  let applyBody: Record<string, unknown> | null = null;

  await page.route("**/api/v1/imports", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ job_id: "mock-goods-order", status: "QUEUED" }) });
  });
  await page.route("**/api/v1/imports/mock-goods-order", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      id: "mock-goods-order",
      kind: "INBOUND",
      status: "REVIEW",
      fileName: "goods-order.png",
      progress: 100,
      createdAt: new Date().toISOString(),
      rows: [{ id: "mock-row", rowNumber: 1, raw: {}, normalized: { skuCode: firstSku.skuCode, quantity: 3 }, confidence: 0.99, validationErrors: [], accepted: false, skuId: firstSku.id }],
    }) });
  });
  await page.route("**/api/v1/imports/mock-goods-order/apply-to-draft", async (route) => {
    applyBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ applied: 1, documentId: applyBody.documentId }) });
  });

  await page.goto("/documents/new?type=INBOUND");
  await page.getByLabel("来源单号").fill(`AI-E2E-${Date.now()}`);
  await page.locator('input[type="file"][accept*=".pdf"]').setInputFiles({ name: "goods-order.png", mimeType: "image/png", buffer: Buffer.from("mock") });
  await expect(page.getByText("AI 识别已完成")).toBeVisible();
  await expect(page.getByLabel(`${firstSku.style.styleNo} ${firstSku.color} ${firstSku.size} 数量`)).toHaveValue("3");
  await expect.poll(() => applyBody).not.toBeNull();
  await page.getByRole("button", { name: "进入预览" }).click();
  await expect(page.getByRole("heading", { name: "入库预览" })).toBeVisible();
  await expect.poll(async () => {
    const response = await page.request.get("/api/v1/inventory/balances");
    const rows = await response.json();
    return rows.find((item: { id: string }) => item.id === firstSku.id)?.onHand;
  }).toBe(before);
  await page.getByRole("button", { name: "确认提交入库" }).click();
  await expect.poll(async () => {
    const response = await page.request.get("/api/v1/inventory/balances");
    const rows = await response.json();
    return rows.find((item: { id: string }) => item.id === firstSku.id)?.onHand;
  }).toBe(before + 3);
});

test("spreadsheet import reaches human review without changing stock @critical", async ({ page }) => {
  const before = await page.request.get("/api/v1/dashboard");
  const beforeOnHand = (await before.json()).metrics.onHand;
  await page.goto("/imports");
  await page.locator('input[type="file"]').setInputFiles({
    name: `inbound-${Date.now()}.csv`,
    mimeType: "text/csv",
    buffer: Buffer.from("SKU编码,数量\nCY2407-BK-S,3", "utf8"),
  });
  await page.getByLabel("导入内容").selectOption("INBOUND");
  await page.getByRole("button", { name: "开始 AI 解析" }).click();
  await expect(page.getByText("文件已进入安全解析队列")).toBeVisible();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("选择全部有效行")).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByText("通过")).toBeVisible();

  const after = await page.request.get("/api/v1/dashboard");
  expect((await after.json()).metrics.onHand).toBe(beforeOnHand);
});
