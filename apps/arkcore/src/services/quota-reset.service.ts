/**
 * Quota Reset Service
 * 
 * Handles daily LLM quota resets for Premium guilds.
 */

import { prisma as db } from '../db.js';
import { logger } from '../observability/logger.js';

/**
 * Reset LLM quota for guilds whose reset time has passed
 */
export async function resetExpiredQuotas(): Promise<void> {
  const now = new Date();

  try {
    // Find guilds with expired quota reset time
    const guilds = await db.guildSettings.findMany({
      where: {
        tier: 'premium',
        llmQuotaResetAt: {
          lte: now,
        },
      },
    });

    if (guilds.length === 0) {
      logger.debug({}, 'No quotas to reset');
      return;
    }

    // Reset quotas
    for (const guild of guilds) {
      await db.guildSettings.update({
        where: { id: guild.id },
        data: {
          llmUsedToday: 0,
          llmQuotaResetAt: new Date(now.getTime() + 24 * 60 * 60 * 1000), // +24h
        },
      });

      logger.info({ guildId: guild.guildId }, `Quota reset for guild ${guild.guildId}`);
    }

    logger.info({ count: guilds.length }, `Reset quotas for ${guilds.length} guilds`);
  } catch (error) {
    logger.error({ error }, 'Failed to reset quotas');
    throw error;
  }
}

/**
 * Initialize quota reset time for a guild (when they upgrade to Premium)
 */
export async function initializeQuotaResetTime(guildId: string): Promise<void> {
  const resetAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // +24h

  await db.guildSettings.update({
    where: { guildId },
    data: {
      llmQuotaResetAt: resetAt,
      llmUsedToday: 0,
    },
  });

  logger.info({ guildId, resetAt }, `Initialized quota reset time for ${guildId}`);
}
