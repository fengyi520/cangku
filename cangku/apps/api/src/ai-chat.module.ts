import { BadRequestException, Body, Controller, ForbiddenException, Injectable, Module, Post, Req } from "@nestjs/common";
import { Request } from "express";
import { randomUUID } from "node:crypto";
import { AiConfigService } from "./ai-config.module";
import { AuthUser, CurrentUser } from "./auth-context";
import { InventoryWorkflowModule, InventoryWorkflowService } from "./inventory-workflow.module";
import { PrismaService } from "./prisma.module";

function hasPermission(user: AuthUser, permission: string) {
  if (user.role.permissions.includes("*") || user.role.permissions.includes(permission)) return true;
  const [resource, action] = permission.split(".");
  return action === "view" && user.role.permissions.includes(`${resource}.manage`);
}

type ChatAction = { type: "create_inbound_draft"; warehouseId: string; lines: Array<{ skuId: string; skuCode: string; styleNo: string; color: string; size: string; quantity: number }> };
type ChatPreview = { action: ChatAction; previewToken: string; rows: Array<Record<string, unknown>>; totals: { quantity: number; delta: number }; valid: boolean; expiresAt: string };

@Injectable()
class AiChatService {
  constructor(private readonly prisma: PrismaService, private readonly aiConfig: AiConfigService, private readonly workflow: InventoryWorkflowService) {}

  async chat(user: AuthUser, message: string) {
    const cleanMessage = String(message ?? "").trim();
    if (!cleanMessage || cleanMessage.length > 2000) throw new BadRequestException("请输入 1 到 2000 字的消息");
    const canViewInventory = hasPermission(user, "inventory.view");
    const canCreateDraft = hasPermission(user, "documents.manage");
    const warehouse = await this.prisma.warehouse.findFirst({ where: { organizationId: user.organizationId, active: true }, orderBy: { createdAt: "asc" } });
    if (!warehouse) throw new BadRequestException("尚未配置可用仓库");
    const skus = canViewInventory ? await this.prisma.sku.findMany({ where: { active: true, style: { organizationId: user.organizationId } }, include: { style: true, balances: { where: { warehouseId: warehouse.id } } }, orderBy: [{ style: { styleNo: "asc" } }, { color: "asc" }, { size: "asc" }], take: 1000 }) : [];
    const inventory = skus.map((sku) => { const onHand = sku.balances.reduce((sum, item) => sum + item.onHand, 0); const reserved = sku.balances.reduce((sum, item) => sum + item.reserved, 0); return { skuId: sku.id, skuCode: sku.skuCode, styleNo: sku.style.styleNo, name: sku.style.name, color: sku.color, size: sku.size, onHand, reserved, available: onHand - reserved }; });
    const config = await this.aiConfig.resolve(user.organizationId);
    if (!config) throw new BadRequestException("尚未配置可用的 AI 模型");
    const prompt = [
      "你是仓库系统内的中文 AI 助手。只根据下方权限和库存数据回答，不得虚构。",
      `权限：查看库存=${canViewInventory}；创建入库草稿=${canCreateDraft}。`,
      "若用户查询库存，返回 JSON：{reply:string,action:null}。",
      "若用户要求增加/入库库存，只有创建草稿权限时，返回 JSON：{reply:string,action:{type:'create_inbound_draft',lines:[{skuId,quantity}]}}。必须使用库存数据中的 skuId，quantity 为正整数。",
      "没有权限时明确拒绝。不能直接修改库存，只能提出待确认草稿。返回纯 JSON。",
      `当前仓库：${warehouse.name} (${warehouse.id})`,
      `库存数据：${JSON.stringify(inventory)}`,
      `用户消息：${cleanMessage}`,
    ].join("\n");
    const response = await fetch(`${config.baseUrl}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: config.model, temperature: 0, response_format: { type: "json_object" }, messages: [{ role: "user", content: prompt }] }), signal: AbortSignal.timeout(40_000) });
    if (!response.ok) throw new BadRequestException(`AI 对话失败（HTTP ${response.status}）`);
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = payload.choices?.[0]?.message?.content ?? "{}";
    let parsed: { reply?: string; action?: { type?: string; lines?: Array<{ skuId?: string; quantity?: number }> } | null };
    try { parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, "")); } catch { throw new BadRequestException("AI 返回格式无法解析，请换一种说法"); }
    let action: ChatAction | null = null;
    if (parsed.action?.type === "create_inbound_draft") {
      if (!canCreateDraft) throw new ForbiddenException("当前账号没有创建入库草稿权限");
      const byId = new Map(inventory.map((item) => [item.skuId, item]));
      const lines = (parsed.action.lines ?? []).flatMap((line) => { const sku = line.skuId ? byId.get(line.skuId) : undefined; const quantity = Number(line.quantity); return sku && Number.isInteger(quantity) && quantity > 0 ? [{ skuId: sku.skuId, skuCode: sku.skuCode, styleNo: sku.styleNo, color: sku.color, size: sku.size, quantity }] : []; });
      if (lines.length) action = { type: "create_inbound_draft", warehouseId: warehouse.id, lines };
    }
    return { reply: parsed.reply || "已处理你的请求。", action, permissions: { canViewInventory, canCreateDraft } };
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
}

@Controller("ai/chat")
class AiChatController {
  constructor(private readonly service: AiChatService) {}
  @Post() chat(@CurrentUser() user: AuthUser, @Body() body: { message?: string }) { return this.service.chat(user, body.message ?? ""); }
  @Post("preview") preview(@CurrentUser() user: AuthUser, @Body() body: { action?: ChatAction }) { return this.service.previewAction(user, body.action as ChatAction); }
  @Post("confirm-draft") confirm(@CurrentUser() user: AuthUser, @Body() body: { preview?: ChatPreview }, @Req() request: Request) { return this.service.confirmDraft(user, body.preview as ChatPreview, request); }
}

@Module({ imports: [InventoryWorkflowModule], controllers: [AiChatController], providers: [AiChatService] })
export class AiChatModule {}
