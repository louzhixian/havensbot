/**
 * LemonSqueezy Webhook Handler
 * 
 * Handles incoming webhooks from LemonSqueezy for subscription events.
 * Docs: https://docs.lemonsqueezy.com/help/webhooks
 */

import { Request, Response } from 'express';
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
 * Handle LemonSqueezy webhook
 */
export async function handleLemonSqueezyWebhook(req: Request, res: Response): Promise<void> {
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
        // TODO: Send alert to guild owner
        logger.warn({ eventId, guildId }, 'Subscription payment failed');
        break;

      default:
        logger.info({ eventName }, `Unhandled webhook event: ${eventName}`);
    }

    res.status(200).json({ received: true });
  } catch (error) {
    logger.error({ error, eventName, eventId }, 'Failed to process webhook');
    res.status(500).json({ error: 'Failed to process webhook' });
  }
}
