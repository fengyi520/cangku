import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: false });
  const httpServer = app.getHttpAdapter().getInstance();
  if (process.env.NODE_ENV === "production") httpServer.set("trust proxy", 1);
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(cookieParser());
  app.use((request: Request, response: Response, next: NextFunction) => {
    const startedAt = performance.now();
    const requestId = request.header("x-request-id") ?? randomUUID();
    response.setHeader("x-request-id", requestId);
    response.on("finish", () => {
      console.info(JSON.stringify({
        level: "info",
        event: "http.request",
        requestId,
        method: request.method,
        path: request.originalUrl.split("?")[0],
        statusCode: response.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        ip: request.ip,
      }));
    });
    next();
  });
  app.enableCors({ origin: process.env.WEB_ORIGIN?.split(",") ?? ["http://127.0.0.1:5173"], credentials: true });
  app.setGlobalPrefix("api/v1");
  const swagger = new DocumentBuilder().setTitle("服装仓库 API").setVersion("1.0").addCookieAuth("cangku_session").build();
  SwaggerModule.setup("api/docs", app, SwaggerModule.createDocument(app, swagger));
  app.enableShutdownHooks();
  await app.listen(Number(process.env.API_PORT ?? 4000), process.env.API_HOST ?? "127.0.0.1");
}

void bootstrap();
