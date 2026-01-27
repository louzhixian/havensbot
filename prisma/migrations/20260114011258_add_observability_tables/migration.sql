-- CreateEnum
CREATE TYPE "MetricType" AS ENUM ('llm_call', 'rss_fetch', 'digest_run', 'editorial_run', 'deeper_run', 'error', 'discord_message', 'system');

-- CreateEnum
CREATE TYPE "MetricStatus" AS ENUM ('success', 'failure', 'degraded');

-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('llm_failure_rate', 'llm_cost_high', 'llm_token_limit', 'storage_warning', 'rss_failure', 'digest_failure', 'editorial_failure');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('info', 'warning', 'error', 'critical');

-- AlterTable
ALTER TABLE "Item" ADD COLUMN "archivedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ObservabilityMetric" (
    "id" TEXT NOT NULL,
    "type" "MetricType" NOT NULL,
    "operation" TEXT NOT NULL,
    "status" "MetricStatus" NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ObservabilityMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemAlert" (
    "id" TEXT NOT NULL,
    "alertType" "AlertType" NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" TIMESTAMP(3),
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Item_createdAt_idx" ON "Item"("createdAt");

-- CreateIndex
CREATE INDEX "Item_archivedAt_idx" ON "Item"("archivedAt");

-- CreateIndex
CREATE INDEX "Item_sourceId_createdAt_idx" ON "Item"("sourceId", "createdAt");

-- CreateIndex
CREATE INDEX "ObservabilityMetric_type_createdAt_idx" ON "ObservabilityMetric"("type", "createdAt");

-- CreateIndex
CREATE INDEX "ObservabilityMetric_status_createdAt_idx" ON "ObservabilityMetric"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ObservabilityMetric_operation_createdAt_idx" ON "ObservabilityMetric"("operation", "createdAt");

-- CreateIndex
CREATE INDEX "SystemAlert_resolved_severity_createdAt_idx" ON "SystemAlert"("resolved", "severity", "createdAt");
