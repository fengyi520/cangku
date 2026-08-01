import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  Injectable,
  Module,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
  Body,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Prisma, SimpleImportKind, SimpleImportStatus } from "@prisma/client";
import { createHash } from "node:crypto";
import { Response } from "express";
import * as XLSX from "xlsx";
import { AuthUser, CurrentUser, RequirePermissions } from "./auth-context";
import { DailyOutboundModule, DailyOutboundService } from "./daily-outbound.module";
import { InventoryPostingModule, InventoryPostingService } from "./inventory-posting.module";
import { PrismaService } from "./prisma.module";
import { readSpreadsheetMatrix } from "./spreadsheet-parser";
import { parseSimpleImportMatrix } from "./simple-import-parser";
import { businessDateString, parseBusinessDate } from "./warehouse-time";

type PreviewRow = {
  sourceRows: number[];
  styleNo: string;
  color: string;
  size: string;
  quantity: number;
  note: string | null;
  skuId: string | null;
  skuCode: string | null;
  error: string | null;
};

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function normalized(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replaceAll(" ", "");
}

function colorCodeFromSku(skuCode: string, size: string) {
  const parts = skuCode.split("-").map((part) => part.trim()).filter(Boolean);
  let sizeIndex = -1;
  for (let index = parts.length - 1; index >= 0; index -= 1) if (normalized(parts[index]) === normalized(size)) { sizeIndex = index; break; }
  return sizeIndex > 0 ? parts[sizeIndex - 1] : "";
}

