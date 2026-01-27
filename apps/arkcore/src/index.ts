import "dotenv/config";
import type { MessageReaction, User } from "discord.js";
import { loadConfig } from "./config.js";
import { handleInteraction } from "./commands.js";
import { createClient, registerCommands } from "./discord.js";
import { disconnect, prisma } from "./db.js";
import { registerFavoriteReactionHandler } from "./favorites.js";
import { ingestAllSources } from "./rss.js";
import { startSchedulers } from "./scheduler.js";
import { registerEditorialDiscussionHandlers } from "./editorial-discussion.js";
import { registerEditorialTranslationHandlers } from "./editorial-translation.js";
import { registerDiaryMessageHandler, registerDiaryButtonHandler } from "./diary/handler.js";
import {
  registerReadingsReactionHandler,
  registerReadingsButtonHandler,
  registerReadingsMessageHandler,
} from "./readings.js";
import {
  ADMIN_CHANNEL_NAME,
  ALERTS_CHANNEL_NAME,
  findFixedChannel,
  setupAdminChannelPermissions,
  getConfigByRole,
  type ChannelConfigRole,
} from "./channel-config.js";
import { logger } from "./observability/logger.js";
import {
  SkillRegistry,
  digestSkill,
  favoritesSkill,
  voiceSkill,
  type SkillContext,
} from "./skills/index.js";
import { getOrCreateGuildSettings } from "./guild-settings.js";
import { registerGuildCreateHandler } from "./onboarding.js";
import { seedBuiltinTemplates } from "./template-service.js";

const main = async (): Promise<void> => {
  const config = loadConfig();
  const client = createClient();

  // Initialize skill context and registry
  const skillCtx: SkillContext = {
    client,
    db: prisma,
    logger,
  };

  const registry = new SkillRegistry(skillCtx);
  registry.register(digestSkill);
  registry.register(favoritesSkill);
  registry.register(voiceSkill);

  // Register skill reaction handlers (multi-tenant)
  const reactionHandlers = registry.getAllReactionHandlers();
  client.on("messageReactionAdd", async (reaction, user) => {
    try {
      const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
      if (!message.guild) return;

      const settings = await getOrCreateGuildSettings(message.guild.id);
      const enabledSkills = await registry.getEnabledForGuild(message.guild.id);
      const enabledSkillIds = new Set(enabledSkills.map((s) => s.id));

      const emojiName = reaction.emoji.name?.replace(/\uFE0F/g, "") ?? "";

      for (const { skill, handler } of reactionHandlers) {
        if (!enabledSkillIds.has(skill.id)) continue;

        const emojis = Array.isArray(handler.emoji) ? handler.emoji : [handler.emoji];
        if (emojis.includes(emojiName)) {
          await handler.execute(skillCtx, reaction as MessageReaction, user as User, settings);
        }
      }
    } catch (error) {
      logger.error({ error }, "Skill reaction handler failed");
    }
  });

  // Register skill message handlers (multi-tenant)
  const messageHandlers = registry.getAllMessageHandlers();
  client.on("messageCreate", async (message) => {
    try {
      if (!message.guild) return;

      const settings = await getOrCreateGuildSettings(message.guild.id);
      const enabledSkills = await registry.getEnabledForGuild(message.guild.id);
      const enabledSkillIds = new Set(enabledSkills.map((s) => s.id));

      for (const { skill, handler } of messageHandlers) {
        if (!enabledSkillIds.has(skill.id)) continue;

        // Check channel role filter
        if (handler.channelRole) {
          const channelConfig = await getConfigByRole(
            message.guild.id,
            handler.channelRole as ChannelConfigRole
          );
          if (!channelConfig || channelConfig.channelId !== message.channelId) continue;
        }

        // Check custom filter
        if (handler.filter && !handler.filter(message)) continue;

        await handler.execute(skillCtx, message, settings);
      }
    } catch (error) {
      logger.error({ error }, "Skill message handler failed");
    }
  });

  // Register onboarding handler for new guilds
  registerGuildCreateHandler(client);

  // Legacy handlers (will be migrated to skills later)
  registerFavoriteReactionHandler(client, config); // Keep for reaction remove handling
  registerEditorialDiscussionHandlers(client, config);
  registerEditorialTranslationHandlers(client, config);
  // Voice handler migrated to voiceSkill
  registerDiaryMessageHandler(client, config);
  registerDiaryButtonHandler(client, config);
  registerReadingsReactionHandler(client, config);
  registerReadingsButtonHandler(client, config);
  registerReadingsMessageHandler(client, config);

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    try {
      await handleInteraction(interaction, config, client, registry);
    } catch (error) {
      console.error("interaction handler failed", error);
      if (interaction.isRepliable()) {
        const content = "Command failed. Please try again or check logs.";
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ content, ephemeral: true });
        } else {
          await interaction.reply({ content, ephemeral: true });
        }
      }
    }
  });

  client.once("ready", async () => {
    console.log(`Logged in as ${client.user?.tag}`);

    // Initialize GuildSettings for all guilds bot is already in
    for (const [guildId, guild] of client.guilds.cache) {
      await getOrCreateGuildSettings(guildId);
      logger.info({ guildId, guildName: guild.name }, "Initialized GuildSettings");
    }

    // Seed builtin templates
    await seedBuiltinTemplates();

    // 初始化固定 channel (legacy, per-guild)
    if (config.discordGuildId) {
      const guild = client.guilds.cache.get(config.discordGuildId);
      if (guild) {
        const adminChannelId = await findFixedChannel(guild, ADMIN_CHANNEL_NAME);
        const alertsChannelId = await findFixedChannel(guild, ALERTS_CHANNEL_NAME);

        if (adminChannelId) {
          await setupAdminChannelPermissions(guild, adminChannelId);
          logger.info({ channelId: adminChannelId }, "Admin channel initialized");
        } else {
          logger.warn(`Admin channel #${ADMIN_CHANNEL_NAME} not found`);
        }

        if (alertsChannelId) {
          await setupAdminChannelPermissions(guild, alertsChannelId);
          logger.info({ channelId: alertsChannelId }, "Alerts channel initialized");
        } else {
          logger.warn(`Alerts channel #${ALERTS_CHANNEL_NAME} not found`);
        }
      }
    }

    await ingestAllSources(config);
    startSchedulers(config, client, registry, skillCtx);
  });

  await registerCommands(config);
  await client.login(config.discordToken);

  const shutdown = async () => {
    console.log("Shutting down...");
    await disconnect();
    client.destroy();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};

main().catch((error) => {
  console.error("Fatal startup error", error);
  process.exit(1);
});
