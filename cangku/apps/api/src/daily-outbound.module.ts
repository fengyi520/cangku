import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Injectable,
  Module,
  OnApplicationBootstrap,
  Param,
  Post,
  Put,
  Query,
  Req,
} from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { DailyOutboundKind, DailyOutboundStatus, Prisma } from "@prisma/client";
import { automationSettingSchema, dailyOutboundLineSchema, updateDailyOutboundSchema } from "@cangku/contracts";
import { Request } from "express";
import { AuthUser, CurrentUser, RequirePermissions } from "./auth-context";
import { InventoryPostingModule, InventoryPostingService } from "./inventory-posting.module";
import { PrismaService } from "./prisma.module";
import { WarehouseModule, WarehouseService } from "./warehouse.module";
import {
  addBusinessDays,
  businessDateString,
  DEFAULT_AUTO_OUTBOUND_TIME,
  parseBusinessDate,
  scheduledAtFor,
  WAREHOUSE_TIMEZONE,
} from "./warehouse-time";

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

const batchInclude = {
  lines: { include: { sku: { include: { style: true } } }, orderBy: { createdAt: "asc" as const } },
  document: { select: { id: true, documentNo: true, status: true, version: true, postedAt: true } },
  reversalDocument: { select: { id: true, documentNo: true, postedAt: true } },
  createdBy: { select: { id: true, name: true } },
  updatedBy: { select: { id: true, name: true } },
};

@Injectable()
export class AutomationSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async timeForDate(organizationId: string, date: string) {
    const setting = await this.prisma.warehouseAutomationSetting.findFirst({
      where: { organizationId, effectiveFrom: { lte: parseBusinessDate(date) } },
      orderBy: { effectiveFrom: "desc" },
    });
    return setting?.autoOutboundTime ?? DEFAULT_AUTO_OUTBOUND_TIME;
  }

  async get(user: AuthUser) {
    const today = businessDateString();
    const [current, pending] = await Promise.all([
      this.prisma.warehouseAutomationSetting.findFirst({
        where: { organizationId: user.organizationId, effectiveFrom: { lte: parseBusinessDate(today) } },
        orderBy: { effectiveFrom: "desc" },
      }),
      this.prisma.warehouseAutomationSetting.findFirst({
        where: { organizationId: user.organizationId, effectiveFrom: { gt: parseBusinessDate(today) } },
        orderBy: { effectiveFrom: "asc" },
      }),
    ]);
    return {
      currentTime: current?.autoOutboundTime ?? DEFAULT_AUTO_OUTBOUND_TIME,
      pendingTime: pending?.autoOutboundTime ?? null,
      effectiveFrom: pending?.effectiveFrom.toISOString().slice(0, 10) ?? null,
      timezone: WAREHOUSE_TIMEZONE,
    };
  }

  async update(user: AuthUser, input: unknown, request: Request) {
    const parsed = automationSettingSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const effectiveDate = addBusinessDays(businessDateString(), 1);
    const before = await this.get(user);
    await this.prisma.warehouseAutomationSetting.upsert({
      where: { organizationId_effectiveFrom: { organizationId: user.organizationId, effectiveFrom: parseBusinessDate(effectiveDate) } },
      update: { autoOutboundTime: parsed.data.autoOutboundTime, createdById: user.id, timezone: WAREHOUSE_TIMEZONE },
      create: {
        organizationId: user.organizationId,
        autoOutboundTime: parsed.data.autoOutboundTime,
        timezone: WAREHOUSE_TIMEZONE,
        effectiveFrom: parseBusinessDate(effectiveDate),
        createdById: user.id,
      },
    });
    const after = await this.get(user);
    await this.prisma.auditEvent.create({
      data: {
        organizationId: user.organizationId,
        actorId: user.id,
        action: "automation.outbound_time.updated",
        entityType: "WarehouseAutomationSetting",
        entityId: `${user.organizationId}:${effectiveDate}`,
        before: json(before),
        after: json(after),
        ip: request.ip,
      },
    });
    return after;
  }
}

