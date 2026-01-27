-- AlterEnum
ALTER TYPE "MetricType" ADD VALUE 'whisper_transcribe';

-- DropIndex
DROP INDEX "EditorialReport_channelId_createdAt_idx";

-- CreateTable
CREATE TABLE "GuildSettings" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "locale" TEXT NOT NULL DEFAULT 'en',
    "tier" TEXT NOT NULL DEFAULT 'free',
    "tierExpiresAt" TIMESTAMP(3),
    "enabledSkills" TEXT[] DEFAULT ARRAY['digest', 'favorites']::TEXT[],
    "rssSourceLimit" INTEGER NOT NULL DEFAULT 10,
    "llmDailyQuota" INTEGER NOT NULL DEFAULT 0,
    "llmUsedToday" INTEGER NOT NULL DEFAULT 0,
    "skillConfigs" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuildSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GuildSettings_guildId_key" ON "GuildSettings"("guildId");

-- CreateIndex
CREATE INDEX "GuildSettings_tier_idx" ON "GuildSettings"("tier");
