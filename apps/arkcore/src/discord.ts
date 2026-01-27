import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
} from "discord.js";
import { AppConfig } from "./config.js";
import { commandData } from "./commands.js";

export const createClient = (): Client => {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Message, Partials.Reaction, Partials.User],
  });
};

export const registerCommands = async (config: AppConfig): Promise<void> => {
  const rest = new REST({ version: "10" }).setToken(config.discordToken);

  if (config.discordGuildId) {
    // Guild-specific commands (faster for development)
    await rest.put(
      Routes.applicationGuildCommands(
        config.discordApplicationId,
        config.discordGuildId
      ),
      { body: commandData }
    );
    console.log(`Registered guild commands for ${config.discordGuildId}`);
  } else {
    // Global commands (for multi-tenant production)
    await rest.put(
      Routes.applicationCommands(config.discordApplicationId),
      { body: commandData }
    );
    console.log("Registered global commands");
  }
};
