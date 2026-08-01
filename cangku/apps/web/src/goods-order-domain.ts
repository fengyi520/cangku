import type { ImportRow, InventoryRow } from "./types";

export type MatrixRow = {
  key: string;
  styleNo: string;
  name: string;
  color: string;
  skus: InventoryRow[];
};

export type MergeConflict = {
  skuId: string;
  styleNo: string;
  color: string;
  size: string;
  current: number;
  incoming: number;
};

export function groupInventoryMatrix(inventory: InventoryRow[]) {
  const groups = new Map<string, MatrixRow>();
  for (const sku of inventory) {
    const key = `${sku.style.styleNo}\u0000${sku.color}`;
    const current = groups.get(key);
    if (current) current.skus.push(sku);
    else groups.set(key, { key, styleNo: sku.style.styleNo, name: sku.style.name, color: sku.color, skus: [sku] });
  }
  return [...groups.values()].sort((left, right) => `${left.styleNo}\u0000${left.color}`.localeCompare(`${right.styleNo}\u0000${right.color}`));
}

export function flattenQuantities(quantities: Record<string, number>) {
  return Object.entries(quantities)
    .filter(([, quantity]) => Number.isInteger(quantity) && quantity > 0)
    .map(([skuId, quantity]) => ({ skuId, stockStatus: "SELLABLE" as const, quantity, note: null }))
    .sort((left, right) => left.skuId.localeCompare(right.skuId));
}

function normalized(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replaceAll(" ", "");
}

function colorCodeFromSku(sku: InventoryRow) {
  const parts = sku.skuCode.split("-").map((part) => part.trim()).filter(Boolean);
  let sizeIndex = -1;
  for (let index = parts.length - 1; index >= 0; index -= 1) if (normalized(parts[index]) === normalized(sku.size)) { sizeIndex = index; break; }
  return sizeIndex > 0 ? normalized(parts[sizeIndex - 1]) : "";
}

function matrixMatchScore(sku: InventoryRow, styleValue: unknown, colorValue: unknown, sizeValue: unknown) {
  if (normalized(sku.size) !== normalized(sizeValue)) return -1;
  const style = normalized(styleValue);
  const color = normalized(colorValue);
  let score = 0;
  if (normalized(sku.style.styleNo) === style) score += 4;
  else if (normalized(sku.style.name) === style) score += 2;
  else return -1;
  if (normalized(sku.color) === color) score += 2;
  else if (colorCodeFromSku(sku) === color) score += 1;
  else return -1;
  if (normalized(sku.style.styleNo) === color) score -= 3;
  return score;
}

function bestMatrixMatch(inventory: InventoryRow[], styleValue: unknown, colorValue: unknown, sizeValue: unknown) {
  const ranked = inventory.map((sku) => ({ sku, score: matrixMatchScore(sku, styleValue, colorValue, sizeValue) })).filter((item) => item.score >= 0).sort((left, right) => right.score - left.score);
  return ranked.length && (ranked.length === 1 || ranked[0].score > ranked[1].score) ? ranked[0].sku : null;
}

export function parseClipboardTable(text: string, inventory: InventoryRow[]) {
  const rows = text.split(/\r?\n/).map((line) => line.split(/\t|,/).map((cell) => cell.trim())).filter((row) => row.some(Boolean));
  if (!rows.length) return { matches: [], errors: ["没有可解析的数据"] };
  const bySku = new Map(inventory.map((sku) => [normalized(sku.skuCode), sku]));
  const byVariant = new Map(inventory.map((sku) => [`${normalized(sku.style.styleNo)}\u0000${normalized(sku.color)}\u0000${normalized(sku.size)}`, sku]));
  const header = rows[0].map(normalized);
  const quantityColumn = header.findIndex((value) => ["数量", "件数", "quantity", "qty"].includes(value));
  const styleColumn = header.findIndex((value) => ["款号", "款式", "styleno", "style"].includes(value));
  const colorColumn = header.findIndex((value) => ["颜色", "color"].includes(value));
  const sizeColumn = header.findIndex((value) => ["尺码", "尺寸", "size"].includes(value));
  const skuColumn = header.findIndex((value) => ["sku", "skucode", "sku编码"].includes(value));
  const matches: Array<{ skuId: string; quantity: number }> = [];
  const errors: string[] = [];

  if (quantityColumn >= 0 && (skuColumn >= 0 || (styleColumn >= 0 && colorColumn >= 0 && sizeColumn >= 0))) {
    for (const [index, row] of rows.slice(1).entries()) {
      const sku = skuColumn >= 0
        ? bySku.get(normalized(row[skuColumn]))
        : byVariant.get(`${normalized(row[styleColumn])}\u0000${normalized(row[colorColumn])}\u0000${normalized(row[sizeColumn])}`);
      const quantity = Number(String(row[quantityColumn] ?? "").replaceAll(",", ""));
      if (!sku) errors.push(`第 ${index + 2} 行无法匹配现有 SKU`);
      else if (!Number.isInteger(quantity) || quantity <= 0) errors.push(`第 ${index + 2} 行数量必须为正整数`);
      else matches.push({ skuId: sku.id, quantity });
    }
    return { matches, errors };
  }

  const matrixStyle = rows[0][0] ?? "";
  const sizes = rows[0].slice(1).map(String).filter(Boolean);
  if (!sizes.length) return { matches: [], errors: ["表头需要包含数量列或尺码列"] };
  for (const [rowIndex, row] of rows.slice(1).entries()) {
    const colorOrCode = row[0] ?? "";
    for (const [offset, size] of sizes.entries()) {
      const quantity = Number(String(row[offset + 1] ?? "").replaceAll(",", ""));
      if (!String(row[offset + 1] ?? "").trim()) continue;
      if (!Number.isInteger(quantity) || quantity <= 0) {
        errors.push(`第 ${rowIndex + 2} 行 ${size} 数量必须为正整数`);
        continue;
      }
      const sku = bestMatrixMatch(inventory, matrixStyle, colorOrCode, size);
      if (!sku) errors.push(`第 ${rowIndex + 2} 行 ${colorOrCode}/${size} 无法唯一匹配现有 SKU`);
      else matches.push({ skuId: sku.id, quantity });
    }
  }
  return { matches, errors };
}

export function mergeRecognizedRows(quantities: Record<string, number>, rows: ImportRow[]) {
  const next = { ...quantities };
  const conflicts: MergeConflict[] = [];
  const reviewRows: ImportRow[] = [];
  const incoming = new Map<string, { quantity: number; row: ImportRow; needsReview: boolean }>();
  for (const row of rows) {
    const quantity = Number(row.normalized.quantity ?? row.normalized.countedPieces ?? 0);
    if (row.validationErrors.length || !row.skuId || !Number.isInteger(quantity) || quantity <= 0) continue;
    const current = incoming.get(row.skuId);
    incoming.set(row.skuId, { quantity: (current?.quantity ?? 0) + quantity, row: current?.row ?? row, needsReview: current?.needsReview || row.confidence < 0.85 });
  }
  for (const [skuId, value] of incoming) {
    const existing = next[skuId] ?? 0;
    const sku = value.row.sku;
    if (existing > 0 && existing !== value.quantity) {
      if (sku) conflicts.push({ skuId, styleNo: sku.style.styleNo, color: sku.color, size: sku.size, current: existing, incoming: value.quantity });
      continue;
    }
    next[skuId] = existing || value.quantity;
    if (value.needsReview) reviewRows.push(value.row);
  }
  return { quantities: next, conflicts, reviewRows };
}
