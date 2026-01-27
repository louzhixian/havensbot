import type {
  Client,
  GuildTextBasedChannel,
  Message,
  MessageReaction,
  PartialMessageReaction,
} from "discord.js";
import { ThreadAutoArchiveDuration } from "discord.js";
import { getConfigByRole } from "./channel-config.js";
import { AppConfig } from "./config.js";
import { generateDeepDive } from "./deeper.js";
import { createDeepDiveForumPost } from "./deep-dive-forum.js";
import { splitMessageContent } from "./messaging.js";
import { sleep } from "./utils.js";

const HEART_EMOJIS = new Set(["❤", "♥"]);
const EYES_EMOJIS = new Set(["👀"]);
const MAX_FORWARD_CACHE = 1000;
const forwardedMessages = new Map<
  string,
  { forwardedId: string; channelId: string; createdAt: number }
>();
const deeperMessages = new Map<
  string,
  { forwardedId: string; channelId: string; threadId: string; createdAt: number }
>();

const normalizeEmoji = (value: string | null): string => {
  if (!value) return "";
  return value.replace(/\uFE0F/g, "");
};

const wasForwarded = (messageId: string): boolean =>
  forwardedMessages.has(messageId);

const markForwarded = (
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

const markDeeperForwarded = (
  messageId: string,
  forwardedId: string,
  channelId: string,
  threadId: string
): void => {
  deeperMessages.set(messageId, {
    forwardedId,
    channelId,
    threadId,
    createdAt: Date.now(),
  });
  if (deeperMessages.size <= MAX_FORWARD_CACHE) return;
  const oldest = deeperMessages.keys().next().value;
  if (oldest) {
    deeperMessages.delete(oldest);
  }
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

const extractItemUrl = (message: Message): string | null => {
  const embedUrl = message.embeds.find((embed) => typeof embed.url === "string")?.url;
  if (embedUrl) return embedUrl;

  const content = message.content ?? "";
  const match = content.match(/https?:\/\/\S+/);
  if (!match) return null;

  return match[0].replace(/[>\])}.,!?]+$/, "");
};

const formatDate = (date: Date, timeZone: string): string => {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
};

const buildDeepDiveThreadName = (date: Date, timeZone: string): string => {
  return `Deep Dive · ${formatDate(date, timeZone)}`;
};

const forwardMessage = async (
  message: Message,
  channel: GuildTextBasedChannel
): Promise<Message> => {
  const forwarder = (message as Message & {
    forward?: (target: GuildTextBasedChannel) => Promise<Message>;
  }).forward;
  if (typeof forwarder === "function") {
    return forwarder.call(message, channel);
  }

  const files = message.attachments.map((attachment) => attachment.url);
  return channel.send({
    content: message.content || undefined,
    embeds: message.embeds,
    files,
  });
};

export const registerFavoriteReactionHandler = (
  client: Client,
  config: AppConfig
): void => {
  client.on("messageReactionAdd", async (reaction, user) => {
    try {
      if (user.bot) return;
      const emojiName = normalizeEmoji(reaction.emoji.name);
      const isHeart = HEART_EMOJIS.has(emojiName);
      const isEyes = EYES_EMOJIS.has(emojiName);
      if (!isHeart && !isEyes) return;

      const message = await ensureMessage(reaction);
      if (!message || !message.guild) return;

      const guildId = message.guild.id;
      if (!guildId) return;

      if (isHeart) {
        let favConfig;
        try {
          favConfig = await getConfigByRole(guildId, "favorites");
        } catch (error) {
          console.error("Failed to fetch favorites config", error);
          // Continue - treat as if no config exists
        }
        const favChannelId = favConfig?.channelId;
        if (!favChannelId) return;

        if (message.channelId === favChannelId) return;
        if (wasForwarded(message.id)) return;

        const channel = await client.channels.fetch(favChannelId);
        if (!channel || !channel.isTextBased() || channel.isDMBased()) {
          console.error("Favorite channel is not text based or not found");
          return;
        }
        const textChannel = channel as GuildTextBasedChannel;

        const forwarded = await forwardMessage(message, textChannel);
        markForwarded(message.id, forwarded.id, textChannel.id);
        return;
      }

      if (isEyes) {
        let deepDiveConfig;
        try {
          deepDiveConfig = await getConfigByRole(guildId, "deep_dive_output");
        } catch (error) {
          console.error("Failed to fetch deep_dive_output config", error);
          // Continue - treat as if no config exists
        }
        const deepDiveForumId = deepDiveConfig?.channelId;

        if (!deepDiveForumId) return;
        if (message.channelId === deepDiveForumId) return;
        if (deeperMessages.has(message.id)) return;

        const itemUrl = extractItemUrl(message);
        if (!itemUrl) {
          return;
        }

        const title = message.embeds[0]?.title || message.content?.slice(0, 90) || "Deep Dive";
        const sourceName = message.embeds[0]?.footer?.text;

        const forumResult = await createDeepDiveForumPost(
          client,
          deepDiveForumId,
          title,
          itemUrl,
          "", // Initial content - will be populated by deep dive
          sourceName
        );

        if (forumResult) {
          markDeeperForwarded(message.id, forumResult.threadId, deepDiveForumId, forumResult.threadId);

          await forumResult.thread.send({ content: "正在生成深度解读，请稍候..." });
          const result = await generateDeepDive(config, itemUrl);
          const chunks = splitMessageContent(result.content, 1800);
          for (const chunk of chunks) {
            await forumResult.thread.send({ content: chunk });
            await sleep(config.digestThreadThrottleMs);
          }
          // Mark as completed after content is posted
          await forumResult.markCompleted();
        }
      }
    } catch (error) {
      console.error("favorite reaction handler failed", error);
    }
  });

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
        const forwarded = await textChannel.messages.fetch(record.forwardedId);
        await forwarded.delete();
      } finally {
        forwardedMessages.delete(message.id);
      }
    } catch (error) {
      console.error("favorite reaction remove handler failed", error);
    }
  });
};