@Injectable()
export class DailyOutboundService implements OnApplicationBootstrap {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AutomationSettingsService,
    private readonly posting: InventoryPostingService,
    private readonly warehouseService: WarehouseService,
  ) {}

  async onApplicationBootstrap() {
    const staleBefore = new Date(Date.now() - 10 * 60_000);
    await this.prisma.dailyOutboundBatch.updateMany({
      where: { status: DailyOutboundStatus.PROCESSING, updatedAt: { lt: staleBefore } },
      data: { status: DailyOutboundStatus.OPEN, error: "服务中断，已重新加入结算队列" },
    });
    await this.processDueBatches();
  }

  @Interval(60_000)
  async processDueBatches() {
    const due = await this.prisma.dailyOutboundBatch.findMany({
      where: {
        kind: DailyOutboundKind.AUTOMATIC,
        status: DailyOutboundStatus.OPEN,
        scheduledAt: { lte: new Date() },
        lines: { some: {} },
      },
      select: { id: true },
      orderBy: { scheduledAt: "asc" },
      take: 20,
    });
    for (const batch of due) {
      await this.settleById(batch.id).catch(() => undefined);
    }
  }

  async getForDate(user: AuthUser, requestedDate?: string) {
    const date = requestedDate ?? businessDateString();
    let businessDate: Date;
    try {
      businessDate = parseBusinessDate(date);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : "业务日期无效");
    }
    if (date > businessDateString()) throw new BadRequestException("不能提前创建未来日期的出库登记");
    const time = await this.settings.timeForDate(user.organizationId, date);
    const scheduledAt = scheduledAtFor(date, time);
    if (date === businessDateString() && new Date() < scheduledAt) await this.ensureAutomaticBatch(user, date, scheduledAt);
    const batches = await this.prisma.dailyOutboundBatch.findMany({
      where: { organizationId: user.organizationId, businessDate },
      include: batchInclude,
      orderBy: { sequence: "asc" },
    });
    return {
      businessDate: date,
      autoOutboundTime: time,
      timezone: WAREHOUSE_TIMEZONE,
      scheduledAt: scheduledAt.toISOString(),
      beforeCutoff: new Date() < scheduledAt,
      automaticBatch: batches.find((batch) => batch.kind === DailyOutboundKind.AUTOMATIC) ?? null,
      supplements: batches.filter((batch) => batch.kind === DailyOutboundKind.SUPPLEMENT),
    };
  }

  async history(user: AuthUser, date?: string) {
    return this.prisma.dailyOutboundBatch.findMany({
      where: {
        organizationId: user.organizationId,
        ...(date ? { businessDate: parseBusinessDate(date) } : {}),
      },
      include: batchInclude,
      orderBy: [{ businessDate: "desc" }, { sequence: "desc" }],
      take: 100,
    });
  }

  async updateBatch(user: AuthUser, id: string, input: unknown) {
    const parsed = updateDailyOutboundSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const batch = await this.batchForUser(user, id);
    if (batch.kind !== DailyOutboundKind.AUTOMATIC) {
      throw new ConflictException("当前批次不可编辑");
    }
    if (batch.status !== DailyOutboundStatus.OPEN && batch.status !== DailyOutboundStatus.FAILED) {
      throw new ConflictException("当前批次不可编辑");
    }
    if (batch.status === DailyOutboundStatus.OPEN && new Date() >= batch.scheduledAt) throw new ConflictException("登记表已到结算时间，请刷新查看处理结果");
    const lines = this.aggregateLines(parsed.data.lines);
    await this.assertSkus(user.organizationId, lines.map((line) => line.skuId));
    const changed = await this.prisma.$transaction(async (tx) => {
      const result = await tx.dailyOutboundBatch.updateMany({
        where: { id, organizationId: user.organizationId, version: parsed.data.version, status: batch.status },
        data: {
          version: { increment: 1 },
          updatedById: user.id,
          status: batch.status === DailyOutboundStatus.FAILED ? DailyOutboundStatus.FAILED : DailyOutboundStatus.OPEN,
          error: batch.status === DailyOutboundStatus.FAILED ? "登记已修改，请手动重试结算" : null,
        },
      });
      if (!result.count) return false;
      await tx.dailyOutboundLine.deleteMany({ where: { batchId: id } });
      if (lines.length) await tx.dailyOutboundLine.createMany({ data: lines.map((line) => ({ batchId: id, ...line })) });
      return true;
    });
    if (!changed) throw new ConflictException("登记表已被其他用户修改，请刷新后重试");
    return this.batchForUser(user, id);
  }

  async settle(user: AuthUser, id: string) {
    const batch = await this.batchForUser(user, id);
    if (batch.kind === DailyOutboundKind.AUTOMATIC && batch.status === DailyOutboundStatus.OPEN && new Date() < batch.scheduledAt) {
      throw new ConflictException("尚未到自动结算时间");
    }
    return this.settleById(id, user.organizationId);
  }

  async createSupplement(user: AuthUser, input: unknown, importSessionId?: string) {
    const parsed = dailyOutboundLineSchema.array().min(1).max(1000).safeParse((input as { lines?: unknown })?.lines);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const lines = this.aggregateLines(parsed.data);
    await this.assertSkus(user.organizationId, lines.map((line) => line.skuId));
    const date = businessDateString();
    const warehouse = await this.warehouse(user.organizationId);
    let batchId = "";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const latest = await this.prisma.dailyOutboundBatch.aggregate({
          where: { organizationId: user.organizationId, businessDate: parseBusinessDate(date) },
          _max: { sequence: true },
        });
        const batch = await this.prisma.$transaction(async (tx) => {
          const created = await tx.dailyOutboundBatch.create({
            data: {
              organizationId: user.organizationId,
              warehouseId: warehouse.id,
              businessDate: parseBusinessDate(date),
              kind: DailyOutboundKind.SUPPLEMENT,
              sequence: (latest._max.sequence ?? 0) + 1,
              scheduledAt: new Date(),
              createdById: user.id,
              updatedById: user.id,
              lines: { create: lines },
            },
          });
          if (importSessionId) {
            await tx.simpleImportSession.update({
              where: { id: importSessionId },
              data: { status: "COMPLETED", completedAt: new Date(), dailyBatchId: created.id },
            });
          }
          return created;
        });
        batchId = batch.id;
        break;
      } catch (error) {
        if (attempt < 2 && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") continue;
        throw error;
      }
    }
    return this.settleById(batchId, user.organizationId);
  }

  async mergeImportedLines(user: AuthUser, lines: Array<{ skuId: string; quantity: number; note?: string | null }>, importSessionId: string) {
    const date = businessDateString();
    const time = await this.settings.timeForDate(user.organizationId, date);
    const scheduledAt = scheduledAtFor(date, time);
    if (new Date() >= scheduledAt) return this.createSupplement(user, { lines }, importSessionId);
    const batch = await this.ensureAutomaticBatch(user, date, scheduledAt);
    await this.prisma.$transaction(async (tx) => {
      for (const line of this.aggregateLines(lines)) {
        await tx.dailyOutboundLine.upsert({
          where: { batchId_skuId: { batchId: batch.id, skuId: line.skuId } },
          create: { batchId: batch.id, ...line },
          update: { quantity: { increment: line.quantity }, note: line.note ?? undefined },
        });
      }
      await tx.dailyOutboundBatch.update({ where: { id: batch.id }, data: { version: { increment: 1 }, updatedById: user.id } });
      await tx.simpleImportSession.update({
        where: { id: importSessionId },
        data: { status: "COMPLETED", completedAt: new Date(), dailyBatchId: batch.id },
      });
      await tx.auditEvent.create({
        data: {
          organizationId: user.organizationId,
          actorId: user.id,
          action: "simple_import.outbound_confirmed",
          entityType: "DailyOutboundBatch",
          entityId: batch.id,
          after: json({ importId: importSessionId, lines: lines.length }),
        },
      });
    });
    return this.batchForUser(user, batch.id);
  }

  async reverse(user: AuthUser, id: string, request: Request) {
    const batch = await this.batchForUser(user, id);
    if (batch.status === DailyOutboundStatus.REVERSED) return batch;
    if (batch.status !== DailyOutboundStatus.POSTED || !batch.document) throw new ConflictException("只有已结算批次可以回退");
    const reversal = await this.warehouseService.reverseDocument(user, batch.document.id, { version: batch.document.version }, request);
    await this.prisma.dailyOutboundBatch.update({
      where: { id: batch.id },
      data: { status: DailyOutboundStatus.REVERSED, reversalDocumentId: reversal.id, reversedAt: new Date(), version: { increment: 1 }, updatedById: user.id },
    });
    return this.batchForUser(user, id);
  }

  private async settleById(id: string, organizationId?: string) {
    const before = await this.prisma.dailyOutboundBatch.findFirst({
      where: { id, ...(organizationId ? { organizationId } : {}) },
      include: { lines: true, createdBy: true },
    });
    if (!before) throw new BadRequestException("出库批次不存在");
    if (before.status === DailyOutboundStatus.POSTED || before.status === DailyOutboundStatus.REVERSED) {
      return this.prisma.dailyOutboundBatch.findUniqueOrThrow({ where: { id }, include: batchInclude });
    }
    if (!before.lines.length) throw new BadRequestException("空登记表不会生成出库单");
    const claimed = await this.prisma.dailyOutboundBatch.updateMany({
      where: { id, status: { in: [DailyOutboundStatus.OPEN, DailyOutboundStatus.FAILED] } },
      data: { status: DailyOutboundStatus.PROCESSING, error: null, version: { increment: 1 } },
    });
    if (!claimed.count) throw new ConflictException("该批次正在处理，请稍后刷新");
    try {
      const document = await this.posting.post({
        actor: { id: before.createdById, organizationId: before.organizationId },
        warehouseId: before.warehouseId,
        type: "OUTBOUND",
        sourceRef: `每日出库-${before.businessDate.toISOString().slice(0, 10)}-${before.sequence}`,
        reason: before.kind === DailyOutboundKind.AUTOMATIC ? "每日登记自动结算" : "结算时间后补充出库",
        idempotencyKey: `daily-outbound:${before.id}`,
        lines: before.lines,
        auditAction: before.kind === DailyOutboundKind.AUTOMATIC ? "daily_outbound.auto_posted" : "daily_outbound.supplement_posted",
      });
      await this.prisma.dailyOutboundBatch.update({
        where: { id },
        data: { status: DailyOutboundStatus.POSTED, documentId: document.id, postedAt: document.postedAt, error: null, version: { increment: 1 } },
      });
    } catch (error) {
      await this.prisma.dailyOutboundBatch.update({
        where: { id },
        data: { status: DailyOutboundStatus.FAILED, error: error instanceof Error ? error.message : "结算失败", version: { increment: 1 } },
      });
      throw error;
    }
    return this.prisma.dailyOutboundBatch.findUniqueOrThrow({ where: { id }, include: batchInclude });
  }

  private aggregateLines(lines: Array<{ skuId: string; quantity: number; note?: string | null }>) {
    const grouped = new Map<string, { skuId: string; quantity: number; note?: string | null }>();
    for (const line of lines) {
      const current = grouped.get(line.skuId);
      grouped.set(line.skuId, { skuId: line.skuId, quantity: (current?.quantity ?? 0) + line.quantity, note: line.note ?? current?.note ?? null });
    }
    return [...grouped.values()];
  }

  private async assertSkus(organizationId: string, skuIds: string[]) {
    const unique = [...new Set(skuIds)];
    const count = await this.prisma.sku.count({ where: { id: { in: unique }, active: true, style: { organizationId } } });
    if (count !== unique.length) throw new BadRequestException("登记表包含不存在或已停用的商品规格");
  }

  private async ensureAutomaticBatch(user: AuthUser, date: string, scheduledAt: Date) {
    const warehouse = await this.warehouse(user.organizationId);
    return this.prisma.dailyOutboundBatch.upsert({
      where: { organizationId_businessDate_sequence: { organizationId: user.organizationId, businessDate: parseBusinessDate(date), sequence: 0 } },
      update: {},
      create: {
        organizationId: user.organizationId,
        warehouseId: warehouse.id,
        businessDate: parseBusinessDate(date),
        kind: DailyOutboundKind.AUTOMATIC,
        sequence: 0,
        scheduledAt,
        createdById: user.id,
        updatedById: user.id,
      },
      include: { lines: true },
    });
  }

  private async warehouse(organizationId: string) {
    const warehouse = await this.prisma.warehouse.findFirst({ where: { organizationId, active: true }, orderBy: { createdAt: "asc" } });
    if (!warehouse) throw new BadRequestException("尚未配置可用仓库");
    return warehouse;
  }

  private async batchForUser(user: AuthUser, id: string) {
    const batch = await this.prisma.dailyOutboundBatch.findFirst({ where: { id, organizationId: user.organizationId }, include: batchInclude });
    if (!batch) throw new BadRequestException("出库批次不存在");
    return batch;
  }
}

