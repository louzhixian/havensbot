/**
 * LLM cost estimation based on token usage
 */

export type TokenUsage = {
  prompt: number;
  completion: number;
  total: number;
};

export type ModelPricing = {
  prompt: number; // cost per 1K tokens
  completion: number; // cost per 1K tokens
};

/**
 * Pricing table for common models (USD per 1K tokens)
 * Update this as needed for new models or pricing changes
 */
const MODEL_PRICING: Record<string, ModelPricing> = {
  // OpenAI models
  "gpt-4": { prompt: 0.03, completion: 0.06 },
  "gpt-4-turbo": { prompt: 0.01, completion: 0.03 },
  "gpt-4o": { prompt: 0.005, completion: 0.015 },
  "gpt-3.5-turbo": { prompt: 0.001, completion: 0.002 },

  // Google Gemini models (via OpenAI-compatible API)
  "gemini-pro": { prompt: 0.00025, completion: 0.0005 },
  "gemini-1.5-pro": { prompt: 0.00125, completion: 0.005 },
  "gemini-1.5-flash": { prompt: 0.000075, completion: 0.0003 },
  "gemini-2-flash": { prompt: 0.000075, completion: 0.0003 },
  "gemini-3-flash": { prompt: 0.000075, completion: 0.0003 },
  "gemini-3-flash-preview": { prompt: 0.000075, completion: 0.0003 },

  // Anthropic Claude models
  "claude-3-opus": { prompt: 0.015, completion: 0.075 },
  "claude-3-sonnet": { prompt: 0.003, completion: 0.015 },
  "claude-3-haiku": { prompt: 0.00025, completion: 0.00125 },
  "claude-3-5-sonnet": { prompt: 0.003, completion: 0.015 },
};

/**
 * Default pricing for unknown models (use GPT-3.5-turbo as baseline)
 */
const DEFAULT_PRICING: ModelPricing = {
  prompt: 0.001,
  completion: 0.002,
};

/**
 * Get pricing for a specific model
 */
export function getModelPricing(model: string): ModelPricing {
  // Normalize model name (remove version suffixes, handle variations)
  const normalizedModel = model.toLowerCase().trim();

  // Try exact match first
  if (MODEL_PRICING[normalizedModel]) {
    return MODEL_PRICING[normalizedModel];
  }

  // Try partial match (e.g., "gpt-4-1106-preview" -> "gpt-4")
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (normalizedModel.startsWith(key)) {
      return pricing;
    }
  }

  // Fall back to default
  return DEFAULT_PRICING;
}

/**
 * Estimate cost for a given token usage and model
 */
export function estimateCost(model: string, tokens: TokenUsage): number {
  const pricing = getModelPricing(model);

  const promptCost = (tokens.prompt / 1000) * pricing.prompt;
  const completionCost = (tokens.completion / 1000) * pricing.completion;

  return promptCost + completionCost;
}

/**
 * Format cost for display (USD)
 */
export function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}
