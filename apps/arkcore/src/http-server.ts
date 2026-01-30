/**
 * HTTP Server for Webhooks
 * 
 * Runs alongside the Discord bot to receive webhooks from external services.
 */

import express, { Express } from 'express';
import { handleLemonSqueezyWebhook } from './webhooks/lemonsqueezy.js';
import { logger } from './observability/logger.js';

/**
 * Create and configure Express server
 */
export function createHttpServer(): Express {
  const app = express();

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // LemonSqueezy webhook endpoint
  // Important: Use express.json() middleware to parse JSON body
  app.post('/api/webhooks/lemonsqueezy', express.json(), handleLemonSqueezyWebhook);

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
