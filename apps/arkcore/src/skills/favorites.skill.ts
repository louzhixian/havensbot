import type {
  GuildTextBasedChannel,
  Message,
  MessageReaction,
  PartialMessageReaction,
  User,
} from "discord.js";
import type { GuildSettings } from "@prisma/client";
import type { Skill, SkillContext, ReactionHandler } from "./types.js";
import { getConfigByRole } from "../channel-config.js";
import { generateDeepDive } from "../deeper.js";
import { createDeepDiveForumPost } from "../deep-dive-forum.js";
import { splitMessageContent } from "../messaging.js";
import { sleep } from "../utils.js";
import { loadConfig } from "../config.js";
import { markForwarded, wasForwarded } from "../favorites.js";
import { CacheStore } from "../utils/cache-store.js";
import { ensureMessage } from "../utils/discord.js"; // F-02: Use centralized utility

const HEART_EMOJIS = ["❤", "♥"];
const EYES_EMOJIS = ["👀"];

/**
 * F-01: Persistent cache for deep dive messages.
 * Uses database-backed CacheStore instead of in-memory Map to survive restarts.
 * Only stores threadId (not full record) since that's all we need for deduplication.
 * TTL: 1 hour
 */
const deeperMessagesCache = new CacheStore("favorites_deeper");
const DEEPER_TTL_MS = 60 * 60 * 1000; // 1 hour

type DeeperRecord = {
  forwardedId: string;
  channelId: string;
  threadId: string;
};

const markDeeperForwarded = async (
  messageId: string,
  forwardedId: string,
  channelId: string,
  threadId: string
): Promise<void> => {
  await deeperMessagesCache.set<DeeperRecord>(
    messageId,
    { forwardedId, channelId, threadId },
    DEEPER_TTL_MS
  );
};

const wasDeeperForwarded = async (messageId: string): Promise<boolean> => {
  return deeperMessagesCache.has(messageId);
};

// F-02: ensureMessage moved to utils/discord.ts

const extractItemUrl = (message: Message): string | null => {
  const embedUrl = message.embeds.find((embed) => typeof embed.url === "string")?.url;
  if (embedUrl) return embedUrl;

  const content = message.content ?? "";
  const match = content.match(/https?:\/\/\S+/);
  if (!match) return null;

  return match[0].replace(/[>\])}.,!?]+$/, "");
};

// TODO (F-05): 改进 fallback 逻辑，保留更多元数据
// 当前 fallback 手动重建消息时丢失原始消息的时间戳、作者等元数据。
// 建议方案：
// 1. 检查 Discord.js 版本是否支持 Message.forward() 方法
// 2. 如果不支持，添加更完整的消息复制逻辑（包括时间戳、作者等）
// 3. 移除类型断言，使用类型守卫 (type guard)
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

  const files = message.attachments.map((attachment: { url: string }) => attachment.url);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (channel as any).send({
    content: message.content || undefined,
    embeds: message.embeds,
    files,
  });
};

const handleHeartReaction = async (
  ctx: SkillContext,
  reaction: MessageReaction,
  message: Message,
  guildId: string
): Promise<void> => {
  const favConfig = await getConfigByRole(guildId, "favorites");
  const favChannelId = favConfig?.channelId;
  if (!favChannelId) return;

  if (message.channelId === favChannelId) return;
  if (wasForwarded(message.id)) return;

  const channel = await ctx.client.channels.fetch(favChannelId);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    ctx.logger.error("Favorite channel is not text based or not found");
    return;
  }
  const textChannel = channel as GuildTextBasedChannel;

  const forwarded = await forwardMessage(message, textChannel);
  markForwarded(message.id, forwarded.id, textChannel.id);
};

const handleEyesReaction = async (
  ctx: SkillContext,
  reaction: MessageReaction,
  message: Message,
  guildId: string,
  _settings: GuildSettings
): Promise<void> => {
  const deepDiveConfig = await getConfigByRole(guildId, "deep_dive_output");
  const deepDiveForumId = deepDiveConfig?.channelId;

  if (!deepDiveForumId) return;
  if (message.channelId === deepDiveForumId) return;
  if (await wasDeeperForwarded(message.id)) return;

  const itemUrl = extractItemUrl(message);
  if (!itemUrl) return;

  const title = message.embeds[0]?.title || message.content?.slice(0, 90) || "Deep Dive";
  const sourceName = message.embeds[0]?.footer?.text;

  const forumResult = await createDeepDiveForumPost(
    ctx.client,
    deepDiveForumId,
    title,
    itemUrl,
    "",
    sourceName
  );

  if (forumResult) {
    await markDeeperForwarded(message.id, forumResult.threadId, deepDiveForumId, forumResult.threadId);

    await forumResult.thread.send({ content: "正在生成深度解读，请稍候..." });

    const config = loadConfig();

    // 定期发送 typing indicator，让用户知道正在处理中
    const typingInterval = setInterval(() => {
      forumResult.thread.sendTyping?.().catch(() => {});
    }, 5000);

    try {
      const result = await generateDeepDive(config, itemUrl);
      const chunks = splitMessageContent(result.content, 1800);
      for (const chunk of chunks) {
        await forumResult.thread.send({ content: chunk });
        await sleep(config.digestThreadThrottleMs);
      }
      await forumResult.markCompleted();
    } catch (error) {
      ctx.logger.error({ error, itemUrl }, "DeepDive generation failed");
      const errorMessage = error instanceof Error ? error.message : String(error);
      await forumResult.thread.send({
        content: `❌ 生成失败: ${errorMessage}\n\n请稍后重试或检查链接是否有效。`,
      });
      await forumResult.markFailed();
    } finally {
      clearInterval(typingInterval);
    }
  }
};

const heartReactionHandler: ReactionHandler = {
  emoji: HEART_EMOJIS,
  execute: async (ctx, reaction, user, settings) => {
    if (user.bot) return;

    const message = await ensureMessage(reaction);
    if (!message || !message.guild) return;

    await handleHeartReaction(ctx, reaction, message, message.guild.id);
  },
};

const eyesReactionHandler: ReactionHandler = {
  emoji: EYES_EMOJIS,
  execute: async (ctx, reaction, user, settings) => {
    if (user.bot) return;

    const message = await ensureMessage(reaction);
    if (!message || !message.guild) return;

    await handleEyesReaction(ctx, reaction, message, message.guild.id, settings);
  },
};

export const favoritesSkill: Skill = {
  id: "favorites",
  name: "Favorites",
  description: "Forward ❤️ reacted messages to favorites channel, 👀 for deep dive",
  tier: "free",

  reactions: [heartReactionHandler, eyesReactionHandler],

  channelRoles: ["favorites", "deep_dive_output"],
};
