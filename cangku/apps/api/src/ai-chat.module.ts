import { BadRequestException, Body, Controller, ForbiddenException, Injectable, Module, NotFoundException, Post, Req } from "@nestjs/common";
import { Request } from "express";
import { randomUUID } from "node:crypto";
import { AiConfigService } from "./ai-config.module";
import { AuthUser, CurrentUser } from "./auth-context";
import { InventoryWorkflowModule, InventoryWorkflowService } from "./inventory-workflow.module";
import { WarehouseModule, WarehouseService } from "./warehouse.module";
import { PrismaService } from "./prisma.module";
import { AiAdapter, JobsModule, ObjectStorageService, compareWarehouseRows } from "./jobs.module";
import { ImportKind, Prisma } from "@prisma/client";

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function hasPermission(user: AuthUser, permission: string) {
  if (user.role.permissions.includes("*") || user.role.permissions.includes(permission)) return true;
  const [resource, action] = permission.split(".");
  return action === "view" && user.role.permissions.includes(`${resource}.manage`);
}

type ChatAction = { type: "create_inbound_draft" | "create_outbound_draft"; warehouseId: string; lines: Array<{ skuId: string; skuCode: string; styleNo: string; color: string; size: string; quantity: number }> };
type ChatPreview = { action: ChatAction; previewToken: string; rows: Array<Record<string, unknown>>; totals: { quantity: number; delta: number }; valid: boolean; expiresAt: string };

type ImportFixAction = { type: "fix_import_rows"; jobId: string; fixes: Array<{ rowId: string; patch: Record<string, string | number> }> };
type CreateStyleAction = { type: "create_style"; styleNo: string; name: string; brand?: string | null; category?: string | null; variants: Array<{ skuCode: string; color: string; size: string; minStock?: number }>; matchJobId?: string | null };
type MapRowsToStyleAction = { type: "map_rows_to_style"; jobId: string; styleNo: string; name?: string | null; rows: Array<{ row: number; color?: string; size?: string }> };
type CreateInboundDraftFromJobAction = { type: "create_inbound_draft_from_job"; jobId: string };
type ReanalyzeImportAction = { type: "reanalyze_import"; jobId: string; instruction?: string };
type ImportContextAction = ImportFixAction | CreateStyleAction | MapRowsToStyleAction | CreateInboundDraftFromJobAction | ReanalyzeImportAction;

const FIXABLE_FIELDS = new Set(["styleNo", "name", "skuCode", "color", "size", "quantity", "cartons", "piecesPerCarton", "countedPieces", "sourceRef", "counterparty", "note"]);

