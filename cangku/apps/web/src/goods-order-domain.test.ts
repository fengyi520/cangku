import { describe, expect, it } from "vitest";
import { flattenQuantities, groupInventoryMatrix, mergeRecognizedRows, parseClipboardTable } from "./goods-order-domain";
import type { ImportRow, InventoryRow } from "./types";

const inventory: InventoryRow[] = [
  sku("sku-m", "SKU-901-M", "901", "保暖衬衫", "黑色", "M", 20),
  sku("sku-l", "SKU-901-L", "901", "保暖衬衫", "黑色", "L", 18),
  sku("sku-902-m", "SKU-902-M", "902", "保暖衬衫", "灰色", "M", 12),
];

describe("goods order matrix", () => {
  it("groups SKU rows by style and color", () => {
    const rows = groupInventoryMatrix(inventory);
    expect(rows).toHaveLength(2);
    expect(rows[0].skus.map((item) => item.size)).toEqual(["M", "L"]);
  });

  it("flattens only positive integer quantities", () => {
    expect(flattenQuantities({ "sku-m": 3, "sku-l": 0, "sku-902-m": 2 })).toEqual([
      { skuId: "sku-902-m", stockStatus: "SELLABLE", quantity: 2, note: null },
      { skuId: "sku-m", stockStatus: "SELLABLE", quantity: 3, note: null },
    ]);
  });

  it("parses row-shaped clipboard data", () => {
    const result = parseClipboardTable("款号\t颜色\t尺码\t数量\n901\t黑色\tM\t5", inventory);
    expect(result.errors).toEqual([]);
    expect(result.matches).toEqual([{ skuId: "sku-m", quantity: 5 }]);
  });

  it("parses size matrix clipboard data when style and size are unique", () => {
    const result = parseClipboardTable("款号\tM\tL\n901\t4\t6", inventory);
    expect(result.errors).toEqual([]);
    expect(result.matches).toEqual([{ skuId: "sku-m", quantity: 4 }, { skuId: "sku-l", quantity: 6 }]);
  });

  it("keeps manual values on AI conflict and requires review for low confidence", () => {
    const rows = [recognized("r1", inventory[0], 5, 0.96), recognized("r2", inventory[1], 3, 0.72)];
    const result = mergeRecognizedRows({ "sku-m": 2 }, rows);
    expect(result.quantities["sku-m"]).toBe(2);
    expect(result.quantities["sku-l"]).toBe(3);
    expect(result.conflicts).toHaveLength(1);
    expect(result.reviewRows.map((row) => row.id)).toEqual(["r2"]);
  });
});

function sku(id: string, skuCode: string, styleNo: string, name: string, color: string, size: string, available: number): InventoryRow {
  return { id, skuCode, color, size, minStock: 0, active: true, style: { id: `style-${styleNo}`, styleNo, name }, onHand: available, reserved: 0, available, lowStock: false, balances: [{ status: "SELLABLE", onHand: available, reserved: 0 }] };
}

function recognized(id: string, item: InventoryRow, quantity: number, confidence: number): ImportRow {
  return { id, rowNumber: 1, raw: {}, normalized: { quantity }, confidence, validationErrors: [], accepted: false, skuId: item.id, sku: item };
}
