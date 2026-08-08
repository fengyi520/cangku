import { BadRequestException, Body, Controller, ForbiddenException, Injectable, Module, NotFoundException, Post, Req } from "@nestjs/common";
import { Request } from "express";
import { randomUUID } from "node:crypto";
import { AiConfigService } from "./ai-config.module";
import { AuthUser, CurrentUser } from "./auth-context";
import { InventoryWorkflowModule, InventoryWorkflowService } from "./inventory-workflow.module";
import { WarehouseModule, WarehouseService } from "./warehouse.module";
import { PrismaService } from "./prisma.module";
import type { Prisma } from "@prisma/client";

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function hasPermission(user: AuthUser, permission: string) {
  if (user.role.permissions.includes("*") || user.role.permissions.includes(permission)) return true;
  const [resource, action] = permission.split(".");
  return action === "view" && user.role.permissions.includes(`${resource}.manage`);
}

type ChatAction = { type: "create_inbound_draft"; warehouseId: string; lines: Array<{ skuId: string; skuCode: string; styleNo: string; color: string; size: string; quantity: number }> };
type ChatPreview = { action: ChatAction; previewToken: string; rows: Array<Record<string, unknown>>; totals: { quantity: number; delta: number }; valid: boolean; expiresAt: string };

type ImportFixAction = { type: "fix_import_rows"; jobId: string; fixes: Array<{ rowId: string; patch: Record<string, string | number> }> };
type CreateStyleAction = { type: "create_style"; styleNo: string; name: string; brand?: string | null; category?: string | null; variants: Array<{ skuCode: string; color: string; size: string; minStock?: number }>; matchJobId?: string | null };
type ImportContextAction = ImportFixAction | CreateStyleAction;

const FIXABLE_FIELDS = new Set(["styleNo", "name", "skuCode", "color", "size", "quantity", "cartons", "piecesPerCarton", "countedPieces", "sourceRef", "counterparty", "note"]);

@Injectable()
class AiChatService {
  constructor(private readonly prisma: PrismaService, private readonly aiConfig: AiConfigService, private readonly workflow: InventoryWorkflowService, private readonly warehouse: WarehouseService) {}

