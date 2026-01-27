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
import { loadConfig } from "../config.js";
import { getSkillConfig } from "../guild-settings.js";

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
  settings: GuildSettings
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

  const timezone = settings.timezone || config.tz;

  // Forum mode
  if (digestForumId) {
    const now = new Date();
    const dateStr = formatDigestDate(now, timezone);

    let thread = await findTodayDigestPost(ctx.client, digestForumId, dateStr);

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
    }

    for (const { channelId } of channelsToProcess) {
      try {
        const { rangeStart, rangeEnd } = await resolveDigestRange(channelId);
        const digest = await createDigest(config, channelId, rangeStart, rangeEnd);
        await sendChannelDigestToThread(thread, channelId, digest, config);
        ctx.logger.info({ guildId, channelId, items: digest.items.length }, "Digest sent to thread");
      } catch (error) {
        ctx.logger.error({ error, channelId }, "Failed to process channel digest");
      }
    }

    await removeDigestingTag(ctx.client, digestForumId, thread);
  } else {
    // Non-forum mode
    for (const { channelId } of channelsToProcess) {
      try {
        const { rangeStart, rangeEnd } = await resolveDigestRange(channelId);
        const digest = await createDigest(config, channelId, rangeStart, rangeEnd);

        if (config.digestThreadMode) {
          await sendDigestThreaded(ctx.client, channelId, digest, config);
        } else {
          await sendDigestOverview(ctx.client, channelId, digest, config);
        }
        ctx.logger.info({ guildId, channelId, items: digest.items.length }, "Digest sent");
      } catch (error) {
        ctx.logger.error({ error, channelId }, "Failed to process channel digest");
      }
    }
  }
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
  execute: async (ctx, interaction, settings) => {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({ content: "This command can only be used in a guild.", ephemeral: true });
      return;
    }

    await interaction.deferReply();

    try {
      await runDigestForGuild(ctx, guildId, settings);
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
