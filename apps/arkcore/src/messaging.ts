import {
  Client,
  EmbedBuilder,
  GuildTextBasedChannel,
  ThreadAutoArchiveDuration,
  ForumChannel,
  ChannelType,
  type AnyThreadChannel,
} from "discord.js";
import { AppConfig } from "./config.js";
import { DigestData, DigestItem } from "./digest.js";
import { formatRange, sleep, truncate } from "./utils.js";
import { withRetry } from "./utils/retry-utils.js";
import { logger } from "./observability/logger.js";

export type ForumPostOptions = {
  title: string;
  content: string;
  embeds?: EmbedBuilder[];
  tags?: string[];
};

export type ForumPostResult = {
  thread: AnyThreadChannel;
  threadId: string;
};

/**
 * Wrap Discord API calls with retry logic
 */
async function retryDiscordCall<T>(
  operation: () => Promise<T>,
  operationName: string
): Promise<T> {
  return withRetry(operation, {
    maxAttempts: 3,
    initialDelayMs: 1000,
    backoffMultiplier: 2,
    retryableErrors: (error: any) => {
      // Retry on rate limits and transient errors
      if (error instanceof Error) {
        const message = error.message.toLowerCase();
        return (
          message.includes("rate limit") ||
          message.includes("timeout") ||
          message.includes("econnreset") ||
          message.includes("503") ||
          message.includes("502")
        );
      }
      return false;
    },
  }).catch((error) => {
    logger.error(
      { error, operation: operationName },
      "Discord API call failed after retries"
    );
    throw error;
  });
}

const ensureTextChannel = async (
  client: Client,
  channelId: string
): Promise<GuildTextBasedChannel> => {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    throw new Error("Channel is not text based or not found");
  }
  return channel as GuildTextBasedChannel;
};

const ensureForumChannel = async (
  client: Client,
  channelId: string
): Promise<ForumChannel> => {
  const channel = await client.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildForum) {
    throw new Error("Channel is not a forum channel or not found");
  }
  return channel as ForumChannel;
};

const resolveTagIds = (
  forum: ForumChannel,
  tagNames: string[]
): string[] => {
  const availableTags = forum.availableTags;
  const resolvedIds: string[] = [];

  for (const name of tagNames) {
    const tag = availableTags.find(
      (t) => t.name.toLowerCase() === name.toLowerCase()
    );
    if (tag) {
      resolvedIds.push(tag.id);
    }
  }

  return resolvedIds;
};

export const createForumPost = async (
  client: Client,
  forumChannelId: string,
  options: ForumPostOptions
): Promise<ForumPostResult> => {
  const forum = await ensureForumChannel(client, forumChannelId);

  const appliedTags = options.tags
    ? resolveTagIds(forum, options.tags)
    : [];

  const thread = await retryDiscordCall(
    () => forum.threads.create({
      name: options.title,
      message: {
        content: options.content || undefined,
        embeds: options.embeds,
      },
      appliedTags: appliedTags.length > 0 ? appliedTags : undefined,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    }),
    "create_forum_post"
  );

  return {
    thread,
    threadId: thread.id,
  };
};

/**
 * Find today's digest forum post if it exists
 */
export const findTodayDigestPost = async (
  client: Client,
  forumChannelId: string,
  dateStr: string
): Promise<AnyThreadChannel | null> => {
  const forum = await ensureForumChannel(client, forumChannelId);
  const expectedTitle = `📰 Daily Digest - ${dateStr}`;

  // Check active threads first
  const activeThreads = await forum.threads.fetchActive();
  const activeMatch = activeThreads.threads.find(
    (thread) => thread.name === expectedTitle
  );
  if (activeMatch) return activeMatch;

  // Check archived threads (recent)
  const archivedThreads = await forum.threads.fetchArchived({ limit: 10 });
  const archivedMatch = archivedThreads.threads.find(
    (thread) => thread.name === expectedTitle
  );
  if (archivedMatch) {
    // Unarchive it so we can post to it
    await archivedMatch.setArchived(false);
    return archivedMatch;
  }

  return null;
};

