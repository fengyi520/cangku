-- Extend stock documents with explicit recovery semantics.
ALTER TYPE "DocumentType" ADD VALUE IF NOT EXISTS 'RESTORE';

ALTER TABLE "StockDocument"
  ADD COLUMN "restoreToAt" TIMESTAMP(3);

ALTER TABLE "StockDocumentLine"
  ADD COLUMN "reservedAdjustmentDelta" INTEGER,
  ADD COLUMN "restoreTargetOnHand" INTEGER,
  ADD COLUMN "restoreTargetReserved" INTEGER;

-- Existing import records belonged to the organization's first active warehouse.
ALTER TABLE "ImportJob" ADD COLUMN "warehouseId" TEXT;
UPDATE "ImportJob" AS job
SET "warehouseId" = (
  SELECT warehouse.id FROM "Warehouse" AS warehouse
  WHERE warehouse."organizationId" = job."organizationId"
  ORDER BY warehouse."active" DESC, warehouse."createdAt" ASC
  LIMIT 1
);
ALTER TABLE "ImportJob" ALTER COLUMN "warehouseId" SET NOT NULL;

ALTER TABLE "SimpleImportSession" ADD COLUMN "warehouseId" TEXT;
UPDATE "SimpleImportSession" AS session
SET "warehouseId" = (
  SELECT warehouse.id FROM "Warehouse" AS warehouse
  WHERE warehouse."organizationId" = session."organizationId"
  ORDER BY warehouse."active" DESC, warehouse."createdAt" ASC
  LIMIT 1
);
ALTER TABLE "SimpleImportSession" ALTER COLUMN "warehouseId" SET NOT NULL;

CREATE UNIQUE INDEX "StockDocument_reversalOfId_key" ON "StockDocument"("reversalOfId");
CREATE INDEX "InventoryLedgerEntry_warehouseId_skuId_stockStatus_createdAt_idx"
  ON "InventoryLedgerEntry"("warehouseId", "skuId", "stockStatus", "createdAt");
CREATE INDEX "ImportJob_organizationId_warehouseId_status_createdAt_idx"
  ON "ImportJob"("organizationId", "warehouseId", "status", "createdAt");
DROP INDEX IF EXISTS "ImportJob_organizationId_status_createdAt_idx";
CREATE INDEX "SimpleImportSession_organizationId_warehouseId_kind_status_createdAt_idx"
  ON "SimpleImportSession"("organizationId", "warehouseId", "kind", "status", "createdAt");
DROP INDEX IF EXISTS "SimpleImportSession_organizationId_kind_status_createdAt_idx";

ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_warehouseId_fkey"
  FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SimpleImportSession" ADD CONSTRAINT "SimpleImportSession_warehouseId_fkey"
  FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockDocument" ADD CONSTRAINT "StockDocument_reversalOfId_fkey"
  FOREIGN KEY ("reversalOfId") REFERENCES "StockDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;
