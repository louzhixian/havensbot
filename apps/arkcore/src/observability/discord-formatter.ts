import type { SystemAlert } from "@prisma/client";
import type { StatsOverview, LlmDetailedStats, ErrorStats } from "./stats.js";

/**
 * Format number with thousand separators
 */
function formatNumber(num: number): string {
  return num.toLocaleString("en-US");
}

/**
 * Format percentage
 */
function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/**
 * Format date/time
 */
function formatDate(date: Date): string {
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Format stats overview for Discord
 */
export function formatStatsOverview(stats: StatsOverview): string {
  const lines = [
    `📊 **System Overview** (${stats.period})`,
    "",
    "**RSS Feeds**",
    `• Fetches: ${stats.rss.totalFetches} (${formatPercent(stats.rss.successRate)} success)`,
    `• Active sources: ${stats.rss.activeSources}`,
    `• Avg items/fetch: ${stats.rss.avgItemsPerFetch.toFixed(1)}`,
    "",
    "**LLM Usage**",
    `• Calls: ${stats.llm.totalCalls} (${formatPercent(stats.llm.successRate)} success)`,
    `• Tokens: ${formatNumber(stats.llm.totalTokens)}`,
    `• Cost: $${stats.llm.totalCost.toFixed(2)}`,
    `• Avg latency: ${stats.llm.avgLatency}ms`,
  ];

  if (stats.llm.degradedCount > 0) {
    lines.push(`⚠️ Degraded: ${stats.llm.degradedCount}`);
  }

  lines.push(
    "",
    "**Digests**",
    `• Runs: ${stats.digest.totalRuns} (${formatPercent(stats.digest.successRate)} success)`,
    `• Avg items: ${stats.digest.avgItemsPerDigest.toFixed(1)}`,
    "",
    "**Storage**",
    `• Total items: ${formatNumber(stats.storage.totalItems)}`,
    `• Active sources: ${stats.storage.totalSources}`
  );

  if (stats.storage.dbSizeGB) {
    lines.push(`• DB size: ${stats.storage.dbSizeGB.toFixed(2)} GB`);
  }

  return lines.join("\n");
}

/**
 * Format detailed LLM stats for Discord
 */
export function formatLlmStats(stats: LlmDetailedStats): string {
  const lines = [
    `🤖 **LLM Usage Details** (${stats.period})`,
    "",
    "**Overall**",
    `• Total calls: ${stats.totalCalls}`,
    `• Success rate: ${formatPercent(stats.successRate)}`,
    `• Total tokens: ${formatNumber(stats.totalTokens)}`,
    `• Total cost: $${stats.totalCost.toFixed(2)}`,
    `• Avg latency: ${stats.avgLatency}ms`,
  ];

  if (stats.byOperation.length > 0) {
    lines.push("", "**By Operation** (top 5 by cost)");
    for (const op of stats.byOperation.slice(0, 5)) {
      lines.push(
        `• ${op.operation}: ${op.calls} calls, ${formatNumber(op.tokens)} tokens, $${op.cost.toFixed(2)}`
      );
    }
  }

  if (stats.degradedCount > 0) {
    lines.push("", `⚠️ **Degraded responses**: ${stats.degradedCount}`);
  }

  return lines.join("\n");
}

/**
 * Format recent errors for Discord
 */
export function formatRecentErrors(errorStats: ErrorStats, limit: number = 10): string {
  const lines = [
    `🔴 **Recent Errors** (showing ${Math.min(limit, errorStats.recentErrors.length)} of ${errorStats.totalErrors})`,
    "",
  ];

  for (const error of errorStats.recentErrors.slice(0, limit)) {
    const timestamp = formatDate(error.timestamp);
    lines.push(`**${error.type}** (${error.operation})`);
    lines.push(`${timestamp}`);
    lines.push(`\`\`\`${error.error.substring(0, 100)}\`\`\``);
    lines.push("");
  }

  if (errorStats.recentErrors.length === 0) {
    lines.push("_No recent errors_ ✅");
  }

  return lines.join("\n");
}

/**
 * Format storage stats for Discord
 */
export function formatStorageStats(stats: {
  totalItems: number;
  archivedItems: number;
  activeItems: number;
  totalSources: number;
  dbSizeGB?: number;
}): string {
  const lines = [
    "💾 **Storage Statistics**",
    "",
    "**Items**",
    `• Total: ${formatNumber(stats.totalItems)}`,
    `• Active: ${formatNumber(stats.activeItems)}`,
    `• Archived: ${formatNumber(stats.archivedItems)}`,
    "",
    "**Sources**",
    `• Total: ${stats.totalSources}`,
  ];

  if (stats.dbSizeGB !== undefined) {
    lines.push("", "**Database**", `• Size: ${stats.dbSizeGB.toFixed(2)} GB`);
  }

  return lines.join("\n");
}

/**
 * Format health check status for Discord
 */
export function formatHealthStatus(health: {
  database: boolean;
  llm: boolean;
  activeAlerts: number;
}): string {
  const dbStatus = health.database ? "✅ Connected" : "❌ Down";
  const llmStatus = health.llm ? "✅ Operational" : "⚠️ Degraded";

  const lines = [
    "🏥 **System Health**",
    "",
    `**Database**: ${dbStatus}`,
    `**LLM**: ${llmStatus}`,
    `**Active Alerts**: ${health.activeAlerts}`,
  ];

  if (health.activeAlerts > 0) {
    lines.push("", "_Use `/alerts list` to view active alerts_");
  }

  return lines.join("\n");
}

/**
 * Format alert message for Discord
 */
export function formatAlertMessage(alert: SystemAlert): string {
  const emojiMap = {
    info: "ℹ️",
    warning: "⚠️",
    error: "🔴",
    critical: "🚨",
  };

  const emoji = emojiMap[alert.severity];

  const lines = [
    `${emoji} **Alert: ${alert.alertType}**`,
    "",
    alert.message,
    "",
    `_Alert ID: ${alert.id}_`,
    `_Created: ${formatDate(alert.createdAt)}_`,
  ];

  return lines.join("\n");
}

/**
 * Format list of active alerts for Discord
 */
export function formatActiveAlerts(alerts: SystemAlert[]): string {
  if (alerts.length === 0) {
    return "✅ **No active alerts**\n\nAll systems operating normally.";
  }

  const MAX_ALERTS = 10;
  const totalAlerts = alerts.length;
  const displayAlerts = alerts.slice(0, MAX_ALERTS);

  const lines = [`🚨 **Active Alerts** (${totalAlerts})`, ""];

  for (const alert of displayAlerts) {
    const emojiMap = {
      info: "ℹ️",
      warning: "⚠️",
      error: "🔴",
      critical: "🚨",
    };
    const emoji = emojiMap[alert.severity];

    lines.push(`${emoji} **${alert.alertType}** (ID: \`${alert.id}\`)`);
    lines.push(`${alert.message}`);
    lines.push(`_Created: ${formatDate(alert.createdAt)}_`);
    lines.push("");
  }

  if (totalAlerts > MAX_ALERTS) {
    lines.push(`_... and ${totalAlerts - MAX_ALERTS} more alerts_`);
    lines.push("");
  }

  lines.push("_Use `/alerts resolve <alert_id>` to resolve an alert_");

  return lines.join("\n");
}

/**
 * Format archival notification
 */
export function formatArchivalNotification(result: {
  itemsArchived: number;
  metricsDeleted: number;
  alertsDeleted?: number;
  duration: number;
}): string {
  const lines = [
    "📦 **Archival Process Completed**",
    "",
    `• Items archived: ${formatNumber(result.itemsArchived)}`,
    `• Metrics cleaned: ${formatNumber(result.metricsDeleted)}`,
  ];

  if (result.alertsDeleted !== undefined && result.alertsDeleted > 0) {
    lines.push(`• Alerts cleaned: ${formatNumber(result.alertsDeleted)}`);
  }

  lines.push(`• Duration: ${(result.duration / 1000).toFixed(1)}s`);

  return lines.join("\n");
}

/**
 * Format archival statistics
 */
export function formatArchivalStats(stats: {
  totalItems: number;
  activeItems: number;
  archivedItems: number;
  archivalRate: number;
  oldestActive: Date | null;
  newestArchived: Date | null;
  estimatedNextArchival: {
    date: Date;
    itemCount: number;
  };
}): string {
  const lines = [
    "📦 **Archival Statistics**",
    "",
    "**Items**",
    `• Total: ${formatNumber(stats.totalItems)}`,
    `• Active: ${formatNumber(stats.activeItems)}`,
    `• Archived: ${formatNumber(stats.archivedItems)} (${formatPercent(stats.archivalRate)})`,
    "",
    "**Timeline**",
    `• Oldest active: ${stats.oldestActive ? formatDate(stats.oldestActive) : "N/A"}`,
    `• Newest archived: ${stats.newestArchived ? formatDate(stats.newestArchived) : "N/A"}`,
    "",
    "**Next Archival Estimate**",
    `• Date: ${formatDate(stats.estimatedNextArchival.date)}`,
    `• Items to archive: ~${formatNumber(stats.estimatedNextArchival.itemCount)}`,
  ];

  return lines.join("\n");
}
