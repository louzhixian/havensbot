-- R-03: Add ReadingBookmark model to prevent concurrent creation of duplicate bookmarks

-- CreateTable
CREATE TABLE "ReadingBookmark" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "articleUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReadingBookmark_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReadingBookmark_messageId_key" ON "ReadingBookmark"("messageId");

-- CreateIndex
CREATE INDEX "ReadingBookmark_guildId_idx" ON "ReadingBookmark"("guildId");

-- CreateIndex
CREATE INDEX "ReadingBookmark_threadId_idx" ON "ReadingBookmark"("threadId");
