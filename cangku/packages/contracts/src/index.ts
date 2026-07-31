import { z } from "zod";

export const documentTypes = ["INBOUND", "OUTBOUND", "RETURN", "STOCKTAKE", "ADJUSTMENT", "RESTORE"] as const;
export const documentStatuses = ["DRAFT", "PENDING_APPROVAL", "CONFIRMED", "RESERVED", "POSTED", "CANCELLED", "REVERSED"] as const;
export const stockStatuses = ["SELLABLE", "INSPECTION", "DAMAGED"] as const;

export const createWarehouseSchema = z.object({
  code: z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9_-]+$/, "仓库编码只能包含字母、数字、下划线和连字符"),
  name: z.string().trim().min(1).max(80),
});

export const updateWarehouseSchema = createWarehouseSchema.extend({
  active: z.boolean(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
});

export const createMemberSchema = z.object({
  name: z.string().min(2).max(50),
  email: z.string().email(),
  password: z.string().min(10).max(128),
  roleId: z.string().cuid(),
});

export const variantSchema = z.object({
  skuCode: z.string().min(1).max(80),
  color: z.string().min(1).max(50),
  size: z.string().min(1).max(30),
  minStock: z.number().int().min(0).default(0),
});

export const createStyleSchema = z.object({
  styleNo: z.string().min(1).max(80),
  name: z.string().min(1).max(120),
  brand: z.string().max(80).optional().nullable(),
  category: z.string().max(80).optional().nullable(),
  season: z.string().max(40).optional().nullable(),
  year: z.number().int().min(2000).max(2100).optional().nullable(),
  attributes: z.record(z.unknown()).default({}),
  variants: z.array(variantSchema).min(1).max(200),
});

export const updateStyleSchema = z.object({
  name: z.string().min(1).max(120),
  brand: z.string().max(80).optional().nullable(),
  category: z.string().max(80).optional().nullable(),
  activeSkuIds: z.array(z.string().cuid()).max(200),
  variants: z.array(variantSchema.extend({ id: z.string().cuid().optional() })).min(1).max(200),
});

export const dailyOutboundLineSchema = z.object({
  skuId: z.string().cuid(),
  quantity: z.number().int().min(1).max(1_000_000),
  note: z.string().max(300).optional().nullable(),
});

export const updateDailyOutboundSchema = z.object({
  version: z.number().int().min(1),
  lines: z.array(dailyOutboundLineSchema).max(1000),
});

export const automationSettingSchema = z.object({
  autoOutboundTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "时间格式必须为 HH:mm"),
});

export const documentLineSchema = z.object({
  skuId: z.string().cuid(),
  stockStatus: z.enum(stockStatuses).default("SELLABLE"),
  cartons: z.number().int().min(0).default(0),
  piecesPerCarton: z.number().int().min(0).default(0),
  loosePieces: z.number().int().min(0).default(0),
  countedPieces: z.number().int().min(0).optional(),
  adjustmentDelta: z.number().int().refine((value) => value !== 0, "调整数量不能为 0").optional(),
  note: z.string().max(300).optional().nullable(),
}).refine((line) => line.cartons * line.piecesPerCarton + line.loosePieces > 0 || line.countedPieces !== undefined || line.adjustmentDelta !== undefined, {
  message: "数量必须大于 0，盘点行则必须填写实盘数量",
});

export const createDocumentSchema = z.object({
  type: z.enum(documentTypes),
  warehouseId: z.string().cuid().optional(),
  sourceRef: z.string().max(120).optional().nullable(),
  counterparty: z.string().max(120).optional().nullable(),
  reason: z.string().max(500).optional().nullable(),
  lines: z.array(documentLineSchema).min(1).max(1000),
});

export const movementLineSchema = z.object({
  skuId: z.string().cuid(),
  stockStatus: z.enum(stockStatuses).default("SELLABLE"),
  quantity: z.number().int().min(1).max(1_000_000),
  note: z.string().trim().max(300).optional().nullable(),
});

export const movementPreviewSchema = z.object({
  warehouseId: z.string().cuid(),
  type: z.enum(["INBOUND", "OUTBOUND"]),
  sourceRef: z.string().trim().max(120).optional().nullable(),
  counterparty: z.string().trim().max(120).optional().nullable(),
  reason: z.string().trim().max(500).optional().nullable(),
  lines: z.array(movementLineSchema).min(1).max(1000),
});

export const updateDocumentSchema = movementPreviewSchema.extend({
  version: z.number().int().min(1),
});

export const createDraftSchema = movementPreviewSchema;

export const commitDocumentSchema = z.object({
  previewToken: z.string().min(20).max(20_000),
});

export const restorePreviewSchema = z.object({
  warehouseId: z.string().cuid(),
  targetAt: z.string().datetime({ offset: true }),
});

export const createRestoreSchema = restorePreviewSchema.extend({
  reason: z.string().trim().min(5).max(500),
  previewToken: z.string().min(20).max(20_000),
});

export const versionSchema = z.object({ version: z.number().int().min(1) });

export const reportDatasets = ["inventory", "ledger", "documents", "alerts", "audit"] as const;
export const reportFormats = ["xlsx", "csv", "pdf"] as const;

export const reportSpecSchema = z.object({
  dataset: z.enum(reportDatasets),
  format: z.enum(reportFormats).default("xlsx"),
  filters: z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).default({}),
  groupBy: z.array(z.string()).max(3).default([]),
  columns: z.array(z.string()).max(30).default([]),
  sort: z.array(z.object({ field: z.string(), direction: z.enum(["asc", "desc"]) })).max(3).default([]),
});

export const createExportSchema = z.object({
  prompt: z.string().min(2).max(500),
  format: z.enum(reportFormats).default("xlsx"),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type CreateMemberInput = z.infer<typeof createMemberSchema>;
export type CreateStyleInput = z.infer<typeof createStyleSchema>;
export type UpdateStyleInput = z.infer<typeof updateStyleSchema>;
export type CreateWarehouseInput = z.infer<typeof createWarehouseSchema>;
export type UpdateWarehouseInput = z.infer<typeof updateWarehouseSchema>;
export type UpdateDailyOutboundInput = z.infer<typeof updateDailyOutboundSchema>;
export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;
export type MovementPreviewInput = z.infer<typeof movementPreviewSchema>;
export type CreateDraftInput = z.infer<typeof createDraftSchema>;
export type UpdateDocumentInput = z.infer<typeof updateDocumentSchema>;
export type CreateRestoreInput = z.infer<typeof createRestoreSchema>;
export type ReportSpec = z.infer<typeof reportSpecSchema>;

export type GoodsOrderMatrixLine = z.infer<typeof movementLineSchema>;
export type GoodsOrderDraft = MovementPreviewInput & { id: string; documentNo: string; version: number; status: "DRAFT" };
export type MovementPreviewRow = GoodsOrderMatrixLine & {
  skuCode: string;
  styleNo: string;
  name: string;
  color: string;
  size: string;
  currentOnHand: number;
  currentReserved: number;
  available: number;
  delta: number;
  projectedOnHand: number;
  errors: string[];
  warnings: string[];
};
export type MovementPreviewResult = {
  warehouse: { id: string; code: string; name: string; active: boolean };
  type: "INBOUND" | "OUTBOUND";
  rows: MovementPreviewRow[];
  totals: { quantity: number; delta: number };
  valid: boolean;
  previewToken: string;
  expiresAt: string;
};
export type RecognitionResult = {
  styleNo?: string;
  skuCode?: string;
  color?: string;
  size?: string;
  quantity?: number;
  sourceRef?: string;
  counterparty?: string;
  note?: string;
};
