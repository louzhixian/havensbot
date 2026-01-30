/**
 * LemonSqueezy Webhook Handler
 * 
 * Handles incoming webhooks from LemonSqueezy for subscription events.
 * Docs: https://docs.lemonsqueezy.com/help/webhooks
 */

import { Request, Response } from 'express';
import { Client, ChannelType, TextChannel } from 'discord.js';
import crypto from 'crypto';
import {
  handleSubscriptionCreated,
  handleSubscriptionUpdated,
  handleSubscriptionCancelled,
  storeBillingEvent,
} from '../services/lemonsqueezy.service.js';
import { logger } from '../observability/logger.js';

/**
 * Verify webhook signature from LemonSqueezy
 */
function verifyWebhookSignature(rawBody: string, signature: string, secret: string): boolean {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rawBody);
  const digest = hmac.digest('hex');
  
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
}

/**
 * Send payment failed notification to Discord
 */
async function sendPaymentFailedNotification(
  client: Client,
  guildId: string
): Promise<void> {
  try {
    const guild = await client.guilds.fetch(guildId);
    
    // Find a suitable channel to send the notification
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
      logger.warn({ guildId }, 'No suitable channel found for payment failed notification');
      return;
    }
    
    const message = `⚠️ **Haven Premium Payment Failed**

Your recent Premium subscription payment could not be processed.

**What This Means:**
• Your Premium access will remain active until the current billing period ends
• We'll automatically retry the payment in a few days
• If payment continues to fail, your subscription may be canceled

**How to Fix:**
1. Check that your payment method is valid and has sufficient funds
2. Update your payment information in your LemonSqueezy account
3. Contact your bank if the issue persists

**Need Help?**
• Use \`/billing\` to check your subscription status
• Visit your LemonSqueezy customer portal to update payment details
• Contact support if you need assistance

We'll notify you once the payment is successfully processed. Thank you for your patience! 🦉`;
    
    await targetChannel.send(message);
    logger.info({ guildId, channelId: targetChannel.id }, 'Payment failed notification sent');
  } catch (error) {
    logger.error({ error, guildId }, 'Failed to send payment failed notification');
  }
}

/**
 * Send payment recovered notification to Discord
 */
async function sendPaymentRecoveredNotification(
  client: Client,
  guildId: string
): Promise<void> {
  try {
    const guild = await client.guilds.fetch(guildId);
    
    // Find a suitable channel to send the notification
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
      logger.warn({ guildId }, 'No suitable channel found for payment recovered notification');
      return;
    }
    
    const message = `✅ **Haven Premium Payment Recovered**

Great news! Your subscription payment has been successfully processed.

Your Premium access will continue uninterrupted. Thank you for resolving the payment issue! 🦉`;
    
    await targetChannel.send(message);
    logger.info({ guildId, channelId: targetChannel.id }, 'Payment recovered notification sent');
  } catch (error) {
    logger.error({ error, guildId }, 'Failed to send payment recovered notification');
  }
}

/**
 * Send subscription success notification to Discord
 */
async function sendSubscriptionSuccessNotification(
  client: Client,
  guildId: string
): Promise<void> {
  try {
    const guild = await client.guilds.fetch(guildId);
    
    // Find a suitable channel to send the notification
    // Priority: system channel > first text channel
    let targetChannel: TextChannel | null = null;
    
    if (guild.systemChannel) {
      targetChannel = guild.systemChannel as TextChannel;
    } else {
      // Find first text channel
      const textChannels = guild.channels.cache.filter(
        (ch) => ch.type === ChannelType.GuildText
      );
      targetChannel = textChannels.first() as TextChannel | undefined || null;
    }
    
    if (!targetChannel) {
      logger.warn({ guildId }, 'No suitable channel found for subscription notification');
      return;
    }
    
    const message = `🎉 **Welcome to Haven Premium!**

Your server has been upgraded to Premium. Here's what you can do now:

✨ **Premium Skills Unlocked:**
• **DeepDive** - AI-powered article analysis with discussion threads
• **Readings** - Bookmark and Q&A system for articles
• **Editorial** - Translation and writing assistance
• **Diary** - AI-powered daily journaling
• **Voice** - Voice message transcription

📊 **LLM Features:**
• 100 LLM calls per day
• Smart digest summaries
• Up to 100 RSS sources

🚀 **Getting Started:**
1. Use \`/skills list\` to see all available skills
2. Use \`/skills enable <skill>\` to activate Premium features
3. Use \`/billing\` to check your usage anytime

💡 **Need Help?**
• \`/help\` - Command reference
• \`/init\` - Quick server setup

Thank you for supporting Haven! 🦉`;
    
    await targetChannel.send(message);
    logger.info({ guildId, channelId: targetChannel.id }, 'Subscription success notification sent');
  } catch (error) {
    logger.error({ error, guildId }, 'Failed to send subscription notification');
  }
}

/**
 * Create LemonSqueezy webhook handler with Discord client
 */
export function createLemonSqueezyWebhookHandler(client: Client) {
  return async function handleLemonSqueezyWebhook(req: Request, res: Response): Promise<void> {
  const signature = req.headers['x-signature'] as string;
  const webhookSecret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;

  if (!webhookSecret) {
    logger.error({}, 'LEMONSQUEEZY_WEBHOOK_SECRET not configured');
    res.status(500).json({ error: 'Webhook secret not configured' });
    return;
  }

  if (!signature) {
    logger.warn({}, 'Webhook signature missing');
    res.status(401).json({ error: 'Signature missing' });
    return;
  }

  // Verify signature
  const rawBody = JSON.stringify(req.body);
  const isValid = verifyWebhookSignature(rawBody, signature, webhookSecret);

  if (!isValid) {
    logger.warn({ signature }, 'Invalid webhook signature');
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  const payload = req.body;
  const eventName = payload.meta?.event_name;
  const eventId = payload.meta?.custom_data?.event_id || payload.data?.id;

  logger.info({ eventName, eventId }, `Received webhook: ${eventName}`);

  try {
    // Store event for audit trail
    const guildId = payload.meta?.custom_data?.guildId;
    await storeBillingEvent(eventName, eventId?.toString() || Date.now().toString(), payload, guildId);

    // Handle different event types
    switch (eventName) {
      case 'subscription_created':
        await handleSubscriptionCreated(payload);
        // Send success notification to Discord
        if (guildId) {
          await sendSubscriptionSuccessNotification(client, guildId);
        }
        break;

      case 'subscription_updated':
        await handleSubscriptionUpdated(payload);
        break;

      case 'subscription_cancelled':
      case 'subscription_expired':
        await handleSubscriptionCancelled(payload);
        break;

      case 'subscription_payment_success':
        // Log successful payments but don't need to update anything
        // (subscription_updated will handle the renewal date)
        logger.info({ eventId, guildId }, 'Subscription payment successful');
        break;

      case 'subscription_payment_failed':
        logger.warn({ eventId, guildId }, 'Subscription payment failed');
        // Send payment failed notification to Discord
        if (guildId) {
          await sendPaymentFailedNotification(client, guildId);
        }
        break;

      case 'subscription_payment_recovered':
        logger.info({ eventId, guildId }, 'Subscription payment recovered');
        // Send payment recovered notification to Discord
        if (guildId) {
          await sendPaymentRecoveredNotification(client, guildId);
        }
        break;

      default:
        logger.info({ eventName }, `Unhandled webhook event: ${eventName}`);
    }

    res.status(200).json({ received: true });
  } catch (error) {
    logger.error({ error, eventName, eventId }, 'Failed to process webhook');
    res.status(500).json({ error: 'Failed to process webhook' });
  }
  };
}
