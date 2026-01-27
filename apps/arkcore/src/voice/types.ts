/**
 * Voice-to-text feature type definitions
 */

/**
 * Result returned by the voice handler after processing a voice message
 */
export type VoiceProcessingResult = {
  /** Whether the voice processing was successful */
  success: boolean;
  /** The polished/transcribed text from the voice message */
  polishedText?: string;
  /** Error message if processing failed */
  error?: string;
};

/**
 * Record stored in retry cache for tracking failed voice messages that can be manually retried
 */
export type RetryRecord = {
  /** Original voice message ID from Discord */
  messageId: string;
  /** Discord CDN URL of the audio attachment */
  audioUrl: string;
  /** Number of retry attempts so far */
  attempts: number;
  /** When the record was created (Date.now()) */
  timestamp: number;
};
