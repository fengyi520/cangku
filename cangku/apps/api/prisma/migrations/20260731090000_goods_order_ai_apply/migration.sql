ALTER TABLE "ImportJob"
  ADD COLUMN "appliedDocumentId" TEXT,
  ADD COLUMN "appliedAt" TIMESTAMP(3);

CREATE INDEX "ImportJob_appliedDocumentId_idx" ON "ImportJob"("appliedDocumentId");

ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_appliedDocumentId_fkey"
  FOREIGN KEY ("appliedDocumentId") REFERENCES "StockDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;
