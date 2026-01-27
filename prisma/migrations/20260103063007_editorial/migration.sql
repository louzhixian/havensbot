-- CreateEnum
CREATE TYPE "ContentQuality" AS ENUM ('title_only', 'snippet', 'fulltext');

-- CreateEnum
CREATE TYPE "EditorialReportStatus" AS ENUM ('success', 'failed');

-- AlterTable
ALTER TABLE "Item" ADD COLUMN "contentQuality" "ContentQuality";
ALTER TABLE "Item" ADD COLUMN "writingSuggestions" JSONB;
ALTER TABLE "Item" ADD COLUMN "enrichedAt" TIMESTAMP(3);
ALTER TABLE "Item" ADD COLUMN "enrichErrorReason" TEXT;

-- CreateTable
CREATE TABLE "EditorialReport" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "status" "EditorialReportStatus" NOT NULL,
    "content" TEXT NOT NULL,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EditorialReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EditorialReport_channelId_createdAt_idx" ON "EditorialReport"("channelId", "createdAt");
