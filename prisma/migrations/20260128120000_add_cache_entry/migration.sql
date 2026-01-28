-- CreateTable
CREATE TABLE "CacheEntry" (
    "id" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CacheEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CacheEntry_namespace_idx" ON "CacheEntry"("namespace");

-- CreateIndex
CREATE UNIQUE INDEX "CacheEntry_namespace_key_key" ON "CacheEntry"("namespace", "key");
