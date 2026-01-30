/**
 * LemonSqueezy Payment Service
 * 
 * Handles subscription creation, webhook processing, and billing management.
 */

import {
  lemonSqueezySetup,
  createCheckout,
  getSubscription,
  updateSubscription,
  cancelSubscription,
  listSubscriptions,
  getStore,
  type Checkout,
  type Subscription,
} from '@lemonsqueezy/lemonsqueezy.js';
import { prisma as db } from '../db.js';
import { logger } from '../observability/logger.js';
import { initializeQuotaResetTime } from './quota-reset.service.js';

/**
 * Initialize LemonSqueezy SDK
 */
export function initializeLemonSqueezy() {
  const apiKey = process.env.LEMONSQUEEZY_API_KEY;
  
  if (!apiKey) {
    logger.warn({}, 'LEMONSQUEEZY_API_KEY not set - payment features disabled');
    return false;
  }

  lemonSqueezySetup({ apiKey });
  logger.info({}, 'LemonSqueezy SDK initialized');
  return true;
}

/**
 * Create a checkout session for Premium subscription
 */
export async function createPremiumCheckout(guildId: string, userId: string): Promise<string> {
  const storeId = process.env.LEMONSQUEEZY_STORE_ID;
  const variantId = process.env.LEMONSQUEEZY_PREMIUM_VARIANT_ID;

  if (!storeId || !variantId) {
    throw new Error('LemonSqueezy store/variant not configured');
  }

  try {
    const checkout = await createCheckout(storeId, variantId, {
      checkoutData: {
        custom: {
          guildId,
          userId,
        },
      },
    });

    if (!checkout.data?.data.attributes.url) {
      throw new Error('Failed to create checkout URL');
    }

    logger.info({
      guildId,
      checkoutId: checkout.data.data.id,
      url: checkout.data.data.attributes.url,
    }, `Created checkout for guild ${guildId}`);

    return checkout.data.data.attributes.url;
  } catch (error) {
    logger.error({ error, guildId, userId }, 'Failed to create checkout');
    throw error;
  }
}

/**
 * Handle subscription_created webhook event
 */
export async function handleSubscriptionCreated(payload: any): Promise<void> {
  const { data } = payload;
  const { id, attributes } = data;
  const customData = attributes.first_subscription_item?.subscription_item_data?.custom_data;

  if (!customData?.guildId) {
    logger.error({ payload }, 'Missing guildId in subscription custom data');
    return;
  }

  const guildId = customData.guildId;

  try {
    // Get guild settings
    const guild = await db.guildSettings.findUnique({
      where: { guildId },
    });

    if (!guild) {
      logger.error({ guildId }, `Guild not found: ${guildId}`);
      return;
    }

    // Create subscription record
    await db.subscription.create({
      data: {
        guildId: guild.guildId,
        lemonSqueezyId: id.toString(),
        customerId: attributes.customer_id.toString(),
        variantId: attributes.variant_id.toString(),
        status: attributes.status,
        currentPeriodEnd: new Date(attributes.renews_at),
        cancelAtPeriodEnd: attributes.cancelled ?? false,
      },
    });

    // Update guild settings
    await db.guildSettings.update({
      where: { guildId },
      data: {
        tier: 'premium',
        tierExpiresAt: new Date(attributes.renews_at),
        llmDailyQuota: 100,
      },
    });

    // Initialize quota reset time
    await initializeQuotaResetTime(guildId);

    logger.info({
      guildId,
      subscriptionId: id,
      expiresAt: attributes.renews_at,
    }, `Subscription activated for guild ${guildId}`);
  } catch (error) {
    logger.error({ error, payload }, 'Failed to handle subscription_created');
    throw error;
  }
}

/**
 * Handle subscription_updated webhook event
 */
