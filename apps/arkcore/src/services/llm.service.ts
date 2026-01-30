/**
 * LLM Service with Quota Management
 * 
 * Unified LLM calling interface with tier and quota checks.
 */

import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../config.js';
import { prisma as db } from '../db.js';
import { logger } from '../observability/logger.js';

/**
 * Custom error for quota exceeded
 */
export class QuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuotaExceededError';
  }
}

/**
 * Custom error for tier restriction
 */
export class TierRestrictedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TierRestrictedError';
  }
}

/**
 * LLM call options
 */
export interface LlmCallOptions {
  guildId: string;
  messages: Anthropic.MessageCreateParams['messages'];
  system?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * LLM call response
 */
export interface LlmCallResponse {
  content: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * Check if guild has LLM access and quota
 */
async function checkLlmAccess(guildId: string): Promise<void> {
  const guild = await db.guildSettings.findUnique({
    where: { guildId },
  });

  if (!guild) {
    throw new Error(`Guild not found: ${guildId}`);
  }

  // Check tier
  if (guild.tier === 'free') {
    throw new TierRestrictedError('LLM access is not available on Free tier. Upgrade to Premium with /subscribe');
  }

  if (guild.tier === 'suspended') {
    throw new TierRestrictedError('Account suspended. Please contact support.');
  }

  // Check quota
  if (guild.llmUsedToday >= guild.llmDailyQuota) {
    const resetTime = guild.llmQuotaResetAt 
      ? new Date(guild.llmQuotaResetAt).toLocaleString()
      : 'tomorrow';
    throw new QuotaExceededError(
      `Daily LLM quota exceeded (${guild.llmUsedToday}/${guild.llmDailyQuota}). Resets at ${resetTime}.`
    );
  }
}

/**
 * Increment LLM usage counter
 */
async function incrementLlmUsage(guildId: string): Promise<void> {
  await db.guildSettings.update({
    where: { guildId },
    data: {
      llmUsedToday: { increment: 1 },
    },
  });
}

/**
 * Call LLM with quota management
 */
export async function callLlmWithQuota(options: LlmCallOptions): Promise<LlmCallResponse> {
  const { guildId, messages, system, model, maxTokens, temperature } = options;

  // Check access and quota
  await checkLlmAccess(guildId);

  // Load config
  const config = loadConfig();

  if (config.llmProvider === 'none' || !config.llmApiKey) {
    throw new Error('LLM provider not configured');
  }

  // Initialize Anthropic client (support for other providers can be added)
  const anthropic = new Anthropic({
    apiKey: config.llmApiKey,
    baseURL: config.llmBaseUrl !== 'https://api.openai.com' ? config.llmBaseUrl : undefined,
  });

  try {
    // Call LLM
    const response = await anthropic.messages.create({
      model: model || config.llmModel || 'claude-3-5-sonnet-20241022',
      max_tokens: maxTokens || config.llmMaxTokens || 4000,
      temperature: temperature ?? 0.7,
      system,
      messages,
    });

    // Increment usage
    await incrementLlmUsage(guildId);

    // Extract text content
    const content = response.content
      .filter((block: Anthropic.ContentBlock): block is Anthropic.TextBlock => block.type === 'text')
      .map((block: Anthropic.TextBlock) => block.text)
      .join('\n');

    logger.info({
      guildId,
      model: response.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    }, 'LLM call completed');

    return {
      content,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  } catch (error) {
    logger.error({ error, guildId }, 'LLM call failed');
    throw error;
  }
}

/**
 * Check if LLM is available for a guild (without throwing)
 */
export async function isLlmAvailable(guildId: string): Promise<boolean> {
  try {
    await checkLlmAccess(guildId);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Get LLM usage stats for a guild
 */
export async function getLlmUsageStats(guildId: string): Promise<{
  used: number;
  quota: number;
  remaining: number;
  resetAt: Date | null;
}> {
  const guild = await db.guildSettings.findUnique({
    where: { guildId },
  });

  if (!guild) {
    throw new Error(`Guild not found: ${guildId}`);
  }

  return {
    used: guild.llmUsedToday,
    quota: guild.llmDailyQuota,
    remaining: Math.max(0, guild.llmDailyQuota - guild.llmUsedToday),
    resetAt: guild.llmQuotaResetAt,
  };
}
