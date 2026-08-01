import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import { Prisma, StockStatus } from "@prisma/client";
import {
  commitDocumentSchema,
  createDraftSchema,
  createRestoreSchema,
  movementPreviewSchema,
  restorePreviewSchema,
  updateDocumentSchema,
  versionSchema,
} from "@cangku/contracts";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Request, Response } from "express";
import * as XLSX from "xlsx";
import { z } from "zod";
import { AuthUser, CurrentUser, RequirePermissions } from "./auth-context";
import { InventoryPostingService, InventoryPostingModule } from "./inventory-posting.module";
import { PrismaService } from "./prisma.module";

type MovementData = z.infer<typeof movementPreviewSchema>;
type PreviewTokenPayload = {
  kind: "movement" | "restore";
  expiresAt: number;
  data: MovementData | { warehouseId: string; targetAt: string };
  versions: Record<string, number>;
};

function canonicalMovement(data: MovementData): MovementData {
  return {
    ...data,
    sourceRef: data.sourceRef || null,
    counterparty: data.counterparty || null,
    reason: data.reason || null,
    lines: [...data.lines]
      .map((line) => ({
        skuId: line.skuId,
        stockStatus: line.stockStatus ?? StockStatus.SELLABLE,
        quantity: line.quantity,
        note: line.note || null,
      }))
      .sort((left, right) => `${left.skuId}:${left.stockStatus}`.localeCompare(`${right.skuId}:${right.stockStatus}`)),
  };
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function balanceKey(skuId: string, stockStatus: StockStatus | string) {
  return `${skuId}:${stockStatus}`;
}

function documentNo(type: "INBOUND" | "OUTBOUND" | "RESTORE") {
  const prefix = type === "INBOUND" ? "RK" : type === "OUTBOUND" ? "CK" : "HF";
  return `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 6).toUpperCase()}`;
}

function parseAsOf(value: string) {
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T15:59:59.999Z` : value;
  const result = new Date(normalized);
  if (Number.isNaN(result.getTime())) throw new BadRequestException("历史时间格式无效");
  return result;
}

@Injectable()
export class InventoryWorkflowService {
  constructor(private readonly prisma: PrismaService, private readonly posting: InventoryPostingService) {}

  async createDraft(user: AuthUser, input: unknown, idempotencyKey: string | undefined, request: Request) {
    const parsed = createDraftSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const preview = await this.previewMovement(user, parsed.data);
    return this.createDraftFromPreview(user, preview.previewToken, idempotencyKey, request);
  }

  async createDraftFromPreview(user: AuthUser, previewToken: string, idempotencyKey: string | undefined, request: Request, expectedType?: "INBOUND" | "OUTBOUND") {
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
      throw new BadRequestException("创建草稿必须提供有效的 Idempotency-Key");
    }
    const existing = await this.prisma.stockDocument.findFirst({
      where: { organizationId: user.organizationId, idempotencyKey },
      include: { createdBy: { select: { id: true, name: true } }, postedBy: { select: { id: true, name: true } }, lines: { include: { sku: { include: { style: true } } } }, approvals: true },
    });
    if (existing) return existing;
    const token = this.verify(previewToken);
    if (token.kind !== "movement") throw new BadRequestException("预览令牌类型无效");
    const tokenData = canonicalMovement(token.data as MovementData);
    if (expectedType && tokenData.type !== expectedType) throw new BadRequestException("预览业务类型不匹配");
    const refreshedPreview = await this.previewMovement(user, tokenData);
    if (!refreshedPreview.valid) throw new ConflictException("预览已失效，请重新预览");
    const refreshedToken = this.verify(refreshedPreview.previewToken);
    const data = canonicalMovement(refreshedToken.data as MovementData);
    const document = await this.prisma.stockDocument.create({
      data: {
        organizationId: user.organizationId,
        warehouseId: data.warehouseId,
        documentNo: documentNo(data.type),
        type: data.type,
        sourceRef: data.sourceRef,
        counterparty: data.counterparty,
        reason: data.reason,
        createdById: user.id,
        idempotencyKey,
        lines: {
          create: data.lines.map((line) => ({
            skuId: line.skuId,
            stockStatus: line.stockStatus,
            loosePieces: line.quantity,
            quantityPieces: line.quantity,
            note: line.note,
          })),
        },
      },
      include: { createdBy: { select: { id: true, name: true } }, postedBy: { select: { id: true, name: true } }, lines: { include: { sku: { include: { style: true } } } }, approvals: true },
    });
    await this.audit(user, request, "document.draft_created", "StockDocument", document.id, null, document);
    return document;
  }

  async getDocument(user: AuthUser, id: string) {
    const document = await this.prisma.stockDocument.findFirst({
      where: { id, organizationId: user.organizationId },
      include: { createdBy: { select: { id: true, name: true } }, postedBy: { select: { id: true, name: true } }, lines: { include: { sku: { include: { style: true } } } }, approvals: true },
    });
    if (!document) throw new NotFoundException("货单不存在");
    return document;
  }

  async previewMovement(user: AuthUser, input: unknown) {
    const parsed = movementPreviewSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const warehouse = await this.assertWarehouse(user, parsed.data.warehouseId);
    const lines = this.posting.aggregateLines(parsed.data.lines).sort((left, right) => `${left.skuId}:${left.stockStatus ?? StockStatus.SELLABLE}`.localeCompare(`${right.skuId}:${right.stockStatus ?? StockStatus.SELLABLE}`));
    const skuIds = lines.map((line) => line.skuId);
    const skus = await this.prisma.sku.findMany({
      where: { id: { in: skuIds }, active: true, style: { organizationId: user.organizationId } },
      include: { style: true, balances: { where: { warehouseId: warehouse.id } } },
    });
    if (skus.length !== skuIds.length) throw new BadRequestException("货单包含不存在或已停用的商品规格");
    const skuMap = new Map(skus.map((sku) => [sku.id, sku]));
    const versions: Record<string, number> = {};
    const rows = lines.map((line) => {
      const sku = skuMap.get(line.skuId)!;
      const stockStatus = line.stockStatus ?? StockStatus.SELLABLE;
      const balance = sku.balances.find((item) => item.status === stockStatus);
      const currentOnHand = balance?.onHand ?? 0;
      const currentReserved = balance?.reserved ?? 0;
      const available = currentOnHand - currentReserved;
      const delta = parsed.data.type === "INBOUND" ? line.quantity : -line.quantity;
      const errors = parsed.data.type === "OUTBOUND" && available < line.quantity ? [`可用库存 ${available}，不足以出库 ${line.quantity} 件`] : [];
      const projectedOnHand = currentOnHand + delta;
      const projectedAvailable = projectedOnHand - currentReserved;
      const warnings = errors.length === 0 && projectedAvailable <= sku.minStock ? [`提交后可用库存 ${projectedAvailable}，不高于预警线 ${sku.minStock}`] : [];
      versions[balanceKey(line.skuId, stockStatus)] = balance?.version ?? 0;
      return {
        skuId: line.skuId,
        skuCode: sku.skuCode,
        styleNo: sku.style.styleNo,
        name: sku.style.name,
        color: sku.color,
        size: sku.size,
        stockStatus,
        quantity: line.quantity,
        note: line.note ?? null,
        currentOnHand,
        currentReserved,
        available,
        delta,
        projectedOnHand,
        errors,
        warnings,
      };
    });
    const normalized = canonicalMovement({
      ...parsed.data,
      sourceRef: parsed.data.sourceRef || null,
      counterparty: parsed.data.counterparty || null,
      lines: lines.map((line) => ({
        skuId: line.skuId,
        stockStatus: line.stockStatus ?? StockStatus.SELLABLE,
        quantity: line.quantity,
        note: line.note || null,
      })),
    });
    return {
      warehouse,
      type: normalized.type,
      rows,
      totals: {
        quantity: rows.reduce((sum, row) => sum + row.quantity, 0),
        delta: rows.reduce((sum, row) => sum + row.delta, 0),
      },
      valid: rows.every((row) => row.errors.length === 0),
      previewToken: this.sign({ kind: "movement", expiresAt: Date.now() + 10 * 60_000, data: normalized, versions }),
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    };
  }

  async template(user: AuthUser, input: unknown, response: Response) {
    const parsed = z.object({ warehouseId: z.string().cuid(), skuIds: z.array(z.string().cuid()).min(1).max(1000) }).safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const warehouse = await this.assertWarehouse(user, parsed.data.warehouseId);
    const skus = await this.prisma.sku.findMany({
      where: { id: { in: [...new Set(parsed.data.skuIds)] }, active: true, style: { organizationId: user.organizationId } },
      include: { style: true, balances: { where: { warehouseId: warehouse.id, status: StockStatus.SELLABLE } } },
      orderBy: [{ style: { styleNo: "asc" } }, { color: "asc" }, { size: "asc" }],
    });
    if (skus.length !== new Set(parsed.data.skuIds).size) throw new BadRequestException("模板包含不存在或已停用的商品规格");
    const sheet = XLSX.utils.aoa_to_sheet([
      ["SKU编码", "款号", "品名", "颜色", "尺码", "当前可用(参考)", "数量", "备注"],
      ...skus.map((sku) => [sku.skuCode, sku.style.styleNo, sku.style.name, sku.color, sku.size, (sku.balances[0]?.onHand ?? 0) - (sku.balances[0]?.reserved ?? 0), "", ""]),
    ]);
    sheet["!cols"] = [{ wch: 20 }, { wch: 16 }, { wch: 24 }, { wch: 14 }, { wch: 10 }, { wch: 18 }, { wch: 10 }, { wch: 28 }];
    const metadata = XLSX.utils.aoa_to_sheet([["templateVersion", "1"], ["warehouseId", warehouse.id], ["warehouseCode", warehouse.code], ["generatedAt", new Date().toISOString()]]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "货单填写");
    XLSX.utils.book_append_sheet(workbook, metadata, "系统信息");
    workbook.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 2 }] };
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    response.setHeader("Content-Disposition", `attachment; filename="goods-sheet-${warehouse.code.toLowerCase()}.xlsx"`);
    response.send(buffer);
  }

  async updateDraft(user: AuthUser, id: string, input: unknown, request: Request) {
    const parsed = updateDocumentSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    await this.assertWarehouse(user, parsed.data.warehouseId);
    const current = await this.prisma.stockDocument.findFirst({ where: { id, organizationId: user.organizationId }, include: { lines: true } });
    if (!current) throw new NotFoundException("货单不存在");
    if (current.status !== "DRAFT") throw new ConflictException("只有草稿货单可以修改");
    if (current.version !== parsed.data.version) throw new ConflictException("货单已被其他用户修改，请刷新后重试");
    const preview = await this.previewMovement(user, parsed.data);
    const normalized = this.verify(preview.previewToken);
    if (normalized.kind !== "movement") throw new BadRequestException("预览令牌无效");
    const data = canonicalMovement(normalized.data as MovementData);
    const updated = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.stockDocument.updateMany({
        where: { id, version: parsed.data.version, status: "DRAFT" },
        data: {
          warehouseId: data.warehouseId,
          type: data.type,
          ...(current.type !== data.type ? { documentNo: documentNo(data.type) } : {}),
          sourceRef: data.sourceRef,
          counterparty: data.counterparty,
          reason: data.reason,
          version: { increment: 1 },
        },
      });
      if (!changed.count) throw new ConflictException("货单已被其他用户修改");
      await tx.stockDocumentLine.deleteMany({ where: { documentId: id } });
      await tx.stockDocumentLine.createMany({
        data: data.lines.map((line) => ({ documentId: id, skuId: line.skuId, stockStatus: line.stockStatus, loosePieces: line.quantity, quantityPieces: line.quantity, note: line.note })),
      });
      return tx.stockDocument.findUniqueOrThrow({ where: { id }, include: { lines: true } });
    });
    await this.audit(user, request, "document.updated", "StockDocument", id, current, updated);
    return { document: updated, preview };
  }

  async commitDraft(user: AuthUser, id: string, input: unknown, postKey: string | undefined, request: Request) {
    const parsed = commitDocumentSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    if (!postKey || postKey.length < 8 || postKey.length > 200) throw new BadRequestException("提交货单必须提供有效的 Idempotency-Key");
    const token = this.verify(parsed.data.previewToken);
    if (token.kind !== "movement") throw new BadRequestException("预览令牌类型无效");
    const data = canonicalMovement(token.data as MovementData);
    const document = await this.prisma.stockDocument.findFirst({ where: { id, organizationId: user.organizationId }, include: { lines: true } });
    if (!document) throw new NotFoundException("货单不存在");
    const comparable = canonicalMovement({ warehouseId: document.warehouseId, type: document.type as "INBOUND" | "OUTBOUND", sourceRef: document.sourceRef || null, counterparty: document.counterparty || null, reason: document.reason || null, lines: document.lines.map((line) => ({ skuId: line.skuId, stockStatus: line.stockStatus, quantity: line.quantityPieces, note: line.note || null })) });
    if (JSON.stringify(comparable) !== JSON.stringify(data)) throw new ConflictException("货单内容与预览不一致，请重新预览");
    const committed = await this.posting.postExisting({ actor: user, documentId: id, expectedVersion: document.version, expectedBalanceVersions: token.versions, postKey, auditAction: "document.committed", ip: request.ip });
    await this.createLowStockNotifications(user.organizationId, document.warehouseId);
    return committed;
  }

  async cancelDocument(user: AuthUser, id: string, input: unknown, request: Request) {
    const parsed = versionSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const document = await this.prisma.stockDocument.findFirst({ where: { id, organizationId: user.organizationId }, include: { lines: { include: { sku: true } } } });
    if (!document) throw new NotFoundException("货单不存在");
    if (!["DRAFT", "CONFIRMED", "RESERVED"].includes(document.status)) throw new ConflictException("当前货单不能取消，已过账货单请使用冲销");
    if (document.version !== parsed.data.version) throw new ConflictException("货单已被修改，请刷新后重试");
    const updated = await this.prisma.$transaction(async (tx) => {
      if (document.status === "RESERVED") {
        for (const line of document.lines) {
          const balance = await tx.stockBalance.findUniqueOrThrow({ where: { warehouseId_skuId_status: { warehouseId: document.warehouseId, skuId: line.skuId, status: line.stockStatus } } });
          if (balance.reserved < line.quantityPieces) throw new ConflictException(`SKU ${line.sku.skuCode} 的预留库存已发生变化`);
          const balanceAfter = await tx.stockBalance.update({ where: { id: balance.id }, data: { reserved: { decrement: line.quantityPieces }, version: { increment: 1 } } });
          await tx.inventoryLedgerEntry.create({ data: { organizationId: user.organizationId, warehouseId: document.warehouseId, skuId: line.skuId, documentId: document.id, documentLineId: line.id, stockStatus: line.stockStatus, quantityDelta: 0, reservedDelta: -line.quantityPieces, balanceAfter: balanceAfter.onHand, reservedAfter: balanceAfter.reserved, actorId: user.id } });
        }
      }
      const changed = await tx.stockDocument.updateMany({ where: { id, version: parsed.data.version, status: document.status }, data: { status: "CANCELLED", version: { increment: 1 } } });
      if (!changed.count) throw new ConflictException("货单已被其他用户处理");
      return tx.stockDocument.findUniqueOrThrow({ where: { id }, include: { lines: true } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    await this.audit(user, request, "document.cancelled", "StockDocument", id, document, updated);
    return updated;
  }

  async inventoryAsOf(user: AuthUser, warehouseId: string, rawAt: string) {
    const warehouse = await this.assertWarehouse(user, warehouseId, false);
    const at = parseAsOf(rawAt);
    const values = await this.asOfMap(user.organizationId, warehouse.id, at);
    const skuIds = [...new Set([...values.values()].map((row) => row.skuId))];
    const skus = await this.prisma.sku.findMany({ where: { id: { in: skuIds }, style: { organizationId: user.organizationId } }, include: { style: true } });
    const skuMap = new Map(skus.map((sku) => [sku.id, sku]));
    return {
      warehouse,
      at: at.toISOString(),
      rows: [...values.values()].map((row) => ({ ...row, available: row.onHand - row.reserved, sku: skuMap.get(row.skuId) })).filter((row) => row.onHand !== 0 || row.reserved !== 0),
    };
  }

  async previewRestore(user: AuthUser, input: unknown) {
    const parsed = restorePreviewSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const warehouse = await this.assertWarehouse(user, parsed.data.warehouseId);
    const targetAt = parseAsOf(parsed.data.targetAt);
    if (targetAt >= new Date()) throw new BadRequestException("恢复目标时间必须早于当前时间");
    const target = await this.asOfMap(user.organizationId, warehouse.id, targetAt);
    const current = await this.prisma.stockBalance.findMany({ where: { warehouseId: warehouse.id }, include: { sku: { include: { style: true } } } });
    const currentMap = new Map(current.map((row) => [balanceKey(row.skuId, row.status), row]));
    const keys = new Set([...target.keys(), ...currentMap.keys()]);
    const versions: Record<string, number> = {};
    const rows = [...keys].map((key) => {
      const targetRow = target.get(key);
      const currentRow = currentMap.get(key);
      const targetOnHand = targetRow?.onHand ?? 0;
      const currentOnHand = currentRow?.onHand ?? 0;
      const currentReserved = currentRow?.reserved ?? 0;
      const delta = targetOnHand - currentOnHand;
      const conflicts = targetOnHand < currentReserved ? [`目标库存 ${targetOnHand} 小于当前预留 ${currentReserved}`] : [];
      versions[key] = currentRow?.version ?? 0;
      return {
        skuId: currentRow?.skuId ?? targetRow!.skuId,
        stockStatus: currentRow?.status ?? targetRow!.stockStatus,
        sku: currentRow?.sku,
        currentOnHand,
        currentReserved,
        targetOnHand,
        delta,
        conflicts,
      };
    }).filter((row) => row.delta !== 0 || row.conflicts.length > 0);
    const data = { warehouseId: warehouse.id, targetAt: targetAt.toISOString() };
    return {
      warehouse,
      targetAt: targetAt.toISOString(),
      rows,
      valid: rows.length > 0 && rows.every((row) => row.conflicts.length === 0),
      previewToken: this.sign({ kind: "restore", expiresAt: Date.now() + 10 * 60_000, data, versions }),
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    };
  }

  async createRestore(user: AuthUser, input: unknown, request: Request) {
    const parsed = createRestoreSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const token = this.verify(parsed.data.previewToken);
    if (token.kind !== "restore") throw new BadRequestException("恢复预览令牌类型无效");
    const tokenData = token.data as { warehouseId: string; targetAt: string };
    const targetAt = parseAsOf(parsed.data.targetAt);
    if (tokenData.warehouseId !== parsed.data.warehouseId || tokenData.targetAt !== targetAt.toISOString()) throw new ConflictException("恢复条件与预览不一致");
    await this.assertWarehouse(user, parsed.data.warehouseId);
    await this.assertVersions(parsed.data.warehouseId, token.versions);
    const preview = await this.previewRestore(user, { warehouseId: parsed.data.warehouseId, targetAt: targetAt.toISOString() });
    if (!preview.valid) throw new ConflictException("恢复预览已失效或存在冲突，请重新预览");
    const document = await this.prisma.stockDocument.create({
      data: {
        organizationId: user.organizationId,
        warehouseId: parsed.data.warehouseId,
        documentNo: documentNo("RESTORE"),
        type: "RESTORE",
        status: "PENDING_APPROVAL",
        reason: parsed.data.reason,
        restoreToAt: targetAt,
        createdById: user.id,
        lines: {
          create: preview.rows.filter((row) => row.delta !== 0).map((row) => ({
            skuId: row.skuId,
            stockStatus: row.stockStatus,
            quantityPieces: Math.abs(row.delta),
            adjustmentDelta: row.delta,
            reservedAdjustmentDelta: 0,
            snapshotQuantity: row.currentOnHand,
            restoreTargetOnHand: row.targetOnHand,
            restoreTargetReserved: row.currentReserved,
            note: `恢复至 ${targetAt.toISOString()}`,
          })),
        },
        approvals: { create: {} },
      },
      include: { lines: true, approvals: true },
    });
    await this.audit(user, request, "inventory.restore_requested", "StockDocument", document.id, null, document);
    const approvers = await this.prisma.user.findMany({ where: { organizationId: user.organizationId, id: { not: user.id }, status: "ACTIVE", OR: [{ role: { permissions: { has: "*" } } }, { role: { permissions: { has: "approvals.manage" } } }] }, select: { id: true } });
    if (approvers.length) await this.prisma.notification.createMany({ data: approvers.map((approver) => ({ organizationId: user.organizationId, userId: approver.id, type: "inventory.restore", title: "待审批库存恢复", message: `${document.documentNo} 请求恢复至 ${targetAt.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`, entityType: "StockDocument", entityId: document.id })) });
    return document;
  }

  private async asOfMap(organizationId: string, warehouseId: string, at: Date) {
    const grouped = await this.prisma.inventoryLedgerEntry.groupBy({
      by: ["skuId", "stockStatus"],
      where: { organizationId, warehouseId, createdAt: { lte: at } },
      _sum: { quantityDelta: true, reservedDelta: true },
    });
    return new Map(grouped.map((row) => [balanceKey(row.skuId, row.stockStatus), { skuId: row.skuId, stockStatus: row.stockStatus, onHand: row._sum.quantityDelta ?? 0, reserved: row._sum.reservedDelta ?? 0 }]));
  }

  private async assertWarehouse(user: AuthUser, warehouseId: string, requireActive = true) {
    const warehouse = await this.prisma.warehouse.findFirst({ where: { id: warehouseId, organizationId: user.organizationId, ...(requireActive ? { active: true } : {}) } });
    if (!warehouse) throw new BadRequestException(requireActive ? "仓库不存在或已停用" : "仓库不存在");
    return warehouse;
  }

  private async assertVersions(warehouseId: string, versions: Record<string, number>) {
    const balances = await this.prisma.stockBalance.findMany({ where: { warehouseId }, select: { skuId: true, status: true, version: true } });
    const current = new Map(balances.map((row) => [balanceKey(row.skuId, row.status), row.version]));
    for (const [key, expected] of Object.entries(versions)) {
      if ((current.get(key) ?? 0) !== expected) throw new ConflictException("预览后库存已发生变化，请重新预览");
    }
  }

  private async createLowStockNotifications(organizationId: string, warehouseId: string) {
    const balances = await this.prisma.stockBalance.findMany({ where: { warehouseId }, include: { sku: { include: { style: true } } } });
    const low = balances.filter((balance) => balance.onHand - balance.reserved <= balance.sku.minStock);
    if (!low.length) return;
    const users = await this.prisma.user.findMany({ where: { organizationId, status: "ACTIVE", role: { code: { in: ["OWNER", "MANAGER"] } } }, select: { id: true } });
    const existing = await this.prisma.notification.findMany({ where: { organizationId, type: "inventory.low", createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } }, select: { userId: true, entityId: true } });
    const seen = new Set(existing.map((item) => `${item.userId}:${item.entityId}`));
    const rows = users.flatMap((target) => low
      .filter((balance) => !seen.has(`${target.id}:${balance.skuId}`))
      .map((balance) => ({ organizationId, userId: target.id, type: "inventory.low", title: "库存低于预警线", message: `${balance.sku.style.styleNo} ${balance.sku.color}/${balance.sku.size} 可用 ${balance.onHand - balance.reserved} 件`, entityType: "Sku", entityId: balance.skuId })));
    if (rows.length) await this.prisma.notification.createMany({ data: rows });
  }

  private secret() {
    const configured = process.env.PREVIEW_TOKEN_SECRET;
    if (configured) return configured;
    if (process.env.NODE_ENV === "production") throw new Error("PREVIEW_TOKEN_SECRET is required in production");
    return "cangku-local-preview-token-secret";
  }

  private sign(payload: PreviewTokenPayload) {
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = createHmac("sha256", this.secret()).update(encoded).digest("base64url");
    return `${encoded}.${signature}`;
  }

  private verify(token: string): PreviewTokenPayload {
    const [encoded, provided] = token.split(".");
    if (!encoded || !provided) throw new BadRequestException("预览令牌无效");
    const expected = createHmac("sha256", this.secret()).update(encoded).digest("base64url");
    const left = Buffer.from(provided);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !timingSafeEqual(left, right)) throw new BadRequestException("预览令牌无效");
    let payload: PreviewTokenPayload;
    try {
      payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as PreviewTokenPayload;
    } catch {
      throw new BadRequestException("预览令牌无效");
    }
    if (payload.expiresAt <= Date.now()) throw new ConflictException("预览已过期，请重新预览");
    return payload;
  }

  private audit(user: AuthUser, request: Request, action: string, entityType: string, entityId: string, before: unknown, after: unknown) {
    return this.prisma.auditEvent.create({ data: { organizationId: user.organizationId, actorId: user.id, action, entityType, entityId, before: before == null ? Prisma.JsonNull : json(before), after: after == null ? Prisma.JsonNull : json(after), ip: request.ip } });
  }
}

@Controller("documents")
class DocumentWorkflowController {
  constructor(private readonly service: InventoryWorkflowService) {}

  @Post("drafts")
  @RequirePermissions("documents.manage")
  createDraft(@CurrentUser() user: AuthUser, @Body() input: unknown, @Headers("idempotency-key") key: string | undefined, @Req() request: Request) {
    return this.service.createDraft(user, input, key, request);
  }

  @Post("template")
  @RequirePermissions("documents.manage")
  template(@CurrentUser() user: AuthUser, @Body() input: unknown, @Res() response: Response) {
    return this.service.template(user, input, response);
  }

  @Post("preview")
  @RequirePermissions("documents.manage")
  preview(@CurrentUser() user: AuthUser, @Body() input: unknown) {
    return this.service.previewMovement(user, input);
  }

  @Get(":id")
  @RequirePermissions("inventory.view")
  get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.service.getDocument(user, id);
  }

  @Put(":id")
  @RequirePermissions("documents.manage")
  update(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() input: unknown, @Req() request: Request) {
    return this.service.updateDraft(user, id, input, request);
  }

  @Post(":id/commit")
  @RequirePermissions("documents.manage")
  commit(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() input: unknown, @Headers("idempotency-key") key: string | undefined, @Req() request: Request) {
    return this.service.commitDraft(user, id, input, key, request);
  }

  @Post(":id/cancel")
  @RequirePermissions("documents.manage")
  cancel(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() input: unknown, @Req() request: Request) {
    return this.service.cancelDocument(user, id, input, request);
  }
}

@Controller("inventory")
class InventoryHistoryController {
  constructor(private readonly service: InventoryWorkflowService) {}

  @Get("as-of")
  @RequirePermissions("inventory.view")
  asOf(@CurrentUser() user: AuthUser, @Query("warehouseId") warehouseId: string, @Query("at") at: string) {
    if (!warehouseId || !at) throw new BadRequestException("必须选择仓库和历史时间");
    return this.service.inventoryAsOf(user, warehouseId, at);
  }

  @Post("restores/preview")
  @RequirePermissions("inventory.restore")
  previewRestore(@CurrentUser() user: AuthUser, @Body() input: unknown) {
    return this.service.previewRestore(user, input);
  }

  @Post("restores")
  @RequirePermissions("inventory.restore")
  createRestore(@CurrentUser() user: AuthUser, @Body() input: unknown, @Req() request: Request) {
    return this.service.createRestore(user, input, request);
  }
}

@Module({
  imports: [InventoryPostingModule],
  controllers: [DocumentWorkflowController, InventoryHistoryController],
  providers: [InventoryWorkflowService],
  exports: [InventoryWorkflowService],
})
export class InventoryWorkflowModule {}
