import { Controller, Get } from "@nestjs/common";
import { Public } from "./auth-context";
import { PrismaService } from "./prisma.module";

@Controller("health")
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  async check() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: "ok", database: "ok", timestamp: new Date().toISOString() };
  }
}
