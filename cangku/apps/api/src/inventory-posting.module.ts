import { BadRequestException, ConflictException, Injectable, Module, NotFoundException } from "@nestjs/common";
import { DocumentType, Prisma, StockStatus } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "./prisma.module";

type PostingLine = { skuId: string; quantity: number; note?: string | null; stockStatus?: StockStatus };
type PostingActor = { id: string; organizationId: string };

function balanceVersionKey(skuId: string, stockStatus: StockStatus | string) {
  return `${skuId}:${stockStatus}`;
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

@Injectable()
export class InventoryPostingService {
  constructor(private readonly prisma: PrismaService) {}

  aggregateLines(lines: PostingLine[]) {
    const grouped = new Map<string, PostingLine>();
    for (const line of lines) {
      if (!Number.isInteger(line.quantity) || line.quantity <= 0) throw new BadRequestException("商品数量必须为正整数");
      const stockStatus = line.stockStatus ?? StockStatus.SELLABLE;
      const key = `${line.skuId}:${stockStatus}`;
      const existing = grouped.get(key);
      grouped.set(key, {
        skuId: line.skuId,
        stockStatus,
        quantity: (existing?.quantity ?? 0) + line.quantity,
        note: [existing?.note, line.note].filter(Boolean).filter((value, index, source) => source.indexOf(value) === index).join("；") || null,
      });
    }
    return [...grouped.values()];
  }

  async post(input: {
    actor: PostingActor;
    warehouseId: string;
    type: Extract<DocumentType, "INBOUND" | "OUTBOUND">;
    sourceRef: string;
    reason: string;
    idempotencyKey: string;
    lines: PostingLine[];
    auditAction: string;
    ip?: string;
  }) {
    const lines = this.aggregateLines(input.lines);
    const existing = await this.prisma.stockDocument.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: { lines: true } });
    if (existing) return existing;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const duplicate = await tx.stockDocument.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: { lines: true } });
          if (duplicate) return duplicate;
          const warehouse = await tx.warehouse.findFirst({ where: { id: input.warehouseId, organizationId: input.actor.organizationId, active: true } });
          if (!warehouse) throw new BadRequestException("仓库不存在或已停用");
          const skuIds = lines.map((line) => line.skuId);
          const skus = await tx.sku.findMany({
            where: { id: { in: skuIds }, active: true, style: { organizationId: input.actor.organizationId } },
            include: { style: true },
          });
          if (skus.length !== new Set(skuIds).size) throw new ConflictException("批次包含不存在或已停用的商品规格");
          const skuMap = new Map(skus.map((sku) => [sku.id, sku]));

          const balances = new Map<string, { id: string; onHand: number; reserved: number }>();
          const shortages: string[] = [];
          for (const line of lines) {
            const balance = await tx.stockBalance.upsert({
              where: { warehouseId_skuId_status: { warehouseId: input.warehouseId, skuId: line.skuId, status: line.stockStatus! } },
              create: { warehouseId: input.warehouseId, skuId: line.skuId, status: line.stockStatus! },
              update: {},
            });
            balances.set(line.skuId, balance);
            if (input.type === "OUTBOUND" && balance.onHand - balance.reserved < line.quantity) {
              const sku = skuMap.get(line.skuId)!;
              shortages.push(`${sku.style.styleNo} ${sku.color}/${sku.size}：可用 ${balance.onHand - balance.reserved}，需要 ${line.quantity}`);
            }
          }
          if (shortages.length) throw new ConflictException(`库存不足：${shortages.join("；")}`);

          const prefix = input.type === "INBOUND" ? "RK" : "CK";
          const document = await tx.stockDocument.create({
            data: {
              organizationId: input.actor.organizationId,
              warehouseId: input.warehouseId,
              documentNo: `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 6).toUpperCase()}`,
              type: input.type,
              status: "POSTED",
              sourceRef: input.sourceRef,
              reason: input.reason,
              createdById: input.actor.id,
              postedById: input.actor.id,
              postedAt: new Date(),
              idempotencyKey: input.idempotencyKey,
              postKey: input.idempotencyKey,
              lines: {
                create: lines.map((line) => ({
                  skuId: line.skuId,
                  stockStatus: line.stockStatus!,
                  loosePieces: line.quantity,
                  quantityPieces: line.quantity,
                  note: line.note,
                })),
              },
            },
            include: { lines: true },
          });

          for (const line of lines) {
            const balance = balances.get(line.skuId)!;
            const delta = input.type === "INBOUND" ? line.quantity : -line.quantity;
            const updated = await tx.stockBalance.update({
              where: { id: balance.id },
              data: { onHand: { increment: delta }, version: { increment: 1 } },
            });
            const documentLine = document.lines.find((item) => item.skuId === line.skuId && item.stockStatus === line.stockStatus)!;
            await tx.inventoryLedgerEntry.create({
              data: {
                organizationId: input.actor.organizationId,
                warehouseId: input.warehouseId,
                skuId: line.skuId,
                documentId: document.id,
                documentLineId: documentLine.id,
                stockStatus: line.stockStatus!,
                quantityDelta: delta,
                balanceAfter: updated.onHand,
                reservedAfter: updated.reserved,
                actorId: input.actor.id,
              },
            });
          }
          await tx.auditEvent.create({
            data: {
              organizationId: input.actor.organizationId,
              actorId: input.actor.id,
              action: input.auditAction,
              entityType: "StockDocument",
              entityId: document.id,
              after: json({ id: document.id, documentNo: document.documentNo, type: document.type, status: document.status }),
              ip: input.ip,
            },
          });
          return document;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (attempt < 2 && error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(error.code)) continue;
        throw error;
      }
    }
    throw new ConflictException("库存正在被其他任务处理，请稍后重试");
  }

  async postExisting(input: {
    actor: PostingActor;
    documentId: string;
    expectedVersion: number;
    expectedBalanceVersions?: Record<string, number>;
    postKey: string;
    auditAction: string;
    ip?: string;
  }) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const document = await tx.stockDocument.findFirst({
            where: { id: input.documentId, organizationId: input.actor.organizationId },
            include: { lines: { include: { sku: { include: { style: true } } } } },
          });
          if (!document) throw new NotFoundException("货单不存在");
          if (document.status === "POSTED" && document.postKey === input.postKey) return document;
          if (!["INBOUND", "OUTBOUND"].includes(document.type)) throw new ConflictException("该单据不能使用快速提交");
          if (!["DRAFT", "CONFIRMED", "RESERVED"].includes(document.status)) throw new ConflictException("当前货单状态不能过账");
          if (document.version !== input.expectedVersion) throw new ConflictException("货单已被修改，请重新预览");

          const warehouse = await tx.warehouse.findFirst({ where: { id: document.warehouseId, organizationId: input.actor.organizationId, active: true } });
          if (!warehouse) throw new BadRequestException("仓库不存在或已停用");
          for (const line of document.lines) {
            if (!line.sku.active) throw new ConflictException(`SKU ${line.sku.skuCode} 已停用`);
            const existingBalance = await tx.stockBalance.findUnique({
              where: { warehouseId_skuId_status: { warehouseId: document.warehouseId, skuId: line.skuId, status: line.stockStatus } },
            });
            const balance = await tx.stockBalance.upsert({
              where: { warehouseId_skuId_status: { warehouseId: document.warehouseId, skuId: line.skuId, status: line.stockStatus } },
              create: { warehouseId: document.warehouseId, skuId: line.skuId, status: line.stockStatus },
              update: {},
            });
            const expectedBalanceVersion = input.expectedBalanceVersions?.[balanceVersionKey(line.skuId, line.stockStatus)];
            if (expectedBalanceVersion !== undefined && (existingBalance?.version ?? 0) !== expectedBalanceVersion) {
              throw new ConflictException("预览后库存已发生变化，请重新预览");
            }
            const delta = document.type === "INBOUND" ? line.quantityPieces : -line.quantityPieces;
            const reservedDelta = document.type === "OUTBOUND" && document.status === "RESERVED" ? -line.quantityPieces : 0;
            const nextOnHand = balance.onHand + delta;
            const nextReserved = balance.reserved + reservedDelta;
            if (nextOnHand < 0 || nextReserved < 0 || nextOnHand - nextReserved < 0) {
              throw new ConflictException(`SKU ${line.sku.skuCode} 可用库存不足，请重新预览`);
            }
            const updated = await tx.stockBalance.update({
              where: { id: balance.id },
              data: { onHand: nextOnHand, reserved: nextReserved, version: { increment: 1 } },
            });
            await tx.inventoryLedgerEntry.create({
              data: {
                organizationId: input.actor.organizationId,
                warehouseId: document.warehouseId,
                skuId: line.skuId,
                documentId: document.id,
                documentLineId: line.id,
                stockStatus: line.stockStatus,
                quantityDelta: delta,
                reservedDelta,
                balanceAfter: updated.onHand,
                reservedAfter: updated.reserved,
                actorId: input.actor.id,
              },
            });
          }
          const changed = await tx.stockDocument.updateMany({
            where: { id: document.id, version: input.expectedVersion, status: document.status },
            data: { status: "POSTED", version: { increment: 1 }, postedAt: new Date(), postedById: input.actor.id, postKey: input.postKey },
          });
          if (!changed.count) throw new ConflictException("货单已被其他用户处理");
          await tx.auditEvent.create({
            data: {
              organizationId: input.actor.organizationId,
              actorId: input.actor.id,
              action: input.auditAction,
              entityType: "StockDocument",
              entityId: document.id,
              after: json({ id: document.id, type: document.type, status: "POSTED" }),
              ip: input.ip,
            },
          });
          return tx.stockDocument.findUniqueOrThrow({ where: { id: document.id }, include: { lines: true } });
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (attempt < 2 && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") continue;
        throw error;
      }
    }
    throw new ConflictException("库存正在被其他任务处理，请稍后重试");
  }
}

@Module({ providers: [InventoryPostingService], exports: [InventoryPostingService] })
export class InventoryPostingModule {}
