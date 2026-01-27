import "dotenv/config";
import { loadConfig } from "./config.js";
import { handleInteraction } from "./commands.js";
import { createClient, registerCommands } from "./discord.js";
import { disconnect } from "./db.js";
import { registerFavoriteReactionHandler } from "./favorites.js";
import { ingestAllSources } from "./rss.js";
import { startSchedulers } from "./scheduler.js";
import { registerEditorialDiscussionHandlers } from "./editorial-discussion.js";
import { registerEditorialTranslationHandlers } from "./editorial-translation.js";
import { registerVoiceHandler } from "./voice/voiceHandler.js";
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
} from "./channel-config.js";
import { logger } from "./observability/logger.js";

const main = async (): Promise<void> => {
  const config = loadConfig();
  const client = createClient();
  registerFavoriteReactionHandler(client, config);
  registerEditorialDiscussionHandlers(client, config);
  registerEditorialTranslationHandlers(client, config);
  registerVoiceHandler(client, config);
  registerDiaryMessageHandler(client, config);
  registerDiaryButtonHandler(client, config);
  registerReadingsReactionHandler(client, config);
  registerReadingsButtonHandler(client, config);
  registerReadingsMessageHandler(client, config);

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    try {
      await handleInteraction(interaction, config, client);
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

    // 初始化固定 channel
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

    await ingestAllSources(config);
    startSchedulers(config, client);
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
