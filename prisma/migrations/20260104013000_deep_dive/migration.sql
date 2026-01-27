-- Add deep dive analysis fields to items
ALTER TABLE "Item"
ADD COLUMN "deepDive" TEXT,
ADD COLUMN "deepDiveAt" TIMESTAMP(3),
ADD COLUMN "deepDiveErrorReason" TEXT;
