/**
 * Subscription Reminder Service
 * 
 * Sends reminders for expiring Premium subscriptions.
 */

import { Client, ChannelType, TextChannel } from 'discord.js';
import { prisma as db } from '../db.js';
import { logger } from '../observability/logger.js';

/**
 * Send expiration reminder to Discord
 */
async function sendExpirationReminder(
  client: Client,
  guildId: string,
  expiresAt: Date,
  daysLeft: number
): Promise<void> {
  try {
    const guild = await client.guilds.fetch(guildId);
    
    // Find a suitable channel (system channel or first text channel)
    let targetChannel: TextChannel | null = null;
    
    if (guild.systemChannel) {
      targetChannel = guild.systemChannel as TextChannel;
    } else {
      const textChannels = guild.channels.cache.filter(
        (ch) => ch.type === ChannelType.GuildText
      );
      targetChannel = textChannels.first() as TextChannel | undefined || null;
    }
    
    if (!targetChannel) {
      logger.warn({ guildId }, 'No suitable channel found for expiration reminder');
      return;
    }
    
    const expiresAtStr = expiresAt.toLocaleDateString();
    
    const message = `⏰ **Haven Premium Expiration Reminder**

Your Premium subscription will expire in **${daysLeft} day${daysLeft > 1 ? 's' : ''}** (${expiresAtStr}).

To continue enjoying Premium features, your subscription will automatically renew. If you have any issues, please use \`/billing\` to check your subscription status.

**Premium Features:**
• All Premium Skills (DeepDive, Readings, Editorial, Diary, Voice)
• 100 LLM calls per day
• Up to 100 RSS sources
• Smart digest summaries

If you'd like to cancel, use \`/cancel\` (your access continues until ${expiresAtStr}).`;
    
    await targetChannel.send(message);
    logger.info({ guildId, daysLeft, expiresAt }, 'Expiration reminder sent');
  } catch (error) {
    logger.error({ error, guildId }, 'Failed to send expiration reminder');
  }
}

/**
 * Check for expiring subscriptions and send reminders
 */
export async function checkExpiringSubscriptions(client: Client): Promise<void> {
  const now = new Date();
  const threeDaysFromNow = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
  const fourDaysFromNow = new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000);

  try {
    // Find Premium guilds with subscriptions expiring in 3 days
    const expiringGuilds = await db.guildSettings.findMany({
      where: {
        tier: 'premium',
        tierExpiresAt: {
          gte: threeDaysFromNow,
          lt: fourDaysFromNow,
        },
      },
      include: {
        subscription: true,
      },
    });

    if (expiringGuilds.length === 0) {
      logger.debug({}, 'No expiring subscriptions to remind');
      return;
    }

    for (const guild of expiringGuilds) {
      // Skip if subscription is set to auto-renew (not canceled)
      if (guild.subscription && !guild.subscription.cancelAtPeriodEnd) {
        logger.debug(
          { guildId: guild.guildId },
          'Subscription auto-renewing, skipping reminder'
        );
        continue;
      }

      if (!guild.tierExpiresAt) {
        continue;
      }

      const daysLeft = Math.ceil(
        (guild.tierExpiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
      );

      await sendExpirationReminder(client, guild.guildId, guild.tierExpiresAt, daysLeft);
    }

    logger.info({ count: expiringGuilds.length }, `Checked ${expiringGuilds.length} expiring subscriptions`);
  } catch (error) {
    logger.error({ error }, 'Failed to check expiring subscriptions');
    throw error;
  }
}
