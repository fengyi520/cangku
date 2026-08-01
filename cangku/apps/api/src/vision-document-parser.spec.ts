import { parseVisionPayload } from "./vision-document-parser";

describe("vision document parser", () => {
  it("expands a size matrix without treating its header as data", () => {
    const rows = parseVisionPayload({
      matrix: [
        ["德绒男士内衣", "5XL", "6XL", "7XL", "8XL"],
        ["黑色中领02号", "377", "141", "512", "447"],
        ["浅灰中领03号", "541", "275", "354", "296"],
        ["酒红中领04号", "35", "157", "156", "128"],
        ["宝蓝中领05号", "174", "96", "493", "398"],
        ["大红中领07号", "457", "334", "264", "216"],
        ["湖蓝中领08号", "150", "248", "165", "146"],
      ],
    });

    expect(rows).toHaveLength(24);
    expect(rows[0]).toEqual(expect.objectContaining({
      normalized: { styleNo: "德绒男士内衣", color: "黑色中领02号", size: "5XL", quantity: 377 },
      validationErrors: [],
    }));
    expect(rows.at(-1)?.normalized).toEqual({ styleNo: "德绒男士内衣", color: "湖蓝中领08号", size: "8XL", quantity: 146 });
    expect(rows.some((row) => row.normalized.color === "德绒男士内衣")).toBe(false);
  });

  it("keeps legacy row-shaped OCR responses compatible", () => {
    const rows = parseVisionPayload({ rows: [{ normalized: { styleNo: "A1", color: "黑", size: "M", quantity: 2 }, confidence: 0.8, validationErrors: [] }] });
    expect(rows).toEqual([expect.objectContaining({ normalized: { styleNo: "A1", color: "黑", size: "M", quantity: 2 }, confidence: 0.8 })]);
  });

  it("accepts common table and headers/data response shapes", () => {
    const rows = parseVisionPayload({
      headers: ["德绒男士内衣", "5XL", "6XL"],
      data: [["黑色中领02号", "377", "141"]],
    });
    expect(rows).toHaveLength(2);
    expect(rows[1]?.normalized).toEqual({ styleNo: "德绒男士内衣", color: "黑色中领02号", size: "6XL", quantity: 141 });
  });
});
