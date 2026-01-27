/**
 * Voice message processing queue
 *
 * Ensures voice messages are processed one at a time to avoid
 * overwhelming the Whisper service with concurrent requests.
 */

import type { Attachment, Message } from "discord.js";
import type { AppConfig } from "../config.js";
import { logger } from "../observability/logger.js";

export type QueueItem = {
  message: Message;
  attachment: Attachment;
  config: AppConfig;
  addedAt: number;
};

export type ProcessingCallback = (
  message: Message,
  attachment: Attachment,
  config: AppConfig
) => Promise<void>;

class VoiceQueue {
  private queue: QueueItem[] = [];
  private isProcessing = false;
  private processor: ProcessingCallback | null = null;

  /**
   * Set the processor function that handles each voice message
   */
  setProcessor(processor: ProcessingCallback): void {
    this.processor = processor;
  }

  /**
   * Add a voice message to the queue
   */
  enqueue(message: Message, attachment: Attachment, config: AppConfig): number {
    const item: QueueItem = {
      message,
      attachment,
      config,
      addedAt: Date.now(),
    };
    this.queue.push(item);
    const position = this.queue.length;

    logger.info(
      {
        messageId: message.id,
        queuePosition: position,
        queueLength: this.queue.length,
      },
      "Voice message added to queue"
    );

    // Start processing if not already running
    if (!this.isProcessing) {
      this.processNext();
    }

    return position;
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
   * Process the next item in queue
   */
  private async processNext(): Promise<void> {
    if (this.queue.length === 0) {
      this.isProcessing = false;
      return;
    }

    if (!this.processor) {
      logger.error("No processor set for voice queue");
      this.isProcessing = false;
      return;
    }

    this.isProcessing = true;
    const item = this.queue.shift()!;

    logger.info(
      {
        messageId: item.message.id,
        remainingInQueue: this.queue.length,
        waitedMs: Date.now() - item.addedAt,
      },
      "Processing voice message from queue"
    );

    try {
      await this.processor(item.message, item.attachment, item.config);
    } catch (error) {
      logger.error(
        { error, messageId: item.message.id },
        "Queue processor error"
      );
    }

    // Process next item
    await this.processNext();
  }
}

export const voiceQueue = new VoiceQueue();
