import * as XLSX from "xlsx";

function decodeCsv(buffer: Buffer) {
  if (buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) return buffer.subarray(3).toString("utf8");
  const utf8 = buffer.toString("utf8");
  if (!utf8.includes("�")) return utf8;
  return new TextDecoder("gb18030").decode(buffer);
}

export function readSpreadsheetMatrix(buffer: Buffer, mimeType?: string) {
  const isCsv = mimeType === "text/csv";
  const input = isCsv ? decodeCsv(buffer) : buffer;
  const workbook = XLSX.read(input, { type: isCsv ? "string" : "buffer", cellDates: false, codepage: 65001 });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("表格没有可读取的工作表");
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: "" });
}
