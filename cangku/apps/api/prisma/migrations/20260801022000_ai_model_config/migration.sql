CREATE TABLE "AiModelConfig" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "baseUrl" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "encryptedApiKey" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "updatedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AiModelConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiModelConfig_organizationId_key" ON "AiModelConfig"("organizationId");
CREATE INDEX "AiModelConfig_updatedAt_idx" ON "AiModelConfig"("updatedAt");

ALTER TABLE "AiModelConfig" ADD CONSTRAINT "AiModelConfig_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AiModelConfig" ADD CONSTRAINT "AiModelConfig_updatedById_fkey"
  FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
