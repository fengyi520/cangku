import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
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
} from "@nestjs/common";
import { DocumentStatus, DocumentType, Prisma, StockStatus } from "@prisma/client";
import { createDocumentSchema, createStyleSchema, updateStyleSchema, versionSchema } from "@cangku/contracts";
import { Request } from "express";
import { AuthUser, CurrentUser, RequirePermissions } from "./auth-context";
import { piecesFromPackaging, quantityDeltaForDocument } from "./inventory.math";
import { PrismaService } from "./prisma.module";

function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function documentPrefix(type: DocumentType) {
  return { INBOUND: "RK", OUTBOUND: "CK", RETURN: "TH", STOCKTAKE: "PD", ADJUSTMENT: "TZ", RESTORE: "HF" }[type];
}

function createDocumentNo(type: DocumentType) {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `${documentPrefix(type)}-${date}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

@Injectable()
export class WarehouseService {
  constructor(private readonly prisma: PrismaService) {}

  private async warehouse(organizationId: string, warehouseId?: string) {
    const warehouse = await this.prisma.warehouse.findFirst({ where: { organizationId, active: true, ...(warehouseId ? { id: warehouseId } : {}) }, orderBy: { createdAt: "asc" } });
    if (!warehouse) throw new BadRequestException("尚未配置可用仓库");
    return warehouse;
  }

  async dashboard(user: AuthUser) {
    const warehouse = await this.warehouse(user.organizationId);
    const [skuCount, balances, pendingApprovals, recentDocuments] = await Promise.all([
      this.prisma.sku.count({ where: { style: { organizationId: user.organizationId }, active: true } }),
      this.prisma.stockBalance.findMany({ where: { warehouseId: warehouse.id }, select: { onHand: true, reserved: true, sku: { select: { minStock: true } } } }),
      this.prisma.approvalTask.count({ where: { status: "PENDING", document: { organizationId: user.organizationId } } }),
      this.prisma.stockDocument.findMany({
        where: { organizationId: user.organizationId },
        include: { createdBy: { select: { name: true } }, _count: { select: { lines: true } } },
        orderBy: { createdAt: "desc" },
        take: 6,
      }),
    ]);
    const onHand = balances.reduce((sum, row) => sum + row.onHand, 0);
    const reserved = balances.reduce((sum, row) => sum + row.reserved, 0);
    const lowStock = balances.filter((row) => row.onHand - row.reserved <= row.sku.minStock).length;
    return { warehouse, metrics: { skuCount, onHand, reserved, available: onHand - reserved, lowStock, pendingApprovals }, recentDocuments };
  }

  async listStyles(user: AuthUser, search?: string) {
    return this.prisma.productStyle.findMany({
      where: {
        organizationId: user.organizationId,
        ...(search ? { OR: [{ styleNo: { contains: search, mode: "insensitive" } }, { name: { contains: search, mode: "insensitive" } }] } : {}),
      },
      include: { skus: { orderBy: [{ color: "asc" }, { size: "asc" }] } },
      orderBy: { updatedAt: "desc" },
      take: 200,
    });
  }

  async createStyle(user: AuthUser, input: unknown, request: Request) {
    const parsed = createStyleSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    try {
      const style = await this.prisma.productStyle.create({
        data: {
          organizationId: user.organizationId,
          styleNo: parsed.data.styleNo,
          name: parsed.data.name,
          brand: parsed.data.brand,
          category: parsed.data.category,
          season: parsed.data.season,
          year: parsed.data.year,
          attributes: parsed.data.attributes as Prisma.InputJsonValue,
          imageUrls: [],
          skus: { create: parsed.data.variants },
        },
        include: { skus: true },
      });
      await this.audit(user, request, "style.created", "ProductStyle", style.id, null, style);
      return style;
    } catch (error) {
      if (String(error).includes("Unique constraint")) throw new ConflictException("款号或 SKU 编码已存在");
      throw error;
    }
  }

  async updateStyle(user: AuthUser, id: string, input: unknown, request: Request) {
    const parsed = updateStyleSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const before = await this.prisma.productStyle.findFirst({
      where: { id, organizationId: user.organizationId },
      include: { skus: true },
    });
    if (!before) throw new NotFoundException("商品款式不存在");
    const existingIds = new Set(before.skus.map((sku) => sku.id));
    const submittedIds = parsed.data.variants.flatMap((variant) => (variant.id ? [variant.id] : []));
    if (submittedIds.some((skuId) => !existingIds.has(skuId))) throw new BadRequestException("商品规格不属于当前款式");
    const activeIds = new Set(parsed.data.activeSkuIds);
    if ([...activeIds].some((skuId) => !existingIds.has(skuId))) throw new BadRequestException("启用状态包含无效商品规格");
    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        await tx.productStyle.update({
          where: { id },
          data: { name: parsed.data.name, brand: parsed.data.brand, category: parsed.data.category },
        });
        const submittedExisting = new Set<string>();
        for (const variant of parsed.data.variants) if (variant.id) submittedExisting.add(variant.id);
        await tx.sku.updateMany({
          where: { styleId: id, id: { notIn: [...submittedExisting] } },
          data: { active: false },
        });
        for (const variant of parsed.data.variants) {
          if (variant.id) {
            await tx.sku.update({
              where: { id: variant.id },
              data: { skuCode: variant.skuCode, color: variant.color, size: variant.size, minStock: variant.minStock, active: activeIds.has(variant.id) },
            });
          } else {
            await tx.sku.create({ data: { styleId: id, skuCode: variant.skuCode, color: variant.color, size: variant.size, minStock: variant.minStock, active: true } });
          }
        }
        return tx.productStyle.findUniqueOrThrow({ where: { id }, include: { skus: { orderBy: [{ color: "asc" }, { size: "asc" }] } } });
      });
      await this.audit(user, request, "style.updated", "ProductStyle", id, before, updated);
      return updated;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new ConflictException("SKU 编码或颜色尺码组合已存在");
      throw error;
    }
  }

  async inventory(user: AuthUser, search?: string, warehouseId?: string) {
    const warehouse = await this.warehouse(user.organizationId, warehouseId);
    const skus = await this.prisma.sku.findMany({
      where: {
        active: true,
        style: { organizationId: user.organizationId },
        ...(search
          ? { OR: [{ skuCode: { contains: search, mode: "insensitive" } }, { style: { styleNo: { contains: search, mode: "insensitive" } } }, { style: { name: { contains: search, mode: "insensitive" } } }] }
          : {}),
      },
      include: { style: true, balances: { where: { warehouseId: warehouse.id } } },
      orderBy: [{ style: { styleNo: "asc" } }, { color: "asc" }, { size: "asc" }],
      take: 1000,
    });
    return skus.map((sku) => {
      const totals = sku.balances.reduce(
        (result, balance) => ({ onHand: result.onHand + balance.onHand, reserved: result.reserved + balance.reserved }),
        { onHand: 0, reserved: 0 },
      );
      return { ...sku, ...totals, available: totals.onHand - totals.reserved, lowStock: totals.onHand - totals.reserved <= sku.minStock };
    });
  }

  async ledger(user: AuthUser, cursor?: string) {
    return this.prisma.inventoryLedgerEntry.findMany({
      where: { organizationId: user.organizationId },
      include: { sku: { include: { style: true } }, document: { select: { documentNo: true, type: true, reason: true, sourceRef: true } }, actor: { select: { name: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 101,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  }

  async listDocuments(user: AuthUser, type?: DocumentType) {
    return this.prisma.stockDocument.findMany({
      where: { organizationId: user.organizationId, ...(type ? { type } : {}) },
      include: {
        createdBy: { select: { id: true, name: true } },
        postedBy: { select: { id: true, name: true } },
        lines: { include: { sku: { include: { style: true } } } },
        approvals: true,
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  }

  async createDocument(user: AuthUser, input: unknown, request: Request, idempotencyKey?: string) {
    const parsed = createDocumentSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    if (idempotencyKey) {
      const existing = await this.prisma.stockDocument.findUnique({ where: { idempotencyKey }, include: { lines: true } });
      if (existing) return existing;
    }
    if (parsed.data.type === "ADJUSTMENT" && !parsed.data.reason) throw new BadRequestException("库存调整必须填写原因");
    const warehouse = await this.warehouse(user.organizationId);
    const skuIds = [...new Set(parsed.data.lines.map((line) => line.skuId))];
    const validSkuCount = await this.prisma.sku.count({ where: { id: { in: skuIds }, style: { organizationId: user.organizationId } } });
    if (validSkuCount !== skuIds.length) throw new BadRequestException("单据包含不存在或无权访问的 SKU");

    const document = await this.prisma.$transaction(async (tx) => {
      const snapshots = new Map<string, number>();
      if (parsed.data.type === "STOCKTAKE") {
        const balances = await tx.stockBalance.findMany({ where: { warehouseId: warehouse.id, skuId: { in: skuIds } } });
        for (const balance of balances) snapshots.set(`${balance.skuId}:${balance.status}`, balance.onHand);
      }
      return tx.stockDocument.create({
        data: {
          organizationId: user.organizationId,
          warehouseId: warehouse.id,
          documentNo: createDocumentNo(parsed.data.type as DocumentType),
          type: parsed.data.type as DocumentType,
          sourceRef: parsed.data.sourceRef,
          counterparty: parsed.data.counterparty,
          reason: parsed.data.reason,
          createdById: user.id,
          idempotencyKey,
          lines: {
            create: parsed.data.lines.map((line) => ({
              skuId: line.skuId,
              stockStatus: line.stockStatus as StockStatus,
              cartons: line.cartons,
              piecesPerCarton: line.piecesPerCarton,
              loosePieces: line.loosePieces,
              quantityPieces: piecesFromPackaging(line.cartons, line.piecesPerCarton, line.loosePieces),
              snapshotQuantity: parsed.data.type === "STOCKTAKE" ? snapshots.get(`${line.skuId}:${line.stockStatus}`) ?? 0 : null,
              countedPieces: line.countedPieces,
              adjustmentDelta: line.adjustmentDelta,
              note: line.note,
            })),
          },
        },
        include: { lines: true },
      });
    });
    await this.audit(user, request, "document.created", "StockDocument", document.id, null, document);
    return document;
  }

  async confirmDocument(user: AuthUser, id: string, input: unknown, request: Request) {
    const parsed = versionSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const document = await this.getDocument(user, id);
    if (document.status !== "DRAFT") throw new ConflictException("只有草稿单据可以确认");
    const requiresApproval = ["STOCKTAKE", "ADJUSTMENT"].includes(document.type);
    const changed = await this.prisma.stockDocument.updateMany({
      where: { id, organizationId: user.organizationId, version: parsed.data.version, status: "DRAFT" },
      data: { status: requiresApproval ? "PENDING_APPROVAL" : "CONFIRMED", version: { increment: 1 } },
    });
    if (!changed.count) throw new ConflictException("单据已被其他用户修改，请刷新后重试");
    if (requiresApproval) {
      await this.prisma.approvalTask.create({ data: { documentId: id } });
      await this.notifyApprovers(user.organizationId, "待审批库存单据", `${document.documentNo} 需要另一名主管审批`, "StockDocument", id);
    }
    const updated = await this.getDocument(user, id);
    await this.audit(user, request, "document.confirmed", "StockDocument", id, document, updated);
    return updated;
  }

  async reserveDocument(user: AuthUser, id: string, input: unknown, request: Request) {
    const parsed = versionSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const document = await this.getDocument(user, id);
    if (document.type !== "OUTBOUND" || document.status !== "CONFIRMED") throw new ConflictException("只有已确认的出库单可以预留库存");
    if (document.version !== parsed.data.version) throw new ConflictException("单据版本已更新，请刷新后重试");
    await this.serializable(async (tx) => {
      for (const line of document.lines) {
        const balance = await tx.stockBalance.upsert({
          where: { warehouseId_skuId_status: { warehouseId: document.warehouseId, skuId: line.skuId, status: line.stockStatus } },
          create: { warehouseId: document.warehouseId, skuId: line.skuId, status: line.stockStatus },
          update: {},
        });
        if (balance.onHand - balance.reserved < line.quantityPieces) throw new ConflictException(`SKU ${line.sku.skuCode} 可用库存不足`);
        const updated = await tx.stockBalance.update({ where: { id: balance.id }, data: { reserved: { increment: line.quantityPieces }, version: { increment: 1 } } });
        await tx.inventoryLedgerEntry.create({
          data: {
            organizationId: user.organizationId,
            warehouseId: document.warehouseId,
            skuId: line.skuId,
            documentId: document.id,
            documentLineId: line.id,
            stockStatus: line.stockStatus,
            quantityDelta: 0,
            reservedDelta: line.quantityPieces,
            balanceAfter: updated.onHand,
            reservedAfter: updated.reserved,
            actorId: user.id,
          },
        });
      }
      const changed = await tx.stockDocument.updateMany({ where: { id, version: parsed.data.version, status: "CONFIRMED" }, data: { status: "RESERVED", version: { increment: 1 } } });
      if (!changed.count) throw new ConflictException("单据已被其他用户修改");
    });
    const updated = await this.getDocument(user, id);
    await this.audit(user, request, "document.reserved", "StockDocument", id, document, updated);
    return updated;
  }

  async postDocument(user: AuthUser, id: string, input: unknown, request: Request, postKey?: string) {
    const parsed = versionSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const document = await this.getDocument(user, id);
    if (document.status === "POSTED" && (!postKey || document.postKey === postKey)) return document;
    if (!["CONFIRMED", "RESERVED"].includes(document.status)) throw new ConflictException("单据尚未确认或审批通过");
    if (document.version !== parsed.data.version) throw new ConflictException("单据版本已更新，请刷新后重试");

    await this.serializable(async (tx) => {
      for (const line of document.lines) {
        const balance = await tx.stockBalance.upsert({
          where: { warehouseId_skuId_status: { warehouseId: document.warehouseId, skuId: line.skuId, status: line.stockStatus } },
          create: { warehouseId: document.warehouseId, skuId: line.skuId, status: line.stockStatus },
          update: {},
        });
        const delta = quantityDeltaForDocument({
          type: document.type,
          quantityPieces: line.quantityPieces,
          snapshotQuantity: line.snapshotQuantity,
          countedPieces: line.countedPieces,
          adjustmentDelta: line.adjustmentDelta,
        });
        const reservedDelta = document.type === "RESTORE"
          ? line.reservedAdjustmentDelta ?? 0
          : document.type === "OUTBOUND" && document.status === "RESERVED"
            ? -line.quantityPieces
            : 0;
        const nextOnHand = balance.onHand + delta;
        const nextReserved = balance.reserved + reservedDelta;
        if (nextOnHand < 0 || nextReserved < 0 || nextOnHand - nextReserved < 0) throw new ConflictException(`SKU ${line.sku.skuCode} 库存不足，不能过账`);
        const updated = await tx.stockBalance.update({
          where: { id: balance.id },
          data: { onHand: nextOnHand, reserved: nextReserved, version: { increment: 1 } },
        });
        await tx.inventoryLedgerEntry.create({
          data: {
            organizationId: user.organizationId,
            warehouseId: document.warehouseId,
            skuId: line.skuId,
            documentId: document.id,
            documentLineId: line.id,
            stockStatus: line.stockStatus,
            quantityDelta: delta,
            reservedDelta,
            balanceAfter: updated.onHand,
            reservedAfter: updated.reserved,
            actorId: user.id,
          },
        });
      }
      const changed = await tx.stockDocument.updateMany({
        where: { id, version: parsed.data.version, status: document.status },
        data: { status: "POSTED", version: { increment: 1 }, postedAt: new Date(), postedById: user.id, postKey },
      });
      if (!changed.count) throw new ConflictException("单据已被其他用户处理");
    });
    await this.createLowStockNotifications(user.organizationId, document.warehouseId);
    const updated = await this.getDocument(user, id);
    await this.audit(user, request, "document.posted", "StockDocument", id, document, updated);
    return updated;
  }

  async reverseDocument(user: AuthUser, id: string, input: unknown, request: Request) {
    const parsed = versionSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const original = await this.getDocument(user, id);
    if (original.status !== "POSTED") throw new ConflictException("只有已过账单据可以冲销");
    if (original.version !== parsed.data.version) throw new ConflictException("单据版本已更新");
    const originalEntries = await this.prisma.inventoryLedgerEntry.findMany({ where: { documentId: id }, orderBy: { createdAt: "asc" } });

    const reversal = await this.serializable(async (tx) => {
      const created = await tx.stockDocument.create({
        data: {
          organizationId: user.organizationId,
          warehouseId: original.warehouseId,
          documentNo: `CX-${original.documentNo}`,
          type: original.type,
          status: "POSTED",
          reason: `冲销 ${original.documentNo}`,
          reversalOfId: original.id,
          createdById: user.id,
          postedById: user.id,
          postedAt: new Date(),
          lines: {
            create: original.lines.map((line) => ({
              skuId: line.skuId,
              stockStatus: line.stockStatus,
              cartons: line.cartons,
              piecesPerCarton: line.piecesPerCarton,
              loosePieces: line.loosePieces,
              quantityPieces: line.quantityPieces,
              snapshotQuantity: line.snapshotQuantity,
              countedPieces: line.countedPieces,
              adjustmentDelta: line.adjustmentDelta,
              note: `冲销原行 ${line.id}`,
            })),
          },
        },
        include: { lines: true },
      });
      for (const [index, entry] of originalEntries.entries()) {
        const line = created.lines[Math.min(index, created.lines.length - 1)];
        const balance = await tx.stockBalance.findUniqueOrThrow({
          where: { warehouseId_skuId_status: { warehouseId: entry.warehouseId, skuId: entry.skuId, status: entry.stockStatus } },
        });
        const nextOnHand = balance.onHand - entry.quantityDelta;
        const nextReserved = balance.reserved - entry.reservedDelta;
        if (nextOnHand < 0 || nextReserved < 0 || nextOnHand - nextReserved < 0) throw new ConflictException("当前库存状态无法安全冲销该单据");
        const updated = await tx.stockBalance.update({ where: { id: balance.id }, data: { onHand: nextOnHand, reserved: nextReserved, version: { increment: 1 } } });
        await tx.inventoryLedgerEntry.create({
          data: {
            organizationId: user.organizationId,
            warehouseId: entry.warehouseId,
            skuId: entry.skuId,
            documentId: created.id,
            documentLineId: line.id,
            stockStatus: entry.stockStatus,
            quantityDelta: -entry.quantityDelta,
            reservedDelta: -entry.reservedDelta,
            balanceAfter: updated.onHand,
            reservedAfter: updated.reserved,
            actorId: user.id,
          },
        });
      }
      const changed = await tx.stockDocument.updateMany({ where: { id, version: parsed.data.version, status: "POSTED" }, data: { status: "REVERSED", version: { increment: 1 } } });
      if (!changed.count) throw new ConflictException("单据已被其他用户处理");
      return created;
    });
    await this.audit(user, request, "document.reversed", "StockDocument", id, original, reversal);
    return reversal;
  }

  async approvals(user: AuthUser) {
    return this.prisma.approvalTask.findMany({
      where: { document: { organizationId: user.organizationId } },
      include: { document: { include: { createdBy: { select: { id: true, name: true } }, lines: { include: { sku: { include: { style: true } } } } } }, actor: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }

  async decideApproval(user: AuthUser, id: string, approved: boolean, comment: string | undefined, request: Request) {
    const task = await this.prisma.approvalTask.findFirst({ where: { id, status: "PENDING", document: { organizationId: user.organizationId } }, include: { document: true } });
    if (!task) throw new NotFoundException("待审批任务不存在");
    if (task.document.createdById === user.id) throw new ForbiddenException("制单人不能审批自己的库存差异单");
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.approvalTask.update({ where: { id }, data: { status: approved ? "APPROVED" : "REJECTED", actorId: user.id, comment, decidedAt: new Date() } });
      return tx.stockDocument.update({ where: { id: task.documentId }, data: { status: approved ? "CONFIRMED" : "DRAFT", version: { increment: 1 } } });
    });
    await this.prisma.notification.create({
      data: {
        organizationId: user.organizationId,
        userId: task.document.createdById,
        type: approved ? "approval.approved" : "approval.rejected",
        title: approved ? "单据已审批" : "单据被驳回",
        message: `${task.document.documentNo}${approved ? "已通过审批" : "需要修改"}`,
        entityType: "StockDocument",
        entityId: task.documentId,
      },
    });
    await this.audit(user, request, approved ? "approval.approved" : "approval.rejected", "ApprovalTask", id, task, updated);
    return updated;
  }

  async notifications(user: AuthUser) {
    return this.prisma.notification.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" }, take: 100 });
  }

  async markNotificationRead(user: AuthUser, id: string) {
    const changed = await this.prisma.notification.updateMany({ where: { id, userId: user.id }, data: { readAt: new Date() } });
    if (!changed.count) throw new NotFoundException("通知不存在");
    return { ok: true };
  }

  async auditEvents(user: AuthUser) {
    return this.prisma.auditEvent.findMany({
      where: { organizationId: user.organizationId },
      include: { actor: { select: { name: true, email: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  }

  private async getDocument(user: AuthUser, id: string) {
    const document = await this.prisma.stockDocument.findFirst({
      where: { id, organizationId: user.organizationId },
      include: { lines: { include: { sku: { include: { style: true } } } }, approvals: true, createdBy: { select: { id: true, name: true } } },
    });
    if (!document) throw new NotFoundException("单据不存在");
    return document;
  }

  private async serializable<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (attempt < 2 && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") continue;
        throw error;
      }
    }
    throw new ConflictException("库存并发更新失败，请重试");
  }

  private async audit(user: AuthUser, request: Request, action: string, entityType: string, entityId: string, before: unknown, after: unknown) {
    await this.prisma.auditEvent.create({
      data: { organizationId: user.organizationId, actorId: user.id, action, entityType, entityId, before: before == null ? Prisma.JsonNull : asJson(before), after: after == null ? Prisma.JsonNull : asJson(after), ip: request.ip },
    });
  }

  private async notifyApprovers(organizationId: string, title: string, message: string, entityType: string, entityId: string) {
    const users = await this.prisma.user.findMany({ where: { organizationId, status: "ACTIVE", role: { code: { in: ["OWNER", "MANAGER"] } } }, select: { id: true } });
    if (users.length) {
      await this.prisma.notification.createMany({ data: users.map((user) => ({ organizationId, userId: user.id, type: "approval.pending", title, message, entityType, entityId })) });
    }
  }

  private async createLowStockNotifications(organizationId: string, warehouseId: string) {
    const low = await this.prisma.stockBalance.findMany({ where: { warehouseId }, include: { sku: { include: { style: true } } } });
    const alerts = low.filter((balance) => balance.onHand - balance.reserved <= balance.sku.minStock);
    if (!alerts.length) return;
    const users = await this.prisma.user.findMany({ where: { organizationId, status: "ACTIVE", role: { code: { in: ["OWNER", "MANAGER"] } } }, select: { id: true } });
    const existing = await this.prisma.notification.findMany({ where: { organizationId, type: "inventory.low", createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } }, select: { userId: true, entityId: true } });
    const keys = new Set(existing.map((item) => `${item.userId}:${item.entityId}`));
    const rows = users.flatMap((user) =>
      alerts
        .filter((balance) => !keys.has(`${user.id}:${balance.skuId}`))
        .map((balance) => ({ organizationId, userId: user.id, type: "inventory.low", title: "库存低于预警线", message: `${balance.sku.style.styleNo} ${balance.sku.color}/${balance.sku.size} 可用 ${balance.onHand - balance.reserved} 件`, entityType: "Sku", entityId: balance.skuId })),
    );
    if (rows.length) await this.prisma.notification.createMany({ data: rows });
  }
}

@Controller("dashboard")
class DashboardController {
  constructor(private readonly service: WarehouseService) {}
  @Get()
  @RequirePermissions("dashboard.view")
  get(@CurrentUser() user: AuthUser) {
    return this.service.dashboard(user);
  }
}

@Controller("catalog/styles")
class CatalogController {
  constructor(private readonly service: WarehouseService) {}
  @Get()
  @RequirePermissions("catalog.view")
  list(@CurrentUser() user: AuthUser, @Query("search") search?: string) {
    return this.service.listStyles(user, search);
  }
  @Post()
  @RequirePermissions("catalog.manage")
  create(@CurrentUser() user: AuthUser, @Body() input: unknown, @Req() request: Request) {
    return this.service.createStyle(user, input, request);
  }
  @Put(":id")
  @RequirePermissions("catalog.manage")
  update(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() input: unknown, @Req() request: Request) {
    return this.service.updateStyle(user, id, input, request);
  }
}

@Controller("inventory")
class InventoryController {
  constructor(private readonly service: WarehouseService) {}
  @Get("balances")
  @RequirePermissions("inventory.view")
  balances(@CurrentUser() user: AuthUser, @Query("search") search?: string, @Query("warehouseId") warehouseId?: string) {
    return this.service.inventory(user, search, warehouseId);
  }
  @Get("ledger")
  @RequirePermissions("inventory.view")
  ledger(@CurrentUser() user: AuthUser, @Query("cursor") cursor?: string) {
    return this.service.ledger(user, cursor);
  }
}

@Controller("documents")
class DocumentsController {
  constructor(private readonly service: WarehouseService) {}
  @Get()
  @RequirePermissions("inventory.view")
  list(@CurrentUser() user: AuthUser, @Query("type") type?: DocumentType) {
    return this.service.listDocuments(user, type);
  }
  @Post()
  @RequirePermissions("documents.manage")
  create(@CurrentUser() user: AuthUser, @Body() input: unknown, @Req() request: Request, @Headers("idempotency-key") key?: string) {
    return this.service.createDocument(user, input, request, key);
  }
  @Post(":id/confirm")
  @RequirePermissions("documents.manage")
  confirm(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() input: unknown, @Req() request: Request) {
    return this.service.confirmDocument(user, id, input, request);
  }
  @Post(":id/reserve")
  @RequirePermissions("documents.manage")
  reserve(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() input: unknown, @Req() request: Request) {
    return this.service.reserveDocument(user, id, input, request);
  }
  @Post(":id/post")
  @RequirePermissions("documents.manage")
  post(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() input: unknown, @Req() request: Request, @Headers("idempotency-key") key?: string) {
    return this.service.postDocument(user, id, input, request, key);
  }
  @Post(":id/reverse")
  @RequirePermissions("inventory.adjust")
  reverse(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() input: unknown, @Req() request: Request) {
    return this.service.reverseDocument(user, id, input, request);
  }
}

@Controller("approvals")
class ApprovalsController {
  constructor(private readonly service: WarehouseService) {}
  @Get()
  @RequirePermissions("approvals.view")
  list(@CurrentUser() user: AuthUser) {
    return this.service.approvals(user);
  }
  @Post(":id/approve")
  @RequirePermissions("approvals.manage")
  approve(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: { comment?: string }, @Req() request: Request) {
    return this.service.decideApproval(user, id, true, body.comment, request);
  }
  @Post(":id/reject")
  @RequirePermissions("approvals.manage")
  reject(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: { comment?: string }, @Req() request: Request) {
    return this.service.decideApproval(user, id, false, body.comment, request);
  }
}

@Controller("notifications")
class NotificationsController {
  constructor(private readonly service: WarehouseService) {}
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.service.notifications(user);
  }
  @Post(":id/read")
  read(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.service.markNotificationRead(user, id);
  }
}

@Controller("audit")
class AuditController {
  constructor(private readonly service: WarehouseService) {}
  @Get()
  @RequirePermissions("audit.view")
  list(@CurrentUser() user: AuthUser) {
    return this.service.auditEvents(user);
  }
}

@Module({
  controllers: [DashboardController, CatalogController, InventoryController, DocumentsController, ApprovalsController, NotificationsController, AuditController],
  providers: [WarehouseService],
  exports: [WarehouseService],
})
export class WarehouseModule {}