/**
 * Create a new daily digest forum post
 */
export const createDailyDigestPost = async (
  client: Client,
  forumChannelId: string,
  dateStr: string,
  totalChannels: number,
  windowStart: Date,
  windowEnd: Date,
  tz: string
): Promise<AnyThreadChannel> => {
  const title = `📰 Daily Digest - ${dateStr}`;

  // Determine tags based on date, add "digesting" tag during processing
  const tags: string[] = [];
  const dayOfWeek = windowEnd.getDay();
  tags.push(dayOfWeek === 0 || dayOfWeek === 6 ? "weekend" : "weekday");
  tags.push("digesting");

  const rangeText = formatRange(windowStart, windowEnd, tz);
  const overviewEmbed = new EmbedBuilder()
    .setTitle(`Daily Digest`)
    .setDescription(`Digest window: ${rangeText}\nChannels: ${totalChannels}`)
    .setTimestamp(new Date());

  const { thread } = await createForumPost(client, forumChannelId, {
    title,
    content: "",
    embeds: [overviewEmbed],
    tags,
  });

  return thread;
};

/**
 * Remove the "digesting" tag from a forum thread after processing is complete
 */
export const removeDigestingTag = async (
  client: Client,
  forumChannelId: string,
  thread: AnyThreadChannel
): Promise<void> => {
  const forum = await ensureForumChannel(client, forumChannelId);
  const digestingTag = forum.availableTags.find(
    (t) => t.name.toLowerCase() === "digesting"
  );

  if (!digestingTag) return;

  const currentTags = thread.appliedTags || [];
  const newTags = currentTags.filter((tagId) => tagId !== digestingTag.id);

  if (newTags.length !== currentTags.length) {
    await retryDiscordCall(
      () => thread.setAppliedTags(newTags),
      "remove_digesting_tag"
    );
  }
};

/**
 * Send a single channel's digest items to an existing forum thread
 */
export const sendChannelDigestToThread = async (
  thread: AnyThreadChannel,
  channelId: string,
  digest: DigestData,
  config: AppConfig
): Promise<{ failedItems: number; totalItems: number }> => {
  // Send channel separator with Discord channel mention
  await retryDiscordCall(
    () => thread.send({ content: `## <#${channelId}>` }),
    "send_channel_separator"
  );

  if (digest.items.length === 0) {
    await retryDiscordCall(
      () => thread.send({ content: "_No new items_" }),
      "send_no_items_notice"
    );
    return { failedItems: 0, totalItems: 0 };
  }

  const failed: DigestItem[] = [];

  for (const item of digest.items) {
    try {
      const embed = buildItemEmbed(item, config);
      await retryDiscordCall(
        () => thread.send({ embeds: [embed] }),
        "send_digest_item_forum"
      );
    } catch (error) {
      logger.warn(
        { error, itemTitle: item.title, itemUrl: item.url },
        "Failed to post digest item to forum"
      );
      failed.push(item);
    }
    await sleep(config.digestThreadThrottleMs);
  }

  if (failed.length > 0) {
    const names = failed
      .slice(0, 5)
      .map((item) => truncate(item.title, 80))
      .join(", ");
    const extra = failed.length - 5;
    await retryDiscordCall(
      () => thread.send({
        content: `_Failed to post ${failed.length} items: ${names}${
          extra > 0 ? ` +${extra}` : ""
        }_`,
      }),
      "send_digest_failure_summary_forum"
    );
  }

  return {
    failedItems: failed.length,
    totalItems: digest.items.length,
  };
};

const formatDate = (date: Date, timeZone: string): string => {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
};

const formatDateTime = (date: Date, timeZone: string): string => {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
};

const buildThreadName = (
  channelName: string,
  windowEnd: Date,
  timeZone: string
): string => {
  return `${channelName} digest · ${formatDate(windowEnd, timeZone)}`;
};

