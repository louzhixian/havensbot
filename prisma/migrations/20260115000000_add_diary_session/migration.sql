-- CreateTable
CREATE TABLE "DiarySession" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "threadId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "exportPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiarySession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DiarySession_threadId_key" ON "DiarySession"("threadId");

-- CreateIndex
CREATE INDEX "DiarySession_date_idx" ON "DiarySession"("date");

-- CreateIndex
CREATE INDEX "DiarySession_channelId_idx" ON "DiarySession"("channelId");
