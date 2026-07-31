import { BadRequestException, Body, ConflictException, Controller, Get, Injectable, Module, Param, Post, Put, Req } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createWarehouseSchema, updateWarehouseSchema } from "@cangku/contracts";
import { Request } from "express";
import { AuthUser, CurrentUser, RequirePermissions } from "./auth-context";
import { PrismaService } from "./prisma.module";

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

@Injectable()
export class WarehousesService {
  constructor(private readonly prisma: PrismaService) {}

  list(user: AuthUser) {
    return this.prisma.warehouse.findMany({
      where: { organizationId: user.organizationId },
      orderBy: [{ active: "desc" }, { createdAt: "asc" }],
    });
  }

  async create(user: AuthUser, input: unknown, request: Request) {
    const parsed = createWarehouseSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    try {
      const warehouse = await this.prisma.warehouse.create({
        data: { organizationId: user.organizationId, code: parsed.data.code.toUpperCase(), name: parsed.data.name },
      });
      await this.audit(user, request, "warehouse.created", warehouse.id, null, warehouse);
      return warehouse;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new ConflictException("仓库编码已存在");
      throw error;
    }
  }

  async update(user: AuthUser, id: string, input: unknown, request: Request) {
    const parsed = updateWarehouseSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const before = await this.prisma.warehouse.findFirst({ where: { id, organizationId: user.organizationId } });
    if (!before) throw new BadRequestException("仓库不存在");
    if (!parsed.data.active && before.active) {
      const activeCount = await this.prisma.warehouse.count({ where: { organizationId: user.organizationId, active: true } });
      if (activeCount <= 1) throw new ConflictException("至少需要保留一个启用仓库");
    }
    try {
      const warehouse = await this.prisma.warehouse.update({
        where: { id },
        data: { code: parsed.data.code.toUpperCase(), name: parsed.data.name, active: parsed.data.active },
      });
      await this.audit(user, request, "warehouse.updated", id, before, warehouse);
      return warehouse;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new ConflictException("仓库编码已存在");
      throw error;
    }
  }

  private audit(user: AuthUser, request: Request, action: string, entityId: string, before: unknown, after: unknown) {
    return this.prisma.auditEvent.create({
      data: {
        organizationId: user.organizationId,
        actorId: user.id,
        action,
        entityType: "Warehouse",
        entityId,
        before: before == null ? Prisma.JsonNull : json(before),
        after: after == null ? Prisma.JsonNull : json(after),
        ip: request.ip,
      },
    });
  }
}

@Controller("warehouses")
class WarehousesController {
  constructor(private readonly service: WarehousesService) {}

  @Get()
  @RequirePermissions("inventory.view")
  list(@CurrentUser() user: AuthUser) {
    return this.service.list(user);
  }

  @Post()
  @RequirePermissions("warehouses.manage")
  create(@CurrentUser() user: AuthUser, @Body() input: unknown, @Req() request: Request) {
    return this.service.create(user, input, request);
  }

  @Put(":id")
  @RequirePermissions("warehouses.manage")
  update(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() input: unknown, @Req() request: Request) {
    return this.service.update(user, id, input, request);
  }
}

@Module({ controllers: [WarehousesController], providers: [WarehousesService], exports: [WarehousesService] })
export class WarehousesModule {}
