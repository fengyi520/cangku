-- CreateEnum
CREATE TYPE "DailyOutboundStatus" AS ENUM ('OPEN', 'PROCESSING', 'POSTED', 'FAILED', 'REVERSED');

-- CreateEnum
CREATE TYPE "DailyOutboundKind" AS ENUM ('AUTOMATIC', 'SUPPLEMENT');

-- CreateEnum
CREATE TYPE "SimpleImportKind" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "SimpleImportStatus" AS ENUM ('REVIEW', 'COMPLETED');

-- Prevent ambiguous product matches for fixed-template imports.
CREATE UNIQUE INDEX "Sku_styleId_color_size_key" ON "Sku"("styleId", "color", "size");

-- CreateTable
CREATE TABLE "WarehouseAutomationSetting" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "autoOutboundTime" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    "effectiveFrom" DATE NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WarehouseAutomationSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyOutboundBatch" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "kind" "DailyOutboundKind" NOT NULL DEFAULT 'AUTOMATIC',
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "status" "DailyOutboundStatus" NOT NULL DEFAULT 'OPEN',
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "error" TEXT,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "documentId" TEXT,
    "reversalDocumentId" TEXT,
    "postedAt" TIMESTAMP(3),
    "reversedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DailyOutboundBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyOutboundLine" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DailyOutboundLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SimpleImportSession" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "SimpleImportKind" NOT NULL,
    "businessDate" DATE,
    "fileName" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "dedupKey" TEXT NOT NULL,
    "rows" JSONB NOT NULL,
    "status" "SimpleImportStatus" NOT NULL DEFAULT 'REVIEW',
    "createdById" TEXT NOT NULL,
    "documentId" TEXT,
    "dailyBatchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "SimpleImportSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WarehouseAutomationSetting_organizationId_effectiveFrom_key" ON "WarehouseAutomationSetting"("organizationId", "effectiveFrom");
CREATE INDEX "WarehouseAutomationSetting_organizationId_effectiveFrom_idx" ON "WarehouseAutomationSetting"("organizationId", "effectiveFrom");
CREATE UNIQUE INDEX "DailyOutboundBatch_documentId_key" ON "DailyOutboundBatch"("documentId");
CREATE UNIQUE INDEX "DailyOutboundBatch_reversalDocumentId_key" ON "DailyOutboundBatch"("reversalDocumentId");
CREATE UNIQUE INDEX "DailyOutboundBatch_organizationId_businessDate_sequence_key" ON "DailyOutboundBatch"("organizationId", "businessDate", "sequence");
CREATE INDEX "DailyOutboundBatch_status_scheduledAt_idx" ON "DailyOutboundBatch"("status", "scheduledAt");
CREATE INDEX "DailyOutboundBatch_organizationId_businessDate_createdAt_idx" ON "DailyOutboundBatch"("organizationId", "businessDate", "createdAt");
CREATE UNIQUE INDEX "DailyOutboundLine_batchId_skuId_key" ON "DailyOutboundLine"("batchId", "skuId");
CREATE INDEX "DailyOutboundLine_skuId_idx" ON "DailyOutboundLine"("skuId");
CREATE UNIQUE INDEX "SimpleImportSession_dedupKey_key" ON "SimpleImportSession"("dedupKey");
CREATE UNIQUE INDEX "SimpleImportSession_documentId_key" ON "SimpleImportSession"("documentId");
CREATE INDEX "SimpleImportSession_organizationId_kind_status_createdAt_idx" ON "SimpleImportSession"("organizationId", "kind", "status", "createdAt");

ALTER TABLE "WarehouseAutomationSetting" ADD CONSTRAINT "WarehouseAutomationSetting_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WarehouseAutomationSetting" ADD CONSTRAINT "WarehouseAutomationSetting_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DailyOutboundBatch" ADD CONSTRAINT "DailyOutboundBatch_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DailyOutboundBatch" ADD CONSTRAINT "DailyOutboundBatch_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DailyOutboundBatch" ADD CONSTRAINT "DailyOutboundBatch_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DailyOutboundBatch" ADD CONSTRAINT "DailyOutboundBatch_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DailyOutboundBatch" ADD CONSTRAINT "DailyOutboundBatch_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "StockDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DailyOutboundBatch" ADD CONSTRAINT "DailyOutboundBatch_reversalDocumentId_fkey" FOREIGN KEY ("reversalDocumentId") REFERENCES "StockDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DailyOutboundLine" ADD CONSTRAINT "DailyOutboundLine_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "DailyOutboundBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DailyOutboundLine" ADD CONSTRAINT "DailyOutboundLine_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SimpleImportSession" ADD CONSTRAINT "SimpleImportSession_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SimpleImportSession" ADD CONSTRAINT "SimpleImportSession_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SimpleImportSession" ADD CONSTRAINT "SimpleImportSession_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "StockDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SimpleImportSession" ADD CONSTRAINT "SimpleImportSession_dailyBatchId_fkey" FOREIGN KEY ("dailyBatchId") REFERENCES "DailyOutboundBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
