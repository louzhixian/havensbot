import {
  ApplicationCommandOptionType,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  SlashCommandBuilder,
} from "discord.js";
import {
  getOrCreateGuildSettings,
  getGuildSettings,
  updateGuildSettings,
  enableSkill,
  disableSkill,
} from "./guild-settings.js";
import { prisma } from "./db.js";
import type { SkillRegistry } from "./skills/index.js";
import { listTemplates, applyTemplate, resetGuild } from "./template-service.js";
import { AppConfig } from "./config.js";
import {
  ADMIN_CHANNEL_NAME,
  findFixedChannel,
  setConfig,
  removeConfig,
  listConfigs,
  getConfigByRole,
  getDigestSourceCategories,
} from "./channel-config.js";
import { createDigest, resolveDigestRange } from "./digest.js";
import { digestQueue, type DigestResult } from "./digest/digestQueue.js";
import {
  sendDigestOverview,
  sendDigestThreaded,
  findTodayDigestPost,
  createDailyDigestPost,
  sendChannelDigestToThread,
  removeDigestingTag,
} from "./messaging.js";
import { ingestAllSources, ingestSourcesForChannel } from "./rss.js";
import {
  handleSourceAddOthers,
  handleSourceAddRss,
  handleSourceList,
  handleSourceRemove,
} from "./source-handlers.js";
import { truncate } from "./utils.js";
import {
  createPremiumCheckout,
  getGuildSubscription,
  isLemonSqueezyEnabled,
  cancelGuildSubscription,
} from "./services/lemonsqueezy.service.js";
import {
  getStatsOverview,
  getLlmDetailedStats,
  getRecentErrors,
  getStorageStats,
  getHealthStatus,
} from "./observability/stats.js";
import {
  formatStatsOverview,
  formatLlmStats,
  formatRecentErrors,
  formatStorageStats,
  formatHealthStatus,
  formatActiveAlerts,
  formatArchivalStats,
} from "./observability/discord-formatter.js";
import {
  getActiveAlerts,
  resolveAlert,
} from "./observability/alerts.js";
import {
  runArchivalProcess,
} from "./archival/archiver.js";
import { getArchivalStats } from "./archival/stats.js";
import {
  endDiarySessionByThread,
  listRecentDiarySessions,
  getDiarySessionByThread,
} from "./diary/index.js";
import { createLlmClient } from "./llm/client.js";
import { formatDiaryDate } from "./diary/context.js";

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

/**
 * Process a single digest job - used by the digest queue
 */
const processDigestJob = async (
  config: AppConfig,
  client: Client,
  channelId: string,
  rangeStart: Date,
  rangeEnd: Date,
  digestForumId?: string
): Promise<DigestResult> => {
  const digest = await createDigest(config, channelId, rangeStart, rangeEnd);

  let sendResult: { threadId?: string; totalItems: number; failedItems: number };

  if (digestForumId) {
    // Forum mode: find or create today's post, then add channel content
    const dateStr = formatDigestDate(new Date(), config.tz);
    let thread = await findTodayDigestPost(client, digestForumId, dateStr);

    if (!thread) {
      thread = await createDailyDigestPost(
        client,
        digestForumId,
        dateStr,
        1,
        rangeStart,
        rangeEnd,
        config.tz
      );
    }

    const result = await sendChannelDigestToThread(
      thread,
      channelId,
      digest,
      config
    );

    // Remove "digesting" tag after processing
    await removeDigestingTag(client, digestForumId, thread);

    sendResult = {
      threadId: thread.id,
      totalItems: result.totalItems,
      failedItems: result.failedItems,
    };
  } else if (config.digestThreadMode) {
    sendResult = await sendDigestThreaded(client, channelId, digest, config);
  } else {
    sendResult = await sendDigestOverview(client, channelId, digest, config);
  }

  return {
    digest,
    threadId: sendResult.threadId,
    totalItems: sendResult.totalItems,
    failedItems: sendResult.failedItems,
  };
};

