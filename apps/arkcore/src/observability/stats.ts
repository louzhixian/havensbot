import { prisma } from "../db.js";
import type { ObservabilityMetric } from "@prisma/client";

export type Period = "1d" | "7d" | "30d";

export type StatsOverview = {
  period: string;
  rss: {
    totalFetches: number;
    successRate: number;
    avgItemsPerFetch: number;
    activeSources: number;
  };
  llm: {
    totalCalls: number;
    successRate: number;
    totalTokens: number;
    totalCost: number;
    avgLatency: number;
    degradedCount: number;
  };
  digest: {
    totalRuns: number;
    successRate: number;
    avgItemsPerDigest: number;
  };
  storage: {
    totalItems: number;
    totalSources: number;
    dbSizeGB?: number;
  };
};

export type LlmDetailedStats = {
  period: string;
  totalCalls: number;
  successRate: number;
  totalTokens: number;
  totalCost: number;
  avgLatency: number;
  degradedCount: number;
  byOperation: Array<{
    operation: string;
    calls: number;
    tokens: number;
    cost: number;
  }>;
};

export type ErrorStats = {
  recentErrors: Array<{
    timestamp: Date;
    type: string;
    operation: string;
    error: string;
  }>;
  totalErrors: number;
};

/**
 * Get date from period string
 */
function getDateFromPeriod(period: Period): Date {
  const now = Date.now();
  const durations: Record<Period, number> = {
    "1d": 24 * 3600000,
    "7d": 7 * 24 * 3600000,
    "30d": 30 * 24 * 3600000,
  };

  return new Date(now - durations[period]);
}

/**
 * Format period for display
 */
function formatPeriod(period: Period): string {
  const labels: Record<Period, string> = {
    "1d": "Last 24 hours",
    "7d": "Last 7 days",
    "30d": "Last 30 days",
  };
  return labels[period];
}

/**
 * Get comprehensive stats overview
 */
export async function getStatsOverview(period: Period = "1d"): Promise<StatsOverview> {
  const since = getDateFromPeriod(period);

  const [rssMetrics, llmMetrics, digestMetrics, itemCount, sourceCount] =
    await Promise.all([
      prisma.observabilityMetric.findMany({
        where: { type: "rss_fetch", createdAt: { gte: since } },
      }),
      prisma.observabilityMetric.findMany({
        where: { type: "llm_call", createdAt: { gte: since } },
      }),
      prisma.observabilityMetric.findMany({
        where: { type: "digest_run", createdAt: { gte: since } },
      }),
      prisma.item.count(),
      prisma.source.count({ where: { enabled: true } }),
    ]);

  return {
    period: formatPeriod(period),
    rss: calculateRssStats(rssMetrics),
    llm: calculateLlmStats(llmMetrics),
    digest: calculateDigestStats(digestMetrics),
    storage: {
      totalItems: itemCount,
      totalSources: sourceCount,
    },
  };
}

/**
 * Calculate RSS statistics
 */
function calculateRssStats(
  metrics: ObservabilityMetric[]
): StatsOverview["rss"] {
  if (metrics.length === 0) {
    return {
      totalFetches: 0,
      successRate: 0,
      avgItemsPerFetch: 0,
      activeSources: 0,
    };
  }

  const successful = metrics.filter((m) => m.status === "success");
  const uniqueSources = new Set(metrics.map((m) => m.operation)).size;

  const totalItems = successful.reduce((sum, m) => {
    const metadata = m.metadata as any;
    return sum + (metadata?.itemCount || 0);
  }, 0);

  return {
    totalFetches: metrics.length,
    successRate: successful.length / metrics.length,
    avgItemsPerFetch: successful.length > 0 ? totalItems / successful.length : 0,
    activeSources: uniqueSources,
  };
}

/**
 * Calculate LLM statistics
 */
function calculateLlmStats(
  metrics: ObservabilityMetric[]
): StatsOverview["llm"] {
  if (metrics.length === 0) {
    return {
      totalCalls: 0,
      successRate: 0,
      totalTokens: 0,
      totalCost: 0,
      avgLatency: 0,
      degradedCount: 0,
    };
  }

  const successful = metrics.filter((m) => m.status === "success");
  const degraded = metrics.filter((m) => m.status === "degraded");

  const totalTokens = successful.reduce((sum, m) => {
    const metadata = m.metadata as any;
    return sum + (metadata?.tokenUsage?.total || 0);
  }, 0);

  const totalCost = successful.reduce((sum, m) => {
    const metadata = m.metadata as any;
    return sum + (metadata?.cost || 0);
  }, 0);

  const totalLatency = successful.reduce((sum, m) => {
    const metadata = m.metadata as any;
    return sum + (metadata?.latency || 0);
  }, 0);

  return {
    totalCalls: metrics.length,
    successRate: successful.length / metrics.length,
    totalTokens,
    totalCost,
    avgLatency: successful.length > 0 ? Math.round(totalLatency / successful.length) : 0,
    degradedCount: degraded.length,
  };
}

