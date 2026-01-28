/**
 * Persistent cache store using the database as backend.
 * Replaces in-memory Map caches to survive restarts and support multi-instance deployments.
 *
 * Addresses issues: V-01, R-01, R-02, F-01
 *
 * @example
 * ```typescript
 * const voiceRetryCache = new CacheStore("voice_retry");
 *
 * // Set with optional TTL (1 hour)
 * await voiceRetryCache.set("msg123", { attempts: 1, timestamp: Date.now() }, 60 * 60 * 1000);
 *
 * // Get
 * const record = await voiceRetryCache.get<RetryRecord>("msg123");
 *
 * // Delete
 * await voiceRetryCache.delete("msg123");
 *
 * // Cleanup expired entries (call periodically)
 * const cleaned = await voiceRetryCache.cleanup();
 * ```
 */

import { prisma } from "../db.js";

/**
 * Database-backed cache store with namespace isolation and optional TTL support.
 */
export class CacheStore {
  /**
   * Creates a new CacheStore instance.
   * @param namespace - Unique namespace to isolate cache entries (e.g., "voice_retry", "readings_bookmark")
   */
  constructor(private namespace: string) {}

  /**
   * Retrieve a cached value by key.
   * Returns null if the key doesn't exist or has expired.
   * @param key - The cache key to retrieve
   * @returns The cached value or null
   */
  async get<T>(key: string): Promise<T | null> {
    const entry = await prisma.cacheEntry.findUnique({
      where: {
        namespace_key: {
          namespace: this.namespace,
          key,
        },
      },
    });

    if (!entry) {
      return null;
    }

    // Check if expired
    if (entry.expiresAt && entry.expiresAt < new Date()) {
      // Expired - delete and return null
      await prisma.cacheEntry.delete({
        where: { id: entry.id },
      });
      return null;
    }

    return entry.value as T;
  }

  /**
   * Store a value in the cache.
   * Uses upsert to handle both insert and update cases.
   * @param key - The cache key
   * @param value - The value to cache (must be JSON-serializable)
   * @param ttlMs - Optional time-to-live in milliseconds
   */
  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const expiresAt = ttlMs ? new Date(Date.now() + ttlMs) : null;

    await prisma.cacheEntry.upsert({
      where: {
        namespace_key: {
          namespace: this.namespace,
          key,
        },
      },
      create: {
        namespace: this.namespace,
        key,
        value: value as any, // Prisma Json type
        expiresAt,
      },
      update: {
        value: value as any,
        expiresAt,
      },
    });
  }

  /**
   * Delete a cached value by key.
   * No-op if the key doesn't exist.
   * @param key - The cache key to delete
   */
  async delete(key: string): Promise<void> {
    await prisma.cacheEntry.deleteMany({
      where: {
        namespace: this.namespace,
        key,
      },
    });
  }

  /**
   * Delete all entries in this namespace.
   * Useful for testing or resetting state.
   * @returns Number of entries deleted
   */
  async clear(): Promise<number> {
    const result = await prisma.cacheEntry.deleteMany({
      where: {
        namespace: this.namespace,
      },
    });
    return result.count;
  }

  /**
   * Remove all expired entries from this namespace.
   * Call periodically to keep the cache table clean.
   * @returns Number of entries cleaned up
   */
  async cleanup(): Promise<number> {
    const result = await prisma.cacheEntry.deleteMany({
      where: {
        namespace: this.namespace,
        expiresAt: {
          lt: new Date(),
        },
      },
    });
    return result.count;
  }

  /**
   * Check if a key exists and is not expired.
   * @param key - The cache key to check
   * @returns true if the key exists and is valid
   */
  async has(key: string): Promise<boolean> {
    const value = await this.get(key);
    return value !== null;
  }

  /**
   * Get multiple values by keys.
   * Returns a Map with only the found (non-expired) entries.
   * @param keys - Array of cache keys to retrieve
   * @returns Map of key to value for found entries
   */
  async getMany<T>(keys: string[]): Promise<Map<string, T>> {
    const entries = await prisma.cacheEntry.findMany({
      where: {
        namespace: this.namespace,
        key: { in: keys },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    });

    const result = new Map<string, T>();
    for (const entry of entries) {
      result.set(entry.key, entry.value as T);
    }
    return result;
  }

  /**
   * Set multiple key-value pairs with the same TTL.
   * @param entries - Map or array of [key, value] pairs
   * @param ttlMs - Optional time-to-live in milliseconds for all entries
   */
  async setMany<T>(
    entries: Map<string, T> | [string, T][],
    ttlMs?: number
  ): Promise<void> {
    const pairs = entries instanceof Map ? Array.from(entries) : entries;
    const expiresAt = ttlMs ? new Date(Date.now() + ttlMs) : null;

    // Use transaction for atomicity
    await prisma.$transaction(
      pairs.map(([key, value]) =>
        prisma.cacheEntry.upsert({
          where: {
            namespace_key: {
              namespace: this.namespace,
              key,
            },
          },
          create: {
            namespace: this.namespace,
            key,
            value: value as any,
            expiresAt,
          },
          update: {
            value: value as any,
            expiresAt,
          },
        })
      )
    );
  }

  /**
   * Update the TTL of an existing entry without changing its value.
   * No-op if the key doesn't exist.
   * @param key - The cache key
   * @param ttlMs - New time-to-live in milliseconds (null to remove TTL)
   * @returns true if the entry was updated, false if not found
   */
  async touch(key: string, ttlMs: number | null): Promise<boolean> {
    const expiresAt = ttlMs ? new Date(Date.now() + ttlMs) : null;

    const result = await prisma.cacheEntry.updateMany({
      where: {
        namespace: this.namespace,
        key,
      },
      data: {
        expiresAt,
      },
    });

    return result.count > 0;
  }
}

/**
 * Global cleanup function to remove expired entries from all namespaces.
 * Call this periodically (e.g., every hour) to keep the cache table clean.
 * @returns Number of entries cleaned up
 */
export async function cleanupAllExpiredCacheEntries(): Promise<number> {
  const result = await prisma.cacheEntry.deleteMany({
    where: {
      expiresAt: {
        lt: new Date(),
      },
    },
  });
  return result.count;
}
