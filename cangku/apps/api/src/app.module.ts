import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { ScheduleModule } from "@nestjs/schedule";
import { AiChatModule } from "./ai-chat.module";
import { AiConfigModule } from "./ai-config.module";
import { AuthModule } from "./auth.module";
import { DailyOutboundModule } from "./daily-outbound.module";
import { HealthController } from "./health.controller";
import { JobsModule } from "./jobs.module";
import { PrismaModule } from "./prisma.module";
import { SimpleImportsModule } from "./simple-imports.module";
import { InventoryWorkflowModule } from "./inventory-workflow.module";
import { WarehouseModule } from "./warehouse.module";
import { WarehousesModule } from "./warehouses.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ["../../.env", ".env"] }),
    ThrottlerModule.forRoot([{ name: "default", ttl: 60_000, limit: 120 }]),
    ScheduleModule.forRoot(),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get("REDIS_HOST", "127.0.0.1"),
          port: Number(config.get("REDIS_PORT", 6379)),
          password: config.get<string>("REDIS_PASSWORD") || undefined,
        },
      }),
    }),
    PrismaModule,
    AiConfigModule,
    AiChatModule,
    AuthModule,
    WarehouseModule,
    WarehousesModule,
    JobsModule,
    DailyOutboundModule,
    SimpleImportsModule,
    InventoryWorkflowModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