export const commandData = [
  new SlashCommandBuilder().setName("ping").setDescription("Health check"),
  new SlashCommandBuilder()
    .setName("source")
    .setDescription("Manage RSS sources")
    .addSubcommandGroup((group) =>
      group
        .setName("add")
        .setDescription("Add a source")
        .addSubcommand((sub) =>
          sub
            .setName("rss")
            .setDescription("Add an RSS source")
            .addStringOption((option) =>
              option
                .setName("url")
                .setDescription("RSS feed URL(s), separated by spaces or commas")
                .setRequired(true)
            )
            .addStringOption((option) =>
              option
                .setName("name")
                .setDescription("Optional display name")
                .setRequired(false)
            )
        )
        .addSubcommand((sub) =>
          sub
            .setName("others")
            .setDescription("Add a site (GitHub or auto-detect RSS)")
            .addStringOption((option) =>
              option
                .setName("url")
                .setDescription("Website URL(s), separated by spaces or commas")
                .setRequired(true)
            )
            .addStringOption((option) =>
              option
                .setName("name")
                .setDescription("Optional display name")
                .setRequired(false)
            )
        )
    )
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("List sources in this channel")
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("Remove a source by URL")
        .addStringOption((option) =>
          option
            .setName("url")
            .setDescription("RSS feed URL(s), separated by spaces or commas")
            .setRequired(true)
        )
    ),
  new SlashCommandBuilder()
    .setName("digest")
    .setDescription("Digest operations")
    .addSubcommand((sub) => sub.setName("run").setDescription("Run digest now")),
  new SlashCommandBuilder()
    .setName("fetch")
    .setDescription("Fetch operations")
    .addSubcommand((sub) => sub.setName("now").setDescription("Fetch RSS now"))
    .addSubcommand((sub) =>
      sub.setName("all").setDescription("Fetch RSS for all channels")
    ),
  new SlashCommandBuilder()
    .setName("stats")
    .setDescription("View system statistics")
    .addSubcommand((sub) =>
      sub.setName("overview").setDescription("Overall system statistics")
    )
    .addSubcommand((sub) =>
      sub.setName("llm").setDescription("Detailed LLM usage statistics")
    )
    .addSubcommand((sub) =>
      sub
        .setName("errors")
        .setDescription("Recent errors")
        .addIntegerOption((option) =>
          option
            .setName("limit")
            .setDescription("Number of errors to show (default 10)")
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub.setName("storage").setDescription("Database storage statistics")
    )
    .addSubcommand((sub) =>
      sub.setName("health").setDescription("System health check")
    ),
  new SlashCommandBuilder()
    .setName("alerts")
    .setDescription("Manage system alerts")
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("List active alerts")
    )
    .addSubcommand((sub) =>
      sub
        .setName("resolve")
        .setDescription("Resolve an alert by ID")
        .addStringOption((option) =>
          option
            .setName("id")
            .setDescription("Alert ID to resolve")
            .setRequired(true)
        )
    ),
  new SlashCommandBuilder()
    .setName("maintenance")
    .setDescription("Maintenance operations")
    .addSubcommand((sub) =>
      sub.setName("archive").setDescription("Run archival process now")
    )
    .addSubcommand((sub) =>
      sub.setName("archive-stats").setDescription("View archival statistics")
    ),
  new SlashCommandBuilder()
    .setName("diary")
    .setDescription("Interactive diary")
    .addSubcommand((sub) =>
      sub.setName("start").setDescription("Start a new diary conversation")
    )
    .addSubcommand((sub) =>
      sub.setName("end").setDescription("End the current diary conversation")
    )
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("List recent diary entries")
    ),
  new SlashCommandBuilder()
    .setName("config")
    .setDescription("Manage ArkCore configuration")
    .addSubcommandGroup((group) =>
      group
        .setName("digest")
        .setDescription("Digest configuration")
        .addSubcommand((sub) =>
          sub
            .setName("add-category")
            .setDescription("Add a digest source category")
            .addChannelOption((opt) =>
              opt.setName("category").setDescription("Category to add").setRequired(true)
            )
            .addStringOption((opt) =>
              opt.setName("cron").setDescription("Cron schedule (e.g., 0 9 * * *)").setRequired(false)
            )
            .addStringOption((opt) =>
              opt
                .setName("format")
                .setDescription("Digest format")
                .addChoices(
                  { name: "Brief", value: "brief" },
                  { name: "Detailed", value: "detailed" },
                  { name: "Minimal", value: "minimal" }
                )
                .setRequired(false)
            )
        )
        .addSubcommand((sub) =>
          sub
            .setName("set-output")
            .setDescription("Set digest output forum")
            .addChannelOption((opt) =>
              opt.setName("channel").setDescription("Forum channel").setRequired(true)
            )
        )
        .addSubcommand((sub) =>
          sub.setName("list").setDescription("List digest configurations")
        )
        .addSubcommand((sub) =>
          sub
            .setName("remove")
            .setDescription("Remove a digest category")
            .addChannelOption((opt) =>
              opt.setName("category").setDescription("Category to remove").setRequired(true)
            )
        )
    )
    .addSubcommandGroup((group) =>
      group
        .setName("diary")
        .setDescription("Diary configuration")
        .addSubcommand((sub) =>
          sub
            .setName("set-channel")
            .setDescription("Set diary forum channel")
            .addChannelOption((opt) =>
              opt.setName("channel").setDescription("Forum channel").setRequired(true)
            )
        )
    )
    .addSubcommandGroup((group) =>
      group
        .setName("favorites")
        .setDescription("Favorites configuration")
        .addSubcommand((sub) =>
          sub
            .setName("set-channel")
            .setDescription("Set favorites output channel")
            .addChannelOption((opt) =>
              opt.setName("channel").setDescription("Text channel").setRequired(true)
            )
        )
    )
    .addSubcommandGroup((group) =>
      group
        .setName("deep-dive")
        .setDescription("Deep-dive configuration")
        .addSubcommand((sub) =>
          sub
            .setName("set-output")
            .setDescription("Set deep-dive output forum")
            .addChannelOption((opt) =>
              opt.setName("channel").setDescription("Forum channel").setRequired(true)
            )
        )
    )
    .addSubcommandGroup((group) =>
      group
        .setName("editorial")
        .setDescription("Editorial configuration")
        .addSubcommand((sub) =>
          sub
            .setName("set-channel")
            .setDescription("Set editorial channel")
            .addChannelOption((opt) =>
              opt.setName("channel").setDescription("Text channel").setRequired(true)
            )
        )
    )
    .addSubcommandGroup((group) =>
      group
        .setName("readings")
        .setDescription("Readings bookmark configuration")
        .addSubcommand((sub) =>
          sub
            .setName("set-channel")
            .setDescription("Set readings forum channel")
            .addChannelOption((opt) =>
              opt.setName("channel").setDescription("Forum channel").setRequired(true)
            )
        )
    )
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("List all configurations")
    ),
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Configure Haven for this server")
    .addStringOption((option) =>
      option
        .setName("timezone")
        .setDescription("Set server timezone (e.g., Asia/Tokyo, UTC)")
        .setRequired(false)
    )
    .addStringOption((option) =>
      option
        .setName("locale")
        .setDescription("Set language")
        .setRequired(false)
        .addChoices(
          { name: "English", value: "en" },
          { name: "中文", value: "zh" },
          { name: "日本語", value: "ja" }
        )
    ),
  new SlashCommandBuilder()
    .setName("skills")
    .setDescription("Manage Haven skills")
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("List all available skills")
    )
    .addSubcommand((sub) =>
      sub
        .setName("enable")
        .setDescription("Enable a skill")
        .addStringOption((option) =>
          option
            .setName("skill")
            .setDescription("Skill to enable")
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("disable")
        .setDescription("Disable a skill")
        .addStringOption((option) =>
          option
            .setName("skill")
            .setDescription("Skill to disable")
            .setRequired(true)
        )
    ),
  new SlashCommandBuilder()
    .setName("template")
    .setDescription("Manage guild structure templates")
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("List available templates")
    )
    .addSubcommand((sub) =>
      sub
        .setName("apply")
        .setDescription("Apply a template to this guild")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("Template name (e.g., havens-default)")
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("reset")
        .setDescription("⚠️ Delete all bot-managed channels and configs (for testing)")
    ),
  new SlashCommandBuilder()
    .setName("init")
    .setDescription("初始化 Haven - 快速搭建频道结构")
    .addStringOption((option) =>
      option
        .setName("template")
        .setDescription("选择模板（默认: havens-default）")
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("显示帮助信息和常用命令"),
  new SlashCommandBuilder()
    .setName("subscribe")
    .setDescription("Upgrade to Haven Premium"),
  new SlashCommandBuilder()
    .setName("billing")
    .setDescription("View subscription status and usage"),
  new SlashCommandBuilder()
    .setName("cancel")
    .setDescription("Cancel your Premium subscription (access continues until period end)"),
  new SlashCommandBuilder()
    .setName("admin")
    .setDescription("Admin commands for managing subscriptions and quotas")
    .addSubcommand((sub) =>
      sub
        .setName("set-tier")
        .setDescription("Set guild tier (admin only)")
        .addStringOption((option) =>
          option
            .setName("tier")
            .setDescription("Tier to set")
            .setRequired(true)
            .addChoices(
              { name: "Free", value: "free" },
              { name: "Premium", value: "premium" },
              { name: "Suspended", value: "suspended" }
            )
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("set-quota")
        .setDescription("Set LLM daily quota (admin only)")
        .addIntegerOption((option) =>
          option
            .setName("quota")
            .setDescription("Daily LLM quota (0-1000)")
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(1000)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("reset-quota")
        .setDescription("Reset today's LLM usage to 0 (admin only)")
    )
    .addSubcommand((sub) =>
      sub
        .setName("info")
        .setDescription("View detailed guild settings (admin only)")
    ),
].map((command) => command.toJSON());

/**
 * Check if user is a guild administrator
 */
function isGuildAdmin(interaction: ChatInputCommandInteraction): boolean {
  if (!interaction.guild || !interaction.member) {
    return false;
  }
  
  const member = interaction.member;
  
  // Check if user has Administrator permission
  if ('permissions' in member && member.permissions && typeof member.permissions !== 'string') {
    return member.permissions.has('Administrator');
  }
  
  return false;
}

/**
 * Handle /admin command
 */
async function handleAdminCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  // Check admin permission
  if (!isGuildAdmin(interaction)) {
    await interaction.reply({
      content: "❌ This command requires Administrator permission.",
      ephemeral: true,
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  await interaction.deferReply({ ephemeral: true });

  try {
    if (subcommand === "set-tier") {
      const tier = interaction.options.getString("tier", true) as "free" | "premium" | "suspended";
      
      await updateGuildSettings(interaction.guildId, { tier });
      
      await interaction.editReply({
        content: `✅ Guild tier updated to **${tier}**.\n\n${
          tier === "premium"
            ? "⚠️ Note: This doesn't create a subscription. Use this for testing or manual grants only."
            : ""
        }`,
      });
    } else if (subcommand === "set-quota") {
      const quota = interaction.options.getInteger("quota", true);
      
      await prisma.guildSettings.update({
        where: { guildId: interaction.guildId },
        data: { llmDailyQuota: quota },
      });
      
      await interaction.editReply({
        content: `✅ LLM daily quota updated to **${quota}** calls/day.`,
      });
    } else if (subcommand === "reset-quota") {
      await prisma.guildSettings.update({
        where: { guildId: interaction.guildId },
        data: { llmUsedToday: 0 },
      });
      
      await interaction.editReply({
        content: `✅ Today's LLM usage reset to 0.`,
      });
    } else if (subcommand === "info") {
      const guild = await getGuildSettings(interaction.guildId);
      
      if (!guild) {
        await interaction.editReply({
          content: "❌ Guild settings not found.",
        });
        return;
      }
      
      const subscription = await getGuildSubscription(interaction.guildId);
      
      let info = `📊 **Guild Settings Info**\n\n`;
      info += `**Guild ID:** ${guild.guildId}\n`;
      info += `**Tier:** ${guild.tier}\n`;
      info += `**Expires At:** ${guild.tierExpiresAt ? guild.tierExpiresAt.toLocaleString() : "N/A"}\n\n`;
      
      info += `**LLM Quota:**\n`;
      info += `• Daily Quota: ${guild.llmDailyQuota}\n`;
      info += `• Used Today: ${guild.llmUsedToday}\n`;
      info += `• Remaining: ${guild.llmDailyQuota - guild.llmUsedToday}\n`;
      info += `• Resets At: ${guild.llmQuotaResetAt ? guild.llmQuotaResetAt.toLocaleString() : "N/A"}\n\n`;
      
      info += `**Settings:**\n`;
      info += `• Timezone: ${guild.timezone}\n`;
      info += `• Locale: ${guild.locale}\n`;
      info += `• RSS Source Limit: ${guild.rssSourceLimit}\n`;
      info += `• Enabled Skills: ${guild.enabledSkills.join(", ")}\n\n`;
      
      if (subscription) {
        info += `**Subscription:**\n`;
        info += `• Status: ${subscription.status}\n`;
        info += `• LemonSqueezy ID: ${subscription.lemonSqueezyId}\n`;
        info += `• Customer ID: ${subscription.customerId}\n`;
        info += `• Variant ID: ${subscription.variantId}\n`;
        info += `• Current Period End: ${subscription.currentPeriodEnd.toLocaleString()}\n`;
        info += `• Cancel At Period End: ${subscription.cancelAtPeriodEnd}\n`;
        info += `• Created At: ${subscription.createdAt.toLocaleString()}\n`;
      } else {
        info += `**Subscription:** None\n`;
      }
      
      await interaction.editReply({ content: info });
    }
  } catch (error) {
    await interaction.editReply({
      content: `❌ Admin command failed: ${(error as Error).message}`,
    });
  }
}

/**
 * Handle /subscribe command
 */
async function handleSubscribeCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  // Check if LemonSqueezy is enabled
  if (!isLemonSqueezyEnabled()) {
    await interaction.reply({
      content: "❌ Payment system is not configured. Please contact the administrator.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    // Get guild settings
    const guild = await getGuildSettings(interaction.guildId);

    if (!guild) {
      await interaction.editReply({
        content: "❌ Guild settings not found. Please contact support.",
      });
      return;
    }

    // Check if already premium
    if (guild.tier === "premium") {
      const subscription = await getGuildSubscription(interaction.guildId);
      const expiresAt = subscription?.currentPeriodEnd
        ? new Date(subscription.currentPeriodEnd).toLocaleDateString()
        : "N/A";

      await interaction.editReply({
        content: `✅ You already have Haven Premium!\n\n📅 Renews: ${expiresAt}\n\nUse \`/billing\` to manage your subscription.`,
      });
      return;
    }

    // Create checkout session
    const checkoutUrl = await createPremiumCheckout(interaction.guildId, interaction.user.id);

    await interaction.editReply({
      content: `🚀 **Upgrade to Haven Premium**\n\n✨ Get access to:\n• All Premium Skills (DeepDive, Readings, Editorial, Diary, Voice)\n• LLM-powered summaries (100 calls/day)\n• Up to 100 RSS sources\n\n💳 **Price:** $9/month\n\n👉 [Click here to subscribe](${checkoutUrl})\n\n_After payment, your server will be automatically upgraded._`,
    });
  } catch (error) {
    await interaction.editReply({
      content: `❌ Failed to create checkout session: ${(error as Error).message}`,
    });
  }
}

/**
 * Handle /billing command
 */
async function handleBillingCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    // Get guild settings
    const guild = await getGuildSettings(interaction.guildId);

    if (!guild) {
      await interaction.editReply({
        content: "❌ Guild settings not found. Please contact support.",
      });
      return;
    }

    // Get subscription
    const subscription = await getGuildSubscription(interaction.guildId);

    // Build status message
    let message = `📊 **Haven Billing Status**\n\n`;
    message += `**Plan:** ${guild.tier === "premium" ? "✨ Premium" : "🆓 Free"}\n`;

    if (guild.tier === "premium" && subscription) {
      const expiresAt = new Date(subscription.currentPeriodEnd).toLocaleDateString();
      const daysLeft = Math.ceil(
        (new Date(subscription.currentPeriodEnd).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
      );

      message += `**Status:** ${subscription.cancelAtPeriodEnd ? "⚠️ Cancels" : "✅ Active"}\n`;
      message += `**Renews:** ${expiresAt} (${daysLeft} days)\n\n`;

      message += `**Usage (Today):**\n`;
      message += `• LLM Calls: ${guild.llmUsedToday} / ${guild.llmDailyQuota}\n`;
      message += `• RSS Sources: Check with \`/source list\`\n\n`;

      if (subscription.cancelAtPeriodEnd) {
        message += `⚠️ Your subscription will end on ${expiresAt}. You can resubscribe anytime with \`/subscribe\`.`;
      } else {
        message += `ℹ️ To cancel your subscription, use \`/cancel\`.`;
      }
    } else if (guild.tier === "free") {
      message += `\n💡 **Want more?** Upgrade to Premium:\n`;
      message += `• All Premium Skills unlocked\n`;
      message += `• 100 LLM calls/day\n`;
      message += `• Up to 100 RSS sources\n\n`;
      message += `Use \`/subscribe\` to upgrade!`;
    }

    await interaction.editReply({ content: message });
  } catch (error) {
    await interaction.editReply({
      content: `❌ Failed to fetch billing info: ${(error as Error).message}`,
    });
  }
}

/**
 * Handle /cancel command
 */
async function handleCancelCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    // Get guild settings
    const guild = await getGuildSettings(interaction.guildId);

    if (!guild) {
      await interaction.editReply({
        content: "❌ Guild settings not found. Please contact support.",
      });
      return;
    }

    // Check if user has Premium
    if (guild.tier !== "premium") {
      await interaction.editReply({
        content: "❌ You don't have an active Premium subscription to cancel.",
      });
      return;
    }

    // Get subscription
    const subscription = await getGuildSubscription(interaction.guildId);

    if (!subscription) {
      await interaction.editReply({
        content: "❌ No subscription found. Please contact support.",
      });
      return;
    }

    // Check if already set to cancel
    if (subscription.cancelAtPeriodEnd) {
      const expiresAt = new Date(subscription.currentPeriodEnd).toLocaleDateString();
      await interaction.editReply({
        content: `ℹ️ Your subscription is already set to cancel on ${expiresAt}.\n\nIf you'd like to continue with Premium, please contact support or resubscribe after cancellation.`,
      });
      return;
    }

    // Cancel subscription
    await cancelGuildSubscription(interaction.guildId);

    const expiresAt = new Date(subscription.currentPeriodEnd).toLocaleDateString();

    await interaction.editReply({
      content: `✅ **Subscription Canceled**\n\nYour Premium subscription has been canceled. You'll continue to have access to all Premium features until **${expiresAt}**.\n\n**What happens next:**\n• Premium access continues until ${expiresAt}\n• No further charges will be made\n• After ${expiresAt}, your server will be downgraded to Free tier\n\n**Changed your mind?**\nYou can resubscribe anytime with \`/subscribe\`.\n\nThank you for using Haven! 🦉`,
    });
  } catch (error) {
    await interaction.editReply({
      content: `❌ Failed to cancel subscription: ${(error as Error).message}`,
    });
  }
}

export const handleInteraction = async (
  interaction: ChatInputCommandInteraction,
  config: AppConfig,
  client: Client,
  registry?: SkillRegistry
): Promise<void> => {
  if (!interaction.guildId || !interaction.channelId) {
    await interaction.reply({
      content: "This command can only be used in a guild channel.",
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === "ping") {
    await interaction.reply({ content: "pong", ephemeral: true });
    return;
  }

  if (interaction.commandName === "source") {
    const group = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand();
    const isSourceAdd = group === "add" && (subcommand === "rss" || subcommand === "others");
    const isTextChannel =
      interaction.channel?.type === ChannelType.GuildText ||
      interaction.channel?.type === ChannelType.GuildAnnouncement;

    if (isSourceAdd && !isTextChannel) {
      await interaction.reply({
        content: "Please use /source add in a guild text or announcement channel.",
        ephemeral: true,
      });
      return;
    }

    if (group === "add" && subcommand === "rss") {
      await handleSourceAddRss(interaction);
      return;
    }

    if (group === "add" && subcommand === "others") {
      await handleSourceAddOthers(interaction);
      return;
    }

    if (subcommand === "list") {
      await handleSourceList(interaction);
      return;
    }

    if (subcommand === "remove") {
      await handleSourceRemove(interaction);
      return;
    }
  }

  if (interaction.commandName === "digest") {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "run") {
      await interaction.deferReply({ ephemeral: true });

      // Set up processor if not already set
      if (!digestQueue.processing && digestQueue.length === 0) {
        digestQueue.setProcessor(processDigestJob);
      }

      // Get digest output forum from database config
      const guildId = interaction.guildId;
      let digestForumId: string | undefined;
      if (guildId) {
        const digestOutputConfig = await getConfigByRole(guildId, "digest_output");
        digestForumId = digestOutputConfig?.channelId ?? undefined;
      }

      const { rangeStart, rangeEnd } = await resolveDigestRange(interaction.channelId);
      const queuePosition = digestQueue.length + 1;

      if (queuePosition > 1) {
        await interaction.editReply({
          content: `Digest queued (position ${queuePosition}). Please wait...`,
        });
      }

      try {
        const result = await digestQueue.enqueue(
          interaction.channelId,
          rangeStart,
          rangeEnd,
          config,
          client,
          digestForumId
        );

        const meta = result.digest.summaryMeta;
        const llmState = meta.llmEnabled ? (meta.llmUsed ? "on" : "fallback") : "off";
        const fallback = meta.fallbackReason ?? "none";
        const threadMention = result.threadId ? `<#${result.threadId}>` : "n/a";

        await interaction.editReply({
          content: `digest posted. thread=${threadMention} items=${result.totalItems} failed=${result.failedItems} LLM=${llmState} llm_items=${meta.llmItems} skipped_llm_items=${meta.skippedLlmItems} used_fulltext_count=${meta.usedFulltextCount} fallback_reason=${fallback}`,
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        await interaction.editReply({
          content: `Digest failed: ${truncate(errorMsg, 200)}`,
        });
      }
      return;
    }
  }

  if (interaction.commandName === "fetch") {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "now") {
      await interaction.deferReply({ ephemeral: true });

      const result = await ingestSourcesForChannel(interaction.channelId, config);
      const failed = result.failedSources;
      const failedList = failed
        .slice(0, 5)
        .map((entry) => `${entry.name} (${entry.reason})`)
        .join(", ");
      const extra = failed.length - 5;

      await interaction.editReply({
        content: `抓取完成，本频道新增 ${result.totalNew} 条。${
          failed.length > 0
            ? ` 失败: ${truncate(failedList, 700)}${extra > 0 ? ` +${extra}` : ""}`
            : ""
        }`,
      });
      return;
    }

    if (subcommand === "all") {
      await interaction.deferReply({ ephemeral: true });

      const result = await ingestAllSources(config);
      const failed = result.failedSources;
      const failedList = failed
        .slice(0, 5)
        .map((entry) => `${entry.name} (${entry.reason})`)
        .join(", ");
      const extra = failed.length - 5;

      await interaction.editReply({
        content: `抓取完成，全部频道新增 ${result.totalNew} 条。${
          failed.length > 0
            ? ` 失败: ${truncate(failedList, 700)}${extra > 0 ? ` +${extra}` : ""}`
            : ""
        }`,
      });
      return;
    }
  }

  if (interaction.commandName === "stats") {
    const subcommand = interaction.options.getSubcommand();
    await interaction.deferReply({ ephemeral: true });

    if (subcommand === "overview") {
      const stats = await getStatsOverview("1d");
      const formatted = formatStatsOverview(stats);
      await interaction.editReply({ content: formatted });
      return;
    }

    if (subcommand === "llm") {
      const stats = await getLlmDetailedStats();
      const formatted = formatLlmStats(stats);
      await interaction.editReply({ content: formatted });
      return;
    }

    if (subcommand === "errors") {
      const limit = interaction.options.getInteger("limit") || 10;
      const errors = await getRecentErrors(limit);
      const formatted = formatRecentErrors(errors);
      await interaction.editReply({ content: formatted });
      return;
    }

    if (subcommand === "storage") {
      const stats = await getStorageStats();
      const formatted = formatStorageStats(stats);
      await interaction.editReply({ content: formatted });
      return;
    }

    if (subcommand === "health") {
      const health = await getHealthStatus();
      const formatted = formatHealthStatus(health);
      await interaction.editReply({ content: formatted });
      return;
    }
  }

  if (interaction.commandName === "alerts") {
    const subcommand = interaction.options.getSubcommand();
    await interaction.deferReply({ ephemeral: true });

    if (subcommand === "list") {
      const alerts = await getActiveAlerts();
      const formatted = formatActiveAlerts(alerts);
      await interaction.editReply({ content: formatted });
      return;
    }

    if (subcommand === "resolve") {
      const alertId = interaction.options.getString("id", true);
      try {
        await resolveAlert(alertId);
        await interaction.editReply({
          content: `✅ Alert ${alertId} has been resolved.`,
        });
      } catch (error) {
        await interaction.editReply({
          content: `❌ Failed to resolve alert: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }
  }

  if (interaction.commandName === "maintenance") {
    const subcommand = interaction.options.getSubcommand();
    await interaction.deferReply({ ephemeral: true });

    if (subcommand === "archive") {
      try {
        const result = await runArchivalProcess(config);
        await interaction.editReply({
          content: `✅ Archival completed:\n- Items archived: ${result.itemsArchived}\n- Metrics deleted: ${result.metricsDeleted}\n- Alerts deleted: ${result.alertsDeleted}\n- Duration: ${result.duration}ms`,
        });
      } catch (error) {
        await interaction.editReply({
          content: `❌ Archival failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }

    if (subcommand === "archive-stats") {
      const stats = await getArchivalStats(config);
      const formatted = formatArchivalStats(stats);
      await interaction.editReply({ content: formatted });
      return;
    }
  }

  if (interaction.commandName === "diary") {
    const subcommand = interaction.options.getSubcommand();

    if (!config.diaryEnabled) {
      await interaction.reply({
        content: "Diary feature is not enabled.",
        ephemeral: true,
      });
      return;
    }

    if (subcommand === "start") {
      // Diary now uses forum posts with buttons - guide user
      await interaction.reply({
        content: "日记功能已改为在 diary forum 中使用。每天会自动创建日记帖子，点击「开始日记」按钮即可开始记录。",
        ephemeral: true,
      });
      return;
    }

    if (subcommand === "end") {
      // Check if we're in a diary thread
      const session = await getDiarySessionByThread(interaction.channelId);
      if (!session || session.endedAt) {
        await interaction.reply({
          content: "This command can only be used in an active diary thread.",
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      try {
        const llmClient = createLlmClient(config);
        const result = await endDiarySessionByThread(
          config,
          client,
          llmClient,
          interaction.channelId,
          "manual"
        );
        await interaction.editReply({
          content: `Diary session ended. ${result.messageCount} messages recorded.`,
        });
      } catch (error) {
        await interaction.editReply({
          content: `Failed to end diary: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }

    if (subcommand === "list") {
      await interaction.deferReply({ ephemeral: true });

      const sessions = await listRecentDiarySessions(10);
      if (sessions.length === 0) {
        await interaction.editReply({
          content: "No diary entries found.",
        });
        return;
      }

      const lines = sessions.map((s) => {
        const dateStr = formatDiaryDate(s.date, config.tz);
        const status = s.endedAt ? "completed" : "active";
        return `- ${dateStr}: ${s.messageCount} messages (${status})`;
      });

      await interaction.editReply({
        content: `**Recent Diary Entries**\n${lines.join("\n")}`,
      });
      return;
    }
  }

  if (interaction.commandName === "config") {
    // Check if command is used in #arkcore-admin channel
    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    const adminChannelId = await findFixedChannel(guild, ADMIN_CHANNEL_NAME);
    if (!adminChannelId || interaction.channelId !== adminChannelId) {
      await interaction.reply({
        content: `This command can only be used in #${ADMIN_CHANNEL_NAME} channel.`,
        ephemeral: true,
      });
      return;
    }

    const subcommandGroup = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand(false);

    // Handle /config digest subcommands
    if (subcommandGroup === "digest") {
      await interaction.deferReply({ ephemeral: true });

      if (subcommand === "add-category") {
        const categoryChannel = interaction.options.getChannel("category", true);
        const cron = interaction.options.getString("cron");
        const format = interaction.options.getString("format");

        // Validate that it's a category
        if (categoryChannel.type !== ChannelType.GuildCategory) {
          await interaction.editReply({
            content: "Please select a category channel, not a text or voice channel.",
          });
          return;
        }

        try {
          await setConfig(interaction.guildId, "digest_source", {
            categoryId: categoryChannel.id,
            digestCron: cron ?? undefined,
            digestFormat: format ?? undefined,
          });

          let message = `Added category <#${categoryChannel.id}> as a digest source.`;
          if (cron) message += ` Cron: \`${cron}\``;
          if (format) message += ` Format: ${format}`;

          await interaction.editReply({ content: message });
        } catch (error) {
          await interaction.editReply({
            content: `Failed to add category: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        return;
      }

      if (subcommand === "set-output") {
        const forumChannel = interaction.options.getChannel("channel", true);

        // Validate that it's a forum channel
        if (forumChannel.type !== ChannelType.GuildForum) {
          await interaction.editReply({
            content: "Please select a forum channel.",
          });
          return;
        }

        try {
          await setConfig(interaction.guildId, "digest_output", {
            channelId: forumChannel.id,
          });

          await interaction.editReply({
            content: `Set <#${forumChannel.id}> as the digest output forum.`,
          });
        } catch (error) {
          await interaction.editReply({
            content: `Failed to set output: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        return;
      }

      if (subcommand === "list") {
        try {
          const sources = await getDigestSourceCategories(interaction.guildId);
          const output = await getConfigByRole(interaction.guildId, "digest_output");

          if (sources.length === 0 && !output) {
            await interaction.editReply({
              content: "No digest configurations found.",
            });
            return;
          }

          let message = "**Digest Configuration**\n\n";

          if (output) {
            message += `**Output Forum:** <#${output.channelId}>\n\n`;
          }

          if (sources.length > 0) {
            message += "**Source Categories:**\n";
            for (const source of sources) {
              message += `- <#${source.categoryId}>`;
              if (source.digestCron) message += ` (cron: \`${source.digestCron}\`)`;
              if (source.digestFormat) message += ` (format: ${source.digestFormat})`;
              message += "\n";
            }
          }

          await interaction.editReply({ content: message });
        } catch (error) {
          await interaction.editReply({
            content: `Failed to list configurations: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        return;
      }

      if (subcommand === "remove") {
        const categoryChannel = interaction.options.getChannel("category", true);

        // Validate that it's a category
        if (categoryChannel.type !== ChannelType.GuildCategory) {
          await interaction.editReply({
            content: "Please select a category channel.",
          });
          return;
        }

        try {
          const sources = await getDigestSourceCategories(interaction.guildId);
          const source = sources.find((s) => s.categoryId === categoryChannel.id);

          if (!source) {
            await interaction.editReply({
              content: `Category <#${categoryChannel.id}> is not configured as a digest source.`,
            });
            return;
          }

          const success = await removeConfig(source.id);
          if (success) {
            await interaction.editReply({
              content: `Removed category <#${categoryChannel.id}> from digest sources.`,
            });
          } else {
            await interaction.editReply({
              content: `Failed to remove category.`,
            });
          }
        } catch (error) {
          await interaction.editReply({
            content: `Failed to remove category: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        return;
      }
    }

    // Handle /config diary subcommands
    if (subcommandGroup === "diary") {
      await interaction.deferReply({ ephemeral: true });

      if (subcommand === "set-channel") {
        const forumChannel = interaction.options.getChannel("channel", true);

        // Validate that it's a forum channel
        if (forumChannel.type !== ChannelType.GuildForum) {
          await interaction.editReply({
            content: "Please select a forum channel.",
          });
          return;
        }

        try {
          await setConfig(interaction.guildId, "diary", {
            channelId: forumChannel.id,
          });

          await interaction.editReply({
            content: `Set <#${forumChannel.id}> as the diary forum channel.`,
          });
        } catch (error) {
          await interaction.editReply({
            content: `Failed to set diary channel: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        return;
      }
    }

    // Handle /config favorites subcommands
    if (subcommandGroup === "favorites") {
      await interaction.deferReply({ ephemeral: true });

      if (subcommand === "set-channel") {
        const channel = interaction.options.getChannel("channel", true);

        try {
          await setConfig(interaction.guildId, "favorites", {
            channelId: channel.id,
          });

          await interaction.editReply({
            content: `Set favorites channel to: <#${channel.id}>`,
          });
        } catch (error) {
          await interaction.editReply({
            content: `Failed to set favorites channel: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        return;
      }
    }

    // Handle /config deep-dive subcommands
    if (subcommandGroup === "deep-dive") {
      await interaction.deferReply({ ephemeral: true });

      if (subcommand === "set-output") {
        const channel = interaction.options.getChannel("channel", true);

        // Validate that it's a forum channel
        if (channel.type !== ChannelType.GuildForum) {
          await interaction.editReply({
            content: "Please select a forum channel.",
          });
          return;
        }

        try {
          await setConfig(interaction.guildId, "deep_dive_output", {
            channelId: channel.id,
          });

          await interaction.editReply({
            content: `Set deep-dive output to: <#${channel.id}>`,
          });
        } catch (error) {
          await interaction.editReply({
            content: `Failed to set deep-dive output: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        return;
      }
    }

    // Handle /config editorial subcommands
    if (subcommandGroup === "editorial") {
      await interaction.deferReply({ ephemeral: true });

      if (subcommand === "set-channel") {
        const channel = interaction.options.getChannel("channel", true);

        try {
          await setConfig(interaction.guildId, "editorial", {
            channelId: channel.id,
          });

          await interaction.editReply({
            content: `Set editorial channel to: <#${channel.id}>`,
          });
        } catch (error) {
          await interaction.editReply({
            content: `Failed to set editorial channel: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        return;
      }
    }

    // Handle /config readings subcommands
    if (subcommandGroup === "readings") {
      await interaction.deferReply({ ephemeral: true });

      if (subcommand === "set-channel") {
        const channel = interaction.options.getChannel("channel", true);

        // Validate that it's a forum channel
        if (channel.type !== ChannelType.GuildForum) {
          await interaction.editReply({
            content: "Please select a forum channel.",
          });
          return;
        }

        try {
          await setConfig(interaction.guildId, "readings", {
            channelId: channel.id,
          });

          await interaction.editReply({
            content: `Set readings forum channel to: <#${channel.id}>`,
          });
        } catch (error) {
          await interaction.editReply({
            content: `Failed to set readings channel: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        return;
      }
    }

    // Handle /config list (no subcommandGroup)
    if (!subcommandGroup && subcommand === "list") {
      await interaction.deferReply({ ephemeral: true });

      try {
        const configs = await listConfigs(interaction.guildId);

        if (configs.length === 0) {
          await interaction.editReply({
            content: "No configurations found.",
          });
          return;
        }

        let message = "**All Configurations**\n\n";

        for (const cfg of configs) {
          const channelRef = cfg.channelId
            ? `<#${cfg.channelId}>`
            : cfg.categoryId
              ? `<#${cfg.categoryId}>`
              : "none";
          message += `- **${cfg.role}**: ${channelRef}`;
          if (cfg.digestCron) message += ` (cron: \`${cfg.digestCron}\`)`;
          if (cfg.digestFormat) message += ` (format: ${cfg.digestFormat})`;
          if (!cfg.enabled) message += ` [disabled]`;
          message += "\n";
        }

        await interaction.editReply({ content: message });
      } catch (error) {
        await interaction.editReply({
          content: `Failed to list configurations: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }

    await interaction.reply({
      content: "Unknown config subcommand.",
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === "setup") {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({ content: "This command can only be used in a guild.", ephemeral: true });
      return;
    }

    const timezone = interaction.options.getString("timezone");
    const locale = interaction.options.getString("locale");

    const settings = await getOrCreateGuildSettings(guildId);

    const updates: Partial<{ timezone: string; locale: string }> = {};
    if (timezone) updates.timezone = timezone;
    if (locale) updates.locale = locale;

    if (Object.keys(updates).length > 0) {
      await updateGuildSettings(guildId, updates);
    }

    const currentSettings = await getGuildSettings(guildId);

    await interaction.reply({
      content: `**Haven 设置**\n\n` +
        `时区: \`${currentSettings?.timezone || "UTC"}\`\n` +
        `语言: \`${currentSettings?.locale || "en"}\`\n` +
        `订阅层级: \`${currentSettings?.tier || "free"}\`\n` +
        `已启用技能: ${(currentSettings?.enabledSkills || []).map(s => `\`${s}\``).join(", ") || "无"}\n\n` +
        `使用 \`/skills list\` 查看所有可用技能`,
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === "skills") {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({ content: "This command can only be used in a guild.", ephemeral: true });
      return;
    }

    if (!registry) {
      await interaction.reply({ content: "Skill registry not available.", ephemeral: true });
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    const settings = await getOrCreateGuildSettings(guildId);
    const allSkills = registry.getAll();

    switch (subcommand) {
      case "list": {
        const lines = allSkills.map((skill) => {
          const enabled = settings.enabledSkills.includes(skill.id);
          const tierBadge = skill.tier === "premium" ? "💎" : "🆓";
          const statusBadge = enabled ? "✅" : "⬜";
          const canUse = registry.canUseSkill(skill, settings.tier);
          const lockBadge = canUse ? "" : "🔒";
          return `${statusBadge} ${tierBadge} **${skill.name}** ${lockBadge}\n   ${skill.description}`;
        });

        await interaction.reply({
          content: `**Haven Skills**\n\n${lines.join("\n\n")}\n\n` +
            `使用 \`/skills enable <skill>\` 或 \`/skills disable <skill>\` 管理技能`,
          ephemeral: true,
        });
        return;
      }

      case "enable": {
        const skillId = interaction.options.getString("skill", true);
        const skill = registry.get(skillId);

        if (!skill) {
          await interaction.reply({ content: `未知技能: ${skillId}`, ephemeral: true });
          return;
        }

        if (!registry.canUseSkill(skill, settings.tier)) {
          await interaction.reply({
            content: `技能 **${skill.name}** 需要 Premium 订阅`,
            ephemeral: true,
          });
          return;
        }

        await enableSkill(guildId, skillId);
        await interaction.reply({
          content: `✅ 已启用技能: **${skill.name}**`,
          ephemeral: true,
        });
        return;
      }

      case "disable": {
        const skillId = interaction.options.getString("skill", true);
        const skill = registry.get(skillId);

        if (!skill) {
          await interaction.reply({ content: `未知技能: ${skillId}`, ephemeral: true });
          return;
        }

        await disableSkill(guildId, skillId);
        await interaction.reply({
          content: `⬜ 已禁用技能: **${skill.name}**`,
          ephemeral: true,
        });
        return;
      }
    }
    return;
  }

  if (interaction.commandName === "template") {
    const guildId = interaction.guildId;
    const guild = interaction.guild;
    if (!guildId || !guild) {
      await interaction.reply({ content: "This command can only be used in a guild.", ephemeral: true });
      return;
    }

    // Check permissions
    const member = interaction.member;
    if (!member || typeof member.permissions === "string" || !member.permissions.has("ManageChannels")) {
      await interaction.reply({
        content: "You need **Manage Channels** permission to use this command.",
        ephemeral: true,
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "list") {
      await interaction.deferReply({ ephemeral: true });

      const templates = await listTemplates();
      if (templates.length === 0) {
        await interaction.editReply({ content: "No templates available." });
        return;
      }

      const lines = templates.map((t) => {
        const badge = t.isBuiltin ? "📦" : "👤";
        return `${badge} **${t.name}**\n   ${t.description}`;
      });

      await interaction.editReply({
        content: `**Available Templates**\n\n${lines.join("\n\n")}\n\n使用 \`/template apply <name>\` 应用模板`,
      });
      return;
    }

    if (subcommand === "apply") {
      const templateName = interaction.options.getString("name", true);

      await interaction.deferReply();

      const result = await applyTemplate(guild, templateName);

      if (!result.success && result.errors.length > 0 && result.categoriesCreated === 0 && result.channelsCreated === 0) {
        await interaction.editReply({
          content: `❌ 应用模板失败\n\n**错误**:\n${result.errors.map((e) => `• ${e}`).join("\n")}`,
        });
        return;
      }

      let message = `✅ 模板 **${templateName}** 应用完成\n\n`;
      message += `**创建**: ${result.categoriesCreated} 个分类, ${result.channelsCreated} 个频道, ${result.configsCreated} 个配置\n`;

      if (result.skipped.length > 0) {
        message += `\n**跳过** (已存在):\n${result.skipped.slice(0, 5).map((s) => `• ${s}`).join("\n")}`;
        if (result.skipped.length > 5) {
          message += `\n• ...还有 ${result.skipped.length - 5} 项`;
        }
      }

      if (result.errors.length > 0) {
        message += `\n\n**错误**:\n${result.errors.slice(0, 3).map((e) => `• ${e}`).join("\n")}`;
      }

      await interaction.editReply({ content: message });
      return;
    }

    if (subcommand === "reset") {
      await interaction.deferReply();

      const result = await resetGuild(guild);

      if (!result.success && result.errors.length > 0 && result.channelsDeleted === 0) {
        await interaction.editReply({
          content: `❌ 重置失败\n\n**错误**:\n${result.errors.map((e) => `• ${e}`).join("\n")}`,
        });
        return;
      }

      let message = `🗑️ **Guild 已重置**\n\n`;
      message += `**删除**: ${result.channelsDeleted} 个频道, ${result.categoriesDeleted} 个空分类, ${result.configsDeleted} 个配置\n`;

      if (result.errors.length > 0) {
        message += `\n**错误**:\n${result.errors.slice(0, 3).map((e) => `• ${e}`).join("\n")}`;
      }

      message += `\n\n现在可以运行 \`/template apply havens-default\` 重新创建频道`;

      await interaction.editReply({ content: message });
      return;
    }
    return;
  }

  if (interaction.commandName === "init") {
    const guildId = interaction.guildId;
    const guild = interaction.guild;
    if (!guildId || !guild) {
      await interaction.reply({ content: "此命令只能在服务器中使用。", ephemeral: true });
      return;
    }

    // Check permissions
    const member = interaction.member;
    if (!member || typeof member.permissions === "string" || !member.permissions.has("ManageChannels")) {
      await interaction.reply({
        content: "你需要 **管理频道** 权限才能使用此命令。",
        ephemeral: true,
      });
      return;
    }

    const templateName = interaction.options.getString("template") || "havens-default";

    await interaction.deferReply();

    // List available templates first if no template specified
    const templates = await listTemplates();
    if (templates.length === 0) {
      await interaction.editReply({
        content: "❌ 没有可用的模板。请联系管理员。",
      });
      return;
    }

    // Check if template exists
    const templateExists = templates.some((t) => t.name === templateName);
    if (!templateExists) {
      const templateList = templates.map((t) => `• \`${t.name}\` - ${t.description}`).join("\n");
      await interaction.editReply({
        content: `❌ 模板 \`${templateName}\` 不存在。\n\n**可用模板：**\n${templateList}\n\n请使用 \`/init template:模板名\` 重试。`,
      });
      return;
    }

    // Apply template
    const result = await applyTemplate(guild, templateName);

    if (!result.success && result.errors.length > 0 && result.categoriesCreated === 0 && result.channelsCreated === 0) {
      await interaction.editReply({
        content: `❌ 初始化失败\n\n**错误**:\n${result.errors.map((e) => `• ${e}`).join("\n")}`,
      });
      return;
    }

    let message = `🎉 **Haven 初始化完成！**\n\n`;
    message += `已应用模板: **${templateName}**\n`;
    message += `创建了 ${result.categoriesCreated} 个分类、${result.channelsCreated} 个频道\n\n`;

    message += `**下一步：**\n`;
    message += `1. 前往信息源频道（如 #tech-news）\n`;
    message += `2. 使用 \`/source add rss url:订阅地址\` 添加 RSS 源\n`;
    message += `3. 使用 \`/fetch now\` 抓取最新内容\n`;
    message += `4. 使用 \`/digest run\` 生成摘要\n\n`;
    message += `💡 提示：使用 \`/help\` 查看所有可用命令`;

    if (result.skipped.length > 0) {
      message += `\n\n**已跳过** (已存在的频道):\n${result.skipped.slice(0, 3).map((s) => `• ${s}`).join("\n")}`;
      if (result.skipped.length > 3) {
        message += `\n• ...还有 ${result.skipped.length - 3} 项`;
      }
    }

    await interaction.editReply({ content: message });
    return;
  }

  if (interaction.commandName === "help") {
    const helpMessage = `# 📚 Haven 帮助

## 🚀 快速开始
\`/init\` - 一键初始化服务器结构
\`/setup\` - 配置时区和语言
\`/skills list\` - 查看可用技能

## 📰 信息源管理
\`/source add rss url:订阅地址\` - 添加 RSS 订阅
\`/source add others url:网址\` - 添加 GitHub 等其他源
\`/source list\` - 列出当前频道的订阅源
\`/source remove url:订阅地址\` - 移除订阅源

## 📊 内容处理
\`/fetch now\` - 抓取当前频道的订阅内容
\`/fetch all\` - 抓取所有频道的订阅内容
\`/digest run\` - 生成当前频道的每日摘要

## ⚙️ 配置管理
\`/config digest add-category\` - 添加摘要源分类
\`/config digest set-output\` - 设置摘要输出频道
\`/config list\` - 列出所有配置
\`/template list\` - 列出可用模板
\`/template apply name:模板名\` - 应用模板

## 📈 系统监控
\`/stats overview\` - 系统统计概览
\`/stats health\` - 健康检查
\`/alerts list\` - 查看活动告警

## 💡 常用工作流

**日常使用：**
订阅内容会自动抓取并在指定时间生成摘要

**添加新信息源：**
1. 进入目标频道 → \`/source add rss url:...\`
2. \`/fetch now\` 立即抓取

**查看摘要：**
摘要会自动发布到配置的 digest 论坛频道

---
*更多帮助：https://havens.bot/docs*`;

    await interaction.reply({
      content: helpMessage,
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === "subscribe") {
    await handleSubscribeCommand(interaction);
    return;
  }

  if (interaction.commandName === "billing") {
    await handleBillingCommand(interaction);
    return;
  }

  if (interaction.commandName === "cancel") {
    await handleCancelCommand(interaction);
    return;
  }

  if (interaction.commandName === "admin") {
    await handleAdminCommand(interaction);
    return;
  }

  await interaction.reply({
    content: "Unsupported command.",
    ephemeral: true,
  });
};
