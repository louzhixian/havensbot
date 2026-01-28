/**
 * Voice message handler for voice-to-text transcription
 *
 * Listens for audio attachments in the editorial channel and automatically
 * transcribes them using Whisper API, then polishes the text with LLM.
 */

import {
  ThreadAutoArchiveDuration,
  type Attachment,
  type Client,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from "discord.js";
import type { AppConfig } from "../config.js";
import { logger } from "../observability/logger.js";
import { getConfigByRole } from "../channel-config.js";
import { retryCache } from "./retryCache.js";
import { polishTranscript } from "./textPolisher.js";
import { voiceQueue } from "./voiceQueue.js";
import { transcribe } from "./whisperClient.js";

/** Thread name for voice transcription results */
const THREAD_NAME = "语音转文字";

/** Reaction emojis for status indication */
const EMOJI_QUEUED = "\uD83D\uDD50"; // clock (🕐)
const EMOJI_PROCESSING = "\u23F3"; // hourglass (⏳)
const EMOJI_SUCCESS = "\u2705"; // check mark (✅)
const EMOJI_ERROR = "\u274C"; // cross mark (❌)
const EMOJI_RETRY = "\uD83D\uDD04"; // retry arrow (🔄)

/**
 * Check if an attachment is an audio file
 */
const isAudioAttachment = (attachment: Attachment): boolean => {
  return attachment.contentType?.startsWith("audio/") ?? false;
};

/**
 * Download audio file from Discord CDN to a buffer
 */
const downloadAudio = async (url: string): Promise<Buffer> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download audio: ${response.status} ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
};

/**
 * Update reaction on a message (remove old, add new)
 */
const updateReaction = async (
  message: Message,
  oldEmoji: string,
  newEmoji: string
): Promise<void> => {
  try {
    await message.reactions.cache.get(oldEmoji)?.users.remove(message.client.user?.id);
  } catch {
    // Ignore errors when removing reaction
  }
  try {
    await message.react(newEmoji);
  } catch (error) {
    logger.warn({ error, emoji: newEmoji }, "Failed to add reaction");
  }
};

/**
 * Handle a voice message by transcribing and posting to a thread
 * Called either directly or from the queue
 */
async function handleVoiceMessage(
  message: Message,
  attachment: Attachment,
  config: AppConfig
): Promise<void> {
  const log = logger.child({
    operation: "voice_handler",
    messageId: message.id,
    channelId: message.channelId,
    userId: message.author.id,
    attachmentUrl: attachment.url,
  });

  log.info("Processing voice message");

  // Update reaction: remove queued emoji if present, add processing emoji
  try {
    await message.reactions.cache.get(EMOJI_QUEUED)?.users.remove(message.client.user?.id);
  } catch {
    // Ignore errors when removing queued reaction
  }
  try {
    await message.react(EMOJI_PROCESSING);
  } catch (error) {
    log.warn({ error }, "Failed to add processing reaction");
  }

  try {
    // Download audio file
    log.debug("Downloading audio file");
    const audioBuffer = await downloadAudio(attachment.url);
    log.debug({ size: audioBuffer.length }, "Audio downloaded");

    // Transcribe audio
    log.debug("Transcribing audio");
    const rawText = await transcribe(audioBuffer, config);
    log.info({ textLength: rawText.length }, "Transcription complete");

    // Polish transcript
    log.debug("Polishing transcript");
    const polishedText = await polishTranscript(rawText, config);
    log.info({ polishedLength: polishedText.length }, "Text polished");

    // Create thread with result
    const thread = await message.startThread({
      name: THREAD_NAME,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    });

    await thread.send({ content: polishedText });
    log.info({ threadId: thread.id }, "Created thread with transcription");

    // Update reaction to success
    await updateReaction(message, EMOJI_PROCESSING, EMOJI_SUCCESS);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error({ error: errorMessage }, "Voice message processing failed");

    // Update reaction to error
    await updateReaction(message, EMOJI_PROCESSING, EMOJI_ERROR);

    // Create error thread
    try {
      const thread = await message.startThread({
        name: THREAD_NAME,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      });

      const errorText = `语音转文字失败: ${errorMessage}\n\n点击 ${EMOJI_RETRY} 重试`;
      const errorMsg = await thread.send({ content: errorText });

      // Add retry reaction
      await errorMsg.react(EMOJI_RETRY);

      // Store retry info
      await retryCache.set(message.id, {
        messageId: message.id,
        audioUrl: attachment.url,
        attempts: 1,
        timestamp: Date.now(),
      });

      log.info({ threadId: thread.id }, "Created error thread with retry option");
    } catch (threadError) {
      log.error({ error: threadError }, "Failed to create error thread");
    }
  }
}

/**
 * Handle retry when user reacts with retry emoji on error message
 */
