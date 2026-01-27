/**
 * Digest processing queue
 *
 * Ensures digest operations are processed one at a time to avoid
 * overwhelming the LLM service with concurrent requests.
 */

import type { Client } from "discord.js";
import type { AppConfig } from "../config.js";
import type { DigestData } from "../digest.js";
import { logger } from "../observability/logger.js";

export type DigestJob = {
  channelId: string;
  rangeStart: Date;
  rangeEnd: Date;
  config: AppConfig;
  client: Client;
  digestForumId?: string;
  resolve: (result: DigestResult) => void;
  reject: (error: Error) => void;
  addedAt: number;
};

export type DigestResult = {
  digest: DigestData;
  threadId?: string;
  totalItems: number;
  failedItems: number;
};

export type DigestProcessor = (
  config: AppConfig,
  client: Client,
  channelId: string,
  rangeStart: Date,
  rangeEnd: Date,
  digestForumId?: string
) => Promise<DigestResult>;

class DigestQueue {
  private queue: DigestJob[] = [];
  private isProcessing = false;
  private processor: DigestProcessor | null = null;

  /**
   * Set the processor function that handles each digest job
   */
  setProcessor(processor: DigestProcessor): void {
    this.processor = processor;
  }

  /**
   * Add a digest job to the queue and return a promise for the result
   */
  enqueue(
    channelId: string,
    rangeStart: Date,
    rangeEnd: Date,
    config: AppConfig,
    client: Client,
    digestForumId?: string
  ): Promise<DigestResult> {
    return new Promise((resolve, reject) => {
      const job: DigestJob = {
        channelId,
        rangeStart,
        rangeEnd,
        config,
        client,
        digestForumId,
        resolve,
        reject,
        addedAt: Date.now(),
      };

      this.queue.push(job);
      const position = this.queue.length;

      logger.info(
        {
          channelId,
          queuePosition: position,
          queueLength: this.queue.length,
        },
        "Digest job added to queue"
      );

      // Start processing if not already running
      if (!this.isProcessing) {
        this.processNext();
      }
    });
  }

  /**
   * Get current queue length
   */
  get length(): number {
    return this.queue.length;
  }

  /**
   * Check if currently processing
   */
  get processing(): boolean {
    return this.isProcessing;
  }

  /**
   * Process the next job in queue
   */
  private async processNext(): Promise<void> {
    if (this.queue.length === 0) {
      this.isProcessing = false;
      return;
    }

    if (!this.processor) {
      logger.error("No processor set for digest queue");
      // Reject all pending jobs
      for (const job of this.queue) {
        job.reject(new Error("Digest queue processor not configured"));
      }
      this.queue = [];
      this.isProcessing = false;
      return;
    }

    this.isProcessing = true;
    const job = this.queue.shift()!;

    logger.info(
      {
        channelId: job.channelId,
        remainingInQueue: this.queue.length,
        waitedMs: Date.now() - job.addedAt,
      },
      "Processing digest job from queue"
    );

    try {
      const result = await this.processor(
        job.config,
        job.client,
        job.channelId,
        job.rangeStart,
        job.rangeEnd,
        job.digestForumId
      );
      job.resolve(result);
    } catch (error) {
      logger.error(
        { error, channelId: job.channelId },
        "Digest queue processor error"
      );
      job.reject(error instanceof Error ? error : new Error(String(error)));
    }

    // Process next job
    await this.processNext();
  }
}

export const digestQueue = new DigestQueue();
