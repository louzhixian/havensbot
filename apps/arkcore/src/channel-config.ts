import { Guild, PermissionFlagsBits } from "discord.js";
import { prisma } from "./db.js";
import { logger } from "./observability/logger.js";

// 固定 channel 名称
export const ADMIN_CHANNEL_NAME = "arkcore-admin";
export const ALERTS_CHANNEL_NAME = "arkcore-alerts";

export type ChannelConfigRole =
  | "digest_source"
  | "digest_output"
  | "deep_dive_output"
  | "diary"
  | "favorites"
  | "editorial"
  | "readings";

export type ChannelConfigData = {
  id: string;
  guildId: string;
  channelId: string | null;
  categoryId: string | null;
  role: ChannelConfigRole;
  digestCron: string | null;
  digestFormat: string | null;
  enabled: boolean;
};

/**
 * 查找固定名称的 channel
 */
export const findFixedChannel = async (
  guild: Guild,
  channelName: string
): Promise<string | null> => {
  const channel = guild.channels.cache.find(
    (ch) => ch.name === channelName && ch.isTextBased() && !ch.isThread()
  );
  return channel?.id ?? null;
};

/**
 * 配置固定 channel 的权限（仅管理员可见）
 */
export const setupAdminChannelPermissions = async (
  guild: Guild,
  channelId: string
): Promise<boolean> => {
  try {
    const channel = await guild.channels.fetch(channelId);
    if (!channel || !("permissionOverwrites" in channel)) return false;

    await channel.permissionOverwrites.set([
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel],
      },
    ]);

    logger.info({ channelId, guildId: guild.id }, "Admin channel permissions configured");
    return true;
  } catch (error) {
    logger.error({ error, channelId }, "Failed to configure admin channel permissions");
    return false;
  }
};

/**
 * 获取指定角色的配置
 */
export const getConfigByRole = async (
  guildId: string,
  role: ChannelConfigRole
): Promise<ChannelConfigData | null> => {
  const config = await prisma.channelConfig.findFirst({
    where: { guildId, role, enabled: true },
  });
  return config as ChannelConfigData | null;
};

/**
 * 获取所有 digest source categories
 */
export const getDigestSourceCategories = async (
  guildId: string
): Promise<ChannelConfigData[]> => {
  const configs = await prisma.channelConfig.findMany({
    where: { guildId, role: "digest_source", enabled: true },
  });
  return configs as ChannelConfigData[];
};

/**
 * 设置配置
 */
export const setConfig = async (
  guildId: string,
  role: ChannelConfigRole,
  data: {
    channelId?: string;
    categoryId?: string;
    digestCron?: string;
    digestFormat?: string;
  }
): Promise<ChannelConfigData> => {
  if (!data.channelId && !data.categoryId) {
    throw new Error("Either channelId or categoryId must be provided");
  }

  const where = data.channelId
    ? { guildId_channelId_role: { guildId, channelId: data.channelId, role } }
    : { guildId_categoryId_role: { guildId, categoryId: data.categoryId!, role } };

  const config = await prisma.channelConfig.upsert({
    where,
    create: {
      guildId,
      role,
      channelId: data.channelId ?? null,
      categoryId: data.categoryId ?? null,
      digestCron: data.digestCron ?? null,
      digestFormat: data.digestFormat ?? null,
    },
    update: {
      digestCron: data.digestCron,
      digestFormat: data.digestFormat,
      enabled: true,
    },
  });
  return config as ChannelConfigData;
};

/**
 * 删除配置
 */
export const removeConfig = async (id: string): Promise<boolean> => {
  try {
    await prisma.channelConfig.delete({ where: { id } });
    return true;
  } catch (error) {
    logger.error({ error, id }, "Failed to remove channel config");
    return false;
  }
};

/**
 * 获取所有配置
 */
export const listConfigs = async (guildId: string): Promise<ChannelConfigData[]> => {
  const configs = await prisma.channelConfig.findMany({
    where: { guildId },
    orderBy: { role: "asc" },
  });
  return configs as ChannelConfigData[];
};
