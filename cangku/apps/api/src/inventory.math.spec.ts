import { piecesFromPackaging, quantityDeltaForDocument } from "./inventory.math";

describe("inventory math", () => {
  it("converts cartons and loose pieces to the base unit", () => {
    expect(piecesFromPackaging(3, 12, 5)).toBe(41);
  });

  it("never accepts negative packaging values", () => {
    expect(() => piecesFromPackaging(-1, 12, 0)).toThrow("不能为负数");
  });

  it("calculates stocktake variance against its snapshot", () => {
    expect(quantityDeltaForDocument({ type: "STOCKTAKE", quantityPieces: 0, snapshotQuantity: 50, countedPieces: 47 })).toBe(-3);
  });

  it("uses signed adjustment deltas", () => {
    expect(quantityDeltaForDocument({ type: "ADJUSTMENT", quantityPieces: 0, adjustmentDelta: -4 })).toBe(-4);
  });
});
