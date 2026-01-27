import type { AppConfig } from "../config.js";
import { prisma } from "../db.js";
import { logger } from "../observability/logger.js";
import { recordMetric } from "../observability/metrics.js";
import { cleanOldAlerts } from "../observability/alerts.js";

export type ArchiveResult = {
  itemsArchived: number;
  metricsDeleted: number;
  alertsDeleted: number;
  duration: number;
};

/**
 * Archive old items by setting archivedAt timestamp
 */
export async function archiveOldItems(config: AppConfig): Promise<number> {
  if (!config.archiveEnabled) {
    logger.info("Archival is disabled");
    return 0;
  }

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - config.archiveAfterDays);

  logger.info(
    { cutoffDate, archiveAfterDays: config.archiveAfterDays },
    "Starting item archival"
  );

  try {
    // Batch update: mark as archived
    const result = await prisma.item.updateMany({
      where: {
        createdAt: { lt: cutoffDate },
        archivedAt: null,
      },
      data: {
        archivedAt: new Date(),
      },
    });

    logger.info({ count: result.count }, "Items archived successfully");

    return result.count;
  } catch (error) {
    logger.error({ error }, "Failed to archive items");
    throw error;
  }
}

/**
 * Clean old observability metrics (hard delete)
 */
export async function cleanOldMetrics(config: AppConfig): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - config.metricsRetentionDays);

  logger.info(
    { cutoffDate, retentionDays: config.metricsRetentionDays },
    "Starting metrics cleanup"
  );

  try {
    const result = await prisma.observabilityMetric.deleteMany({
      where: {
        createdAt: { lt: cutoffDate },
      },
    });

    logger.info({ count: result.count }, "Old metrics deleted successfully");

    return result.count;
  } catch (error) {
    logger.error({ error }, "Failed to clean old metrics");
    throw error;
  }
}

/**
 * Run complete archival process
 */
export async function runArchivalProcess(config: AppConfig): Promise<ArchiveResult> {
  const startTime = Date.now();

  logger.info("Starting archival process");

  try {
    const [itemsArchived, metricsDeleted, alertsDeleted] = await Promise.all([
      archiveOldItems(config),
      cleanOldMetrics(config),
      cleanOldAlerts(),
    ]);

    const duration = Date.now() - startTime;

    logger.info(
      {
        itemsArchived,
        metricsDeleted,
        alertsDeleted,
        duration,
      },
      "Archival process completed"
    );

    // Record archival metrics
    await recordMetric({
      type: "system",
      operation: "archive_process",
      status: "success",
      metadata: {
        itemsArchived,
        metricsDeleted,
        alertsDeleted,
        duration,
      },
    });

    return {
      itemsArchived,
      metricsDeleted,
      alertsDeleted,
      duration,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    logger.error({ error, duration }, "Archival process failed");

    await recordMetric({
      type: "system",
      operation: "archive_process",
      status: "failure",
      metadata: {
        duration,
        error: error instanceof Error ? error.message : String(error),
      },
    });

    throw error;
  }
}
