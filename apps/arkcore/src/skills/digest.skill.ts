import { ChannelType } from "discord.js";
import type { GuildSettings } from "@prisma/client";
import type { Skill, SkillContext, SkillCronJob, SkillCommand } from "./types.js";
import { getDigestSourceCategories, getConfigByRole } from "../channel-config.js";
import { createDigest, resolveDigestRange } from "../digest.js";
import {
  sendDigestThreaded,
  sendDigestOverview,
  findTodayDigestPost,
  createDailyDigestPost,
  sendChannelDigestToThread,
  removeDigestingTag,
} from "../messaging.js";
import { loadConfig, AppConfig } from "../config.js";
import { getSkillConfig } from "../guild-settings.js";
import { getGuildTimezone } from "../utils/timezone.js";

// Retry configuration
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 5000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

type ProcessChannelResult = {
  success: boolean;
  channelId: string;
  channelName: string;
  itemCount?: number;
  error?: Error;
};

/**
 * Process a single channel's digest with retry mechanism
 */
const processChannelWithRetry = async (
  ctx: SkillContext,
  config: AppConfig,
  channelId: string,
  channelName: string,
  thread: { send: (options: { content: string }) => Promise<unknown> } | null,
  forumMode: boolean
): Promise<ProcessChannelResult> => {
  const { rangeStart, rangeEnd } = await resolveDigestRange(channelId);

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      const digest = await createDigest(config, channelId, rangeStart, rangeEnd);

      if (forumMode && thread) {
        await sendChannelDigestToThread(thread as Awaited<ReturnType<typeof createDailyDigestPost>>, channelId, digest, config);
      } else if (config.digestThreadMode) {
        await sendDigestThreaded(ctx.client, channelId, digest, config);
      } else {
        await sendDigestOverview(ctx.client, channelId, digest, config);
      }

      ctx.logger.info(
        { channelId, channelName, items: digest.items.length, attempt },
        "Digest processed successfully"
      );

      return {
        success: true,
        channelId,
        channelName,
        itemCount: digest.items.length,
      };
    } catch (error) {
      const isLastAttempt = attempt > MAX_RETRIES;

      if (isLastAttempt) {
        ctx.logger.error(
          { error, channelId, channelName, attempt },
          "Digest processing failed after all retries"
        );
        return {
          success: false,
          channelId,
          channelName,
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }

      ctx.logger.warn(
        { error, channelId, channelName, attempt, maxRetries: MAX_RETRIES },
        "Digest processing failed, retrying..."
      );
      await sleep(RETRY_DELAY_MS);
    }
  }

  // Should not reach here, but TypeScript needs this
  return {
    success: false,
    channelId,
    channelName,
    error: new Error("Unexpected retry loop exit"),
  };
};

const formatDigestDate = (date: Date, timeZone: string): string => {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
};