const buildOverviewDescription = (
  digest: DigestData,
  timeZone: string,
  threadMention?: string
): string => {
  const rangeText = formatRange(digest.windowStart, digest.windowEnd, timeZone);
  const lines = [`Digest window: ${rangeText}`];

  if (digest.items.length === 0) {
    lines.push("", "No new items today.");
  } else if (digest.updatedSources.length > 0) {
    const list = digest.updatedSources.slice(0, 10).join(", ");
    const extra = digest.updatedSources.length - 10;
    lines.push("", `Updated sources: ${list}${extra > 0 ? ` +${extra}` : ""}`);
  }

  if (digest.failedSources.length > 0) {
    const list = digest.failedSources
      .slice(0, 5)
      .map((entry) => `${entry.name} (${entry.reason})`)
      .join(", ");
    const extra = digest.failedSources.length - 5;
    lines.push("", `Failed sources: ${list}${extra > 0 ? ` +${extra}` : ""}`);
  }

  if (threadMention) {
    lines.push("", `Items posted to thread: ${threadMention}`);
  }

  return lines.join("\n");
};

const buildDigestTitle = (count: number): string => {
  const label = count === 1 ? "Message" : "Messages";
  return `${count} ${label} for Today`;
};

const limitSentences = (value: string, maxSentences: number): string => {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (/[.!?。！？]/.test(value[index])) {
      count += 1;
      if (count >= maxSentences) {
        return value.slice(0, index + 1);
      }
    }
  }
  return value;
};

const ensureSentenceEnding = (value: string): string => {
  if (!value) return value;
  if (/[.!?。！？]$/.test(value) || value.endsWith("...")) return value;
  return `${value}...`;
};

const sanitizeSummary = (value: string): string => {
  if (!value) return value;
  let cleaned = value;
  cleaned = cleaned.replace(/^\s*原标题[:：]\s*《?[^》\n]+》?\s*/i, "");
  cleaned = cleaned.replace(/评分[:：]\s*\d+\s*\|\s*作者[:：]\s*[^\n]+/i, "");
  cleaned = cleaned.replace(/作者[:：]\s*[^\n]+/i, "");
  cleaned = cleaned.replace(/评分[:：]\s*\d+/i, "");
  cleaned = cleaned.replace(/\s*\|\s*/g, " ");
  cleaned = cleaned.replace(/\s{2,}/g, " ").trim();
  return cleaned;
};

const buildItemEmbed = (
  item: DigestItem,
  config: AppConfig
): EmbedBuilder => {
  const title = truncate(item.title, 180);
  const publishedAt = item.publishedAt ? new Date(item.publishedAt) : null;
  const meta = publishedAt
    ? `${item.sourceName} · ${formatDateTime(publishedAt, config.tz)}`
    : item.sourceName;
  const rawSummary = item.summary?.trim() ?? "";
  const cleanedSummary = sanitizeSummary(rawSummary) || rawSummary;
  const limitedSummary = limitSentences(cleanedSummary, 2);
  const summary = ensureSentenceEnding(
    truncate(limitedSummary, config.digestItemSummaryMaxChars).trim()
  );

  const description = [meta, "", summary].join("\n");

  return new EmbedBuilder()
    .setTitle(title)
    .setURL(item.url)
    .setDescription(description);
};

const findExistingThread = async (
  channel: GuildTextBasedChannel,
  name: string
) => {
  const threadsManager = "threads" in channel ? channel.threads : null;
  if (!threadsManager) return null;

  const active = await threadsManager.fetchActive();
  const existing = active.threads.find((thread) => thread.name === name);
  return existing ?? null;
};

