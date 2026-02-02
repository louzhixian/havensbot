/**
 * Readings Skill - Bookmark messages to a readings forum
 *
 * Features:
 * - 🔖 reaction to bookmark a message to the readings forum
 * - Button to toggle read/unread status
 * - Q&A via LLM in reading threads
 */

import {
  ChannelType,
  EmbedBuilder,
  type AnyThreadChannel,
  type ForumChannel,
  type Message,
} from "discord.js";
import type { GuildSettings } from "@prisma/client";
import type {
  Skill,
  SkillContext,
  MessageHandler,
  ReactionHandler,
  ButtonHandler,
} from "./types.js";
import { getConfigByRole } from "../channel-config.js";
import { loadConfig, type AppConfig } from "../config.js";
import { createForumPost } from "../messaging.js";
import { truncate } from "../utils.js";
import {
  buildMarkAsReadButton,
  buildMarkAsUnreadButton,
  READINGS_TOGGLE_PREFIX,
} from "../readings/buttons.js";
import { logger } from "../observability/logger.js";
import { generateReadingsResponse } from "../readings/llm.js";
import { CacheStore } from "../utils/cache-store.js";
import { prisma } from "../db.js";

const BOOKMARK_EMOJI = "🔖";

/**
 * Persistent cache for thread article URLs (R-02 fix).
 * Uses database-backed CacheStore instead of in-memory Map to survive restarts.
 * URLs have a 30-day TTL to prevent unbounded growth.
 */
const threadArticleUrlCache = new CacheStore("readings_thread_url");
const THREAD_URL_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * R-01: Persistent cache for bookmarked messages.
 * Uses database-backed CacheStore instead of in-memory Map to survive restarts.
 * TTL: 1 hour
 */
const bookmarkedMessagesCache = new CacheStore("readings_bookmarked");
const BOOKMARK_TTL_MS = 60 * 60 * 1000; // 1 hour

const PENDING_MARKER = "__pending__";

/**
 * Store article URL for a thread in persistent cache.
 */
const setThreadArticleUrl = async (threadId: string, url: string): Promise<void> => {
  await threadArticleUrlCache.set(threadId, url, THREAD_URL_TTL_MS);
};

/**
 * Retrieve article URL for a thread from persistent cache.
 */
const getThreadArticleUrl = async (threadId: string): Promise<string | null> => {
  return threadArticleUrlCache.get<string>(threadId);
};

const wasBookmarked = async (messageId: string): Promise<boolean> => {
  return bookmarkedMessagesCache.has(messageId);
};

const markPending = async (messageId: string): Promise<void> => {
  await bookmarkedMessagesCache.set(messageId, { threadId: PENDING_MARKER }, BOOKMARK_TTL_MS);
};

const clearPending = async (messageId: string): Promise<void> => {
  const entry = await bookmarkedMessagesCache.get<{ threadId: string }>(messageId);
  if (entry?.threadId === PENDING_MARKER) {
    await bookmarkedMessagesCache.delete(messageId);
  }
};

const markBookmarked = async (messageId: string, threadId: string): Promise<void> => {
  await bookmarkedMessagesCache.set(messageId, { threadId }, BOOKMARK_TTL_MS);
};

const generatePostTitle = (message: Message): string => {
  // Priority 1: embed title
  const embedTitle = message.embeds[0]?.title;
  if (embedTitle) {
    return truncate(embedTitle, 90);
  }

  // Priority 2: message content (first 50 chars)
  if (message.content && message.content.trim()) {
    const firstLine = message.content.split("\n")[0];
    return truncate(firstLine, 50);
  }

  // Priority 3: attachments
  if (message.attachments.size > 0) {
    return "[附件]";
  }

  return "[无标题]";
};

const buildMessageLink = (message: Message): string => {
  return `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`;
};

const extractArticleUrl = (message: Message): string | null => {
  // Priority 1: embed URL
  const embedUrl = message.embeds[0]?.url;
  if (embedUrl) return embedUrl;

  // Priority 2: first URL in message content
  const urlMatch = message.content?.match(/https?:\/\/[^\s<>]+/);
  if (urlMatch) return urlMatch[0];

  return null;
};

/**
 * Reaction handler for bookmark emoji
 */
