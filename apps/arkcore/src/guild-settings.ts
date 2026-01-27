import { prisma } from "./db.js";
import type { GuildSettings } from "@prisma/client";
import { logger } from "./observability/logger.js";

const DEFAULT_ENABLED_SKILLS = ["digest", "favorites"];

export type SkillConfigValue = string | number | boolean | null;
export type SkillConfigs = Record<string, Record<string, SkillConfigValue>>;

export const getOrCreateGuildSettings = async (
  guildId: string
): Promise<GuildSettings> => {
  let settings = await prisma.guildSettings.findUnique({
    where: { guildId },
  });

  if (!settings) {
    settings = await prisma.guildSettings.create({
      data: {
        guildId,
        enabledSkills: DEFAULT_ENABLED_SKILLS,
      },
    });
    logger.info({ guildId }, "Created new GuildSettings");
  }

  return settings;
};

export const getGuildSettings = async (
  guildId: string
): Promise<GuildSettings | null> => {
  return prisma.guildSettings.findUnique({
    where: { guildId },
  });
};

export const getAllGuildSettings = async (): Promise<GuildSettings[]> => {
  return prisma.guildSettings.findMany({
    where: {
      tier: { not: "suspended" },
    },
  });
};

export const updateGuildSettings = async (
  guildId: string,
  data: Partial<Pick<GuildSettings, "timezone" | "locale" | "tier" | "enabledSkills">>
): Promise<GuildSettings> => {
  return prisma.guildSettings.update({
    where: { guildId },
    data,
  });
};

export const isSkillEnabled = async (
  guildId: string,
  skillId: string
): Promise<boolean> => {
  const settings = await getGuildSettings(guildId);
  if (!settings) return DEFAULT_ENABLED_SKILLS.includes(skillId);
  return settings.enabledSkills.includes(skillId);
};

export const enableSkill = async (
  guildId: string,
  skillId: string
): Promise<GuildSettings> => {
  const settings = await getOrCreateGuildSettings(guildId);
  if (settings.enabledSkills.includes(skillId)) {
    return settings;
  }
  return prisma.guildSettings.update({
    where: { guildId },
    data: {
      enabledSkills: [...settings.enabledSkills, skillId],
    },
  });
};

export const disableSkill = async (
  guildId: string,
  skillId: string
): Promise<GuildSettings> => {
  const settings = await getOrCreateGuildSettings(guildId);
  return prisma.guildSettings.update({
    where: { guildId },
    data: {
      enabledSkills: settings.enabledSkills.filter((id) => id !== skillId),
    },
  });
};

export const getSkillConfig = <T extends SkillConfigValue>(
  settings: GuildSettings,
  skillId: string,
  key: string,
  defaultValue: T
): T => {
  const configs = settings.skillConfigs as SkillConfigs | null;
  if (!configs) return defaultValue;
  const skillConfig = configs[skillId];
  if (!skillConfig) return defaultValue;
  const value = skillConfig[key];
  if (value === undefined || value === null) return defaultValue;
  return value as T;
};

export const deleteGuildSettings = async (guildId: string): Promise<void> => {
  await prisma.guildSettings.delete({
    where: { guildId },
  }).catch(() => {
    // Ignore if doesn't exist
  });
};
