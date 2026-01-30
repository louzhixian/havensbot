/**
 * HTTP Server for Webhooks
 * 
 * Runs alongside the Discord bot to receive webhooks from external services.
 */

import express, { Express } from 'express';
import { Client } from 'discord.js';
import { createLemonSqueezyWebhookHandler } from './webhooks/lemonsqueezy.js';
import { logger } from './observability/logger.js';

/**
 * Create and configure Express server
 */
export function createHttpServer(discordClient: Client): Express {
  const app = express();

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // LemonSqueezy webhook endpoint
  // Important: Use express.json() middleware to parse JSON body
  const webhookHandler = createLemonSqueezyWebhookHandler(discordClient);
  app.post('/api/webhooks/lemonsqueezy', express.json(), webhookHandler);

  return app;
}

/**
 * Start HTTP server
 */
export function startHttpServer(app: Express): void {
  const port = process.env.HTTP_PORT || 3000;

  app.listen(port, () => {
    logger.info({ port }, `HTTP server listening on port ${port}`);
  });
}