export const splitMessageContent = (
  content: string,
  maxLength = 1800
): string[] => {
  if (!content.trim()) {
    return ["(no content)"];
  }
  const paragraphs = content.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  const pushCurrent = () => {
    if (current.trim()) {
      chunks.push(current.trim());
    }
    current = "";
  };

  for (const paragraph of paragraphs) {
    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length <= maxLength) {
      current = next;
      continue;
    }
    if (current) {
      pushCurrent();
    }
    if (paragraph.length <= maxLength) {
      current = paragraph;
    } else {
      let offset = 0;
      while (offset < paragraph.length) {
        const slice = paragraph.slice(offset, offset + maxLength);
        chunks.push(slice.trim());
        offset += maxLength;
      }
    }
  }

  pushCurrent();
  return chunks.length > 0 ? chunks : [truncate(content, maxLength)];
};

export type DigestThreadResult = {
  threadId?: string;
  threadName?: string;
  failedItems: number;
  totalItems: number;
};

export const sendDigestOverview = async (
  client: Client,
  channelId: string,
  digest: DigestData,
  config: AppConfig
): Promise<DigestThreadResult> => {
  const channel = await ensureTextChannel(client, channelId);
  const overviewEmbed = new EmbedBuilder()
    .setTitle(buildDigestTitle(digest.items.length))
    .setDescription(buildOverviewDescription(digest, config.tz))
    .setTimestamp(new Date());

  await retryDiscordCall(
    () => channel.send({ embeds: [overviewEmbed] }),
    "send_digest_overview"
  );

  return {
    failedItems: 0,
    totalItems: digest.items.length,
  };
};

export const sendDigestThreaded = async (
  client: Client,
  channelId: string,
  digest: DigestData,
  config: AppConfig
): Promise<DigestThreadResult> => {
  const channel = await ensureTextChannel(client, channelId);
  const channelName = "name" in channel ? channel.name : channelId;
  const threadName = buildThreadName(channelName, digest.windowEnd, config.tz);
  const overviewEmbed = new EmbedBuilder()
    .setTitle(buildDigestTitle(digest.items.length))
    .setDescription(buildOverviewDescription(digest, config.tz))
    .setTimestamp(new Date());

  const overviewMessage = await retryDiscordCall(
    () => channel.send({ embeds: [overviewEmbed] }),
    "send_digest_threaded_overview"
  );

  if (digest.items.length === 0) {
    return {
      failedItems: 0,
      totalItems: 0,
    };
  }

  let thread = await findExistingThread(channel, threadName);

  if (!thread) {
    thread = await retryDiscordCall(
      () => overviewMessage.startThread({
        name: threadName,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      }),
      "start_digest_thread"
    );
  }

  const threadMention = thread ? `<#${thread.id}>` : undefined;
  if (threadMention) {
    const updatedEmbed = new EmbedBuilder()
      .setTitle(buildDigestTitle(digest.items.length))
      .setDescription(buildOverviewDescription(digest, config.tz, threadMention))
      .setTimestamp(new Date());

    await overviewMessage.edit({ embeds: [updatedEmbed] });
  }

  const failed: DigestItem[] = [];

  if (thread) {
    for (const item of digest.items) {
      try {
        const embed = buildItemEmbed(item, config);
        await retryDiscordCall(
          () => thread.send({ embeds: [embed] }),
          "send_digest_item"
        );
      } catch (error) {
        logger.warn(
          { error, itemTitle: item.title, itemUrl: item.url },
          "Failed to post digest item"
        );
        failed.push(item);
      }
      await sleep(config.digestThreadThrottleMs);
    }

    if (failed.length > 0) {
      const names = failed
        .slice(0, 5)
        .map((item) => truncate(item.title, 80))
        .join(", ");
      const extra = failed.length - 5;
      await retryDiscordCall(
        () => thread.send({
          content: `Failed to post ${failed.length} items: ${names}${
            extra > 0 ? ` +${extra}` : ""
          }`,
        }),
        "send_digest_failure_summary"
      );
    }
  }

  return {
    threadId: thread?.id,
    threadName,
    failedItems: failed.length,
    totalItems: digest.items.length,
  };
};
