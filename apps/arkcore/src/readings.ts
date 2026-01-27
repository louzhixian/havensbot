import type {
  Client,
  Message,
  MessageReaction,
  PartialMessageReaction,
  ForumChannel,
  AnyThreadChannel,
} from "discord.js";
import { ChannelType, EmbedBuilder } from "discord.js";
import { getConfigByRole } from "./channel-config.js";
import { AppConfig } from "./config.js";
import { createForumPost } from "./messaging.js";
import { truncate } from "./utils.js";
import { buildMarkAsReadButton, READINGS_TOGGLE_PREFIX } from "./readings/buttons.js";
import { logger } from "./observability/logger.js";
import { createLlmClient } from "./llm/client.js";
import { generateReadingsResponse } from "./readings/llm.js";

const BOOKMARK_EMOJI = "🔖";
const MAX_BOOKMARK_CACHE = 1000;
const bookmarkedMessages = new Map<string, { threadId: string; createdAt: number }>();

// Map thread ID to original article URL for Q&A context
const threadArticleUrls = new Map<string, string>();
const MAX_THREAD_URL_CACHE = 500;

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

const normalizeEmoji = (value: string | null): string => {
  if (!value) return "";
  return value.replace(/\uFE0F/g, "");
};

const PENDING_MARKER = "__pending__";

const wasBookmarked = (messageId: string): boolean =>
  bookmarkedMessages.has(messageId);

const markPending = (messageId: string): void => {
  bookmarkedMessages.set(messageId, { threadId: PENDING_MARKER, createdAt: Date.now() });
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

const ensureMessage = async (
  reaction: MessageReaction | PartialMessageReaction
): Promise<Message | null> => {
  const fullReaction = reaction.partial ? await reaction.fetch() : reaction;
  const message = fullReaction.message.partial
    ? await fullReaction.message.fetch()
    : fullReaction.message;
  return message ?? null;
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

export const registerReadingsReactionHandler = (
  client: Client,
  config: AppConfig
): void => {
  client.on("messageReactionAdd", async (reaction, user) => {
    try {
      if (user.bot) return;

      const emojiName = normalizeEmoji(reaction.emoji.name);
      if (emojiName !== BOOKMARK_EMOJI) return;

      const message = await ensureMessage(reaction);
      if (!message || !message.guild) return;

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
      if ("parentId" in messageChannel && messageChannel.parentId === readingsForumId) return;

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
        const { thread } = await createForumPost(client, readingsForumId, {
          title,
          content: truncatedContent,
          embeds: message.embeds.length > 0 ? message.embeds.map(e => EmbedBuilder.from(e)) : undefined,
          tags: ["unread"],
        });

        // Mark as bookmarked immediately after thread creation to prevent duplicates
        // even if subsequent steps (attachments/button) fail
        markBookmarked(message.id, thread.id);

        // Extract and store article URL for Q&A
        const articleUrl = extractArticleUrl(message);
        if (articleUrl) {
          setThreadArticleUrl(thread.id, articleUrl);
        }

        // Send attachments if any (best effort, don't fail the whole operation)
        if (message.attachments.size > 0) {
          try {
            const files = message.attachments.map((a) => a.url);
            await thread.send({ files });
          } catch (attachError) {
            logger.warn({ error: attachError, threadId: thread.id }, "Failed to send attachments");
          }
        }

        // Send link footer as separate message (after embeds/attachments, before button)
        const linkFooter = `───────────────────\n📎 原消息: ${messageLink}\n💬 直接回复消息即可提问或探讨`;
        try {
          await thread.send({ content: linkFooter });
        } catch (linkError) {
          logger.warn({ error: linkError, threadId: thread.id }, "Failed to send link footer");
        }

        // Send the toggle button (best effort)
        try {
          await thread.send({ components: [buildMarkAsReadButton()] });
        } catch (buttonError) {
          logger.warn({ error: buttonError, threadId: thread.id }, "Failed to send toggle button");
        }

        logger.info({ messageId: message.id, threadId: thread.id }, "Bookmark created");
      } catch (innerError) {
        // Clear pending on failure so the message can be retried
        // This only happens if createForumPost itself fails
        clearPending(message.id);
        throw innerError;
      }
    } catch (error) {
      logger.error({ error }, "readings reaction handler failed");
    }
  });
};

export const registerReadingsButtonHandler = (
  client: Client,
  config: AppConfig
): void => {
  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith(READINGS_TOGGLE_PREFIX)) return;

    try {
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
      const { buildMarkAsReadButton, buildMarkAsUnreadButton } = await import(
        "./readings/buttons.js"
      );
      const newButton = hasUnread
        ? buildMarkAsUnreadButton()
        : buildMarkAsReadButton();

      await interaction.editReply({ components: [newButton] });

      logger.info(
        { threadId: thread.id, newState: hasUnread ? "read" : "unread" },
        "Reading status toggled"
      );
    } catch (error) {
      logger.error({ error }, "readings button handler failed");
    }
  });
};

/**
 * Register message handler for readings Q&A
 * Handles user messages in readings forum threads
 */
export const registerReadingsMessageHandler = (
  client: Client,
  config: AppConfig
): void => {
  const llmClient = createLlmClient(config);

  client.on("messageCreate", async (message) => {
    try {
      // Ignore bot messages
      if (message.author.bot) return;

      // Only handle messages in threads
      if (
        message.channel.type !== ChannelType.PublicThread &&
        message.channel.type !== ChannelType.PrivateThread
      ) {
        return;
      }

      // Check if this thread is in the readings forum
      const thread = message.channel;
      if (!("parentId" in thread) || !thread.parentId) return;

      // Get readings forum config
      const guildId = message.guild?.id;
      if (!guildId) return;

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
    } catch (error) {
      logger.error({ error }, "readings message handler failed");
    }
  });

  logger.info("Readings message handler registered");
};
