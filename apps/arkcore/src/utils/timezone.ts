import type { GuildSettings } from '@prisma/client';
import type { AppConfig } from '../config.js';

/**
 * Get the timezone for a guild, falling back to the default config timezone.
 * @param settings - The guild settings object (may be null)
 * @param config - The application configuration
 * @returns The timezone string to use
 */
export const getGuildTimezone = (
  settings: GuildSettings | null,
  config: AppConfig
): string => {
  return settings?.timezone || config.tz;
};
