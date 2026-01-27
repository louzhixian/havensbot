-- CreateEnum
CREATE TYPE "ChannelConfigRole" AS ENUM ('digest_source', 'digest_output', 'deep_dive_output', 'diary', 'favorites', 'editorial');

-- CreateTable
CREATE TABLE "ChannelConfig" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT,
    "categoryId" TEXT,
    "role" "ChannelConfigRole" NOT NULL,
    "digestCron" TEXT,
    "digestFormat" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChannelConfig_guildId_role_idx" ON "ChannelConfig"("guildId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelConfig_guildId_channelId_role_key" ON "ChannelConfig"("guildId", "channelId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelConfig_guildId_categoryId_role_key" ON "ChannelConfig"("guildId", "categoryId", "role");