@Injectable()
class AiChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiConfig: AiConfigService,
    private readonly workflow: InventoryWorkflowService,
    private readonly warehouse: WarehouseService,
    private readonly storage: ObjectStorageService,
    private readonly ai: AiAdapter,
  ) {}

  async chat(user: AuthUser, message: string, jobId?: string, history?: Array<{ role: string; text: string }>) {
    const cleanMessage = String(message ?? "").trim();
    if (!cleanMessage || cleanMessage.length > 2000) throw new BadRequestException("请输入 1 到 2000 字的消息");
    const canViewInventory = hasPermission(user, "inventory.view");
    const canCreateDraft = hasPermission(user, "documents.manage");
    const canManageCatalog = hasPermission(user, "catalog.manage");
    const warehouse = await this.prisma.warehouse.findFirst({ where: { organizationId: user.organizationId, active: true }, orderBy: { createdAt: "asc" } });
    if (!warehouse) throw new BadRequestException("尚未配置可用仓库");
    const skus = canViewInventory ? await this.prisma.sku.findMany({ where: { active: true, style: { organizationId: user.organizationId } }, include: { style: true, balances: { where: { warehouseId: warehouse.id } } }, orderBy: [{ style: { styleNo: "asc" } }, { color: "asc" }, { size: "asc" }], take: 1000 }) : [];
    const inventory = skus.map((sku) => { const onHand = sku.balances.reduce((sum, item) => sum + item.onHand, 0); const reserved = sku.balances.reduce((sum, item) => sum + item.reserved, 0); return { skuId: sku.id, skuCode: sku.skuCode, styleNo: sku.style.styleNo, name: sku.style.name, color: sku.color, size: sku.size, onHand, reserved, available: onHand - reserved, minStock: sku.minStock }; });
    let importContext = "";
    // 识别任务上下文中 AI 主要做纠错/新建商品，无需完整余额数据；精简库存上下文可显著减小 prompt、加快生成，避免超时。
    const inventoryForPrompt = jobId ? inventory.map((item) => ({ skuId: item.skuId, skuCode: item.skuCode, styleNo: item.styleNo, name: item.name, color: item.color, size: item.size })) : inventory;
    if (jobId) {
      const job = await this.prisma.importJob.findFirst({ where: { id: jobId, organizationId: user.organizationId }, include: { rows: { orderBy: { rowNumber: "asc" }, take: 500 } } });
      if (!job) throw new NotFoundException("导入任务不存在");
      if (job.status === "REVIEW") {
        const lines = job.rows.slice(0, 300).map((row) => {
          const data = row.normalized as Record<string, unknown>;
          const key = [data.styleNo, data.color, data.size].filter(Boolean).map(String).join("/");
          let candidateText = "";
          if (row.validationErrors.includes("SKU 不存在")) {
            const candidates = this.findSimilarCandidates(data, inventoryForPrompt);
            if (candidates.length) candidateText = ` 相似候选:${candidates.map((c) => `${c.styleNo}(${c.name || "无名称"}${c.specs.length ? ";" + c.specs.join("|") : ""})`).join("、")}`;
          }
          return `行${row.rowNumber} id=${row.id} SKU=${data.skuCode ?? "-"} 款号/颜色/尺码=${key || "-"} 数量=${data.quantity ?? data.countedPieces ?? "-"} 校验=${row.validationErrors.length ? row.validationErrors.join(",") : "通过"}${candidateText}`;
        });
        importContext = [
          `\n当前有一份 AI 识别任务：${job.fileName}（id=${job.id}，kind=${job.kind}，共 ${job.rows.length} 行），状态为待确认。以下是识别结果（行号/行id/SKU/款号/颜色/尺码/数量/校验结果）：`,
          lines.join("\n"),
          "用户如果指出某行识别错误（例如颜色、尺码、数量、SKU 编码等），你必须返回 fix_import_rows 动作。",
          "如果用户指出识别整体不对（例如漏行、多行、表头错位、整表结构看错、或明确要求“重新识别/再看一遍图/按原图重来”），返回轻量动作 {type:'reanalyze_import',jobId:'<任务id>',instruction:'<用户指出的问题，简明概括>'}, 由系统结合原图重新识别。不要尝试逐行手写修正。",
          "如果某些行校验失败原因是“SKU 不存在”，先看该行是否标注了「相似候选」（形如：相似候选:款号(名称;颜色/尺码)）。若有相似候选，你必须主动向用户提问确认是否为同一商品，例如：“第3行识别为 XX，库中有相似商品 A001（德绒男士内衣；黑色/M、黑色/L），是否就是这款？请确认。” 即使当前消息只是询问识别情况，汇报时也要把候选列出并以明确提问结尾，等待用户确认；不要直接新建商品，也不要跳过候选。",
          "用户确认是同一个商品后，优先返回 map_rows_to_style 批量关联动作（比逐行 fix 更高效、不易超时）：{type:'map_rows_to_style',jobId:'<任务id>',styleNo:'<候选款号>',rows:[{row:<行号>,color?:'<如需修正颜色>',size?:'<如需修正尺码>'}]}。rows 中列出所有要关联的行（行号用识别结果中的行号）；颜色/尺码已正确的不必写出，有差异的（如颜色 02 对候选 2）要写出修正值。",
          "若用户确认是同一商品但指定了候选规格之外的颜色/尺码，先向用户说明该规格在库中不存在，引导其从候选规格中选择，或走新建商品流程。",
          "只有用户明确表示不是库中任何相似商品、且商品信息齐全时，才返回 create_style 动作来新建商品（权限声明为“新建商品=是”时可直接返回，不要以权限为由拒绝）。",
          "fix_import_rows 格式：{type:'fix_import_rows',jobId:'<任务id>',fixes:[{rowId:'<行id>',patch:{字段:值}}]}。可修正字段：styleNo,name,skuCode,color,size,quantity,cartons,piecesPerCarton,countedPieces,sourceRef,counterparty,note。",
          "create_style 格式：{type:'create_style',styleNo,name,variants:[{skuCode,color,size}]}。新建商品前必须先用文字向用户确认，得到用户同意后再返回该动作。",
          "如果用户要求把这份识别结果直接入库/增加库存（例如“没问题，入库”“确认入库”“全部入库”“生成入库方案”），且所有行校验结果都是“通过”：你必须返回轻量动作 {type:'create_inbound_draft_from_job',jobId:'<任务id>'}，禁止自己逐行生成 create_inbound_draft（行数多时容易漏行）。系统会自动从识别行展开入库明细，无需你重复生成。",
          "若识别结果里仍有校验失败的行（如 SKU 不存在），不能直接入库：先按上面的规则处理错误行（候选确认/关联/新建），全部行通过后再返回 create_inbound_draft_from_job。",
          "注意：不要编造用户没说过的新建信息；如果信息不足，先询问用户。",
        ].join("\n");
      }
    }
    const config = await this.aiConfig.resolve(user.organizationId);
    if (!config) throw new BadRequestException("尚未配置可用的 AI 模型");
    const historyContext = (history ?? []).slice(-12).map((item) => `${item.role === "user" ? "用户" : "助手"}：${String(item.text ?? "").slice(0, 500)}`).join("\n");
    const lowStockItems = inventory.filter((item) => item.minStock > 0 && item.available <= item.minStock).slice(0, 30);
    const lowStockContext = lowStockItems.length ? `\n低库存预警（可用库存 ≤ 预警值 minStock，共 ${lowStockItems.length} 项，最多列出 30 项）：\n${lowStockItems.map((item) => `- ${item.styleNo} ${item.name} ${item.color}/${item.size}：可用 ${item.available}，预警值 ${item.minStock}`).join("\n")}` : "";
    const prompt = [
      "你是仓库系统内的中文 AI 助手。只根据下方权限和库存数据回答，不得虚构。",
      `权限：查看库存=${canViewInventory ? "是" : "否"}；创建草稿=${canCreateDraft ? "是" : "否"}（入库/出库草稿共用此权限）；新建商品=${canManageCatalog ? "是" : "否"}。`,
      "若用户查询库存，返回 JSON：{reply:string,action:null}。",
      "若用户要求增加/入库库存，只有创建草稿权限时，返回 JSON：{reply:string,action:{type:'create_inbound_draft',lines:[{skuId,quantity}]}}。必须使用库存数据中的 skuId，quantity 为正整数。",
      "若用户要求减少/出库库存（例如“出库 5 件”“发 20 件给客户”“调出 X 件”），只有创建草稿权限时，返回 JSON：{reply:string,action:{type:'create_outbound_draft',lines:[{skuId,quantity}]}}。出库数量不能超过该 SKU 的可用库存（available），若超出要提示用户可用库存不足并给出最大可出库数量。",
      "权限以这行声明为准：\"新建商品=是\" 表示用户拥有 catalog.manage 权限，可直接新建商品；\"新建商品=否\" 才需要拒绝。不要臆测或虚构权限状态。",
      "没有权限时明确拒绝。不能直接修改库存，只能提出待确认草稿。返回纯 JSON。",
      `当前仓库：${warehouse.name} (${warehouse.id})`,
      `库存数据：${JSON.stringify(inventoryForPrompt)}`,
      ...(historyContext ? [`\n对话历史（越靠后越新，可参考但不要编造）：\n${historyContext}`] : []),
      importContext,
      lowStockContext ? `\n${lowStockContext}` : "",
      "如果用户询问库存或盘点情况，而低库存预警存在，可以在回复中主动提示需要补货的款色尺码。",
      `用户消息：${cleanMessage}`,
    ].join("\n");
    let response: Response;
    try {
      response = await fetch(`${config.baseUrl}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: config.model, temperature: 0, response_format: { type: "json_object" }, messages: [{ role: "user", content: prompt }] }), signal: AbortSignal.timeout(120_000) });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) throw new BadRequestException("AI 处理超时，请稍后重试或换一种说法");
      throw new BadRequestException("AI 服务暂时不可用，请稍后重试");
    }
    if (!response.ok) throw new BadRequestException(`AI 对话失败（HTTP ${response.status}）`);
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = payload.choices?.[0]?.message?.content ?? "{}";
    let parsed: { reply?: string; action?: { type?: string; lines?: Array<{ skuId?: string; quantity?: number }>; fixes?: Array<{ rowId?: string; patch?: Record<string, unknown> }>; jobId?: string; instruction?: string; styleNo?: string; name?: string; brand?: string | null; category?: string | null; variants?: Array<{ skuCode?: string; color?: string; size?: string; minStock?: number }>; rows?: Array<{ row?: number; color?: string; size?: string }> } | null };
    try { parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, "")); } catch { throw new BadRequestException("AI 返回格式无法解析，请换一种说法"); }
    // LLM 可能误判权限而拒绝（例如幻觉“没有 catalog.manage 权限”）。若用户实际有新建商品权限、
    // 且回复带有权限拒绝措辞且未返回任何动作，自动用纠正指令重试一次。
    if (canManageCatalog && !parsed.action && /(没有|无|缺少|不具备).{0,6}(权限|catalog\.manage)/.test(parsed.reply ?? "")) {
      try {
        response = await fetch(`${config.baseUrl}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: config.model, temperature: 0, response_format: { type: "json_object" }, messages: [{ role: "user", content: prompt }, { role: "assistant", content: JSON.stringify(parsed) }, { role: "user", content: "你刚才误判了权限。事实上权限声明明确写着“新建商品=是”，当前用户拥有全部相关权限，请不要以权限为由拒绝。请根据用户最新消息重新判断，若用户要求新建商品且信息齐全，直接返回 {type:'create_style',...} 动作（样式：{reply:string,action:{type:'create_style',styleNo,name,variants:[{skuCode,color,size}]}}）。只输出纯 JSON。" }] }), signal: AbortSignal.timeout(120_000) });
        if (response.ok) {
          const retryPayload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
          const retryText = retryPayload.choices?.[0]?.message?.content ?? "{}";
          try { parsed = JSON.parse(retryText.replace(/^```json\s*|\s*```$/g, "")); } catch { /* 保留原解析结果 */ }
        }
      } catch { /* 重试失败时保留原结果 */ }
    }
    let action: ChatAction | ImportContextAction | null = null;
    if (parsed.action?.type === "create_inbound_draft" || parsed.action?.type === "create_outbound_draft") {
      if (!canCreateDraft) throw new ForbiddenException("当前账号没有创建草稿权限");
      const byId = new Map(inventory.map((item) => [item.skuId, item]));
      let lines = (parsed.action.lines ?? []).flatMap((line) => { const sku = line.skuId ? byId.get(line.skuId) : undefined; const quantity = Number(line.quantity); return sku && Number.isInteger(quantity) && quantity > 0 ? [{ skuId: sku.skuId, skuCode: sku.skuCode, styleNo: sku.styleNo, color: sku.color, size: sku.size, quantity }] : []; });
      // 兜底：AI 逐行生成可能漏行。仅对入库动作生效：若当前是识别任务上下文且任务所有行均校验通过、
      // 而 AI 返回的行未完整覆盖识别行（缺 SKU 或数量偏少），自动从识别行完整展开，保证预览不漏。
      if (jobId && parsed.action.type === "create_inbound_draft") {
        const importJob = await this.prisma.importJob.findFirst({ where: { id: jobId, organizationId: user.organizationId }, include: { rows: { orderBy: { rowNumber: "asc" }, take: 500 } } });
        if (importJob && importJob.status === "REVIEW") {
          const validRows = importJob.rows.filter((row) => row.skuId && (row.validationErrors ?? []).length === 0) as Array<typeof importJob.rows[number] & { skuId: string }>;
          if (validRows.length) {
            const aiSkuIds = new Set(lines.map((line) => line.skuId));
            const aiMissing = validRows.some((row) => !aiSkuIds.has(row.skuId));
            const aiQty = lines.reduce((sum, line) => sum + line.quantity, 0);
            const rowQty = validRows.reduce((sum, row) => sum + Number((row.normalized as Record<string, unknown>).quantity ?? (row.normalized as Record<string, unknown>).countedPieces ?? 0), 0);
            if (aiMissing || aiQty < rowQty) {
              const fullLines = validRows.flatMap((row) => {
                const sku = byId.get(row.skuId);
                const data = row.normalized as Record<string, unknown>;
                const quantity = Number(data.quantity ?? data.countedPieces);
                return sku && Number.isInteger(quantity) && quantity > 0 ? [{ skuId: sku.skuId, skuCode: sku.skuCode, styleNo: sku.styleNo, color: sku.color, size: sku.size, quantity }] : [];
              });
              if (fullLines.length >= validRows.length) {
                lines = fullLines;
                parsed.reply = `${parsed.reply ?? ""}（已按识别结果完整展开 ${fullLines.length} 行入库明细，AI 原返回有缺漏已修正）`;
              }
            }
          }
        }
      }
      if (lines.length) action = { type: parsed.action.type, warehouseId: warehouse.id, lines };
    } else if (parsed.action?.type === "reanalyze_import") {
      const targetJobId = jobId || parsed.action.jobId;
      if (!targetJobId) throw new BadRequestException("缺少导入任务 ID，无法重新识别");
      action = { type: "reanalyze_import", jobId: targetJobId, instruction: typeof parsed.action.instruction === "string" && parsed.action.instruction.trim() ? parsed.action.instruction.trim().slice(0, 500) : undefined };
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
    } else if (parsed.action?.type === "map_rows_to_style") {
      const targetJobId = jobId || parsed.action.jobId;
      if (!targetJobId) throw new BadRequestException("缺少导入任务 ID，无法关联商品");
      const styleNo = String(parsed.action.styleNo ?? "").trim();
      const rows = (parsed.action.rows ?? []).flatMap((r) => {
        const row = Number(r?.row);
        const color = r?.color !== undefined && r?.color !== null && String(r.color).trim() ? String(r.color).trim() : undefined;
        const size = r?.size !== undefined && r?.size !== null && String(r.size).trim() ? String(r.size).trim() : undefined;
        return Number.isInteger(row) && row > 0 ? [{ row, color, size }] : [];
      });
      if (styleNo && rows.length) action = { type: "map_rows_to_style", jobId: targetJobId, styleNo, name: parsed.action.name ?? null, rows };
    } else if (parsed.action?.type === "create_inbound_draft_from_job") {
      if (!canCreateDraft) throw new ForbiddenException("当前账号没有创建入库草稿权限");
      const targetJobId = jobId || parsed.action.jobId;
      if (!targetJobId) throw new BadRequestException("缺少导入任务 ID，无法生成入库方案");
      const importJob = await this.prisma.importJob.findFirst({ where: { id: targetJobId, organizationId: user.organizationId }, include: { rows: { orderBy: { rowNumber: "asc" }, take: 500 } } });
      if (!importJob) throw new NotFoundException("导入任务不存在");
      if (importJob.status !== "REVIEW") throw new BadRequestException("任务不是待确认状态，无法生成入库方案");
      const byId = new Map(inventory.map((item) => [item.skuId, item]));
      const lines = importJob.rows.flatMap((row) => {
        if (!row.skuId || (row.validationErrors ?? []).length) return [];
        const data = row.normalized as Record<string, unknown>;
        const quantity = Number(data.quantity ?? data.countedPieces);
        if (!Number.isInteger(quantity) || quantity <= 0) return [];
        const sku = byId.get(row.skuId);
        return [{ skuId: row.skuId, skuCode: sku?.skuCode ?? String(data.skuCode ?? ""), styleNo: sku?.styleNo ?? String(data.styleNo ?? ""), color: sku?.color ?? String(data.color ?? ""), size: sku?.size ?? String(data.size ?? ""), quantity }];
      });
      if (!lines.length) throw new BadRequestException("识别结果中没有可通过校验的行，无法生成入库方案");
      action = { type: "create_inbound_draft", warehouseId: importJob.warehouseId ?? warehouse.id, lines };
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
    if (!hasPermission(user, "documents.manage")) throw new ForbiddenException("当前账号没有创建草稿权限");
    if (!["create_inbound_draft", "create_outbound_draft"].includes(action.type) || !Array.isArray(action.lines) || !action.lines.length) throw new BadRequestException("草稿提案无效");
    const type = action.type === "create_outbound_draft" ? "OUTBOUND" : "INBOUND";
    const preview = await this.workflow.previewMovement(user, { warehouseId: action.warehouseId, type, sourceRef: "AI-CONVERSATION", reason: `对话式 AI 创建的待确认${type === "OUTBOUND" ? "出库" : "入库"}草稿`, lines: action.lines.map((line) => ({ skuId: line.skuId, stockStatus: "SELLABLE", quantity: Number(line.quantity) })) });
    return { action, previewToken: preview.previewToken, rows: preview.rows, totals: preview.totals, valid: preview.valid, expiresAt: preview.expiresAt } satisfies ChatPreview;
  }

  async confirmDraft(user: AuthUser, preview: ChatPreview, request: Request) {
    if (!hasPermission(user, "documents.manage")) throw new ForbiddenException("当前账号没有创建草稿权限");
    if (!preview?.previewToken || !preview.action) throw new BadRequestException("缺少有效的预览结果");
    return this.workflow.createDraftFromPreview(user, preview.previewToken, `ai-chat-${randomUUID()}`, request, preview.action.type === "create_outbound_draft" ? "OUTBOUND" : "INBOUND");
  }

  // 结合原图重新识别：读取导入任务源文件，把用户指出的问题作为提示传给视觉模型重新识别，
  // 用新识别结果替换旧行并重新匹配 SKU、重新校验。
  async reanalyzeImport(user: AuthUser, jobId: string, instruction: string | undefined, request: Request) {
    if (!hasPermission(user, "imports.manage")) throw new ForbiddenException("当前账号没有导入管理权限");
    const job = await this.prisma.importJob.findFirst({ where: { id: jobId, organizationId: user.organizationId } });
    if (!job) throw new NotFoundException("导入任务不存在");
    if (job.status !== "REVIEW") throw new BadRequestException("任务不是待确认状态，无法重新识别");
    if (!job.objectKey || job.expiresAt <= new Date()) throw new BadRequestException("源文件已过期，无法重新识别");
    if (!["image/jpeg", "image/jpg", "image/png", "image/webp", "application/pdf"].includes(job.mimeType)) throw new BadRequestException("仅图片或 PDF 识别任务支持结合原图重新识别");
    const buffer = await this.storage.get(job.objectKey);
    const rows = await this.ai.extractDocument(user.organizationId, buffer, job.mimeType, job.kind as ImportKind, instruction);
    rows.sort(compareWarehouseRows);
    await this.prisma.$transaction([
      this.prisma.importRow.deleteMany({ where: { importJobId: job.id } }),
      this.prisma.importJob.update({ where: { id: job.id }, data: { status: "PROCESSING", progress: 50, error: null } }),
    ]);
    try {
      const { skuCodeMap, variantMap, nameVariantMap } = await this.loadSkuMaps(user.organizationId, job.warehouseId ?? "");
      for (let index = 0; index < rows.length; index += 500) {
        const batch = rows.slice(index, index + 500);
        const created: Array<{ rowNumber: number; skuId: string | null; validationErrors: string[]; confidence: number; normalized: Record<string, unknown>; raw: Record<string, unknown> }> = [];
        for (let offset = 0; offset < batch.length; offset += 1) {
          const row = batch[offset];
          const normalized = { ...row.normalized };
          delete normalized.skuId;
          const { skuId, errors } = await this.validateAndMatchRow(job.kind, normalized, skuCodeMap, variantMap, nameVariantMap);
          created.push({ rowNumber: index + offset + 1, skuId, validationErrors: errors, confidence: row.confidence, normalized: { ...normalized, skuId }, raw: row.raw });
        }
        await this.prisma.importRow.createMany({
          data: created.map((row) => ({ importJobId: job.id, rowNumber: row.rowNumber, raw: json(row.raw), normalized: json(row.normalized), confidence: row.confidence, validationErrors: row.validationErrors, skuId: row.skuId })),
        });
      }
      await this.prisma.$transaction([
        this.prisma.importJob.update({ where: { id: job.id }, data: { status: "REVIEW", progress: 100 } }),
        this.prisma.auditEvent.create({ data: { organizationId: user.organizationId, actorId: user.id, action: "import.reanalyzed_by_ai", entityType: "ImportJob", entityId: job.id, after: json({ rowCount: rows.length, instruction: instruction ?? null }), ip: request.ip } }),
      ]);
    } catch (error) {
      // 重识别中途失败：恢复待确认状态，允许用户再次发起重识别，避免任务卡死。
      await this.prisma.importJob.update({ where: { id: job.id }, data: { status: "REVIEW", progress: 100, error: error instanceof Error ? error.message : "重新识别失败" } }).catch(() => undefined);
      throw error;
    }
    return this.prisma.importJob.findUnique({ where: { id: job.id }, include: { rows: { orderBy: { rowNumber: "asc" }, take: 5000, include: { sku: { include: { style: true } } } } } });
  }

  private normalizeKey(value: unknown): string {
    return String(value ?? "").toLowerCase().replace(/[\s\-_/\\()（）\[\]【】.·:：,，;；+]+/g, "");
  }

  private levenshtein(a: string, b: string): number {
    if (a === b) return 0;
    const m = a.length;
    const n = b.length;
    if (!m) return n;
    if (!n) return m;
    const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
    }
    return dp[m][n];
  }

  // 相似商品候选：用于“SKU 不存在”时向用户确认是否为同一商品。
  // 按款号/名称的精确、包含、编辑距离给分，返回最多 3 个候选款，每个款列出已有颜色/尺码规格。
  private findSimilarCandidates(row: Record<string, unknown>, inventory: Array<{ styleNo: string; name: string; color: string; size: string }>): Array<{ styleNo: string; name: string; specs: string[]; score: number }> {
    const normStyle = this.normalizeKey(row.styleNo);
    const normName = this.normalizeKey(row.name ?? row.styleNo);
    if (!normStyle && !normName) return [];
    const styleMap = new Map<string, { styleNo: string; name: string; specs: Set<string>; score: number }>();
    for (const item of inventory) {
      const s = this.normalizeKey(item.styleNo);
      const nm = this.normalizeKey(item.name);
      if (!s && !nm) continue;
      let score = 0;
      if (normStyle && s && normStyle === s) score = 100;
      else if (normName && nm && normName === nm) score = 90;
      else if (normStyle && s && (normStyle.includes(s) || s.includes(normStyle))) score = 60;
      else if (normName && nm && (normName.includes(nm) || nm.includes(normName))) score = 50;
      else if (normStyle && s && normStyle.length >= 4 && this.levenshtein(normStyle, s) <= 2) score = 45;
      if (!score) continue;
      const key = `${item.styleNo}\u0000${item.name ?? ""}`;
      let entry = styleMap.get(key);
      if (!entry) { entry = { styleNo: item.styleNo, name: item.name, specs: new Set(), score: 0 }; styleMap.set(key, entry); }
      if (score > entry.score) entry.score = score;
      const spec = [item.color, item.size].filter(Boolean).join("/");
      if (spec) entry.specs.add(spec);
    }
    return [...styleMap.values()].map((entry) => ({ styleNo: entry.styleNo, name: entry.name, specs: [...entry.specs].slice(0, 6), score: entry.score })).sort((a, b) => b.score - a.score).slice(0, 3);
  }

  private async loadSkuMaps(organizationId: string, warehouseId: string) {
    const skus = await this.prisma.sku.findMany({ where: { active: true, style: { organizationId } }, include: { style: true } });
    const skuCodeMap = new Map<string, string>();
    const variantMap = new Map<string, string>();
    // 识别行里"款号"字段可能是商品名称（如"德绒男士内衣"），新建商品时用户可能另起款号；
    // 因此额外提供按名称+颜色+尺码的兜底映射，保证对话新建后能自动重匹配。
    const nameVariantMap = new Map<string, string>();
    for (const sku of skus) {
      skuCodeMap.set(sku.skuCode.trim().toLowerCase(), sku.id);
      variantMap.set(`${sku.style.styleNo.trim().toLowerCase()}\u0000${sku.color.trim().toLowerCase()}\u0000${sku.size.trim().toLowerCase()}`, sku.id);
      const styleName = (sku.style.name ?? "").trim().toLowerCase();
      if (styleName) nameVariantMap.set(`${styleName}\u0000${sku.color.trim().toLowerCase()}\u0000${sku.size.trim().toLowerCase()}`, sku.id);
    }
    return { skuCodeMap, variantMap, nameVariantMap };
  }

  private async validateAndMatchRow(kind: string, normalized: Record<string, unknown>, skuCodeMap: Map<string, string>, variantMap: Map<string, string>, nameVariantMap: Map<string, string> = new Map()) {
    const errors: string[] = [];
    const skuCode = String(normalized.skuCode ?? "").trim().toLowerCase();
    const styleNoNorm = String(normalized.styleNo ?? "").trim().toLowerCase();
    const colorNorm = String(normalized.color ?? "").trim().toLowerCase();
    const sizeNorm = String(normalized.size ?? "").trim().toLowerCase();
    const nameNorm = String(normalized.name ?? normalized.styleNo ?? "").trim().toLowerCase();
    const variantKey = `${styleNoNorm}\u0000${colorNorm}\u0000${sizeNorm}`;
    const nameVariantKey = `${nameNorm}\u0000${colorNorm}\u0000${sizeNorm}`;
    const skuId = (skuCodeMap.get(skuCode) ?? variantMap.get(variantKey) ?? nameVariantMap.get(nameVariantKey)) ?? null;
    // 兜底：颜色前导零差异（如 02 vs 2）归一化后再匹配一次，兼容常见录入差异
    let fallbackSkuId: string | null = skuId;
    if (!fallbackSkuId && colorNorm && /^0+\d+$/.test(colorNorm)) {
      const colorNoZero = colorNorm.replace(/^0+(?=\d)/, "");
      fallbackSkuId = variantMap.get(`${styleNoNorm}\u0000${colorNoZero}\u0000${sizeNorm}`) ?? nameVariantMap.get(`${nameNorm}\u0000${colorNoZero}\u0000${sizeNorm}`) ?? null;
    }
    const quantity = Number(normalized.quantity ?? normalized.countedPieces);
    if (kind !== "CATALOG" && !skuCode && !(normalized.styleNo && normalized.color && normalized.size)) errors.push("缺少 SKU 编码或款号/颜色/尺码");
    if (kind === "CATALOG" && (!normalized.styleNo || !normalized.color || !normalized.size)) errors.push("商品资料缺少款号、颜色或尺码");
    if (kind !== "CATALOG" && (!Number.isInteger(quantity) || quantity <= 0)) errors.push("数量必须为正整数");
    if (kind !== "CATALOG" && !fallbackSkuId) errors.push("SKU 不存在");
    return { skuId: fallbackSkuId as string | null, errors };
  }

  async applyImportFix(user: AuthUser, jobId: string, fixes: Array<{ rowId: string; patch: Record<string, string | number> }>, request: Request) {
    if (!hasPermission(user, "imports.manage")) throw new ForbiddenException("当前账号没有导入管理权限");
    const job = await this.prisma.importJob.findFirst({ where: { id: jobId, organizationId: user.organizationId }, include: { rows: true } });
    if (!job) throw new NotFoundException("导入任务不存在");
    if (job.status !== "REVIEW") throw new BadRequestException("任务不是待确认状态，无法修正");
    const { skuCodeMap, variantMap, nameVariantMap } = await this.loadSkuMaps(user.organizationId, job.warehouseId ?? "");
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
      const { skuId, errors } = await this.validateAndMatchRow(job.kind, normalized, skuCodeMap, variantMap, nameVariantMap);
      updates.push({ row, normalized, skuId, errors });
    }
    await this.prisma.$transaction([
      ...updates.map((update) => this.prisma.importRow.update({ where: { id: update.row.id }, data: { normalized: json(update.normalized), skuId: update.skuId, validationErrors: update.errors, confidence: Math.min(update.row.confidence, 0.9), accepted: false } })),
      this.prisma.auditEvent.create({ data: { organizationId: user.organizationId, actorId: user.id, action: "import.rows_fixed_by_ai", entityType: "ImportJob", entityId: job.id, after: json({ rowCount: updates.length, fixes: fixes.map((fix) => ({ rowId: fix.rowId, patch: fix.patch })) }), ip: request.ip } }),
    ]);
    return this.prisma.importJob.findUnique({ where: { id: job.id }, include: { rows: { orderBy: { rowNumber: "asc" } } } });
  }

  async applyMapRowsToStyle(user: AuthUser, action: MapRowsToStyleAction, request: Request) {
    if (!hasPermission(user, "imports.manage")) throw new ForbiddenException("当前账号没有导入管理权限");
    const job = await this.prisma.importJob.findFirst({ where: { id: action.jobId, organizationId: user.organizationId }, include: { rows: true } });
    if (!job) throw new NotFoundException("导入任务不存在");
    if (job.status !== "REVIEW") throw new BadRequestException("任务不是待确认状态，无法关联商品");
    const style = await this.prisma.productStyle.findFirst({ where: { organizationId: user.organizationId, styleNo: action.styleNo } });
    if (!style) throw new NotFoundException(`库中不存在款号 ${action.styleNo}，请先新建商品或检查款号`);
    const rowsByNumber = new Map(job.rows.map((row) => [row.rowNumber, row]));
    const missing = action.rows.filter((target) => !rowsByNumber.has(target.row)).map((target) => target.row);
    if (missing.length) throw new BadRequestException(`以下行号不存在：${missing.join(", ")}`);
    const { skuCodeMap, variantMap, nameVariantMap } = await this.loadSkuMaps(user.organizationId, job.warehouseId ?? "");
    const updates: Array<{ row: typeof job.rows[number]; normalized: Record<string, unknown>; skuId: string | null; errors: string[] }> = [];
    for (const target of action.rows) {
      const row = rowsByNumber.get(target.row)!;
      const normalized = { ...(row.normalized as Record<string, unknown>) };
      normalized.styleNo = action.styleNo;
      if (action.name) normalized.name = action.name;
      if (target.color !== undefined) normalized.color = target.color;
      if (target.size !== undefined) normalized.size = target.size;
      delete normalized.skuId;
      const { skuId, errors } = await this.validateAndMatchRow(job.kind, normalized, skuCodeMap, variantMap, nameVariantMap);
      updates.push({ row, normalized, skuId, errors });
    }
    await this.prisma.$transaction([
      ...updates.map((update) => this.prisma.importRow.update({ where: { id: update.row.id }, data: { normalized: json(update.normalized), skuId: update.skuId, validationErrors: update.errors, confidence: Math.min(update.row.confidence, 0.9), accepted: false } })),
      this.prisma.auditEvent.create({ data: { organizationId: user.organizationId, actorId: user.id, action: "import.rows_mapped_to_style", entityType: "ImportJob", entityId: job.id, after: json({ styleNo: action.styleNo, rowCount: updates.length, rows: action.rows }), ip: request.ip } }),
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
        const { skuCodeMap, variantMap, nameVariantMap } = await this.loadSkuMaps(user.organizationId, importJob.warehouseId ?? "");
        const updates: Array<{ id: string; skuId: string | null; errors: string[] }> = [];
        for (const row of importJob.rows) {
          const normalized = row.normalized as Record<string, unknown>;
          const { skuId, errors } = await this.validateAndMatchRow(importJob.kind, { ...normalized }, skuCodeMap, variantMap, nameVariantMap);
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
  @Post() chat(@CurrentUser() user: AuthUser, @Body() body: { message?: string; jobId?: string; history?: Array<{ role?: string; text?: string }> }) { return this.service.chat(user, body.message ?? "", body.jobId, (body.history ?? []).flatMap((item) => (item.role === "user" || item.role === "assistant") && typeof item.text === "string" ? [{ role: item.role, text: item.text }] : [])); }
  @Post("preview") preview(@CurrentUser() user: AuthUser, @Body() body: { action?: ChatAction }) { return this.service.previewAction(user, body.action as ChatAction); }
  @Post("confirm-draft") confirm(@CurrentUser() user: AuthUser, @Body() body: { preview?: ChatPreview }, @Req() request: Request) { return this.service.confirmDraft(user, body.preview as ChatPreview, request); }
  @Post("reanalyze-import") reanalyze(@CurrentUser() user: AuthUser, @Body() body: { jobId?: string; instruction?: string }, @Req() request: Request) { return this.service.reanalyzeImport(user, String(body.jobId ?? ""), typeof body.instruction === "string" ? body.instruction : undefined, request); }
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
  @Post("map-rows-to-style") mapRowsToStyle(@CurrentUser() user: AuthUser, @Body() body: { jobId?: string; styleNo?: string; name?: string | null; rows?: Array<{ row?: number; color?: string; size?: string }> }, @Req() request: Request) {
    const styleNo = String(body.styleNo ?? "").trim();
    const rows = (body.rows ?? []).flatMap((r) => {
      const row = Number(r?.row);
      const color = r?.color?.trim() || undefined;
      const size = r?.size?.trim() || undefined;
      return Number.isInteger(row) && row > 0 ? [{ row, color, size }] : [];
    });
    if (!body.jobId || !styleNo || !rows.length) throw new BadRequestException("缺少导入任务 ID、款号或行号列表");
    return this.service.applyMapRowsToStyle(user, { type: "map_rows_to_style", jobId: body.jobId, styleNo, name: body.name ?? null, rows }, request);
  }
  @Post("create-style") createStyle(@CurrentUser() user: AuthUser, @Body() body: { styleNo?: string; name?: string; brand?: string | null; category?: string | null; variants?: Array<{ skuCode?: string; color?: string; size?: string; minStock?: number }>; matchJobId?: string }, @Req() request: Request) {
    const styleNo = String(body.styleNo ?? "").trim();
    const name = String(body.name ?? "").trim();
    const variants = (body.variants ?? []).flatMap((v) => { const skuCode = String(v.skuCode ?? "").trim(); const color = String(v.color ?? "").trim(); const size = String(v.size ?? "").trim(); return styleNo && skuCode && (color || size) ? [{ skuCode, color, size, minStock: Number.isFinite(Number(v.minStock)) ? Number(v.minStock) : undefined }] : []; });
    if (!styleNo || !name || !variants.length) throw new BadRequestException("商品信息不完整，需要款号、品名和至少一个规格");
    return this.service.createStyleFromChat(user, { type: "create_style", styleNo, name, brand: body.brand ?? null, category: body.category ?? null, variants, matchJobId: body.matchJobId }, request);
  }
}

@Module({ imports: [InventoryWorkflowModule, WarehouseModule, JobsModule], controllers: [AiChatController], providers: [AiChatService] })
export class AiChatModule {}
