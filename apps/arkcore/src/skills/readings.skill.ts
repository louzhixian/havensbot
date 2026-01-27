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
import { createLlmClient } from "../llm/client.js";
import { generateReadingsResponse } from "../readings/llm.js";

const BOOKMARK_EMOJI = "🔖";
const MAX_BOOKMARK_CACHE = 1000;
const bookmarkedMessages = new Map<
  string,
  { threadId: string; createdAt: number }
>();

/** Map thread ID to original article URL for Q&A context */
const threadArticleUrls = new Map<string, string>();
const MAX_THREAD_URL_CACHE = 500;

const PENDING_MARKER = "__pending__";

const setThreadArticleUrl = (threadId: string, url: string): void => {
  threadArticleUrls.set(threadId, url);
  if (threadArticleUrls.size <= MAX_THREAD_URL_CACHE) return;
  const oldest = threadArticleUrls.keys().next().value;
  if (oldest) {
    threadArticleUrls.delete(oldest);
  }
};

const getThreadArticleUrl = (threadId: string): string | undefined => {
  return threadArticleUrls.get(threadId);
};

const wasBookmarked = (messageId: string): boolean =>
  bookmarkedMessages.has(messageId);

const markPending = (messageId: string): void => {
  bookmarkedMessages.set(messageId, {
    threadId: PENDING_MARKER,
    createdAt: Date.now(),
  });
};

const clearPending = (messageId: string): void => {
  const entry = bookmarkedMessages.get(messageId);
  if (entry?.threadId === PENDING_MARKER) {
    bookmarkedMessages.delete(messageId);
  }
};

const markBookmarked = (messageId: string, threadId: string): void => {
  bookmarkedMessages.set(messageId, { threadId, createdAt: Date.now() });
  if (bookmarkedMessages.size <= MAX_BOOKMARK_CACHE) return;
  const oldest = bookmarkedMessages.keys().next().value;
  if (oldest) {
    bookmarkedMessages.delete(oldest);
  }
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

    // Check if already bookmarked or pending (in memory)
    if (wasBookmarked(message.id)) return;

    // Mark as pending to prevent concurrent duplicate creation
    markPending(message.id);

    try {
      // Generate post title
      const title = generatePostTitle(message);
      const messageLink = buildMessageLink(message);

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

      // Mark as bookmarked immediately after thread creation to prevent duplicates
      markBookmarked(message.id, thread.id);

      // Extract and store article URL for Q&A
      const articleUrl = extractArticleUrl(message);
      if (articleUrl) {
        setThreadArticleUrl(thread.id, articleUrl);
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
      }

      logger.info(
        { messageId: message.id, threadId: thread.id },
        "Bookmark created"
      );
    } catch (innerError) {
      // Clear pending on failure so the message can be retried
      clearPending(message.id);
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

    // Get the article URL for this thread
    const articleUrl = getThreadArticleUrl(thread.id);
    if (!articleUrl) {
      // No URL stored - might be an older thread before Q&A was added
      return;
    }

    const config = loadConfig();
    const llmClient = createLlmClient(config);

    // Show typing indicator
    await message.channel.sendTyping();

    // Generate response
    const response = await generateReadingsResponse(
      config,
      llmClient,
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
