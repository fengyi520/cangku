import {
  BadRequestException,
  Body,
  CanActivate,
  ConflictException,
  Controller,
  Delete,
  ExecutionContext,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  Param,
  Post,
  Put,
  Req,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import { APP_GUARD, Reflector } from "@nestjs/core";
import { Request, Response } from "express";
import { createHash, randomBytes } from "node:crypto";
import { hash, verify } from "argon2";
import { createMemberSchema, loginSchema, updateMemberSchema, updateSelfSchema } from "@cangku/contracts";
import { PrismaService } from "./prisma.module";
import { AuthUser, CurrentUser, IS_PUBLIC_KEY, PERMISSIONS_KEY, Public, RequirePermissions } from "./auth-context";

type AuthRequest = Request & { user?: AuthUser };

const SESSION_COOKIE = "cangku_session";
const CSRF_COOKIE = "cangku_csrf";

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

@Injectable()
class SessionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext) {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()])) return true;
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const token = request.cookies?.[SESSION_COOKIE];
    if (!token) throw new UnauthorizedException("请先登录");
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: tokenHash(token) },
      include: { user: { include: { role: true } } },
    });
    if (!session || session.expiresAt <= new Date() || session.user.status !== "ACTIVE") {
      throw new UnauthorizedException("登录已失效，请重新登录");
    }
    request.user = {
      id: session.user.id,
      organizationId: session.user.organizationId,
      email: session.user.email,
      name: session.user.name,
      role: session.user.role,
    };
    return true;
  }
}

@Injectable()
class CsrfGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext) {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()])) return true;
    const request = context.switchToHttp().getRequest<Request>();
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;
    const cookie = request.cookies?.[CSRF_COOKIE];
    const header = request.header("x-csrf-token");
    if (!cookie || !header || cookie !== header) throw new ForbiddenException("CSRF 校验失败，请刷新页面后重试");
    return true;
  }
}

@Injectable()
class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext) {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [context.getHandler(), context.getClass()]) ?? [];
    if (!required.length) return true;
    const user = context.switchToHttp().getRequest<AuthRequest>().user;
    if (!user) throw new UnauthorizedException();
    const granted = (permission: string) => {
      if (user.role.permissions.includes("*") || user.role.permissions.includes(permission)) return true;
      const [resource, action] = permission.split(".");
      return action === "view" && user.role.permissions.includes(`${resource}.manage`);
    };
    if (required.every(granted)) return true;
    throw new ForbiddenException("当前角色没有执行此操作的权限");
  }
}

@Controller("auth")
class AuthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Post("login")
  async login(@Body() input: unknown, @Res({ passthrough: true }) response: Response) {
    const parsed = loginSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const user = await this.prisma.user.findUnique({ where: { email: parsed.data.email.toLowerCase() }, include: { role: true } });
    if (!user || user.status !== "ACTIVE" || !(await verify(user.passwordHash, parsed.data.password))) {
      throw new UnauthorizedException("邮箱或密码错误");
    }
    const token = randomBytes(32).toString("base64url");
    const csrf = randomBytes(24).toString("base64url");
    await this.prisma.session.create({
      data: { userId: user.id, tokenHash: tokenHash(token), expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
    });
    const secure = process.env.NODE_ENV === "production";
    response.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: "strict", secure, maxAge: 7 * 24 * 60 * 60 * 1000, path: "/" });
    response.cookie(CSRF_COOKIE, csrf, { httpOnly: false, sameSite: "strict", secure, maxAge: 7 * 24 * 60 * 60 * 1000, path: "/" });
    return { user: { id: user.id, email: user.email, name: user.name, role: user.role } };
  }

  @Get("me")
  me(@CurrentUser() user: AuthUser) {
    return { user };
  }

  @Put("me")
  async updateMe(@Body() input: unknown, @CurrentUser() user: AuthUser, @Req() request: Request) {
    const parsed = updateSelfSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    try {
      const before = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id }, include: { role: true } });
      const updated = await this.prisma.user.update({
        where: { id: user.id },
        data: {
          name: parsed.data.name,
          email: parsed.data.email.toLowerCase(),
          ...(parsed.data.password ? { passwordHash: await hash(parsed.data.password, { type: 2 }) } : {}),
        },
        include: { role: true },
      });
      await this.prisma.auditEvent.create({ data: { organizationId: user.organizationId, actorId: user.id, action: "member.self_updated", entityType: "User", entityId: user.id, before, after: updated, ip: request.ip } });
      return { user: { id: updated.id, organizationId: updated.organizationId, email: updated.email, name: updated.name, role: updated.role } };
    } catch (error) {
      if (String(error).includes("Unique constraint")) throw new ConflictException("该邮箱已存在");
      throw error;
    }
  }

  @Post("logout")
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const token = request.cookies?.[SESSION_COOKIE];
    if (token) await this.prisma.session.deleteMany({ where: { tokenHash: tokenHash(token) } });
    response.clearCookie(SESSION_COOKIE, { path: "/" });
    response.clearCookie(CSRF_COOKIE, { path: "/" });
    return { ok: true };
  }
}