  async chat(user: AuthUser, message: string, jobId?: string) {
    const cleanMessage = String(message ?? "").trim();
    if (!cleanMessage || cleanMessage.length > 2000) throw new BadRequestException("请输入 1 到 2000 字的消息");
    const canViewInventory = hasPermission(user, "inventory.view");
    const canCreateDraft = hasPermission(user, "documents.manage");
    const canManageCatalog = hasPermission(user, "catalog.manage");
    const warehouse = await this.prisma.warehouse.findFirst({ where: { organizationId: user.organizationId, active: true }, orderBy: { createdAt: "asc" } });
    if (!warehouse) throw new BadRequestException("尚未配置可用仓库");
    const skus = canViewInventory ? await this.prisma.sku.findMany({ where: { active: true, style: { organizationId: user.organizationId } }, include: { style: true, balances: { where: { warehouseId: warehouse.id } } }, orderBy: [{ style: { styleNo: "asc" } }, { color: "asc" }, { size: "asc" }], take: 1000 }) : [];
    const inventory = skus.map((sku) => { const onHand = sku.balances.reduce((sum, item) => sum + item.onHand, 0); const reserved = sku.balances.reduce((sum, item) => sum + item.reserved, 0); return { skuId: sku.id, skuCode: sku.skuCode, styleNo: sku.style.styleNo, name: sku.style.name, color: sku.color, size: sku.size, onHand, reserved, available: onHand - reserved }; });
    let importContext = "";
    if (jobId) {
      const job = await this.prisma.importJob.findFirst({ where: { id: jobId, organizationId: user.organizationId }, include: { rows: { orderBy: { rowNumber: "asc" }, take: 500 } } });
      if (!job) throw new NotFoundException("导入任务不存在");
      if (job.status === "REVIEW") {
        const lines = job.rows.slice(0, 300).map((row) => {
          const data = row.normalized as Record<string, unknown>;
          const key = [data.styleNo, data.color, data.size].filter(Boolean).map(String).join("/");
          return `行${row.rowNumber} id=${row.id} SKU=${data.skuCode ?? "-"} 款号/颜色/尺码=${key || "-"} 数量=${data.quantity ?? data.countedPieces ?? "-"} 校验=${row.validationErrors.length ? row.validationErrors.join(",") : "通过"}`;
        });
        importContext = [
          `\n当前有一份 AI 识别任务：${job.fileName}（kind=${job.kind}，共 ${job.rows.length} 行），状态为待确认。以下是识别结果（行号/行id/SKU/款号/颜色/尺码/数量/校验结果）：`,
          lines.join("\n"),
          "用户如果指出某行识别错误（例如颜色、尺码、数量、SKU 编码等），你必须返回 fix_import_rows 动作。",
          "如果某些行校验失败原因是“SKU 不存在”，你可以向用户确认商品信息（款号、品名、颜色、尺码、SKU 编码），确认后返回 create_style 动作来新建商品（需要 catalog.manage 权限）。",
          "fix_import_rows 格式：{type:'fix_import_rows',jobId:'<任务id>',fixes:[{rowId:'<行id>',patch:{字段:值}}]}。可修正字段：styleNo,name,skuCode,color,size,quantity,cartons,piecesPerCarton,countedPieces,sourceRef,counterparty,note。",
          "create_style 格式：{type:'create_style',styleNo,name,variants:[{skuCode,color,size}]}。新建商品前必须先用文字向用户确认，得到用户同意后再返回该动作。",
          "注意：不要编造用户没说过的新建信息；如果信息不足，先询问用户。",
        ].join("\n");
      }
    }
    const config = await this.aiConfig.resolve(user.organizationId);
    if (!config) throw new BadRequestException("尚未配置可用的 AI 模型");
    const prompt = [
      "你是仓库系统内的中文 AI 助手。只根据下方权限和库存数据回答，不得虚构。",
      `权限：查看库存=${canViewInventory}；创建入库草稿=${canCreateDraft}；新建商品=${canManageCatalog}。`,
      "若用户查询库存，返回 JSON：{reply:string,action:null}。",
      "若用户要求增加/入库库存，只有创建草稿权限时，返回 JSON：{reply:string,action:{type:'create_inbound_draft',lines:[{skuId,quantity}]}}。必须使用库存数据中的 skuId，quantity 为正整数。",
      "没有权限时明确拒绝。不能直接修改库存，只能提出待确认草稿。返回纯 JSON。",
      `当前仓库：${warehouse.name} (${warehouse.id})`,
      `库存数据：${JSON.stringify(inventory)}`,
      importContext,
      `用户消息：${cleanMessage}`,
    ].join("\n");
    const response = await fetch(`${config.baseUrl}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: config.model, temperature: 0, response_format: { type: "json_object" }, messages: [{ role: "user", content: prompt }] }), signal: AbortSignal.timeout(40_000) });
    if (!response.ok) throw new BadRequestException(`AI 对话失败（HTTP ${response.status}）`);
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = payload.choices?.[0]?.message?.content ?? "{}";
    let parsed: { reply?: string; action?: { type?: string; lines?: Array<{ skuId?: string; quantity?: number }>; fixes?: Array<{ rowId?: string; patch?: Record<string, unknown> }>; jobId?: string; styleNo?: string; name?: string; brand?: string | null; category?: string | null; variants?: Array<{ skuCode?: string; color?: string; size?: string; minStock?: number }> } | null };
    try { parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, "")); } catch { throw new BadRequestException("AI 返回格式无法解析，请换一种说法"); }
    let action: ChatAction | ImportContextAction | null = null;
    if (parsed.action?.type === "create_inbound_draft") {
      if (!canCreateDraft) throw new ForbiddenException("当前账号没有创建入库草稿权限");
      const byId = new Map(inventory.map((item) => [item.skuId, item]));
      const lines = (parsed.action.lines ?? []).flatMap((line) => { const sku = line.skuId ? byId.get(line.skuId) : undefined; const quantity = Number(line.quantity); return sku && Number.isInteger(quantity) && quantity > 0 ? [{ skuId: sku.skuId, skuCode: sku.skuCode, styleNo: sku.styleNo, color: sku.color, size: sku.size, quantity }] : []; });
      if (lines.length) action = { type: "create_inbound_draft", warehouseId: warehouse.id, lines };
    } else if (parsed.action?.type === "fix_import_rows") {
      const targetJobId = jobId || parsed.action.jobId;
      if (!targetJobId) throw new BadRequestException("缺少导入任务 ID，无法修正");
      const fixes = (parsed.action.fixes ?? []).flatMap((fix) => {
        const patch: Record<string, string | number> = {};
        for (const [field, value] of Object.entries(fix.patch ?? {})) {
          if (FIXABLE_FIELDS.has(field) && (typeof value === "string" || typeof value === "number")) patch[field] = value;
        }
        return fix.rowId && Object.keys(patch).length ? [{ rowId: fix.rowId, patch }] : [];
      });
      if (fixes.length) action = { type: "fix_import_rows", jobId: targetJobId, fixes };
    } else if (parsed.action?.type === "create_style") {
      if (!canManageCatalog) throw new ForbiddenException("当前账号没有新建商品权限");
      const styleNo = String(parsed.action.styleNo ?? "").trim();
      const name = String(parsed.action.name ?? "").trim();
      const variants = (parsed.action.variants ?? []).flatMap((v) => { const skuCode = String(v.skuCode ?? "").trim(); const color = String(v.color ?? "").trim(); const size = String(v.size ?? "").trim(); return styleNo && skuCode && (color || size) ? [{ skuCode, color, size, minStock: Number.isFinite(Number(v.minStock)) ? Number(v.minStock) : undefined }] : []; });
      if (styleNo && name && variants.length) action = { type: "create_style", styleNo, name, brand: parsed.action.brand ?? null, category: parsed.action.category ?? null, variants, matchJobId: jobId };
    }
    return { reply: parsed.reply || "已处理你的请求。", action, permissions: { canViewInventory, canCreateDraft, canManageCatalog } };
  }

  async previewAction(user: AuthUser, action: ChatAction) {
    if (!hasPermission(user, "documents.manage")) throw new ForbiddenException("当前账号没有创建入库草稿权限");
    if (action.type !== "create_inbound_draft" || !Array.isArray(action.lines) || !action.lines.length) throw new BadRequestException("草稿提案无效");
    const preview = await this.workflow.previewMovement(user, { warehouseId: action.warehouseId, type: "INBOUND", sourceRef: "AI-CONVERSATION", reason: "对话式 AI 创建的待确认入库草稿", lines: action.lines.map((line) => ({ skuId: line.skuId, stockStatus: "SELLABLE", quantity: Number(line.quantity) })) });
    return { action, previewToken: preview.previewToken, rows: preview.rows, totals: preview.totals, valid: preview.valid, expiresAt: preview.expiresAt } satisfies ChatPreview;
  }

  async confirmDraft(user: AuthUser, preview: ChatPreview, request: Request) {
    if (!hasPermission(user, "documents.manage")) throw new ForbiddenException("当前账号没有创建入库草稿权限");
    if (!preview?.previewToken || !preview.action) throw new BadRequestException("缺少有效的预览结果");
    return this.workflow.createDraftFromPreview(user, preview.previewToken, `ai-chat-${randomUUID()}`, request, "INBOUND");
  }

  private async loadSkuMaps(organizationId: string, warehouseId: string) {
    const skus = await this.prisma.sku.findMany({ where: { active: true, style: { organizationId } }, include: { style: true } });
    const skuCodeMap = new Map<string, string>();
    const variantMap = new Map<string, string>();
    for (const sku of skus) {
      skuCodeMap.set(sku.skuCode.trim().toLowerCase(), sku.id);
      variantMap.set(`${sku.style.styleNo.trim().toLowerCase()}\u0000${sku.color.trim().toLowerCase()}\u0000${sku.size.trim().toLowerCase()}`, sku.id);
    }
    return { skuCodeMap, variantMap };
  }

  private async validateAndMatchRow(kind: string, normalized: Record<string, unknown>, skuCodeMap: Map<string, string>, variantMap: Map<string, string>) {
    const errors: string[] = [];
    const skuCode = String(normalized.skuCode ?? "").trim().toLowerCase();
    const variantKey = `${String(normalized.styleNo ?? "").trim().toLowerCase()}\u0000${String(normalized.color ?? "").trim().toLowerCase()}\u0000${String(normalized.size ?? "").trim().toLowerCase()}`;
    const skuId = (skuCodeMap.get(skuCode) ?? variantMap.get(variantKey)) ?? null;
    const quantity = Number(normalized.quantity ?? normalized.countedPieces);
    if (kind !== "CATALOG" && !skuCode && !(normalized.styleNo && normalized.color && normalized.size)) errors.push("缺少 SKU 编码或款号/颜色/尺码");
    if (kind === "CATALOG" && (!normalized.styleNo || !normalized.color || !normalized.size)) errors.push("商品资料缺少款号、颜色或尺码");
    if (kind !== "CATALOG" && (!Number.isInteger(quantity) || quantity <= 0)) errors.push("数量必须为正整数");
    if (kind !== "CATALOG" && !skuId) errors.push("SKU 不存在");
    return { skuId: skuId as string | null, errors };
  }

  async applyImportFix(user: AuthUser, jobId: string, fixes: Array<{ rowId: string; patch: Record<string, string | number> }>, request: Request) {
    if (!hasPermission(user, "imports.manage")) throw new ForbiddenException("当前账号没有导入管理权限");
    const job = await this.prisma.importJob.findFirst({ where: { id: jobId, organizationId: user.organizationId }, include: { rows: true } });
    if (!job) throw new NotFoundException("导入任务不存在");
    if (job.status !== "REVIEW") throw new BadRequestException("任务不是待确认状态，无法修正");
    const { skuCodeMap, variantMap } = await this.loadSkuMaps(user.organizationId, job.warehouseId ?? "");
    const rowsById = new Map(job.rows.map((row) => [row.id, row]));
    const updates: Array<{ row: typeof job.rows[number]; normalized: Record<string, unknown>; skuId: string | null; errors: string[] }> = [];
    const missing = fixes.filter((fix) => !rowsById.has(fix.rowId)).map((fix) => fix.rowId);
    if (missing.length) throw new BadRequestException(`以下行不存在：${missing.join(", ")}`);
    for (const fix of fixes) {
      const row = rowsById.get(fix.rowId)!;
      const normalized = { ...(row.normalized as Record<string, unknown>) };
      for (const [field, value] of Object.entries(fix.patch)) {
        if (FIXABLE_FIELDS.has(field)) normalized[field] = value;
      }
      delete normalized.skuId;
      const { skuId, errors } = await this.validateAndMatchRow(job.kind, normalized, skuCodeMap, variantMap);
      updates.push({ row, normalized, skuId, errors });
    }
    await this.prisma.$transaction([
      ...updates.map((update) => this.prisma.importRow.update({ where: { id: update.row.id }, data: { normalized: json(update.normalized), skuId: update.skuId, validationErrors: update.errors, confidence: Math.min(update.row.confidence, 0.9), accepted: false } })),
      this.prisma.auditEvent.create({ data: { organizationId: user.organizationId, actorId: user.id, action: "import.rows_fixed_by_ai", entityType: "ImportJob", entityId: job.id, after: json({ rowCount: updates.length, fixes: fixes.map((fix) => ({ rowId: fix.rowId, patch: fix.patch })) }), ip: request.ip } }),
    ]);
    return this.prisma.importJob.findUnique({ where: { id: job.id }, include: { rows: { orderBy: { rowNumber: "asc" } } } });
  }

  async createStyleFromChat(user: AuthUser, action: CreateStyleAction, request: Request) {
    if (!hasPermission(user, "catalog.manage")) throw new ForbiddenException("当前账号没有新建商品权限");
    const style = await this.warehouse.createStyle(user, { styleNo: action.styleNo, name: action.name, brand: action.brand, category: action.category, variants: action.variants }, request);
    let job = null;
    if (action.matchJobId) {
      const importJob = await this.prisma.importJob.findFirst({ where: { id: action.matchJobId, organizationId: user.organizationId }, include: { rows: true } });
      if (importJob && importJob.status === "REVIEW") {
        const { skuCodeMap, variantMap } = await this.loadSkuMaps(user.organizationId, importJob.warehouseId ?? "");
        const updates: Array<{ id: string; skuId: string | null; errors: string[] }> = [];
        for (const row of importJob.rows) {
          const normalized = row.normalized as Record<string, unknown>;
          const { skuId, errors } = await this.validateAndMatchRow(importJob.kind, { ...normalized }, skuCodeMap, variantMap);
          updates.push({ id: row.id, skuId, errors });
        }
        await this.prisma.$transaction(updates.map((update) => this.prisma.importRow.update({ where: { id: update.id }, data: { skuId: update.skuId, validationErrors: update.errors, accepted: false } })));
        job = await this.prisma.importJob.findUnique({ where: { id: importJob.id }, include: { rows: { orderBy: { rowNumber: "asc" } } } });
      }
    }
    return { style, job };
  }
}

@Controller("ai/chat")
class AiChatController {
  constructor(private readonly service: AiChatService) {}
  @Post() chat(@CurrentUser() user: AuthUser, @Body() body: { message?: string; jobId?: string }) { return this.service.chat(user, body.message ?? "", body.jobId); }
  @Post("preview") preview(@CurrentUser() user: AuthUser, @Body() body: { action?: ChatAction }) { return this.service.previewAction(user, body.action as ChatAction); }
  @Post("confirm-draft") confirm(@CurrentUser() user: AuthUser, @Body() body: { preview?: ChatPreview }, @Req() request: Request) { return this.service.confirmDraft(user, body.preview as ChatPreview, request); }
  @Post("fix-import-rows") fixImportRows(@CurrentUser() user: AuthUser, @Body() body: { jobId?: string; fixes?: Array<{ rowId?: string; patch?: Record<string, unknown> }> }, @Req() request: Request) {
    const fixes = (body.fixes ?? []).flatMap((fix) => {
      const patch: Record<string, string | number> = {};
      for (const [field, value] of Object.entries(fix.patch ?? {})) {
        if (FIXABLE_FIELDS.has(field) && (typeof value === "string" || typeof value === "number")) patch[field] = value;
      }
      return fix.rowId && Object.keys(patch).length ? [{ rowId: fix.rowId, patch }] : [];
    });
    if (!body.jobId || !fixes.length) throw new BadRequestException("缺少导入任务 ID 或修正内容");
    return this.service.applyImportFix(user, body.jobId, fixes, request);
  }
  @Post("create-style") createStyle(@CurrentUser() user: AuthUser, @Body() body: { styleNo?: string; name?: string; brand?: string | null; category?: string | null; variants?: Array<{ skuCode?: string; color?: string; size?: string; minStock?: number }>; matchJobId?: string }, @Req() request: Request) {
    const styleNo = String(body.styleNo ?? "").trim();
    const name = String(body.name ?? "").trim();
    const variants = (body.variants ?? []).flatMap((v) => { const skuCode = String(v.skuCode ?? "").trim(); const color = String(v.color ?? "").trim(); const size = String(v.size ?? "").trim(); return styleNo && skuCode && (color || size) ? [{ skuCode, color, size, minStock: Number.isFinite(Number(v.minStock)) ? Number(v.minStock) : undefined }] : []; });
    if (!styleNo || !name || !variants.length) throw new BadRequestException("商品信息不完整，需要款号、品名和至少一个规格");
    return this.service.createStyleFromChat(user, { type: "create_style", styleNo, name, brand: body.brand ?? null, category: body.category ?? null, variants, matchJobId: body.matchJobId }, request);
  }
}

@Module({ imports: [InventoryWorkflowModule, WarehouseModule], controllers: [AiChatController], providers: [AiChatService] })
export class AiChatModule {}
