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
import { db } from '../db.js';
import { logger } from '../utils/logger.js';

/**
 * Initialize LemonSqueezy SDK
 */
export function initializeLemonSqueezy() {
  const apiKey = process.env.LEMONSQUEEZY_API_KEY;
  
  if (!apiKey) {
    logger.warn('LEMONSQUEEZY_API_KEY not set - payment features disabled');
    return false;
  }

  lemonSqueezySetup({ apiKey });
  logger.info('LemonSqueezy SDK initialized');
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

    logger.info(`Created checkout for guild ${guildId}`, {
      checkoutId: checkout.data.data.id,
      url: checkout.data.data.attributes.url,
    });

    return checkout.data.data.attributes.url;
  } catch (error) {
    logger.error('Failed to create checkout', { error, guildId, userId });
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
    logger.error('Missing guildId in subscription custom data', { payload });
    return;
  }

  const guildId = customData.guildId;

  try {
    // Get guild settings
    const guild = await db.guildSettings.findUnique({
      where: { guildId },
    });

    if (!guild) {
      logger.error(`Guild not found: ${guildId}`);
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
        llmUsedToday: 0,
        llmQuotaResetAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    logger.info(`Subscription activated for guild ${guildId}`, {
      subscriptionId: id,
      expiresAt: attributes.renews_at,
    });
  } catch (error) {
    logger.error('Failed to handle subscription_created', { error, payload });
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
      logger.warn(`Subscription not found: ${id}`);
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

    logger.info(`Subscription updated for guild ${subscription.guildId}`, {
      subscriptionId: id,
      status: attributes.status,
    });
  } catch (error) {
    logger.error('Failed to handle subscription_updated', { error, payload });
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
      logger.warn(`Subscription not found: ${id}`);
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

    logger.info(`Subscription cancelled for guild ${subscription.guildId}`, {
      subscriptionId: id,
      expiresAt: attributes.ends_at,
      immediateDowngrade: isExpired,
    });
  } catch (error) {
    logger.error('Failed to handle subscription_cancelled', { error, payload });
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
      logger.debug(`Duplicate billing event ignored: ${lemonSqueezyId}`);
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
 * Check if LemonSqueezy is configured
 */
export function isLemonSqueezyEnabled(): boolean {
  return !!(
    process.env.LEMONSQUEEZY_API_KEY &&
    process.env.LEMONSQUEEZY_STORE_ID &&
    process.env.LEMONSQUEEZY_PREMIUM_VARIANT_ID
  );
}