@Controller("members")
@RequirePermissions("members.manage")
class MembersController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@CurrentUser() user: AuthUser) {
    return this.prisma.user.findMany({
      where: { organizationId: user.organizationId },
      select: { id: true, email: true, name: true, status: true, createdAt: true, role: { select: { id: true, code: true, name: true, permissions: true } } },
      orderBy: { createdAt: "asc" },
    });
  }

  @Post()
  async create(@Body() input: unknown, @CurrentUser() user: AuthUser, @Req() request: Request) {
    const parsed = createMemberSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const role = await this.prisma.role.findFirst({ where: { id: parsed.data.roleId, organizationId: user.organizationId } });
    if (!role) throw new BadRequestException("角色不存在");
    try {
      const created = await this.prisma.user.create({
        data: {
          organizationId: user.organizationId,
          roleId: role.id,
          email: parsed.data.email.toLowerCase(),
          name: parsed.data.name,
          passwordHash: await hash(parsed.data.password, { type: 2 }),
        },
        select: { id: true, email: true, name: true, status: true, role: true },
      });
      await this.prisma.auditEvent.create({
        data: { organizationId: user.organizationId, actorId: user.id, action: "member.created", entityType: "User", entityId: created.id, after: created, ip: request.ip },
      });
      return created;
    } catch (error) {
      if (String(error).includes("Unique constraint")) throw new ConflictException("该邮箱已存在");
      throw error;
    }
  }

  @Put(":id")
  async update(@Param("id") id: string, @Body() input: unknown, @CurrentUser() user: AuthUser, @Req() request: Request) {
    if (user.role.code !== "OWNER") throw new ForbiddenException("只有仓库所有者可以修改成员账号");
    const parsed = updateMemberSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const role = await this.prisma.role.findFirst({ where: { id: parsed.data.roleId, organizationId: user.organizationId } });
    if (!role) throw new BadRequestException("角色不存在");
    const before = await this.prisma.user.findFirst({ where: { id, organizationId: user.organizationId }, include: { role: true } });
    if (!before) throw new BadRequestException("成员不存在");
    try {
      const updated = await this.prisma.user.update({
        where: { id },
        data: {
          name: parsed.data.name,
          email: parsed.data.email.toLowerCase(),
          roleId: role.id,
          ...(parsed.data.password ? { passwordHash: await hash(parsed.data.password, { type: 2 }) } : {}),
        },
        select: { id: true, email: true, name: true, status: true, createdAt: true, role: { select: { id: true, code: true, name: true, permissions: true } } },
      });
      if (parsed.data.password) await this.prisma.session.deleteMany({ where: { userId: id } });
      await this.prisma.auditEvent.create({ data: { organizationId: user.organizationId, actorId: user.id, action: "member.updated", entityType: "User", entityId: id, before, after: updated, ip: request.ip } });
      return updated;
    } catch (error) {
      if (String(error).includes("Unique constraint")) throw new ConflictException("该邮箱已存在");
      throw error;
    }
  }

  @Post(":id/restore")
  async restore(@Param("id") id: string, @CurrentUser() user: AuthUser, @Req() request: Request) {
    if (user.role.code !== "OWNER") throw new ForbiddenException("只有仓库所有者可以恢复成员账号");
    const before = await this.prisma.user.findFirst({ where: { id, organizationId: user.organizationId }, include: { role: true } });
    if (!before) throw new BadRequestException("成员不存在");
    const updated = await this.prisma.user.update({ where: { id }, data: { status: "ACTIVE" }, select: { id: true, email: true, name: true, status: true, createdAt: true, role: { select: { id: true, code: true, name: true, permissions: true } } } });
    await this.prisma.auditEvent.create({ data: { organizationId: user.organizationId, actorId: user.id, action: "member.restored", entityType: "User", entityId: id, before, after: updated, ip: request.ip } });
    return updated;
  }

  @Delete(":id")
  async remove(@Param("id") id: string, @CurrentUser() user: AuthUser, @Req() request: Request) {
    if (user.role.code !== "OWNER") throw new ForbiddenException("只有仓库所有者可以删除成员账号");
    if (id === user.id) throw new BadRequestException("不能在成员列表删除自己的账号，请修改自己的账号信息");
    const before = await this.prisma.user.findFirst({ where: { id, organizationId: user.organizationId }, include: { role: true } });
    if (!before) throw new BadRequestException("成员不存在");
    const updated = await this.prisma.user.update({ where: { id }, data: { status: "DISABLED" }, select: { id: true, email: true, name: true, status: true, createdAt: true, role: { select: { id: true, code: true, name: true, permissions: true } } } });
    await this.prisma.session.deleteMany({ where: { userId: id } });
    await this.prisma.auditEvent.create({ data: { organizationId: user.organizationId, actorId: user.id, action: "member.disabled", entityType: "User", entityId: id, before, after: updated, ip: request.ip } });
    return updated;
  }
}

@Controller("roles")
class RolesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@CurrentUser() user: AuthUser) {
    return this.prisma.role.findMany({ where: { organizationId: user.organizationId }, orderBy: { name: "asc" } });
  }

  @Put(":id")
  @RequirePermissions("members.manage")
  async update(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: { name?: string; permissions?: string[] }, @Req() request: Request) {
    if (user.role.code !== "OWNER") throw new ForbiddenException("只有仓库所有者可以修改角色权限");
    const role = await this.prisma.role.findFirst({ where: { id, organizationId: user.organizationId } });
    if (!role) throw new BadRequestException("角色不存在");
    if (role.code === "OWNER") throw new ForbiddenException("所有者角色不可修改");
    const updated = await this.prisma.role.update({ where: { id }, data: { name: body.name, permissions: Array.isArray(body.permissions) ? body.permissions : role.permissions } });
    await this.prisma.auditEvent.create({ data: { organizationId: user.organizationId, actorId: user.id, action: "role.updated", entityType: "Role", entityId: id, before: role, after: updated, ip: request.ip } });
    return updated;
  }
}

@Module({
  controllers: [AuthController, MembersController, RolesController],
  providers: [
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AuthModule {}
