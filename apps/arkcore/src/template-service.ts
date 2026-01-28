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

export interface ForumTag {
  name: string;
  moderated?: boolean;
  emoji?: string; // Unicode emoji or custom emoji name
}

export interface TemplateChannel {
  name: string;
  type: "text" | "forum" | "voice" | "announcement";
  role?: string; // ChannelConfigRole
  permissions?: ChannelPermission[];
  topic?: string;
  availableTags?: ForumTag[]; // Forum channel tags
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

  const structure = template.structure as unknown as TemplateStructure;
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

          // Check if this is a forum channel by type string
          const isForum = channelDef.type === "forum";

          const newChannel = await guild.channels.create({
            name: channelDef.name,
            type: channelType as ChannelType.GuildText | ChannelType.GuildVoice | ChannelType.GuildForum | ChannelType.GuildAnnouncement,
            parent: categoryId,
            topic: channelDef.topic,
            permissionOverwrites: permissionOverwrites.length > 0 ? permissionOverwrites : undefined,
          });

          // Set availableTags after creating forum channel
          if (isForum && channelDef.availableTags?.length) {
            logger.info({ 
              guildId, 
              channelName: channelDef.name, 
              channelType: newChannel.type,
              hasSetAvailableTags: "setAvailableTags" in newChannel,
              tagsCount: channelDef.availableTags.length 
            }, "Attempting to set forum tags");
            
            try {
              const tags = channelDef.availableTags.map((tag) => ({
                name: tag.name,
                moderated: tag.moderated ?? false,
                emoji: tag.emoji ? { id: null, name: tag.emoji } : null,
              }));
              await (newChannel as any).setAvailableTags(tags, "Template apply");
              logger.info({ guildId, channelName: channelDef.name, tagsCount: tags.length }, "Set forum tags SUCCESS");
            } catch (tagError) {
              logger.error({ guildId, channelName: channelDef.name, error: tagError }, "Failed to set forum tags");
            }
          }

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

export interface ResetGuildResult {
  success: boolean;
  channelsDeleted: number;
  categoriesDeleted: number;
  configsDeleted: number;
  errors: string[];
}

/**
 * Reset guild by deleting all bot-managed channels and configs
 * Useful for testing template apply from scratch
 */
export const resetGuild = async (
  guild: Guild
): Promise<ResetGuildResult> => {
  const result: ResetGuildResult = {
    success: false,
    channelsDeleted: 0,
    categoriesDeleted: 0,
    configsDeleted: 0,
    errors: [],
  };

  const guildId = guild.id;

  // Get all channel configs for this guild
  const configs = await prisma.channelConfig.findMany({
    where: { guildId },
  });

  const managedChannelIds = new Set(configs.map((c) => c.channelId));
  const categoriesToDelete = new Set<string>();

  // Delete managed channels
  for (const config of configs) {
    if (!config.channelId) continue;
    const channelId = config.channelId;
    try {
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (channel) {
        // Track parent category for later deletion
        if (channel.parentId) {
          categoriesToDelete.add(channel.parentId);
        }
        await channel.delete("Template reset");
        result.channelsDeleted++;
        logger.info({ guildId, channelId }, "Deleted channel");
      }
    } catch (error) {
      result.errors.push(`Failed to delete channel ${channelId}: ${error}`);
    }
  }

  // Delete empty categories that were parents of managed channels
  for (const categoryId of categoriesToDelete) {
    try {
      const category = await guild.channels.fetch(categoryId).catch(() => null);
      if (category && category.type === ChannelType.GuildCategory) {
        // Check if category is now empty
        const children = guild.channels.cache.filter((ch) => ch.parentId === categoryId);
        if (children.size === 0) {
          await category.delete("Template reset - empty category");
          result.categoriesDeleted++;
          logger.info({ guildId, categoryId }, "Deleted empty category");
        }
      }
    } catch (error) {
      result.errors.push(`Failed to delete category ${categoryId}: ${error}`);
    }
  }

  // Delete all channel configs for this guild
  const deleteResult = await prisma.channelConfig.deleteMany({
    where: { guildId },
  });
  result.configsDeleted = deleteResult.count;
  logger.info({ guildId, count: deleteResult.count }, "Deleted channel configs");

  result.success = result.errors.length === 0;
  return result;
};

// Builtin template: havens-default
export const HAVENS_DEFAULT_TEMPLATE: TemplateStructure = {
  guildSettings: {
    timezone: "Asia/Tokyo",
    locale: "zh",
    enabledSkills: ["digest", "favorites", "voice", "readings", "editorial", "diary"],
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
        {
          name: "daily-digest",
          type: "forum",
          role: "digest_output",
          availableTags: [
            { name: "Digesting", emoji: "📊" },
            { name: "Complete", emoji: "✅" },
          ],
        },
        { name: "favorites", type: "text", role: "favorites" },
        {
          name: "deep-dive",
          type: "forum",
          role: "deep_dive_output",
          availableTags: [
            { name: "Analyzing", emoji: "🔍" },
            { name: "Complete", emoji: "✅" },
          ],
        },
      ],
    },
    {
      name: "📚 阅读",
      slug: "readings",
      channels: [
        {
          name: "readings",
          type: "forum",
          role: "readings",
          availableTags: [
            { name: "Reading", emoji: "📖" },
            { name: "Complete", emoji: "✅" },
          ],
        },
      ],
    },
    {
      name: "✍️ 编辑",
      slug: "editorial",
      channels: [
        {
          name: "editorial",
          type: "forum",
          role: "editorial",
          availableTags: [
            { name: "Translating", emoji: "🌐" },
            { name: "Discussing", emoji: "💬" },
            { name: "Complete", emoji: "✅" },
          ],
        },
      ],
    },
    {
      name: "📔 日记",
      slug: "diary",
      channels: [
        {
          name: "diary",
          type: "forum",
          role: "diary",
          availableTags: [
            { name: "In Progress", emoji: "✏️" },
            { name: "Complete", emoji: "✅" },
          ],
        },
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
      "Haven 标准布局 - 包含信息源、输出、阅读、编辑、日记和系统频道",
      HAVENS_DEFAULT_TEMPLATE,
      undefined,
      true
    );
    logger.info("Seeded builtin template: havens-default");
  } else {
    // Update existing builtin template
    await prisma.guildTemplate.update({
      where: { name: "havens-default" },
      data: {
        description: "Haven 标准布局 - 包含信息源、输出、阅读、编辑、日记和系统频道",
        structure: HAVENS_DEFAULT_TEMPLATE as any,
      },
    });
    logger.info("Updated builtin template: havens-default");
  }
};