const bookmarkReactionHandler: ReactionHandler = {
  emoji: BOOKMARK_EMOJI,
  execute: async (ctx, reaction, user, _settings) => {
    if (user.bot) return;

    const message = reaction.message.partial
      ? await reaction.message.fetch()
      : reaction.message;
    if (!message.guild) return;

    const guildId = message.guild.id;

    // Get readings forum config
    let readingsConfig;
    try {
      readingsConfig = await getConfigByRole(guildId, "readings");
    } catch (error) {
      logger.error({ error }, "Failed to fetch readings config");
      return;
    }

    const readingsForumId = readingsConfig?.channelId;
    if (!readingsForumId) return;

    // Don't bookmark messages from the readings forum itself or its threads
    if (message.channelId === readingsForumId) return;
    const messageChannel = message.channel;
    if (
      "parentId" in messageChannel &&
      messageChannel.parentId === readingsForumId
    )
      return;

    // Check if already bookmarked or pending (persisted in database)
    if (await wasBookmarked(message.id)) return;

    // Mark as pending to prevent concurrent duplicate creation
    await markPending(message.id);

    // R-03: Track the database record for cleanup on failure
    let bookmarkRecordId: string | null = null;

    try {
      // Generate post title and article URL early (needed for database record)
      const title = generatePostTitle(message);
      const messageLink = buildMessageLink(message);
      const articleUrl = extractArticleUrl(message);

      // R-03: Create database record first with unique constraint to prevent duplicates
      // If another instance is creating this bookmark concurrently, one will fail with P2002
      try {
        const bookmarkRecord = await prisma.readingBookmark.create({
          data: {
            guildId: message.guild.id,
            messageId: message.id,
            threadId: "", // Will update after thread creation
            channelId: message.channelId,
            userId: user.id,
            articleUrl,
          },
        });
        bookmarkRecordId = bookmarkRecord.id;
      } catch (dbError: any) {
        // P2002: Unique constraint violation - another instance already created this bookmark
        if (dbError.code === "P2002") {
          logger.info(
            { messageId: message.id, guildId: message.guild.id },
            "Bookmark already exists (concurrent creation prevented)"
          );
          await clearPending(message.id);
          return;
        }
        // Other database errors should be thrown
        throw dbError;
      }

      // Build content (truncate to Discord limit)
      const truncatedContent = truncate(message.content || "", 2000);

      // Create forum post with content and embeds
      const { thread } = await createForumPost(
        ctx.client,
        readingsForumId,
        {
          title,
          content: truncatedContent,
          embeds:
            message.embeds.length > 0
              ? message.embeds.map((e) => EmbedBuilder.from(e))
              : undefined,
          tags: ["unread"],
        }
      );

      // Update the bookmark record with the actual thread ID
      await prisma.readingBookmark.update({
        where: { id: bookmarkRecordId! },
        data: { threadId: thread.id },
      });

      // Mark as bookmarked in cache for fast lookups
      await markBookmarked(message.id, thread.id);

      // Store article URL for Q&A (persisted to database)
      if (articleUrl) {
        await setThreadArticleUrl(thread.id, articleUrl);
      }

      // Send attachments if any (best effort)
      if (message.attachments.size > 0) {
        try {
          const files = message.attachments.map((a) => a.url);
          await thread.send({ files });
        } catch (attachError) {
          logger.warn(
            { error: attachError, threadId: thread.id },
            "Failed to send attachments"
          );
          await thread.send({ content: "⚠️ 部分附件发送失败，请查看原消息" }).catch(() => {});
        }
      }

      // Send link footer as separate message
      const linkFooter = `───────────────────\n📎 原消息: ${messageLink}\n💬 直接回复消息即可提问或探讨`;
      try {
        await thread.send({ content: linkFooter });
      } catch (linkError) {
        logger.warn(
          { error: linkError, threadId: thread.id },
          "Failed to send link footer"
        );
      }

      // Send the toggle button (best effort)
      try {
        await thread.send({ components: [buildMarkAsReadButton()] });
      } catch (buttonError) {
        logger.warn(
          { error: buttonError, threadId: thread.id },
          "Failed to send toggle button"
        );
        await thread.send({ content: "⚠️ 状态切换按钮加载失败" }).catch(() => {});
      }

      logger.info(
        { messageId: message.id, threadId: thread.id },
        "Bookmark created"
      );
    } catch (innerError) {
      // R-03: Clean up database record if it was created
      if (bookmarkRecordId) {
        try {
          await prisma.readingBookmark.delete({
            where: { id: bookmarkRecordId },
          });
          logger.debug(
            { bookmarkRecordId, messageId: message.id },
            "Cleaned up orphaned bookmark record after failure"
          );
        } catch (cleanupError) {
          logger.warn(
            { error: cleanupError, bookmarkRecordId },
            "Failed to clean up bookmark record"
          );
        }
      }
      
      // Clear pending on failure so the message can be retried
      await clearPending(message.id);
      throw innerError;
    }
  },
};

