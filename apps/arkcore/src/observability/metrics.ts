import { prisma } from "../db.js";
import { logger } from "./logger.js";
import type { MetricType, MetricStatus } from "@prisma/client";

export type RecordMetricInput = {
  type: MetricType;
  operation: string;
  status: MetricStatus;
  metadata?: {
    latency?: number;
    tokenUsage?: { prompt: number; completion: number; total: number };
    cost?: number;
    error?: string;
    attempts?: number;
    itemCount?: number;
    [key: string]: any;
  };
};

/**
 * Record a single metric to database and logs
 */
export async function recordMetric(input: RecordMetricInput): Promise<void> {
  try {
    await prisma.observabilityMetric.create({
      data: {
        type: input.type,
        operation: input.operation,
        status: input.status,
        metadata: input.metadata || {},
      },
    });

    // Also log for immediate visibility
    logger.info(
      {
        metric: input.type,
        operation: input.operation,
        status: input.status,
        ...input.metadata,
      },
      "Metric recorded"
    );
  } catch (error) {
    // Metric recording failure should not affect main flow
    logger.error({ error, input }, "Failed to record metric");
  }
}

/**
 * Record multiple metrics in a batch (reduces DB writes)
 */
export async function recordMetricsBatch(inputs: RecordMetricInput[]): Promise<void> {
  if (inputs.length === 0) return;

  try {
    await prisma.observabilityMetric.createMany({
      data: inputs.map((input) => ({
        type: input.type,
        operation: input.operation,
        status: input.status,
        metadata: input.metadata || {},
      })),
    });

    logger.info({ count: inputs.length }, "Metrics batch recorded");
  } catch (error) {
    logger.error({ error, count: inputs.length }, "Failed to record metrics batch");
  }
}
