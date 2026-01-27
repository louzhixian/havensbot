import { logger } from "../observability/logger.js";
import { recordMetric, type RecordMetricInput } from "../observability/metrics.js";
import type { MetricType } from "@prisma/client";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type RetryOptions = {
  maxAttempts?: number; // Default 3
  initialDelayMs?: number; // Default 1000
  maxDelayMs?: number; // Default 10000
  backoffMultiplier?: number; // Default 2 (exponential backoff)
  retryableErrors?: (error: any) => boolean; // Predicate to determine if error is retryable
  onRetry?: (error: any, attempt: number) => void; // Callback on retry
};

/**
 * Default retryable error predicate
 */
const defaultRetryableErrors = (error: any): boolean => {
  // Network errors
  if (error.code === "ECONNRESET" || error.code === "ETIMEDOUT" || error.code === "ENOTFOUND") {
    return true;
  }

  // HTTP 5xx errors
  if (error.response?.status >= 500) {
    return true;
  }

  // Discord rate limit (429)
  if (error.response?.status === 429 || error.httpStatus === 429) {
    return true;
  }

  // Fetch errors
  if (error.name === "FetchError") {
    return true;
  }

  return false;
};

/**
 * Execute an operation with automatic retry logic
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelayMs = 1000,
    maxDelayMs = 10000,
    backoffMultiplier = 2,
    retryableErrors = defaultRetryableErrors,
    onRetry,
  } = options;

  let lastError: any;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (attempt === maxAttempts || !retryableErrors(error)) {
        throw error;
      }

      const delay = Math.min(
        initialDelayMs * Math.pow(backoffMultiplier, attempt - 1),
        maxDelayMs
      );

      onRetry?.(error, attempt);
      logger.warn(
        {
          error: error instanceof Error ? error.message : String(error),
          attempt,
          delayMs: delay,
          maxAttempts,
        },
        "Retrying operation"
      );

      await sleep(delay);
    }
  }

  throw lastError;
}

export type WithRetryAndMetricsOptions = RetryOptions & {
  metricType: MetricType;
  metricOperation: string;
};

/**
 * Execute an operation with retry and automatic metrics recording
 */
export async function withRetryAndMetrics<T>(
  operation: () => Promise<T>,
  options: WithRetryAndMetricsOptions
): Promise<T> {
  const { metricType, metricOperation, ...retryOptions } = options;
  const startTime = Date.now();
  let attempts = 0;

  try {
    const result = await withRetry(operation, {
      ...retryOptions,
      onRetry: (error, attempt) => {
        attempts = attempt;
        retryOptions.onRetry?.(error, attempt);
      },
    });

    // Record success metric
    await recordMetric({
      type: metricType,
      operation: metricOperation,
      status: "success",
      metadata: {
        latency: Date.now() - startTime,
        attempts: attempts + 1,
      },
    });

    return result;
  } catch (error) {
    // Record failure metric
    await recordMetric({
      type: metricType,
      operation: metricOperation,
      status: "failure",
      metadata: {
        latency: Date.now() - startTime,
        attempts: attempts + 1,
        error: error instanceof Error ? error.message : String(error),
      },
    });

    throw error;
  }
}
