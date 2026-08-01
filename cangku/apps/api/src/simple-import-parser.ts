export type ParsedSimpleImportRow = {
  key: string;
  sourceRows: number[];
  styleNo: string;
  color: string;
  size: string;
  quantity: number;
  note: string | null;
  inputError: string | null;
};

function headerKey(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replaceAll(" ", "");
}

const headerAliases = {
  styleNo: new Set(["款号", "款式编号", "styleno", "style_no"]),
  color: new Set(["颜色", "color"]),
  size: new Set(["尺码", "尺寸", "size"]),
  quantity: new Set(["数量", "件数", "quantity", "qty"]),
  note: new Set(["备注", "note", "remark"]),
};

function parseStyleSizeMatrix(matrix: unknown[][]) {
  const headerIndex = matrix.slice(0, 5).findIndex((row) => row.slice(1).some((value) => String(value ?? "").trim()));
  if (headerIndex < 0) throw new Error("模板必须包含：款号、颜色、尺码、数量，或使用左上角商品、首行尺码、首列颜色的矩阵");
  const header = matrix[headerIndex];
  const styleNo = String(header[0] ?? "").trim();
  const sizes = header.slice(1).map((value) => String(value ?? "").trim());
  if (!styleNo || !sizes.some(Boolean)) throw new Error("矩阵模板必须在左上角填写商品名称或款号，并在首行填写尺码");
  const grouped = new Map<string, Omit<ParsedSimpleImportRow, "key" | "inputError">>();
  for (const [offset, source] of matrix.slice(headerIndex + 1).entries()) {
    const color = String(source[0] ?? "").trim();
    if (!color) continue;
    for (const [sizeOffset, size] of sizes.entries()) {
      if (!size) continue;
      const rawQuantity = String(source[sizeOffset + 1] ?? "").replaceAll(",", "").trim();
      if (!rawQuantity) continue;
      const quantity = Number(rawQuantity);
      const key = `${styleNo}\u0000${color}\u0000${size}`;
      const existing = grouped.get(key);
      grouped.set(key, {
        sourceRows: [...(existing?.sourceRows ?? []), headerIndex + offset + 2],
        styleNo,
        color,
        size,
        quantity: (existing?.quantity ?? 0) + quantity,
        note: null,
      });
    }
  }
  if (!grouped.size) throw new Error("表格没有可导入的数据行");
  return [...grouped.entries()].map(([key, row]): ParsedSimpleImportRow => ({
    key,
    ...row,
    inputError: !row.styleNo || !row.color || !row.size ? "商品、颜色和尺码不能为空" : !Number.isInteger(row.quantity) || row.quantity <= 0 ? "数量必须为正整数" : null,
  }));
}

export function parseSimpleImportMatrix(matrix: unknown[][]) {
  if (!matrix.length) throw new Error("表格没有数据");
  if (matrix.length > 10_001) throw new Error("简单导入最多支持 10,000 行");
  const headerIndex = matrix.slice(0, 5).reduce((best, row, index, source) => (row.filter(Boolean).length > source[best].filter(Boolean).length ? index : best), 0);
  const headers = matrix[headerIndex].map(headerKey);
  const column = (aliases: Set<string>) => headers.findIndex((header) => aliases.has(header));
  const columns = {
    styleNo: column(headerAliases.styleNo),
    color: column(headerAliases.color),
    size: column(headerAliases.size),
    quantity: column(headerAliases.quantity),
    note: column(headerAliases.note),
  };
  if ([columns.styleNo, columns.color, columns.size, columns.quantity].some((index) => index < 0)) return parseStyleSizeMatrix(matrix);

  const grouped = new Map<string, Omit<ParsedSimpleImportRow, "key" | "inputError">>();
  for (const [offset, source] of matrix.slice(headerIndex + 1).entries()) {
    if (!source.some((value) => String(value ?? "").trim())) continue;
    const styleNo = String(source[columns.styleNo] ?? "").trim();
    const color = String(source[columns.color] ?? "").trim();
    const size = String(source[columns.size] ?? "").trim();
    const quantity = Number(String(source[columns.quantity] ?? "").replaceAll(",", "").trim());
    const note = columns.note >= 0 ? String(source[columns.note] ?? "").trim() || null : null;
    const key = `${styleNo}\u0000${color}\u0000${size}`;
    const existing = grouped.get(key);
    grouped.set(key, {
      sourceRows: [...(existing?.sourceRows ?? []), headerIndex + offset + 2],
      styleNo,
      color,
      size,
      quantity: (existing?.quantity ?? 0) + quantity,
      note: note ?? existing?.note ?? null,
    });
  }
  if (!grouped.size) throw new Error("表格没有可导入的数据行");
  return [...grouped.entries()].map(([key, row]): ParsedSimpleImportRow => ({
    key,
    ...row,
    inputError: !row.styleNo || !row.color || !row.size ? "款号、颜色和尺码不能为空" : !Number.isInteger(row.quantity) || row.quantity <= 0 ? "数量必须为正整数" : null,
  }));
}

