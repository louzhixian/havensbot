import type {
  Client,
  ChatInputCommandInteraction,
  MessageReaction,
  User,
  ApplicationCommandOptionData,
  ButtonInteraction,
} from "discord.js";
import type { PrismaClient, GuildSettings } from "@prisma/client";
import type { Logger } from "pino";

export type SkillTier = "free" | "premium";

export interface SkillContext {
  client: Client;
  db: PrismaClient;
  logger: Logger;
}

export interface SkillCommand {
  name: string;
  description: string;
  options?: ApplicationCommandOptionData[];
  execute: (
    ctx: SkillContext,
    interaction: ChatInputCommandInteraction,
    guildSettings: GuildSettings
  ) => Promise<void>;
}

export interface ReactionHandler {
  emoji: string | string[];
  execute: (
    ctx: SkillContext,
    reaction: MessageReaction,
    user: User,
    guildSettings: GuildSettings
  ) => Promise<void>;
}

export interface MessageHandler {
  /** Channel role to filter (e.g., "editorial"). If undefined, fires for all channels. */
  channelRole?: string;
  /** Filter function to determine if message should be handled */
  filter?: (message: import("discord.js").Message) => boolean;
  execute: (
    ctx: SkillContext,
    message: import("discord.js").Message,
    guildSettings: GuildSettings
  ) => Promise<void>;
}

export interface ButtonHandler {
  /** Custom ID prefix to match (e.g., "readings_toggle_") */
  customIdPrefix: string;
  execute: (
    ctx: SkillContext,
    interaction: ButtonInteraction,
    guildSettings: GuildSettings
  ) => Promise<void>;
}

export interface SkillCronJob {
  id: string;
  defaultCron: string;
  configKey: string;
  execute: (
    ctx: SkillContext,
    guildId: string,
    settings: GuildSettings
  ) => Promise<void>;
}

export interface Skill {
  // Identity
  id: string;
  name: string;
  description: string;
  tier: SkillTier;

  // Lifecycle (optional)
  onGuildJoin?: (ctx: SkillContext, guildId: string) => Promise<void>;
  onGuildLeave?: (ctx: SkillContext, guildId: string) => Promise<void>;
  onBotReady?: (ctx: SkillContext) => Promise<void>;  // bot 启动完成
  onBotStop?: (ctx: SkillContext) => Promise<void>;   // bot 正在关闭

  // Capabilities (optional)
  commands?: SkillCommand[];
  reactions?: ReactionHandler[];
  buttons?: ButtonHandler[];
  messages?: MessageHandler[];
  cron?: SkillCronJob[];
  channelRoles?: string[];
}
