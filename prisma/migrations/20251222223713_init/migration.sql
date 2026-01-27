-- CreateEnum
CREATE TYPE "SourceType" AS ENUM ('RSS');

-- CreateTable
CREATE TABLE "Source" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "type" "SourceType" NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "etag" TEXT,
    "lastModified" TEXT,
    "lastFetchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Item" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "contentSnippet" TEXT,
    "contentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Digest" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "rangeStart" TIMESTAMP(3) NOT NULL,
    "rangeEnd" TIMESTAMP(3) NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Digest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Source_channelId_type_url_key" ON "Source"("channelId", "type", "url");

-- CreateIndex
CREATE UNIQUE INDEX "Item_sourceId_contentHash_key" ON "Item"("sourceId", "contentHash");

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

