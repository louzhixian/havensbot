import type { AppConfig } from "../config.js";
import type { Client } from "discord.js";
import { prisma } from "../db.js";
import { logger } from "./logger.js";
import { triggerAlert } from "./alerts.js";
import { sendAlertToDiscord } from "./discord-notifier.js";

/**
 * Run all alert rule checks
 * Should be called periodically (e.g., every hour)
 */
export async function checkAlertRules(
  config: AppConfig,
  client?: Client
): Promise<void> {
  logger.debug("Running alert rules check");

  await Promise.all([
    checkLlmFailureRate(config, client),
    checkLlmCost(config, client),
    checkRssFailures(config, client),
    checkStorageUsage(config, client),
  ]);
}

// Alias for backwards compatibility
export const runAllAlertRules = checkAlertRules;

/**
 * Check LLM failure rate in the last hour
 */
async function checkLlmFailureRate(config: AppConfig, client?: Client): Promise<void> {
  const oneHourAgo = new Date(Date.now() - 3600000);

  const metrics = await prisma.observabilityMetric.findMany({
    where: {
      type: "llm_call",
      createdAt: { gte: oneHourAgo },
    },
  });

  if (metrics.length === 0) return;

  const failures = metrics.filter((m) => m.status === "failure").length;
  const failureRate = failures / metrics.length;

  if (failureRate > 0.3) {
    // 30% failure rate threshold
    const alert = await triggerAlert({
      alertType: "llm_failure_rate",
      severity: failureRate > 0.5 ? "critical" : "warning",
      message: `LLM failure rate is ${(failureRate * 100).toFixed(1)}% in the last hour (${failures}/${metrics.length} calls)`,
      metadata: { failureRate, failures, total: metrics.length },
    });

    // Send Discord notification if client is available
    if (alert && client) {
      await sendAlertToDiscord(client, config, alert);
    }
  }
}

/**
 * Check LLM daily cost
 */
async function checkLlmCost(config: AppConfig, client?: Client): Promise<void> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const metrics = await prisma.observabilityMetric.findMany({
    where: {
      type: "llm_call",
      status: "success",
      createdAt: { gte: today },
    },
  });

  const totalCost = metrics.reduce((sum, m) => {
    const metadata = m.metadata as any;
    return sum + (metadata?.cost || 0);
  }, 0);

  const dailyBudget = config.llmDailyBudget;

  if (totalCost > dailyBudget * 0.8) {
    // 80% of budget threshold
    const alert = await triggerAlert({
      alertType: "llm_cost_high",
      severity: totalCost > dailyBudget ? "error" : "warning",
      message: `LLM cost today: $${totalCost.toFixed(2)} (budget: $${dailyBudget.toFixed(2)})`,
      metadata: {
        totalCost,
        dailyBudget,
        percentage: ((totalCost / dailyBudget) * 100).toFixed(1),
      },
    });

    // Send Discord notification if client is available
    if (alert && client) {
      await sendAlertToDiscord(client, config, alert);
    }
  }
}

/**
 * Check for RSS sources with consecutive failures
 */
async function checkRssFailures(config: AppConfig, client?: Client): Promise<void> {
  const oneHourAgo = new Date(Date.now() - 3600000);

  const recentFetches = await prisma.observabilityMetric.findMany({
    where: {
      type: "rss_fetch",
      createdAt: { gte: oneHourAgo },
    },
    orderBy: { createdAt: "desc" },
  });

  // Group by source (operation field contains sourceId)
  const bySource = new Map<string, typeof recentFetches>();
  for (const metric of recentFetches) {
    const sourceId = metric.operation;
    if (!bySource.has(sourceId)) {
      bySource.set(sourceId, []);
    }
    bySource.get(sourceId)!.push(metric);
  }

  // Check for 3 consecutive failures
  for (const [sourceId, metrics] of bySource) {
    const recent3 = metrics.slice(0, 3);
    if (recent3.length === 3 && recent3.every((m) => m.status === "failure")) {
      // Get source details for a better error message
      const source = await prisma.source.findUnique({
        where: { id: sourceId },
        select: { name: true, url: true },
      });

      const sourceName = source?.name || sourceId;
      const sourceUrl = source?.url || "unknown";
      const errorMsg = (recent3[0].metadata as any)?.error || "unknown error";

      const alert = await triggerAlert({
        alertType: "rss_failure",
        severity: "warning",
        message: `RSS source "${sourceName}" failed 3 times consecutively\nURL: ${sourceUrl}\nError: ${errorMsg}`,
        metadata: { sourceId, sourceName, sourceUrl, failures: recent3.length, error: errorMsg },
      });

      // Send Discord notification if client is available
      if (alert && client) {
        await sendAlertToDiscord(client, config, alert);
      }
    }
  }
}

/**
 * Check database storage usage
 */
async function checkStorageUsage(config: AppConfig, client?: Client): Promise<void> {
  try {
    // PostgreSQL-specific query to get database size
    const result = await prisma.$queryRaw<Array<{ total_size: bigint }>>`
      SELECT pg_database_size(current_database()) as total_size
    `;

    const sizeBytes = Number(result[0].total_size);
    const sizeGB = sizeBytes / 1024 ** 3;

    const warningThresholdGB = config.storageWarningGB;

    if (sizeGB > warningThresholdGB) {
      const alert = await triggerAlert({
        alertType: "storage_warning",
        severity: "warning",
        message: `Database storage is ${sizeGB.toFixed(2)} GB (threshold: ${warningThresholdGB} GB)`,
        metadata: { sizeGB: sizeGB.toFixed(2), threshold: warningThresholdGB },
      });

      // Send Discord notification if client is available
      if (alert && client) {
        await sendAlertToDiscord(client, config, alert);
      }
    }
  } catch (error) {
    logger.error({ error }, "Failed to check storage usage");
  }
}
