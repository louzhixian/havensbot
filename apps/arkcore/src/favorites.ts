import type {
  Client,
  GuildTextBasedChannel,
  Message,
  MessageReaction,
  PartialMessageReaction,
} from "discord.js";
import type { AppConfig } from "./config.js";

const HEART_EMOJIS = new Set(["❤", "♥"]);
const MAX_FORWARD_CACHE = 1000;

// Track forwarded messages for cleanup on reaction removal
const forwardedMessages = new Map<
  string,
  { forwardedId: string; channelId: string; createdAt: number }
>();

const normalizeEmoji = (value: string | null): string => {
  if (!value) return "";
  return value.replace(/\uFE0F/g, "");
};

const ensureMessage = async (
  reaction: MessageReaction | PartialMessageReaction
): Promise<Message | null> => {
  const fullReaction = reaction.partial ? await reaction.fetch() : reaction;
  const message = fullReaction.message.partial
    ? await fullReaction.message.fetch()
    : fullReaction.message;
  return message ?? null;
};

const ensureReaction = async (
  reaction: MessageReaction | PartialMessageReaction
): Promise<MessageReaction> => {
  return reaction.partial ? await reaction.fetch() : reaction;
};

/**
 * Mark a message as forwarded (called by skill handler)
 */
export const markForwarded = (
  messageId: string,
  forwardedId: string,
  channelId: string
): void => {
  forwardedMessages.set(messageId, {
    forwardedId,
    channelId,
    createdAt: Date.now(),
  });
  if (forwardedMessages.size <= MAX_FORWARD_CACHE) return;
  const oldest = forwardedMessages.keys().next().value;
  if (oldest) {
    forwardedMessages.delete(oldest);
  }
};

/**
 * Check if a message was already forwarded
 */
export const wasForwarded = (messageId: string): boolean =>
  forwardedMessages.has(messageId);

/**
 * Register reaction removal handler for favorites cleanup
 * Note: messageReactionAdd is handled by the skill registry in index.ts
 */
export const registerFavoriteReactionHandler = (
  client: Client,
  _config: AppConfig
): void => {
  client.on("messageReactionRemove", async (reaction) => {
    try {
      const fullReaction = await ensureReaction(reaction);
      const emojiName = normalizeEmoji(fullReaction.emoji.name);
      if (!HEART_EMOJIS.has(emojiName)) return;

      if (fullReaction.count && fullReaction.count > 0) {
        return;
      }

      const message = await ensureMessage(fullReaction);
      if (!message) return;
      const record = forwardedMessages.get(message.id);
      if (!record) return;

      const channel = await client.channels.fetch(record.channelId);
      if (!channel || !channel.isTextBased() || channel.isDMBased()) {
        return;
      }
      const textChannel = channel as GuildTextBasedChannel;

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const forwarded = await (textChannel as any).messages.fetch(record.forwardedId);
        await forwarded.delete();
      } finally {
        forwardedMessages.delete(message.id);
      }
    } catch (error) {
      console.error("favorite reaction remove handler failed", error);
    }
  });
};
