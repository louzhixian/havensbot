/**
 * Retry cache for managing failed voice message retries
 */

import type { RetryRecord } from "./types.js";

/** Maximum number of retry attempts allowed per voice message */
const MAX_RETRY_ATTEMPTS = 3;

/** Time-to-live for retry records in milliseconds (1 hour) */
const RECORD_TTL_MS = 60 * 60 * 1000;

/**
 * Cache class for managing retry records of failed voice message transcriptions.
 * Allows users to retry failed transcriptions up to MAX_RETRY_ATTEMPTS times.
 * Records automatically expire after RECORD_TTL_MS.
 */
export class RetryCache {
  private cache = new Map<string, RetryRecord>();

  /**
   * Store a retry record for a voice message
   * @param messageId - The original voice message ID from Discord
   * @param record - The retry record to store
   */
  set(messageId: string, record: RetryRecord): void {
    this.cache.set(messageId, record);
  }

  /**
   * Get a retry record by voice message ID
   * @param messageId - The voice message ID to look up
   * @returns The retry record if found, undefined otherwise
   */
  get(messageId: string): RetryRecord | undefined {
    return this.cache.get(messageId);
  }

  /**
   * Check if retry is allowed for a given message (attempts < MAX_RETRY_ATTEMPTS)
   * @param messageId - The voice message ID to check
   * @returns true if retry is allowed, false otherwise
   */
  canRetry(messageId: string): boolean {
    const record = this.cache.get(messageId);
    if (!record) {
      return false;
    }
    return record.attempts < MAX_RETRY_ATTEMPTS;
  }

  /**
   * Increment the attempt count for a message
   * @param messageId - The voice message ID to increment
   */
  incrementAttempts(messageId: string): void {
    const record = this.cache.get(messageId);
    if (record) {
      record.attempts += 1;
    }
  }

  /**
   * Remove records older than 1 hour (RECORD_TTL_MS)
   * Should be called periodically to clean up expired records
   */
  cleanup(): void {
    const now = Date.now();
    for (const [messageId, record] of this.cache) {
      if (now - record.timestamp > RECORD_TTL_MS) {
        this.cache.delete(messageId);
      }
    }
  }
}

/** Singleton instance of RetryCache for use across the application */
export const retryCache = new RetryCache();