/**
 * Button handler for toggling read/unread status
 */
const toggleButtonHandler: ButtonHandler = {
  customIdPrefix: READINGS_TOGGLE_PREFIX,
  execute: async (ctx, interaction, _settings) => {
    await interaction.deferUpdate();

    const channel = interaction.channel;
    if (!channel || !("parent" in channel)) return;

    const parent = channel.parent;
    if (!parent || parent.type !== ChannelType.GuildForum) return;

    const forum = parent as ForumChannel;
    const thread = channel as AnyThreadChannel;

    // Find tag IDs
    const unreadTag = forum.availableTags.find(
      (t) => t.name.toLowerCase() === "unread"
    );
    const readTag = forum.availableTags.find(
      (t) => t.name.toLowerCase() === "read"
    );

    if (!unreadTag || !readTag) {
      logger.warn("unread or read tag not found in forum");
      return;
    }

    const currentTags = thread.appliedTags || [];
    const hasUnread = currentTags.includes(unreadTag.id);

    // Toggle: unread -> read, or read -> unread
    const newTags = currentTags
      .filter((id) => id !== unreadTag.id && id !== readTag.id)
      .concat(hasUnread ? readTag.id : unreadTag.id);

    await thread.setAppliedTags(newTags);

    // Update button
    const newButton = hasUnread
      ? buildMarkAsUnreadButton()
      : buildMarkAsReadButton();

    await interaction.editReply({ components: [newButton] });

    logger.info(
      { threadId: thread.id, newState: hasUnread ? "read" : "unread" },
      "Reading status toggled"
    );
  },
};

/**
 * Message handler for Q&A in reading threads
 */
const readingsQAHandler: MessageHandler = {
  channelRole: "readings",
  filter: (message) => {
    // Ignore bot messages
    if (message.author.bot) return false;
    // Only handle messages in threads
    return (
      message.channel.type === ChannelType.PublicThread ||
      message.channel.type === ChannelType.PrivateThread
    );
  },
  execute: async (ctx, message, _settings) => {
    const thread = message.channel;
    if (!("parentId" in thread) || !thread.parentId) return;

    const guildId = message.guild?.id;
    if (!guildId) return;

    // Get readings forum config
    let readingsConfig;
    try {
      readingsConfig = await getConfigByRole(guildId, "readings");
    } catch {
      return;
    }

    const readingsForumId = readingsConfig?.channelId;
    if (!readingsForumId || thread.parentId !== readingsForumId) return;

    // Get the article URL for this thread (from persistent cache)
    const articleUrl = await getThreadArticleUrl(thread.id);
    if (!articleUrl) {
      // No URL stored - might be an older thread before Q&A was added
      return;
    }

    const config = loadConfig();

    // Show typing indicator
    if ('sendTyping' in message.channel) {
      await message.channel.sendTyping();
    }

    // Generate response
    const response = await generateReadingsResponse(
      config,
      guildId,
      articleUrl,
      message.content
    );

    // Send response
    await message.reply({ content: response });

    logger.info({ threadId: thread.id }, "Readings Q&A response sent");
  },
};

export const readingsSkill: Skill = {
  id: "readings",
  name: "Readings",
  description: "Bookmark messages to a readings forum with Q&A support",
  tier: "free",

  reactions: [bookmarkReactionHandler],
  buttons: [toggleButtonHandler],
  messages: [readingsQAHandler],

  channelRoles: ["readings"],
};