export async function handleSubscriptionUpdated(payload: any): Promise<void> {
  const { data } = payload;
  const { id, attributes } = data;

  try {
    // Find subscription
    const subscription = await db.subscription.findUnique({
      where: { lemonSqueezyId: id.toString() },
      include: { guild: true },
    });

    if (!subscription) {
      logger.warn({ id }, `Subscription not found: ${id}`);
      return;
    }

    // Update subscription record
    await db.subscription.update({
      where: { lemonSqueezyId: id.toString() },
      data: {
        status: attributes.status,
        currentPeriodEnd: new Date(attributes.renews_at),
        cancelAtPeriodEnd: attributes.cancelled ?? false,
      },
    });

    // Update guild settings
    const isActive = attributes.status === 'active' || attributes.status === 'on_trial';
    await db.guildSettings.update({
      where: { guildId: subscription.guildId },
      data: {
        tier: isActive ? 'premium' : 'free',
        tierExpiresAt: isActive ? new Date(attributes.renews_at) : null,
        llmDailyQuota: isActive ? 100 : 0,
      },
    });

    logger.info({
      guildId: subscription.guildId,
      subscriptionId: id,
      status: attributes.status,
    }, `Subscription updated for guild ${subscription.guildId}`);
  } catch (error) {
    logger.error({ error, payload }, 'Failed to handle subscription_updated');
    throw error;
  }
}

/**
 * Handle subscription_cancelled webhook event
 */
export async function handleSubscriptionCancelled(payload: any): Promise<void> {
  const { data } = payload;
  const { id, attributes } = data;

  try {
    // Find subscription
    const subscription = await db.subscription.findUnique({
      where: { lemonSqueezyId: id.toString() },
      include: { guild: true },
    });

    if (!subscription) {
      logger.warn({ id }, `Subscription not found: ${id}`);
      return;
    }

    // Update subscription record
    await db.subscription.update({
      where: { lemonSqueezyId: id.toString() },
      data: {
        status: 'cancelled',
        cancelAtPeriodEnd: true,
      },
    });

    // If already expired, downgrade immediately
    const isExpired = new Date(attributes.ends_at) <= new Date();
    if (isExpired) {
      await db.guildSettings.update({
        where: { guildId: subscription.guildId },
        data: {
          tier: 'free',
          tierExpiresAt: null,
          llmDailyQuota: 0,
          llmUsedToday: 0,
        },
      });
    }

    logger.info({
      guildId: subscription.guildId,
      subscriptionId: id,
      expiresAt: attributes.ends_at,
      immediateDowngrade: isExpired,
    }, `Subscription cancelled for guild ${subscription.guildId}`);
  } catch (error) {
    logger.error({ error, payload }, 'Failed to handle subscription_cancelled');
    throw error;
  }
}

/**
 * Store billing event for audit trail
 */
export async function storeBillingEvent(
  type: string,
  lemonSqueezyId: string,
  payload: any,
  guildId?: string
): Promise<void> {
  try {
    await db.billingEvent.create({
      data: {
        type,
        lemonSqueezyId,
        payload,
        guildId,
      },
    });
  } catch (error) {
    // Ignore duplicate events
    if ((error as any).code === 'P2002') {
      logger.debug({ lemonSqueezyId }, `Duplicate billing event ignored: ${lemonSqueezyId}`);
      return;
    }
    throw error;
  }
}

/**
 * Get subscription status for a guild
 */
export async function getGuildSubscription(guildId: string) {
  return db.subscription.findUnique({
    where: { guildId },
    include: { guild: true },
  });
}

/**
 * Cancel a guild's subscription (access continues until period end)
 */
export async function cancelGuildSubscription(guildId: string): Promise<void> {
  const subscription = await db.subscription.findUnique({
    where: { guildId },
  });

  if (!subscription) {
    throw new Error('No active subscription found');
  }

  if (subscription.cancelAtPeriodEnd) {
    throw new Error('Subscription is already set to cancel');
  }

  try {
    // Cancel subscription in LemonSqueezy (at period end)
    await cancelSubscription(subscription.lemonSqueezyId);

    // Update local record
    await db.subscription.update({
      where: { guildId },
      data: {
        cancelAtPeriodEnd: true,
      },
    });

    logger.info(
      { guildId, subscriptionId: subscription.lemonSqueezyId },
      `Subscription canceled for guild ${guildId} (access continues until ${subscription.currentPeriodEnd})`
    );
  } catch (error) {
    logger.error({ error, guildId }, 'Failed to cancel subscription');
    throw error;
  }
}

/**
 * Check if LemonSqueezy is configured
 */
export function isLemonSqueezyEnabled(): boolean {
  return !!(
    process.env.LEMONSQUEEZY_API_KEY &&
    process.env.LEMONSQUEEZY_STORE_ID &&
    process.env.LEMONSQUEEZY_PREMIUM_VARIANT_ID
  );
}