const runDigestForGuild = async (
  ctx: SkillContext,
  guildId: string,
  settings: GuildSettings,
  force = false // G-01: Allow force regeneration
): Promise<void> => {
  const config = loadConfig();
  const guild = ctx.client.guilds.cache.get(guildId);
  if (!guild) {
    ctx.logger.warn({ guildId }, "Guild not found for digest");
    return;
  }

  const digestOutputConfig = await getConfigByRole(guildId, "digest_output");
  const digestForumId = digestOutputConfig?.channelId;
  const sourceCategories = await getDigestSourceCategories(guildId);

  if (sourceCategories.length === 0) {
    ctx.logger.info({ guildId }, "No source categories configured, skipping digest");
    return;
  }

  // Collect all text channels from configured categories
  const channelsToProcess: Array<{ channelId: string; channelName: string }> = [];

  for (const categoryConfig of sourceCategories) {
    if (!categoryConfig.categoryId) continue;

    try {
      const category = await guild.channels.fetch(categoryConfig.categoryId);
      if (!category || category.type !== ChannelType.GuildCategory) {
        ctx.logger.warn({ categoryId: categoryConfig.categoryId }, "Category not found");
        continue;
      }

      const textChannels = guild.channels.cache.filter(
        (ch) =>
          ch.parentId === categoryConfig.categoryId &&
          ch.type === ChannelType.GuildText
      );

      for (const [channelId, channel] of textChannels) {
        const channelName = "name" in channel ? channel.name : channelId;
        channelsToProcess.push({ channelId, channelName });
      }
    } catch (error) {
      ctx.logger.error({ error, categoryId: categoryConfig.categoryId }, "Failed to fetch category");
    }
  }

  if (channelsToProcess.length === 0) {
    ctx.logger.info({ guildId }, "No channels to process for digest");
    return;
  }

  const timezone = getGuildTimezone(settings, config);

  const failedChannels: Array<{ channelName: string; error: string }> = [];
  let successCount = 0;

  // Forum mode
  if (digestForumId) {
    const now = new Date();
    const dateStr = formatDigestDate(now, timezone);

    let thread = await findTodayDigestPost(ctx.client, digestForumId, dateStr);

    // G-01: Skip processing if today's digest already exists (incremental digest)
    if (thread && !force) {
      ctx.logger.info(
        { guildId, threadId: thread.id, dateStr },
        "Today's digest already exists, skipping (use /digest run --force to regenerate)"
      );
      return;
    }

    // If force=true and thread exists, we'll reuse the thread and append content
    // Otherwise, create a new digest post
    if (!thread) {
      const { rangeStart, rangeEnd } = await resolveDigestRange(channelsToProcess[0].channelId);
      thread = await createDailyDigestPost(
        ctx.client,
        digestForumId,
        dateStr,
        channelsToProcess.length,
        rangeStart,
        rangeEnd,
        timezone
      );
      ctx.logger.info({ guildId, threadId: thread.id }, "Created forum digest post");
    } else {
      ctx.logger.info({ guildId, threadId: thread.id }, "Reusing existing digest post (force=true)");
    }

    // Create initial progress message
    let statusMessage: Awaited<ReturnType<typeof thread.send>> | null = null;
    try {
      statusMessage = await thread.send({
        content: `📊 正在生成每日摘要 (0/${channelsToProcess.length} 频道)，请稍候...`,
      });
    } catch (error) {
      ctx.logger.warn({ error }, "Failed to create status message");
    }

    for (let i = 0; i < channelsToProcess.length; i++) {
      const { channelId, channelName } = channelsToProcess[i];

      // Update progress message
      if (statusMessage && "edit" in statusMessage) {
        try {
          await statusMessage.edit({
            content: `📊 正在处理: ${i + 1}/${channelsToProcess.length} 频道 (#${channelName})...`,
          });
        } catch (error) {
          ctx.logger.debug({ error }, "Failed to update status message");
        }
      }

      const result = await processChannelWithRetry(
        ctx,
        config,
        channelId,
        channelName,
        thread,
        true
      );

      if (result.success) {
        successCount++;
      } else {
        failedChannels.push({
          channelName,
          error: result.error?.message || "Unknown error",
        });
      }
    }

    // Delete status message after completion
    if (statusMessage && "delete" in statusMessage) {
      try {
        await statusMessage.delete();
      } catch (error) {
        ctx.logger.debug({ error }, "Failed to delete status message");
      }
    }

    // Report failed channels in the forum thread
    if (failedChannels.length > 0) {
      const failedList = failedChannels
        .map(({ channelName }) => `#${channelName}`)
        .join(", ");
      try {
        await thread.send({
          content: `⚠️ 以下频道摘要生成失败 (已重试 ${MAX_RETRIES} 次): ${failedList}`,
        });
      } catch (sendError) {
        ctx.logger.error(
          { error: sendError, failedChannels },
          "Failed to send failure notification to thread"
        );
      }
    }

    await removeDigestingTag(ctx.client, digestForumId, thread);
  } else {
    // Non-forum mode
    for (const { channelId, channelName } of channelsToProcess) {
      const result = await processChannelWithRetry(
        ctx,
        config,
        channelId,
        channelName,
        null,
        false
      );

      if (result.success) {
        successCount++;
      } else {
        failedChannels.push({
          channelName,
          error: result.error?.message || "Unknown error",
        });
      }
    }
  }

  // Log summary
  ctx.logger.info(
    {
      guildId,
      totalChannels: channelsToProcess.length,
      successCount,
      failedCount: failedChannels.length,
      failedChannels: failedChannels.map((c) => c.channelName),
    },
    "Digest run completed"
  );
};

const digestCronJob: SkillCronJob = {
  id: "digest-daily",
  defaultCron: "0 9 * * *",
  configKey: "digestCron",
  execute: runDigestForGuild,
};

const runDigestCommand: SkillCommand = {
  name: "run",
  description: "Run digest now for this guild",
  options: [
    {
      type: 5, // Boolean
      name: "force",
      description: "Force re-generation even if today's digest already exists",
      required: false,
    },
  ],
  execute: async (ctx, interaction, settings) => {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({ content: "This command can only be used in a guild.", ephemeral: true });
      return;
    }

    const force = interaction.options.getBoolean("force") ?? false;

    await interaction.deferReply();

    // G-01: Pass force parameter to runDigestForGuild for incremental digest control
    try {
      await runDigestForGuild(ctx, guildId, settings, force);
      await interaction.editReply({ content: "Digest completed!" });
    } catch (error) {
      ctx.logger.error({ error, guildId }, "Digest command failed");
      await interaction.editReply({ content: "Digest failed. Check logs for details." });
    }
  },
};

export const digestSkill: Skill = {
  id: "digest",
  name: "Digest",
  description: "Daily RSS digest summaries",
  tier: "free",

  commands: [runDigestCommand],
  cron: [digestCronJob],

  channelRoles: ["digest_source", "digest_output"],
};
