import { parseSimpleImportMatrix } from "./simple-import-parser";

describe("simple import parser", () => {
  it("recognizes the fixed Chinese headers and aggregates duplicate variants", () => {
    const rows = parseSimpleImportMatrix([
      ["仓库入库登记"],
      ["款号", "颜色", "尺码", "数量", "备注"],
      ["CY-1", "黑色", "M", "2", "首箱"],
      ["CY-1", "黑色", "M", "3", "补箱"],
    ]);
    expect(rows).toEqual([
      expect.objectContaining({ styleNo: "CY-1", color: "黑色", size: "M", quantity: 5, sourceRows: [3, 4], note: "补箱", inputError: null }),
    ]);
  });

  it("keeps invalid quantities visible for preview", () => {
    const [row] = parseSimpleImportMatrix([["款号", "颜色", "尺码", "数量"], ["CY-1", "黑色", "L", "1.5"]]);
    expect(row.inputError).toBe("数量必须为正整数");
  });

  it("recognizes style matrix files with color codes as rows and sizes as columns", () => {
    const rows = parseSimpleImportMatrix([
      ["保暖衬衫", "M", "L", "XL"],
      ["901", "225", "413", ""],
      ["902", "112", "272", "243"],
    ]);
    expect(rows).toEqual([
      expect.objectContaining({ styleNo: "保暖衬衫", color: "901", size: "M", quantity: 225, inputError: null }),
      expect.objectContaining({ styleNo: "保暖衬衫", color: "901", size: "L", quantity: 413, inputError: null }),
      expect.objectContaining({ styleNo: "保暖衬衫", color: "902", size: "M", quantity: 112, inputError: null }),
      expect.objectContaining({ styleNo: "保暖衬衫", color: "902", size: "L", quantity: 272, inputError: null }),
      expect.objectContaining({ styleNo: "保暖衬衫", color: "902", size: "XL", quantity: 243, inputError: null }),
    ]);
  });

  it("rejects files that do not use a supported template shape", () => {
    expect(() => parseSimpleImportMatrix([["商品", "数量"]])).toThrow("表格没有可导入的数据行");
  });
});