/**
 * Calculate Digest statistics
 */
function calculateDigestStats(
  metrics: ObservabilityMetric[]
): StatsOverview["digest"] {
  if (metrics.length === 0) {
    return {
      totalRuns: 0,
      successRate: 0,
      avgItemsPerDigest: 0,
    };
  }

  const successful = metrics.filter((m) => m.status === "success");

  const totalItems = successful.reduce((sum, m) => {
    const metadata = m.metadata as any;
    return sum + (metadata?.itemCount || 0);
  }, 0);

  return {
    totalRuns: metrics.length,
    successRate: successful.length / metrics.length,
    avgItemsPerDigest: successful.length > 0 ? totalItems / successful.length : 0,
  };
}

/**
 * Get detailed LLM statistics
 */
export async function getLlmDetailedStats(period: Period = "1d"): Promise<LlmDetailedStats> {
  const since = getDateFromPeriod(period);

  const metrics = await prisma.observabilityMetric.findMany({
    where: {
      type: "llm_call",
      createdAt: { gte: since },
    },
  });

  const baseStats = calculateLlmStats(metrics);

  // Group by operation
  const byOperation = new Map<
    string,
    { calls: number; tokens: number; cost: number }
  >();

  for (const metric of metrics) {
    if (metric.status !== "success") continue;

    const operation = metric.operation;
    const metadata = metric.metadata as any;
    const tokens = metadata?.tokenUsage?.total || 0;
    const cost = metadata?.cost || 0;

    if (!byOperation.has(operation)) {
      byOperation.set(operation, { calls: 0, tokens: 0, cost: 0 });
    }

    const stats = byOperation.get(operation)!;
    stats.calls += 1;
    stats.tokens += tokens;
    stats.cost += cost;
  }

  return {
    period: formatPeriod(period),
    ...baseStats,
    byOperation: Array.from(byOperation.entries())
      .map(([operation, stats]) => ({ operation, ...stats }))
      .sort((a, b) => b.cost - a.cost),
  };
}

/**
 * Get recent errors
 */
export async function getRecentErrors(limit: number = 20): Promise<ErrorStats> {
  const errorMetrics = await prisma.observabilityMetric.findMany({
    where: { status: "failure" },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  const recentErrors = errorMetrics.map((m) => {
    const metadata = m.metadata as any;
    return {
      timestamp: m.createdAt,
      type: m.type,
      operation: m.operation,
      error: metadata?.error || "Unknown error",
    };
  });

  const totalErrors = await prisma.observabilityMetric.count({
    where: { status: "failure" },
  });

  return {
    recentErrors,
    totalErrors,
  };
}

/**
 * Get storage statistics (database size, item counts, etc.)
 */
export async function getStorageStats(): Promise<{
  totalItems: number;
  archivedItems: number;
  activeItems: number;
  totalSources: number;
  dbSizeGB?: number;
}> {
  const [totalItems, archivedItems, totalSources] = await Promise.all([
    prisma.item.count(),
    prisma.item.count({ where: { archivedAt: { not: null } } }),
    prisma.source.count(),
  ]);

  let dbSizeGB: number | undefined;

  try {
    const result = await prisma.$queryRaw<Array<{ total_size: bigint }>>`
      SELECT pg_database_size(current_database()) as total_size
    `;
    const sizeBytes = Number(result[0].total_size);
    dbSizeGB = sizeBytes / 1024 ** 3;
  } catch (error) {
    // Database size query failed, skip
  }

  return {
    totalItems,
    archivedItems,
    activeItems: totalItems - archivedItems,
    totalSources,
    dbSizeGB,
  };
}

/**
 * Get health check status
 */
export async function getHealthStatus(): Promise<{
  database: boolean;
  llm: boolean;
  activeAlerts: number;
}> {
  let database = false;
  let llm = false;
  let activeAlerts = 0;

  // Check database connectivity
  try {
    await prisma.$queryRaw`SELECT 1`;
    database = true;
  } catch {
    database = false;
  }

  // Check recent LLM success
  try {
    const recentLlm = await prisma.observabilityMetric.findMany({
      where: {
        type: "llm_call",
        createdAt: { gte: new Date(Date.now() - 3600000) }, // Last hour
      },
      take: 10,
    });

    if (recentLlm.length > 0) {
      const successCount = recentLlm.filter((m) => m.status === "success").length;
      llm = successCount / recentLlm.length > 0.5; // At least 50% success rate
    } else {
      llm = true; // No recent calls, assume OK
    }
  } catch {
    llm = false;
  }

  // Count active alerts
  try {
    activeAlerts = await prisma.systemAlert.count({
      where: { resolved: false },
    });
  } catch {
    activeAlerts = 0;
  }

  return { database, llm, activeAlerts };
}