@Injectable()
class SimpleImportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: InventoryPostingService,
    private readonly dailyOutbound: DailyOutboundService,
  ) {}

  template(kind: SimpleImportKind, response: Response) {
    if (!Object.values(SimpleImportKind).includes(kind)) throw new BadRequestException("导入类型无效");
    const sheet = XLSX.utils.aoa_to_sheet([
      ["款号", "颜色", "尺码", "数量", "备注"],
      ["CY-2407", "曜石黑", "M", 10, kind === SimpleImportKind.INBOUND ? "到货入库" : "今日订单"],
    ]);
    sheet["!cols"] = [{ wch: 18 }, { wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 24 }];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, kind === SimpleImportKind.INBOUND ? "入库模板" : "出库模板");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    response.setHeader("Content-Disposition", `attachment; filename="${kind.toLowerCase()}-template.xlsx"`);
    response.send(buffer);
  }

  async preview(user: AuthUser, file: Express.Multer.File, rawKind: string) {
    const kind = rawKind as SimpleImportKind;
    if (!Object.values(SimpleImportKind).includes(kind)) throw new BadRequestException("导入类型无效");
    if (!file) throw new BadRequestException("请选择 Excel 或 CSV 文件");
    if (!/\.(xlsx?|csv)$/i.test(file.originalname)) throw new BadRequestException("仅支持 Excel 或 CSV 文件");
    const matrix = readSpreadsheetMatrix(file.buffer);
    let parsedRows;
    try {
      parsedRows = parseSimpleImportMatrix(matrix);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : "表格格式无效");
    }
    const styleNos = [...new Set(parsedRows.map((row) => row.styleNo).filter(Boolean))];
    const styles = await this.prisma.productStyle.findMany({
      where: { organizationId: user.organizationId, OR: [{ styleNo: { in: styleNos } }, { name: { in: styleNos } }] },
      include: { skus: true },
    });
    const skuCandidates = styles.flatMap((style) => style.skus.map((sku) => ({ style, sku })));
    const findSku = (styleValue: string, colorValue: string, sizeValue: string) => {
      const ranked = skuCandidates
        .map(({ style, sku }) => {
          if (normalized(sku.size) !== normalized(sizeValue)) return { sku, score: -1 };
          let score = 0;
          if (normalized(style.styleNo) === normalized(styleValue)) score += 4;
          else if (normalized(style.name) === normalized(styleValue)) score += 2;
          else return { sku, score: -1 };
          if (normalized(sku.color) === normalized(colorValue)) score += 2;
          else if (normalized(colorCodeFromSku(sku.skuCode, sku.size)) === normalized(colorValue)) score += 1;
          else return { sku, score: -1 };
          if (normalized(style.styleNo) === normalized(colorValue)) score -= 3;
          return { sku, score };
        })
        .filter((item) => item.score >= 0)
        .sort((left, right) => right.score - left.score);
      return ranked.length && (ranked.length === 1 || ranked[0].score > ranked[1].score) ? ranked[0].sku : null;
    };
    const rows: PreviewRow[] = parsedRows.map(({ inputError, ...row }) => {
      const sku = findSku(row.styleNo, row.color, row.size);
      let error: string | null = inputError;
      if (!error && !sku) error = "未找到对应的款号、颜色和尺码";
      else if (!error && sku && !sku.active) error = "该商品规格已停用";
      return { ...row, skuId: sku?.id ?? null, skuCode: sku?.skuCode ?? null, error };
    });

    const date = businessDateString();
    const warehouse = await this.prisma.warehouse.findFirst({
      where: { organizationId: user.organizationId, active: true },
      orderBy: { createdAt: "asc" },
    });
    if (!warehouse) throw new BadRequestException("尚未配置可用仓库");
    const fileHash = createHash("sha256").update(file.buffer).digest("hex");
    const dedupKey = createHash("sha256").update(`${user.organizationId}:${kind}:${date}:${fileHash}`).digest("hex");
    const existing = await this.prisma.simpleImportSession.findUnique({ where: { dedupKey } });
    if (existing?.status === SimpleImportStatus.COMPLETED) throw new ConflictException("这份文件今天已经确认过，请勿重复导入");
    if (existing?.status === SimpleImportStatus.PROCESSING) throw new ConflictException("这份文件正在确认，请稍后刷新");
    const session = existing
      ? await this.prisma.simpleImportSession.update({ where: { id: existing.id }, data: { rows: json(rows), fileName: file.originalname } })
      : await this.prisma.simpleImportSession.create({
          data: {
            organizationId: user.organizationId,
            warehouseId: warehouse.id,
            kind,
            businessDate: parseBusinessDate(date),
            fileName: file.originalname,
            fileHash,
            dedupKey,
            rows: json(rows),
            createdById: user.id,
          },
        });
    return { id: session.id, kind: session.kind, fileName: session.fileName, status: session.status, rows, valid: rows.every((row) => !row.error) };
  }

  async confirm(user: AuthUser, id: string) {
    const session = await this.prisma.simpleImportSession.findFirst({ where: { id, organizationId: user.organizationId } });
    if (!session) throw new BadRequestException("导入预览不存在");
    if (session.status === SimpleImportStatus.COMPLETED) {
      return { id: session.id, status: session.status, documentId: session.documentId, dailyBatchId: session.dailyBatchId };
    }
    const claimed = await this.prisma.simpleImportSession.updateMany({
      where: { id: session.id, status: SimpleImportStatus.REVIEW },
      data: { status: SimpleImportStatus.PROCESSING },
    });
    if (!claimed.count) throw new ConflictException("导入正在确认，请稍后刷新");
    const rows = session.rows as unknown as PreviewRow[];
    try {
      if (!rows.length || rows.some((row) => row.error || !row.skuId)) throw new BadRequestException("导入数据仍有错误，不能确认");
      const lines = rows.map((row) => ({ skuId: row.skuId!, quantity: row.quantity, note: row.note }));
      if (session.kind === SimpleImportKind.INBOUND) {
        const document = await this.posting.post({
          actor: user,
          warehouseId: session.warehouseId,
          type: "INBOUND",
          sourceRef: `快速入库-${session.fileName}`,
          reason: "固定模板确认入库",
          idempotencyKey: `simple-import:${session.id}`,
          lines,
          auditAction: "simple_import.inbound_posted",
        });
        await this.prisma.simpleImportSession.update({
          where: { id: session.id },
          data: { status: SimpleImportStatus.COMPLETED, completedAt: new Date(), documentId: document.id },
        });
        return { id: session.id, status: SimpleImportStatus.COMPLETED, documentId: document.id };
      }

      const batch = await this.dailyOutbound.mergeImportedLines(user, lines, session.id);
      return { id: session.id, status: SimpleImportStatus.COMPLETED, dailyBatchId: batch.id };
    } catch (error) {
      await this.prisma.simpleImportSession.updateMany({
        where: { id: session.id, status: SimpleImportStatus.PROCESSING },
        data: { status: SimpleImportStatus.REVIEW },
      });
      throw error;
    }
  }
}

@Controller("simple-imports")
@RequirePermissions("documents.manage")
class SimpleImportsController {
  constructor(private readonly service: SimpleImportsService) {}

  @Get("template")
  templateByQuery(@Query("kind") kind: SimpleImportKind, @Res() response: Response) {
    return this.service.template(kind, response);
  }

  @Get("template/:kind")
  templateByPath(@Param("kind") kind: SimpleImportKind, @Res() response: Response) {
    return this.service.template(kind, response);
  }

  @Post("preview")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 5 * 1024 * 1024, files: 1 } }))
  preview(@CurrentUser() user: AuthUser, @UploadedFile() file: Express.Multer.File, @Body("kind") kind: string) {
    return this.service.preview(user, file, kind);
  }

  @Post(":id/confirm")
  confirm(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.service.confirm(user, id);
  }
}

@Module({
  imports: [InventoryPostingModule, DailyOutboundModule],
  controllers: [SimpleImportsController],
  providers: [SimpleImportsService],
})
export class SimpleImportsModule {}
