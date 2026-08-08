export type ParsedVisionRow = {
  raw: Record<string, unknown>;
  normalized: Record<string, unknown>;
  confidence: number;
  validationErrors: string[];
};

type VisionPayload = {
  matrix?: unknown;
  table?: unknown;
  headers?: unknown;
  data?: unknown;
  rows?: unknown;
};

function text(value: unknown) {
  return String(value ?? "").trim();
}

function asMatrix(value: unknown): unknown[][] | null {
  if (!Array.isArray(value)) return null;
  const rows = value.filter(Array.isArray) as unknown[][];
  return rows.length ? rows : null;
}

function matrixFromPayload(payload: VisionPayload) {
  const direct = [payload.matrix, payload.table].map(asMatrix).find(Boolean);
  if (direct) return direct;
  const headers = Array.isArray(payload.headers) ? payload.headers : null;
  const rows = asMatrix(payload.rows) ?? asMatrix(payload.data);
  if (headers && rows) return [headers, ...rows];
  return asMatrix(payload.data);
}

function parseMatrix(matrix: unknown[][]): ParsedVisionRow[] {
  const headerIndex = matrix.slice(0, 5).findIndex((row) => {
    const rest = row.slice(1).map(text).filter(Boolean);
    return rest.length > 0 && rest.some((value) => /^(?:XXS|XS|S|M|L|XL|XXL|XXXL|\d+XL)$/i.test(value));
  });
  if (headerIndex < 0) return [];
  const header = matrix[headerIndex];
  const sizes = header.slice(1).map(text);
  let styleNo = text(header[0]);
  if (!styleNo) {
    // 模型有时把产品名单独放一行（表头行第一列为空），此时从上一行继承
    for (let index = headerIndex - 1; index >= 0; index -= 1) {
      const candidate = text(matrix[index]?.[0]);
      if (candidate) {
        styleNo = candidate;
        break;
      }
    }
  }
  if (!sizes.some(Boolean)) return [];
  const missingStyleNo = !styleNo;

  const rows: ParsedVisionRow[] = [];
  for (const source of matrix.slice(headerIndex + 1)) {
    const color = text(source[0]);
    if (!color) continue;
    for (const [sizeIndex, size] of sizes.entries()) {
      if (!size) continue;
      const rawQuantity = source[sizeIndex + 1];
      const quantityText = text(rawQuantity).replaceAll(",", "");
      if (!quantityText) continue;
      const quantity = Number(quantityText);
      const validationErrors = Number.isInteger(quantity) && quantity > 0 ? [] : ["数量必须为正整数"];
      if (missingStyleNo && !validationErrors.includes("缺少款号")) validationErrors.push("缺少款号");
      rows.push({
        raw: { styleNo, color, size, quantity: rawQuantity },
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
  const matrix = matrixFromPayload(parsed);
  if (matrix) {
    const matrixRows = parseMatrix(matrix);
    if (matrixRows.length) return matrixRows;
  }
  if (!Array.isArray(parsed.rows)) return [];
  return parsed.rows.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row)).map((row) => ({
    raw: row.raw && typeof row.raw === "object" ? row.raw as Record<string, unknown> : {},
    normalized: row.normalized && typeof row.normalized === "object" ? row.normalized as Record<string, unknown> : row,
    confidence: Number(row.confidence ?? 0.7),
    validationErrors: Array.isArray(row.validationErrors) ? row.validationErrors.map(String) : [],
  }));
}
