/**
 * Retry cache for managing failed voice message retries
 *
 * V-01: Migrated from in-memory Map to CacheStore for persistence across restarts.
 */

import { CacheStore } from "../utils/cache-store.js";
import type { RetryRecord } from "./types.js";

/** Maximum number of retry attempts allowed per voice message */
const MAX_RETRY_ATTEMPTS = 3;

/** Time-to-live for retry records in milliseconds (24 hours) */
const RECORD_TTL_MS = 24 * 60 * 60 * 1000;

/** Database-backed cache store for retry records */
const retryCacheStore = new CacheStore("voice_retry");

/**
 * Cache class for managing retry records of failed voice message transcriptions.
 * Allows users to retry failed transcriptions up to MAX_RETRY_ATTEMPTS times.
 * Records automatically expire after RECORD_TTL_MS (24 hours).
 *
 * Uses database-backed CacheStore instead of in-memory Map to survive restarts.
 */
export class RetryCache {
  /**
   * Store a retry record for a voice message
   * @param messageId - The original voice message ID from Discord
   * @param record - The retry record to store
   */
  async set(messageId: string, record: RetryRecord): Promise<void> {
    await retryCacheStore.set(messageId, record, RECORD_TTL_MS);
  }

  /**
   * Get a retry record by voice message ID
   * @param messageId - The voice message ID to look up
   * @returns The retry record if found, null otherwise
   */
  async get(messageId: string): Promise<RetryRecord | null> {
    return retryCacheStore.get<RetryRecord>(messageId);
  }

  /**
   * Check if retry is allowed for a given message (attempts < MAX_RETRY_ATTEMPTS)
   * @param messageId - The voice message ID to check
   * @returns true if retry is allowed, false otherwise
   */
  async canRetry(messageId: string): Promise<boolean> {
    const record = await retryCacheStore.get<RetryRecord>(messageId);
    if (!record) {
      return false;
    }
    return record.attempts < MAX_RETRY_ATTEMPTS;
  }

  /**
   * Increment the attempt count for a message
   * @param messageId - The voice message ID to increment
   */
  async incrementAttempts(messageId: string): Promise<void> {
    const record = await retryCacheStore.get<RetryRecord>(messageId);
    if (record) {
      record.attempts += 1;
      await retryCacheStore.set(messageId, record, RECORD_TTL_MS);
    }
  }

  /**
   * Remove expired records from the cache.
   * CacheStore handles TTL automatically, but this can be called for explicit cleanup.
   * @returns Number of entries cleaned up
   */
  async cleanup(): Promise<number> {
    return retryCacheStore.cleanup();
  }
}

/** Singleton instance of RetryCache for use across the application */
export const retryCache = new RetryCache();
