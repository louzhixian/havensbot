import {
  ChannelType,
  Guild,
  PermissionFlagsBits,
  OverwriteType,
} from "discord.js";
import { prisma } from "./db.js";
import { setConfig } from "./channel-config.js";
import { getOrCreateGuildSettings, updateGuildSettings } from "./guild-settings.js";
import { logger } from "./observability/logger.js";
import type { GuildTemplate, ChannelConfigRole } from "@prisma/client";

// Template structure types
export interface ChannelPermission {
  type: "role" | "member";
  id: string; // role id, "@everyone", or member id
  allow?: string[];
  deny?: string[];
}

export interface TemplateChannel {
  name: string;
  type: "text" | "forum" | "voice" | "announcement";
  role?: string; // ChannelConfigRole
  permissions?: ChannelPermission[];
  topic?: string;
}

export interface TemplateCategory {
  name: string;
  slug: string;
  channels: TemplateChannel[];
}

export interface TemplateGuildSettings {
  timezone?: string;
  locale?: string;
  enabledSkills?: string[];
}

export interface TemplateStructure {
  guildSettings?: TemplateGuildSettings;
  categories: TemplateCategory[];
}

// Discord channel type mapping
const CHANNEL_TYPE_MAP: Record<string, ChannelType> = {
  text: ChannelType.GuildText,
  forum: ChannelType.GuildForum,
  voice: ChannelType.GuildVoice,
  announcement: ChannelType.GuildAnnouncement,
};

// Permission mapping
const PERMISSION_MAP: Record<string, bigint> = {
  VIEW_CHANNEL: PermissionFlagsBits.ViewChannel,
  SEND_MESSAGES: PermissionFlagsBits.SendMessages,
  MANAGE_CHANNELS: PermissionFlagsBits.ManageChannels,
  MANAGE_MESSAGES: PermissionFlagsBits.ManageMessages,
  READ_MESSAGE_HISTORY: PermissionFlagsBits.ReadMessageHistory,
};

export const getTemplate = async (name: string): Promise<GuildTemplate | null> => {
  return prisma.guildTemplate.findUnique({
    where: { name },
  });
};

export const listTemplates = async (): Promise<GuildTemplate[]> => {
  return prisma.guildTemplate.findMany({
    orderBy: { name: "asc" },
  });
};

export const createTemplate = async (
  name: string,
  description: string,
  structure: TemplateStructure,
  createdBy?: string,
  isBuiltin: boolean = false
): Promise<GuildTemplate> => {
  return prisma.guildTemplate.create({
    data: {
      name,
      description,
      structure: structure as any,
      isBuiltin,
      createdBy,
    },
  });
};

export interface ApplyTemplateResult {
  success: boolean;
  categoriesCreated: number;
  channelsCreated: number;
  configsCreated: number;
  skipped: string[];
  errors: string[];
}

