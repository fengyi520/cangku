import { BadRequestException, Body, Controller, ForbiddenException, Get, Global, Injectable, Module, Post, Put, Req } from "@nestjs/common";
import { aiModelConfigSchema } from "@cangku/contracts";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Request } from "express";
import { AuthUser, CurrentUser, RequirePermissions } from "./auth-context";
import { PrismaService } from "./prisma.module";

type ResolvedAiConfig = { baseUrl: string; model: string; apiKey: string; enabled: boolean; source: "database" | "environment" };

@Injectable()
export class AiConfigService {
  constructor(private readonly prisma: PrismaService) {}

  private encryptionKey() {
    const secret = process.env.AI_CONFIG_ENCRYPTION_KEY || process.env.PREVIEW_TOKEN_SECRET;
    if (!secret) throw new BadRequestException("后端未配置 AI 配置加密密钥，请设置 AI_CONFIG_ENCRYPTION_KEY");
    return createHash("sha256").update(secret).digest();
  }

  private encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
  }

  private decrypt(value: string) {
    const [version, iv, tag, encrypted] = value.split(".");
    if (version !== "v1" || !iv || !tag || !encrypted) throw new BadRequestException("AI 密钥数据格式无效");
    const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
  }

  async resolve(organizationId: string): Promise<ResolvedAiConfig | null> {
    const saved = await this.prisma.aiModelConfig.findUnique({ where: { organizationId } });
    if (saved?.enabled) return { baseUrl: saved.baseUrl, model: saved.model, apiKey: this.decrypt(saved.encryptedApiKey), enabled: true, source: "database" };
    if (process.env.AI_BASE_URL && process.env.AI_API_KEY && process.env.AI_MODEL) return { baseUrl: process.env.AI_BASE_URL.replace(/\/$/, ""), model: process.env.AI_MODEL, apiKey: process.env.AI_API_KEY, enabled: true, source: "environment" };
    return null;
  }

  async publicConfig(organizationId: string) {
    const saved = await this.prisma.aiModelConfig.findUnique({ where: { organizationId }, select: { baseUrl: true, model: true, encryptedApiKey: true, enabled: true, updatedAt: true } });
    if (saved) return { baseUrl: saved.baseUrl, model: saved.model, apiKeyMasked: saved.encryptedApiKey ? "••••••••••••" : "", hasApiKey: Boolean(saved.encryptedApiKey), enabled: saved.enabled, source: "database", updatedAt: saved.updatedAt };
    const environmentConfigured = Boolean(process.env.AI_BASE_URL && process.env.AI_API_KEY && process.env.AI_MODEL);
    return { baseUrl: process.env.AI_BASE_URL ?? "", model: process.env.AI_MODEL ?? "", apiKeyMasked: environmentConfigured ? "••••••••••••" : "", hasApiKey: environmentConfigured, enabled: environmentConfigured, source: environmentConfigured ? "environment" : "none", updatedAt: null };
  }

  async save(user: AuthUser, input: unknown, request: Request) {
    if (user.role.code !== "OWNER") throw new ForbiddenException("只有仓库所有者可以配置 AI 模型");
    const parsed = aiModelConfigSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const existing = await this.prisma.aiModelConfig.findUnique({ where: { organizationId: user.organizationId } });
    if (!existing && !parsed.data.apiKey) throw new BadRequestException("首次配置必须填写 API 密钥");
    const encryptedApiKey = parsed.data.apiKey ? this.encrypt(parsed.data.apiKey) : existing!.encryptedApiKey;
    const updated = await this.prisma.aiModelConfig.upsert({
      where: { organizationId: user.organizationId },
      create: { organizationId: user.organizationId, baseUrl: parsed.data.baseUrl, model: parsed.data.model, encryptedApiKey, enabled: parsed.data.enabled, updatedById: user.id },
      update: { baseUrl: parsed.data.baseUrl, model: parsed.data.model, encryptedApiKey, enabled: parsed.data.enabled, updatedById: user.id },
    });
    await this.prisma.auditEvent.create({ data: { organizationId: user.organizationId, actorId: user.id, action: "ai_config.updated", entityType: "AiModelConfig", entityId: updated.id, before: existing ? { baseUrl: existing.baseUrl, model: existing.model, enabled: existing.enabled } : undefined, after: { baseUrl: updated.baseUrl, model: updated.model, enabled: updated.enabled }, ip: request.ip } });
    return this.publicConfig(user.organizationId);
  }

  async test(organizationId: string) {
    const config = await this.resolve(organizationId);
    if (!config) throw new BadRequestException("请先保存 AI 模型配置");
    const startedAt = Date.now();
    const response = await fetch(`${config.baseUrl}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: config.model, temperature: 0, max_tokens: 8, messages: [{ role: "user", content: "Reply OK" }] }), signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new BadRequestException(`模型连接失败（HTTP ${response.status}）`);
    return { ok: true, latencyMs: Date.now() - startedAt, model: config.model, source: config.source };
  }
}

@Controller("settings/ai-model")
@RequirePermissions("settings.manage")
class AiConfigController {
  constructor(private readonly service: AiConfigService) {}
  @Get() get(@CurrentUser() user: AuthUser) { return this.service.publicConfig(user.organizationId); }
  @Put() save(@CurrentUser() user: AuthUser, @Body() input: unknown, @Req() request: Request) { return this.service.save(user, input, request); }
  @Post("test") test(@CurrentUser() user: AuthUser) { return this.service.test(user.organizationId); }
}

@Global()
@Module({ controllers: [AiConfigController], providers: [AiConfigService], exports: [AiConfigService] })
export class AiConfigModule {}