@Controller("settings/warehouse-automation")
@RequirePermissions("settings.manage")
class AutomationSettingsController {
  constructor(private readonly service: AutomationSettingsService) {}

  @Get()
  get(@CurrentUser() user: AuthUser) {
    return this.service.get(user);
  }

  @Put()
  update(@CurrentUser() user: AuthUser, @Body() input: unknown, @Req() request: Request) {
    return this.service.update(user, input, request);
  }
}

@Controller("daily-outbound")
@RequirePermissions("documents.manage")
class DailyOutboundController {
  constructor(private readonly service: DailyOutboundService) {}

  @Get()
  get(@CurrentUser() user: AuthUser, @Query("date") date?: string) {
    return this.service.getForDate(user, date);
  }

  @Get("history")
  history(@CurrentUser() user: AuthUser, @Query("date") date?: string) {
    return this.service.history(user, date);
  }

  @Put(":id")
  update(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() input: unknown) {
    return this.service.updateBatch(user, id, input);
  }

  @Post("supplements")
  supplement(@CurrentUser() user: AuthUser, @Body() input: unknown) {
    return this.service.createSupplement(user, input);
  }

  @Post(":id/settle")
  settle(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.service.settle(user, id);
  }

  @Post(":id/reverse")
  @RequirePermissions("inventory.adjust")
  reverse(@CurrentUser() user: AuthUser, @Param("id") id: string, @Req() request: Request) {
    return this.service.reverse(user, id, request);
  }
}

@Module({
  imports: [InventoryPostingModule, WarehouseModule],
  controllers: [AutomationSettingsController, DailyOutboundController],
  providers: [AutomationSettingsService, DailyOutboundService],
  exports: [AutomationSettingsService, DailyOutboundService],
})
export class DailyOutboundModule {}
