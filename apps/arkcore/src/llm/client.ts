/**
 * @deprecated This module is no longer used. All LLM calls have been migrated
 * to `services/llm.service.ts` which provides quota-aware access via `callLlmWithQuota`.
 * This file can be safely removed once confirmed no external consumers remain.
 */
import type { AppConfig } from "../config.js";
import { logger } from "../observability/logger.js";
import { recordMetric } from "../observability/metrics.js";
import { withRetry } from "../utils/retry-utils.js";
import { estimateCost, type TokenUsage } from "./cost-estimator.js";

export type LlmMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type LlmRequest = {
  operation: string; // Operation name for metrics (e.g., "digest", "editorial_enrich", "deeper")
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
};

export type LlmResponse<T = string> = {
  success: boolean;
  data?: T;
  degraded: boolean; // Whether fallback was used
  tokenUsage?: TokenUsage;
  cost?: number;
  latency: number; // milliseconds
  error?: string;
};

type OpenAiChatResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

/**
 * LLM Client with automatic retry, metrics, and fallback support
 */
export class LlmClient {
  private config: AppConfig;
  private recentCalls: boolean[] = []; // Track recent success/failure for circuit breaker
  private readonly maxRecentCalls = 100;

  constructor(config: AppConfig) {
    this.config = config;
  }

  /**
   * Call LLM with automatic retry and metrics recording
   */
  async call(request: LlmRequest): Promise<LlmResponse<string>> {
    const startTime = Date.now();

    // Check if LLM is configured
    if (this.config.llmProvider === "none" || !this.config.llmApiKey || !this.config.llmModel) {
      return {
        success: false,
        degraded: false,
        latency: Date.now() - startTime,
        error: "LLM not configured",
      };
    }

    try {
      const result = await withRetry(
        () => this.makeRequest(request),
        {
          maxAttempts: 3,
          initialDelayMs: 1000,
          retryableErrors: (error: any) => {
            // Retry on network errors and 5xx
            if (error.code === "ECONNRESET" || error.code === "ETIMEDOUT") {
              return true;
            }
            if (error.message?.includes("429") || error.message?.includes("503")) {
              return true;
            }
            return false;
          },
          onRetry: (error, attempt) => {
            logger.warn(
              { operation: request.operation, attempt, error: error.message },
              "Retrying LLM request"
            );
          },
        }
      );

      const latency = Date.now() - startTime;

      // Track success
      this.recordCall(true);

      // Record metrics
      await recordMetric({
        type: "llm_call",
        operation: request.operation,
        status: "success",
        metadata: {
          latency,
          tokenUsage: result.tokenUsage,
          cost: result.cost,
        },
      });

      return {
        success: true,
        data: result.content,
        degraded: false,
        tokenUsage: result.tokenUsage,
        cost: result.cost,
        latency,
      };
    } catch (error) {
      const latency = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Track failure
      this.recordCall(false);

      // Record failure metric
      await recordMetric({
        type: "llm_call",
        operation: request.operation,
        status: "failure",
        metadata: {
          latency,
          error: errorMessage,
        },
      });

      logger.error(
        { operation: request.operation, error: errorMessage, latency },
        "LLM call failed"
      );

      return {
        success: false,
        degraded: false,
        latency,
        error: errorMessage,
      };
    }
  }

  /**
   * Call LLM with fallback function if LLM fails
   */
  async callWithFallback<T>(
    request: LlmRequest,
    fallback: () => T | Promise<T>
  ): Promise<LlmResponse<T>> {
    const llmResponse = await this.call(request);

    if (llmResponse.success && llmResponse.data) {
      return {
        ...llmResponse,
        data: llmResponse.data as T,
      };
    }

    // LLM failed, use fallback
    const startTime = Date.now();
    try {
      const fallbackData = await fallback();
      const latency = Date.now() - startTime;

      logger.info(
        { operation: request.operation, latency },
        "Using fallback due to LLM failure"
      );

      // Record degraded metric
      await recordMetric({
        type: "llm_call",
        operation: request.operation,
        status: "degraded",
        metadata: {
          latency: llmResponse.latency + latency,
          fallbackUsed: true,
        },
      });

      return {
        success: true,
        data: fallbackData,
        degraded: true,
        latency: llmResponse.latency + latency,
      };
    } catch (fallbackError) {
      logger.error(
        { operation: request.operation, error: fallbackError },
        "Fallback also failed"
      );

      return {
        success: false,
        degraded: false,
        latency: Date.now() - startTime,
        error: `LLM and fallback both failed: ${llmResponse.error}`,
      };
    }
  }

  /**
   * Make actual LLM API request
   */
  private async makeRequest(request: LlmRequest): Promise<{
    content: string;
    tokenUsage?: TokenUsage;
    cost?: number;
  }> {
    const endpoint = this.buildEndpoint();
    const timeoutMs = this.config.llmTimeoutMs ?? 120000; // Default 2 minutes

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.llmApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.llmModel,
          messages: request.messages,
          temperature: request.temperature ?? 0.3,
          max_tokens: request.maxTokens ?? this.config.llmMaxTokens,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`LLM request failed (${response.status}): ${errorText}`);
      }

      const data = (await response.json()) as OpenAiChatResponse;

      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error("LLM returned empty content");
      }

      // Extract token usage and calculate cost
      let tokenUsage: TokenUsage | undefined;
      let cost: number | undefined;

      if (data.usage) {
        tokenUsage = {
          prompt: data.usage.prompt_tokens,
          completion: data.usage.completion_tokens,
          total: data.usage.total_tokens,
        };

        cost = estimateCost(this.config.llmModel || "", tokenUsage);
      }

      return { content, tokenUsage, cost };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Build API endpoint URL
   */
  private buildEndpoint(): string {
    const baseUrl = this.config.llmBaseUrl.replace(/\/+$/, "");

    // Handle different API providers
    if (baseUrl.includes("generativelanguage.googleapis.com")) {
      // Google Gemini
      return `${baseUrl}/chat/completions`;
    } else if (baseUrl.includes("api.openai.com")) {
      // OpenAI
      return `${baseUrl}/v1/chat/completions`;
    } else {
      // Generic OpenAI-compatible
      return `${baseUrl}/v1/chat/completions`;
    }
  }

  /**
   * Track call result for failure rate monitoring
   */
  private recordCall(success: boolean): void {
    this.recentCalls.push(success);

    // Keep only the last N calls
    if (this.recentCalls.length > this.maxRecentCalls) {
      this.recentCalls.shift();
    }
  }

  /**
   * Get current failure rate (for monitoring)
   */
  getFailureRate(): number {
    if (this.recentCalls.length === 0) return 0;

    const failures = this.recentCalls.filter((success) => !success).length;
    return failures / this.recentCalls.length;
  }

  /**
   * Get recent call statistics
   */
  getStats(): {
    totalCalls: number;
    successRate: number;
    failureRate: number;
  } {
    const totalCalls = this.recentCalls.length;
    const failures = this.recentCalls.filter((success) => !success).length;
    const successes = totalCalls - failures;

    return {
      totalCalls,
      successRate: totalCalls > 0 ? successes / totalCalls : 0,
      failureRate: totalCalls > 0 ? failures / totalCalls : 0,
    };
  }
}

/**
 * Create a new LLM client instance
 */
export function createLlmClient(config: AppConfig): LlmClient {
  return new LlmClient(config);
}
