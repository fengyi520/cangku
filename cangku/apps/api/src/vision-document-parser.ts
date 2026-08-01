export type ParsedVisionRow = {
  raw: Record<string, unknown>;
  normalized: Record<string, unknown>;
  confidence: number;
  validationErrors: string[];
};

type VisionPayload = {
  matrix?: unknown[][];
  rows?: Array<Record<string, unknown>>;
};

function text(value: unknown) {
  return String(value ?? "").trim();
}

function parseMatrix(matrix: unknown[][]): ParsedVisionRow[] {
  const headerIndex = matrix.slice(0, 5).findIndex((row) => text(row[0]) && row.slice(1).some((value) => text(value)));
  if (headerIndex < 0) return [];
  const header = matrix[headerIndex];
  const styleNo = text(header[0]);
  const sizes = header.slice(1).map(text);
  if (!styleNo || !sizes.some(Boolean)) return [];

  const rows: ParsedVisionRow[] = [];
  for (const source of matrix.slice(headerIndex + 1)) {
    const color = text(source[0]);
    if (!color) continue;
    for (const [sizeIndex, size] of sizes.entries()) {
      if (!size) continue;
      const quantityText = text(source[sizeIndex + 1]).replaceAll(",", "");
      if (!quantityText) continue;
      const quantity = Number(quantityText);
      const validationErrors = Number.isInteger(quantity) && quantity > 0 ? [] : ["数量必须为正整数"];
      rows.push({
        raw: { styleNo, color, size, quantity: source[sizeIndex + 1] },
        normalized: { styleNo, color, size, quantity },
        confidence: validationErrors.length ? 0.45 : 0.95,
        validationErrors,
      });
    }
  }
  return rows;
}

export function parseVisionPayload(payload: unknown): ParsedVisionRow[] {
  if (!payload || typeof payload !== "object") return [];
  const parsed = payload as VisionPayload;
  if (Array.isArray(parsed.matrix)) {
    const matrixRows = parseMatrix(parsed.matrix.filter(Array.isArray));
    if (matrixRows.length) return matrixRows;
  }
  if (!Array.isArray(parsed.rows)) return [];
  return parsed.rows.map((row) => ({
    raw: row.raw && typeof row.raw === "object" ? row.raw as Record<string, unknown> : {},
    normalized: row.normalized && typeof row.normalized === "object" ? row.normalized as Record<string, unknown> : row,
    confidence: Number(row.confidence ?? 0.7),
    validationErrors: Array.isArray(row.validationErrors) ? row.validationErrors.map(String) : [],
  }));
}
