import type {
  Client,
  ChatInputCommandInteraction,
  MessageReaction,
  User,
  ApplicationCommandOptionData,
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

  // Capabilities (optional)
  commands?: SkillCommand[];
  reactions?: ReactionHandler[];
  cron?: SkillCronJob[];
  channelRoles?: string[];
}
