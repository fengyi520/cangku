import { readSpreadsheetMatrix } from "./spreadsheet-parser";

describe("spreadsheet parser", () => {
  it("decodes UTF-8 Chinese CSV headers without mojibake", () => {
    const matrix = readSpreadsheetMatrix(Buffer.from("SKU编码,数量\nCY2407-BK-S,3", "utf8"));
    expect(matrix[0]).toEqual(["SKU编码", "数量"]);
    expect(matrix[1]).toEqual(["CY2407-BK-S", "3"]);
  });
});
