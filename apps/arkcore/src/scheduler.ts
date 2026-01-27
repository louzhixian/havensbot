import cron from "node-cron";
import { ChannelType, Client } from "discord.js";
import { AppConfig } from "./config.js";
import { getDigestSourceCategories, getConfigByRole } from "./channel-config.js";
import { createDigest, resolveDigestRange } from "./digest.js";
import {
  sendDigestOverview,
  sendDigestThreaded,
  findTodayDigestPost,
  createDailyDigestPost,
  sendChannelDigestToThread,
  removeDigestingTag,
} from "./messaging.js";
import { ingestAllSources } from "./rss.js";
import { runAllAlertRules } from "./observability/alert-rules.js";
import { sendDailyReport } from "./observability/discord-notifier.js";
import { runArchivalProcess } from "./archival/archiver.js";
import { logger } from "./observability/logger.js";
import { checkTimeoutSessions, createDailyDiaryPost } from "./diary/session.js";
import { createLlmClient } from "./llm/client.js";

/**
 * Process digest for a single channel (non-forum mode)
 */
const processDigestForChannel = async (
  client: Client,
  config: AppConfig,
  channelId: string
): Promise<void> => {
  const channelStart = Date.now();

  const { rangeStart, rangeEnd } = await resolveDigestRange(channelId);
  console.log(
    `digest channel start: channelId=${channelId} rangeStart=${rangeStart.toISOString()} rangeEnd=${rangeEnd.toISOString()}`
  );
  const digest = await createDigest(config, channelId, rangeStart, rangeEnd);
  const meta = digest.summaryMeta;
  const llmState = meta.llmEnabled ? (meta.llmUsed ? "on" : "fallback") : "off";
  const fallback = meta.fallbackReason ?? "none";
  console.log(
    `digest channel built: channelId=${channelId} items=${digest.items.length} llm=${llmState} llm_items=${meta.llmItems} skipped_llm_items=${meta.skippedLlmItems} used_fulltext_count=${meta.usedFulltextCount} fallback_reason=${fallback}`
  );

  if (config.digestThreadMode) {
    await sendDigestThreaded(client, channelId, digest, config);
  } else {
    await sendDigestOverview(client, channelId, digest, config);
  }
  console.log(
    `digest channel sent: channelId=${channelId} duration_ms=${Date.now() - channelStart}`
  );
};

/**
 * Format date for digest post title
 */
const formatDigestDate = (date: Date, timeZone: string): string => {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
};

