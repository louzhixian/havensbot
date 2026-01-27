import type { Client, TextChannel } from "discord.js";
import type { AppConfig } from "../config.js";
import type { SystemAlert } from "@prisma/client";
import { prisma } from "../db.js";
import { logger } from "./logger.js";
import { formatAlertMessage, formatStatsOverview } from "./discord-formatter.js";
import { getStatsOverview } from "./stats.js";
import { ALERTS_CHANNEL_NAME, findFixedChannel } from "../channel-config.js";

/**
 * Get the alerts channel ID by fixed channel name
 */
async function getAlertsChannelId(client: Client, config: AppConfig): Promise<string | null> {
  const guild = client.guilds.cache.get(config.discordGuildId);
  if (!guild) {
    logger.debug("Guild not found, cannot get alerts channel");
    return null;
  }
  return findFixedChannel(guild, ALERTS_CHANNEL_NAME);
}

/**
 * Send alert notification to Discord observability channel
 */
export async function sendAlertToDiscord(
  client: Client,
  config: AppConfig,
  alert: SystemAlert
): Promise<void> {
  const alertsChannelId = await getAlertsChannelId(client, config);
  if (!alertsChannelId) {
    logger.debug(`Alerts channel #${ALERTS_CHANNEL_NAME} not found, skipping alert notification`);
    return;
  }

  try {
    const channel = await client.channels.fetch(alertsChannelId);

    if (!channel || !channel.isTextBased()) {
      throw new Error("Invalid observability channel");
    }

    let content = formatAlertMessage(alert);

    // Add @mention for critical alerts
    if (alert.severity === "critical" && config.alertMentionUserId) {
      content = `<@${config.alertMentionUserId}>\n\n${content}`;
    }

    await (channel as TextChannel).send({ content });

    // Mark as notified
    await prisma.systemAlert.update({
      where: { id: alert.id },
      data: { notifiedAt: new Date() },
    });

    logger.info({ alertId: alert.id }, "Alert sent to Discord");
  } catch (error) {
    logger.error({ error, alertId: alert.id }, "Failed to send alert to Discord");
    throw error;
  }
}

/**
 * Send daily observability report to Discord
 */
export async function sendDailyReport(
  client: Client,
  config: AppConfig
): Promise<void> {
  const alertsChannelId = await getAlertsChannelId(client, config);
  if (!alertsChannelId) {
    logger.debug(`Alerts channel #${ALERTS_CHANNEL_NAME} not found, skipping daily report`);
    return;
  }

  try {
    const stats = await getStatsOverview("1d");
    const activeAlerts = await prisma.systemAlert.count({
      where: { resolved: false },
    });

    let content = formatStatsOverview(stats);

    if (activeAlerts > 0) {
      content += `\n\n⚠️ **Active alerts**: ${activeAlerts} (use \`/alerts list\` to view)`;
    }

    const channel = await client.channels.fetch(alertsChannelId);

    if (channel?.isTextBased()) {
      await (channel as TextChannel).send({ content });
      logger.info("Daily observability report sent to Discord");
    }
  } catch (error) {
    logger.error({ error }, "Failed to send daily report to Discord");
  }
}

/**
 * Send archival notification to Discord
 */
export async function sendArchivalNotification(
  client: Client,
  config: AppConfig,
  result: {
    itemsArchived: number;
    metricsDeleted: number;
    alertsDeleted?: number;
    duration: number;
  }
): Promise<void> {
  if (result.itemsArchived === 0) {
    return;
  }

  const alertsChannelId = await getAlertsChannelId(client, config);
  if (!alertsChannelId) {
    return;
  }

  try {
    const { formatArchivalNotification } = await import("./discord-formatter.js");
    const content = formatArchivalNotification(result);

    const channel = await client.channels.fetch(alertsChannelId);

    if (channel?.isTextBased()) {
      await (channel as TextChannel).send({ content });
      logger.info("Archival notification sent to Discord");
    }
  } catch (error) {
    logger.error({ error }, "Failed to send archival notification to Discord");
  }
}