export const applyTemplate = async (
  guild: Guild,
  templateName: string
): Promise<ApplyTemplateResult> => {
  const result: ApplyTemplateResult = {
    success: false,
    categoriesCreated: 0,
    channelsCreated: 0,
    configsCreated: 0,
    skipped: [],
    errors: [],
  };

  const template = await getTemplate(templateName);
  if (!template) {
    result.errors.push(`Template "${templateName}" not found`);
    return result;
  }

  const structure = template.structure as TemplateStructure;
  const guildId = guild.id;

  // Apply guild settings if specified
  if (structure.guildSettings) {
    try {
      const settings = await getOrCreateGuildSettings(guildId);
      const updates: Partial<typeof settings> = {};
      
      if (structure.guildSettings.timezone) {
        updates.timezone = structure.guildSettings.timezone;
      }
      if (structure.guildSettings.locale) {
        updates.locale = structure.guildSettings.locale;
      }
      if (structure.guildSettings.enabledSkills) {
        updates.enabledSkills = structure.guildSettings.enabledSkills;
      }
      
      if (Object.keys(updates).length > 0) {
        await updateGuildSettings(guildId, updates as any);
      }
    } catch (error) {
      result.errors.push(`Failed to apply guild settings: ${error}`);
    }
  }

  // Create categories and channels
  const categoryMap = new Map<string, string>(); // slug -> categoryId

  for (const categoryDef of structure.categories) {
    try {
      // Check if category already exists
      const existingCategory = guild.channels.cache.find(
        (ch) => ch.type === ChannelType.GuildCategory && ch.name === categoryDef.name
      );

      let categoryId: string;

      if (existingCategory) {
        categoryId = existingCategory.id;
        result.skipped.push(`Category "${categoryDef.name}" already exists`);
      } else {
        const newCategory = await guild.channels.create({
          name: categoryDef.name,
          type: ChannelType.GuildCategory,
        });
        categoryId = newCategory.id;
        result.categoriesCreated++;
        logger.info({ guildId, categoryName: categoryDef.name }, "Created category");
      }

      categoryMap.set(categoryDef.slug, categoryId);

      // Create channels in this category
      for (const channelDef of categoryDef.channels) {
        try {
          // Check if channel already exists in this category
          const existingChannel = guild.channels.cache.find(
            (ch) =>
              ch.parentId === categoryId &&
              ch.name === channelDef.name
          );

          if (existingChannel) {
            result.skipped.push(`Channel "${channelDef.name}" already exists`);
            
            // Still set up the config if role is specified
            if (channelDef.role) {
              await setConfig(guildId, channelDef.role as ChannelConfigRole, {
                channelId: existingChannel.id,
              });
              result.configsCreated++;
            }
            continue;
          }

          const channelType = CHANNEL_TYPE_MAP[channelDef.type] || ChannelType.GuildText;

          // Build permission overwrites
          const permissionOverwrites: Array<{
            id: string;
            type: OverwriteType;
            allow?: bigint[];
            deny?: bigint[];
          }> = [];

          if (channelDef.permissions) {
            for (const perm of channelDef.permissions) {
              const targetId = perm.id === "@everyone" ? guildId : perm.id;
              const overwrite: {
                id: string;
                type: OverwriteType;
                allow?: bigint[];
                deny?: bigint[];
              } = {
                id: targetId,
                type: perm.type === "role" ? OverwriteType.Role : OverwriteType.Member,
              };

              if (perm.allow) {
                overwrite.allow = perm.allow
                  .map((p) => PERMISSION_MAP[p])
                  .filter(Boolean);
              }
              if (perm.deny) {
                overwrite.deny = perm.deny
                  .map((p) => PERMISSION_MAP[p])
                  .filter(Boolean);
              }

              permissionOverwrites.push(overwrite);
            }
          }

          const newChannel = await guild.channels.create({
            name: channelDef.name,
            type: channelType,
            parent: categoryId,
            topic: channelDef.topic,
            permissionOverwrites: permissionOverwrites.length > 0 ? permissionOverwrites : undefined,
          });

          result.channelsCreated++;
          logger.info({ guildId, channelName: channelDef.name }, "Created channel");

          // Set up ChannelConfig if role is specified
          if (channelDef.role) {
            await setConfig(guildId, channelDef.role as ChannelConfigRole, {
              channelId: newChannel.id,
            });
            result.configsCreated++;
          }
        } catch (error) {
          result.errors.push(`Failed to create channel "${channelDef.name}": ${error}`);
        }
      }
    } catch (error) {
      result.errors.push(`Failed to create category "${categoryDef.name}": ${error}`);
    }
  }

  result.success = result.errors.length === 0;
  return result;
};

// Builtin template: havens-default
export const HAVENS_DEFAULT_TEMPLATE: TemplateStructure = {
  guildSettings: {
    timezone: "Asia/Tokyo",
    locale: "zh",
    enabledSkills: ["digest", "favorites"],
  },
  categories: [
    {
      name: "📰 信息源",
      slug: "sources",
      channels: [
        { name: "tech-news", type: "text", role: "digest_source" },
        { name: "crypto-news", type: "text", role: "digest_source" },
      ],
    },
    {
      name: "📋 输出",
      slug: "outputs",
      channels: [
        { name: "daily-digest", type: "forum", role: "digest_output" },
        { name: "favorites", type: "text", role: "favorites" },
        { name: "deep-dive", type: "forum", role: "deep_dive_output" },
      ],
    },
    {
      name: "🔧 系统",
      slug: "system",
      channels: [
        {
          name: "havens-admin",
          type: "text",
          permissions: [
            { type: "role", id: "@everyone", deny: ["VIEW_CHANNEL"] },
          ],
        },
        {
          name: "havens-alerts",
          type: "text",
          permissions: [
            { type: "role", id: "@everyone", deny: ["SEND_MESSAGES"] },
          ],
        },
      ],
    },
  ],
};

// Seed builtin templates
export const seedBuiltinTemplates = async (): Promise<void> => {
  const existing = await getTemplate("havens-default");
  if (!existing) {
    await createTemplate(
      "havens-default",
      "Haven 标准布局 - 包含信息源、输出和系统频道",
      HAVENS_DEFAULT_TEMPLATE,
      undefined,
      true
    );
    logger.info("Seeded builtin template: havens-default");
  }
};
