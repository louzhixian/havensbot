-- D-04: Add userId to DiarySession for per-user concurrency limit

-- Step 1: Add userId column as nullable
ALTER TABLE "DiarySession" ADD COLUMN "userId" TEXT;

-- Step 2: Set default value for existing rows (if any)
-- Use a placeholder user ID for existing sessions
UPDATE "DiarySession" SET "userId" = 'unknown' WHERE "userId" IS NULL;

-- Step 3: Make userId NOT NULL
ALTER TABLE "DiarySession" ALTER COLUMN "userId" SET NOT NULL;

-- Step 4: Add index for efficient user active session lookups
CREATE INDEX "DiarySession_guildId_userId_endedAt_idx" ON "DiarySession"("guildId", "userId", "endedAt");