async function handleRetry(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  config: AppConfig
): Promise<void> {
  // Ensure reaction is fully fetched
  if (reaction.partial) {
    try {
      reaction = await reaction.fetch();
    } catch (error) {
      logger.error({ error }, "Failed to fetch partial reaction");
      return;
    }
  }

  const message = reaction.message;

  // Must be in a thread
  if (!message.channel.isThread()) {
    return;
  }

  const thread = message.channel;

  // Must be from the bot
  if (message.author?.id !== message.client.user?.id) {
    return;
  }

  // Must be a retry emoji
  if (reaction.emoji.name !== EMOJI_RETRY) {
    return;
  }

  // Get starter message to find original voice message ID
  const starterMessage = await thread.fetchStarterMessage().catch(() => null);
  if (!starterMessage) {
    return;
  }

  const originalMessageId = starterMessage.id;
  const log = logger.child({
    operation: "voice_retry",
    originalMessageId,
    userId: user.id,
  });

  // Check if retry is allowed
  if (!(await retryCache.canRetry(originalMessageId))) {
    log.info("Retry not allowed (max attempts reached or no record)");
    await thread.send({ content: "已达到最大重试次数" });
    return;
  }

  const record = await retryCache.get(originalMessageId);
  if (!record) {
    log.warn("No retry record found");
    return;
  }

  log.info({ attempt: record.attempts + 1 }, "Retrying voice transcription");

  // Increment attempts
  await retryCache.incrementAttempts(originalMessageId);

  // Send processing message
  await thread.send({ content: "正在重试转录..." });

  try {
    // Download and transcribe
    const audioBuffer = await downloadAudio(record.audioUrl);
    const rawText = await transcribe(audioBuffer, config);
    const polishedText = await polishTranscript(rawText, config);

    await thread.send({ content: polishedText });

    // Update original message reaction to success
    try {
      await starterMessage.reactions.cache.get(EMOJI_ERROR)?.users.remove(starterMessage.client.user?.id);
      await starterMessage.react(EMOJI_SUCCESS);
    } catch {
      // Ignore reaction errors
    }

    log.info("Retry successful");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error({ error: errorMessage }, "Retry failed");

    if (await retryCache.canRetry(originalMessageId)) {
      await thread.send({ content: `重试失败: ${errorMessage}\n\n点击 ${EMOJI_RETRY} 再次重试` });
      const retryMsg = await thread.send({ content: "." });
      // Delete the placeholder and create a new message with retry reaction
      await retryMsg.delete().catch(() => {});
      const newRetryMsg = await thread.send({ content: `点击下方 ${EMOJI_RETRY} 重试` });
      await newRetryMsg.react(EMOJI_RETRY);
    } else {
      await thread.send({ content: `重试失败: ${errorMessage}\n\n已达到最大重试次数` });
    }
  }
}

/**
 * Register voice message handlers on Discord client
 */
export function registerVoiceHandler(client: Client, config: AppConfig): void {
  // Skip if voice-to-text is not enabled
  if (!config.voiceToTextEnabled) {
    logger.info("Voice-to-text disabled, skipping handler registration");
    return;
  }

  // Must have Whisper API configured
  if (!config.whisperApiUrl) {
    logger.warn("Whisper API URL not configured, voice handler not registered");
    return;
  }

  logger.info(
    { whisperApiUrl: config.whisperApiUrl },
    "Registering voice message handler"
  );

  // Set up the queue processor
  voiceQueue.setProcessor(handleVoiceMessage);

  // Listen for new messages
  client.on("messageCreate", async (message) => {
    try {
      // Skip bot messages
      if (message.author.bot) {
        return;
      }

      // Skip if already in a thread
      if (message.channel.isThread()) {
        return;
      }

      // Get editorial channel from database config
      if (!message.guild) return;
      const editorialConfig = await getConfigByRole(message.guild.id, "editorial");
      const editorialChannelId = editorialConfig?.channelId;
      if (!editorialChannelId) return;

      // Only process messages in editorial channel
      if (message.channelId !== editorialChannelId) {
        return;
      }

      // Find audio attachment
      const audioAttachment = message.attachments.find(isAudioAttachment);
      if (!audioAttachment) {
        return;
      }

      // Add queued reaction and enqueue for processing
      try {
        await message.react(EMOJI_QUEUED);
      } catch (error) {
        logger.warn({ error, messageId: message.id }, "Failed to add queued reaction");
      }
      voiceQueue.enqueue(message, audioAttachment, config);
    } catch (error) {
      logger.error(
        { error, messageId: message.id },
        "Voice handler messageCreate error"
      );
    }
  });

  // Listen for retry reactions
  client.on("messageReactionAdd", async (reaction, user) => {
    try {
      // Skip bot reactions
      if (user.bot) {
        return;
      }

      // Handle retry
      await handleRetry(reaction, user, config);
    } catch (error) {
      logger.error(
        { error, messageId: reaction.message.id },
        "Voice handler messageReactionAdd error"
      );
    }
  });

  // Set up periodic cleanup of retry cache
  setInterval(async () => {
    await retryCache.cleanup();
  }, 60 * 60 * 1000); // Every hour

  logger.info("Voice message handler registered");
}