export const startSchedulers = (config: AppConfig, client: Client): void => {
  let fetching = false;
  let digesting = false;

  const fetchSchedule = `*/${config.fetchIntervalMinutes} * * * *`;
  console.log(
    `scheduler config: fetch=${fetchSchedule} digest=${config.digestCron} tz=${config.tz}`
  );

  cron.schedule(
    fetchSchedule,
    async () => {
      if (fetching) return;
      fetching = true;
      try {
        const result = await ingestAllSources(config);
        console.log(`rss ingest complete: ${result.totalNew} new items`);
        if (result.failedSources.length > 0) {
          const list = result.failedSources
            .slice(0, 3)
            .map((entry) => `${entry.name} (${entry.reason})`)
            .join(", ");
          const extra = result.failedSources.length - 3;
          console.warn(
            `rss ingest failures: ${list}${extra > 0 ? ` +${extra}` : ""}`
          );
        }
      } catch (error) {
        console.error("rss ingest job failed", error);
      } finally {
        fetching = false;
      }
    },
    { timezone: config.tz, recoverMissedExecutions: true }
  );

  cron.schedule(
    config.digestCron,
    async () => {
      console.log(`digest cron tick: ${new Date().toISOString()}`);
      if (digesting) return;
      digesting = true;

      try {
        // Get guild from any available channel to fetch database config
        const guild = client.guilds.cache.first();
        const guildId = guild?.id;

        // Get digest output from database config
        let digestForumId: string | null | undefined;
        if (guildId) {
          const digestOutputConfig = await getConfigByRole(guildId, "digest_output");
          digestForumId = digestOutputConfig?.channelId;
        }

        // Try to get digest source categories from database
        const sourceCategories = guildId ? await getDigestSourceCategories(guildId) : [];

        if (sourceCategories.length === 0 || !guild) {
          console.log("digest: no source categories configured, skipping");
          return;
        }

        // Collect all text channels from configured categories
        const channelsToProcess: Array<{ channelId: string; channelName: string }> = [];

        for (const categoryConfig of sourceCategories) {
          if (!categoryConfig.categoryId) continue;

          try {
            const category = await guild.channels.fetch(categoryConfig.categoryId);
            if (!category || category.type !== ChannelType.GuildCategory) {
              console.warn(`digest: category ${categoryConfig.categoryId} not found or not a category`);
              continue;
            }

            const textChannels = guild.channels.cache.filter(
              (ch) =>
                ch.parentId === categoryConfig.categoryId &&
                ch.type === ChannelType.GuildText
            );

            console.log(
              `digest category ${category.name}: found ${textChannels.size} text channels`
            );

            for (const [channelId, channel] of textChannels) {
              const channelName = "name" in channel ? channel.name : channelId;
              channelsToProcess.push({ channelId, channelName });
            }
          } catch (error) {
            console.error(
              `digest job failed for category ${categoryConfig.categoryId}`,
              error
            );
          }
        }

        if (channelsToProcess.length === 0) {
          console.log("digest: no channels to process");
          return;
        }

        // Forum mode: create single post, add all channels
        if (digestForumId) {
          const now = new Date();
          const dateStr = formatDigestDate(now, config.tz);

          // Find or create today's digest post
          let thread = await findTodayDigestPost(client, digestForumId, dateStr);

          if (!thread) {
            // Get time range from first channel to use for overview
            const { rangeStart, rangeEnd } = await resolveDigestRange(channelsToProcess[0].channelId);
            thread = await createDailyDigestPost(
              client,
              digestForumId,
              dateStr,
              channelsToProcess.length,
              rangeStart,
              rangeEnd,
              config.tz
            );
            console.log(`digest: created forum post ${thread.id}`);
          } else {
            console.log(`digest: found existing forum post ${thread.id}`);
          }

          // Process each channel and add to the same post
          for (const { channelId } of channelsToProcess) {
            try {
              const channelStart = Date.now();
              const { rangeStart, rangeEnd } = await resolveDigestRange(channelId);
              console.log(
                `digest channel start: channelId=${channelId} rangeStart=${rangeStart.toISOString()} rangeEnd=${rangeEnd.toISOString()}`
              );

              const digest = await createDigest(config, channelId, rangeStart, rangeEnd);
              const meta = digest.summaryMeta;
              const llmState = meta.llmEnabled ? (meta.llmUsed ? "on" : "fallback") : "off";
              const fallback = meta.fallbackReason ?? "none";
              console.log(
                `digest channel built: channelId=${channelId} items=${digest.items.length} llm=${llmState} llm_items=${meta.llmItems} skipped_llm_items=${meta.skippedLlmItems} used_fulltext_count=${meta.usedFulltextCount} fallback_reason=${fallback}`
              );

              await sendChannelDigestToThread(thread, channelId, digest, config);
              console.log(
                `digest channel sent: channelId=${channelId} duration_ms=${Date.now() - channelStart}`
              );
            } catch (error) {
              console.error(`digest job failed for channel ${channelId}`, error);
            }
          }

          // Remove "digesting" tag after all channels are processed
          await removeDigestingTag(client, digestForumId, thread);
          console.log(`digest: removed digesting tag from post ${thread.id}`);
        } else {
          // Non-forum mode: process each channel individually
          for (const { channelId } of channelsToProcess) {
            try {
              await processDigestForChannel(client, config, channelId);
            } catch (error) {
              console.error(`digest job failed for channel ${channelId}`, error);
            }
          }
        }
      } catch (error) {
        console.error("digest job failed", error);
      } finally {
        digesting = false;
      }
    },
    { timezone: config.tz, recoverMissedExecutions: true }
  );

  // Daily diary forum post creation
  if (config.diaryEnabled) {
    cron.schedule(
      config.diaryCron,
      async () => {
        try {
          logger.info("Creating daily diary post");
          const guild = client.guilds.cache.get(config.discordGuildId);
          if (!guild) {
            logger.warn("Guild not found for diary post creation");
            return;
          }

          const result = await createDailyDiaryPost(config, client, guild.id);
          if (result) {
            logger.info({ threadId: result.threadId }, "Daily diary post created");
          }
        } catch (error) {
          logger.error({ error }, "Failed to create daily diary post");
        }
      },
      { timezone: config.tz, recoverMissedExecutions: false }
    );
  }

  // Alert checking (hourly)
  cron.schedule(
    "0 * * * *",
    async () => {
      try {
        logger.info("Starting hourly alert check");
        await runAllAlertRules(config, client);
        logger.info("Alert check completed");
      } catch (error) {
        logger.error({ error }, "Alert check job failed");
      }
    },
    { timezone: config.tz, recoverMissedExecutions: true }
  );

  // Archival process (configurable schedule)
  if (config.archiveEnabled) {
    logger.info(
      { cron: config.archiveCheckCron, retentionDays: config.archiveAfterDays },
      "Archival task scheduled"
    );
    cron.schedule(
      config.archiveCheckCron,
      async () => {
        try {
          logger.info("Starting archival process");
          const result = await runArchivalProcess(config);
          logger.info(
            {
              itemsArchived: result.itemsArchived,
              metricsDeleted: result.metricsDeleted,
              alertsDeleted: result.alertsDeleted,
              duration: result.duration,
            },
            "Archival process completed"
          );
        } catch (error) {
          logger.error({ error }, "Archival job failed");
        }
      },
      { timezone: config.tz, recoverMissedExecutions: true }
    );
  }

  // Daily report (configurable schedule)
  if (config.dailyReportEnabled) {
    logger.info(
      { cron: config.dailyReportCron },
      "Daily report task scheduled (will use #arkcore-alerts channel)"
    );
    cron.schedule(
      config.dailyReportCron,
      async () => {
        try {
          logger.info("Starting daily report");
          await sendDailyReport(client, config);
          logger.info("Daily report sent");
        } catch (error) {
          logger.error({ error }, "Daily report job failed");
        }
      },
      { timezone: config.tz, recoverMissedExecutions: true }
    );
  }

  // Diary timeout checker (every 5 minutes)
  if (config.diaryEnabled) {
    const llmClient = createLlmClient(config);

    cron.schedule(
      "*/5 * * * *",
      async () => {
        try {
          await checkTimeoutSessions(config, client, llmClient);
        } catch (error) {
          logger.error({ error }, "Diary timeout check failed");
        }
      },
      { timezone: config.tz, recoverMissedExecutions: false }
    );
  }
};
