import { prisma } from "../db.js";
import { logger } from "./logger.js";
import type { AlertType, AlertSeverity, SystemAlert } from "@prisma/client";

export type AlertTriggerInput = {
  alertType: AlertType;
  severity: AlertSeverity;
  message: string;
  metadata?: Record<string, any>;
};

/**
 * Trigger a new system alert
 * Checks for existing unresolved alerts to avoid duplicates
 */
export async function triggerAlert(input: AlertTriggerInput): Promise<SystemAlert | null> {
  // Check if there's already an unresolved alert of the same type within the last hour
  const oneHourAgo = new Date(Date.now() - 3600000);

  const existingAlert = await prisma.systemAlert.findFirst({
    where: {
      alertType: input.alertType,
      resolved: false,
      createdAt: { gte: oneHourAgo },
    },
  });

  if (existingAlert) {
    logger.debug({ alertType: input.alertType }, "Alert already exists, skipping");
    return null;
  }

  // Create new alert
  const alert = await prisma.systemAlert.create({
    data: {
      alertType: input.alertType,
      severity: input.severity,
      message: input.message,
      metadata: input.metadata || {},
    },
  });

  logger.warn(
    {
      alertId: alert.id,
      alertType: input.alertType,
      severity: input.severity,
    },
    "Alert triggered"
  );

  return alert;
}

/**
 * Resolve an alert by ID
 */
export async function resolveAlert(alertId: string): Promise<void> {
  await prisma.systemAlert.update({
    where: { id: alertId },
    data: {
      resolved: true,
      resolvedAt: new Date(),
    },
  });

  logger.info({ alertId }, "Alert resolved");
}

/**
 * Get all active (unresolved) alerts
 */
export async function getActiveAlerts(): Promise<SystemAlert[]> {
  return prisma.systemAlert.findMany({
    where: { resolved: false },
    orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
  });
}

/**
 * Auto-resolve stale alerts (older than 24 hours)
 */
export async function autoResolveStaleAlerts(): Promise<number> {
  const staleDuration = 24 * 3600000; // 24 hours
  const staleDate = new Date(Date.now() - staleDuration);

  const result = await prisma.systemAlert.updateMany({
    where: {
      resolved: false,
      createdAt: { lt: staleDate },
    },
    data: {
      resolved: true,
      resolvedAt: new Date(),
    },
  });

  if (result.count > 0) {
    logger.info({ count: result.count }, "Auto-resolved stale alerts");
  }

  return result.count;
}

/**
 * Clean up old resolved alerts (older than 30 days)
 */
export async function cleanOldAlerts(): Promise<number> {
  const cleanupDate = new Date(Date.now() - 30 * 24 * 3600000); // 30 days

  const result = await prisma.systemAlert.deleteMany({
    where: {
      resolved: true,
      resolvedAt: { lt: cleanupDate },
    },
  });

  if (result.count > 0) {
    logger.info({ count: result.count }, "Cleaned old resolved alerts");
  }

  return result.count;
}
