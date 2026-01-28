/**
 * Voice Skill - Voice-to-text transcription via Whisper API
 *
 * Listens for audio attachments in the editorial channel and automatically
 * transcribes them using Whisper API, then polishes the text with LLM.
 */

import {
  ThreadAutoArchiveDuration,
  type Attachment,
  type Message,
  type MessageReaction,
} from "discord.js";
import type { GuildSettings } from "@prisma/client";
import type { Skill, SkillContext, MessageHandler, ReactionHandler } from "./types.js";
import { getConfigByRole } from "../channel-config.js";
import { loadConfig, type AppConfig } from "../config.js";
import { retryCache } from "../voice/retryCache.js";
import { polishTranscript } from "../voice/textPolisher.js";
import { voiceQueue } from "../voice/voiceQueue.js";
import { transcribe } from "../voice/whisperClient.js";
import { logger } from "../observability/logger.js";

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
  } catch (error) {
    logger.debug({ error, messageId: message.id, emoji: oldEmoji }, "Failed to remove reaction");
  }
  try {
    await message.react(newEmoji);
  } catch (error) {
    logger.debug({ error, messageId: message.id, emoji: newEmoji }, "Failed to add reaction");
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
  // Update reaction: remove queued emoji if present, add processing emoji
  try {
    await message.reactions.cache.get(EMOJI_QUEUED)?.users.remove(message.client.user?.id);
  } catch (error) {
    logger.debug({ error, messageId: message.id }, "Failed to remove queued reaction");
  }
  try {
    await message.react(EMOJI_PROCESSING);
  } catch (error) {
    logger.debug({ error, messageId: message.id }, "Failed to add processing reaction");
  }

  try {
    // Download audio file
    const audioBuffer = await downloadAudio(attachment.url);

    // Transcribe audio
    const rawText = await transcribe(audioBuffer, config);

    // Polish transcript
    const polishedText = await polishTranscript(rawText, config);

    // Create thread with result
    const thread = await message.startThread({
      name: THREAD_NAME,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    });

    await thread.send({ content: polishedText });

    // Update reaction to success
    await updateReaction(message, EMOJI_PROCESSING, EMOJI_SUCCESS);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

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
    } catch (error) {
      logger.debug({ error, messageId: message.id }, "Failed to create error thread");
    }
  }
}

/**
 * Message handler for detecting audio attachments in editorial channel
 */
const voiceMessageHandler: MessageHandler = {
  channelRole: "editorial",
  filter: (message) => {
    // Skip bot messages
    if (message.author.bot) return false;
    // Skip if already in a thread
    if (message.channel.isThread()) return false;
    // Must have audio attachment
    const hasAudio = message.attachments.some(isAudioAttachment);
    logger.info({
      channelId: message.channelId,
      attachmentCount: message.attachments.size,
      attachmentTypes: message.attachments.map(a => a.contentType).join(', '),
      hasAudio,
    }, "Voice skill filter check");
    return hasAudio;
  },
  execute: async (ctx, message, _settings) => {
    // TODO (V-05): 考虑在 SkillContext 中预传入 config
    // 或在 Skill 模块级别缓存，避免重复调用 loadConfig()
    const config = loadConfig();
    logger.info({
      voiceToTextEnabled: config.voiceToTextEnabled,
      whisperApiUrl: config.whisperApiUrl,
    }, "Voice skill execute check");

    // Skip if voice-to-text is not enabled
    if (!config.voiceToTextEnabled) return;

    // Must have Whisper API configured
    if (!config.whisperApiUrl) return;

    const audioAttachment = message.attachments.find(isAudioAttachment);
    if (!audioAttachment) return;

    // Add queued reaction and enqueue for processing
    try {
      await message.react(EMOJI_QUEUED);
    } catch (error) {
      logger.debug({ error, messageId: message.id }, "Failed to add queued reaction");
    }
    voiceQueue.enqueue(message, audioAttachment, config);
  },
};

/**
 * Reaction handler for retry emoji on error messages
 */
const retryReactionHandler: ReactionHandler = {
  emoji: EMOJI_RETRY,
  execute: async (ctx, reaction, user, _settings) => {
    if (user.bot) return;

    const message = reaction.message.partial
      ? await reaction.message.fetch()
      : reaction.message;

    // Must be in a thread
    if (!message.channel.isThread()) return;

    const thread = message.channel;

    // Must be from the bot
    if (message.author?.id !== message.client.user?.id) return;

    // Get starter message to find original voice message ID
    const starterMessage = await thread.fetchStarterMessage().catch(() => null);
    if (!starterMessage) return;

    const originalMessageId = starterMessage.id;

    // Check if retry is allowed
    if (!(await retryCache.canRetry(originalMessageId))) {
      await thread.send({ content: "已达到最大重试次数" });
      return;
    }

    const record = await retryCache.get(originalMessageId);
    if (!record) return;

    // Increment attempts
    await retryCache.incrementAttempts(originalMessageId);

    // Send processing message
    await thread.send({ content: "正在重试转录..." });

    // TODO (V-05): 考虑在 SkillContext 中预传入 config
    // 或在 Skill 模块级别缓存，避免重复调用 loadConfig()
    const config = loadConfig();

    try {
      // Download and transcribe
      const audioBuffer = await downloadAudio(record.audioUrl);
      const rawText = await transcribe(audioBuffer, config);
      const polishedText = await polishTranscript(rawText, config);

      await thread.send({ content: polishedText });

      // Update original message reaction to success
      try {
        await starterMessage.reactions.cache
          .get(EMOJI_ERROR)
          ?.users.remove(starterMessage.client.user?.id);
        await starterMessage.react(EMOJI_SUCCESS);
      } catch (error) {
        logger.debug({ error, messageId: starterMessage.id }, "Failed to update reaction on retry success");
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (await retryCache.canRetry(originalMessageId)) {
        await thread.send({
          content: `重试失败: ${errorMessage}\n\n点击 ${EMOJI_RETRY} 再次重试`,
        });
        const newRetryMsg = await thread.send({ content: `点击下方 ${EMOJI_RETRY} 重试` });
        await newRetryMsg.react(EMOJI_RETRY);
      } else {
        await thread.send({
          content: `重试失败: ${errorMessage}\n\n已达到最大重试次数`,
        });
      }
    }
  },
};

// Set up the queue processor (module-level initialization)
voiceQueue.setProcessor(handleVoiceMessage);

// Set up periodic cleanup of retry cache (every hour)
setInterval(async () => {
  await retryCache.cleanup();
}, 60 * 60 * 1000);

export const voiceSkill: Skill = {
  id: "voice",
  name: "Voice Transcription",
  description: "Transcribe voice messages to text using Whisper API",
  tier: "free",

  messages: [voiceMessageHandler],
  reactions: [retryReactionHandler],

  channelRoles: ["editorial"],
};
