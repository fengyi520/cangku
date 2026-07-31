import * as XLSX from "xlsx";

export function readSpreadsheetMatrix(buffer: Buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false, codepage: 65001 });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("表格没有可读取的工作表");
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: "" });
}
