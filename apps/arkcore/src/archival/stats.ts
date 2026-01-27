import type { AppConfig } from "../config.js";
import { prisma } from "../db.js";

export type ArchivalStats = {
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
};

/**
 * Get comprehensive archival statistics
 */
export async function getArchivalStats(config: AppConfig): Promise<ArchivalStats> {
  const [totalItems, activeItems, archivedItems, oldestActive, newestArchived] =
    await Promise.all([
      prisma.item.count(),
      prisma.item.count({ where: { archivedAt: null } }),
      prisma.item.count({ where: { archivedAt: { not: null } } }),
      prisma.item.findFirst({
        where: { archivedAt: null },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      }),
      prisma.item.findFirst({
        where: { archivedAt: { not: null } },
        orderBy: { archivedAt: "desc" },
        select: { createdAt: true },
      }),
    ]);

  // Estimate next archival
  const nextArchiveDate = new Date();
  nextArchiveDate.setDate(nextArchiveDate.getDate() - config.archiveAfterDays);

  const estimatedCount = await prisma.item.count({
    where: {
      createdAt: { lt: nextArchiveDate },
      archivedAt: null,
    },
  });

  return {
    totalItems,
    activeItems,
    archivedItems,
    archivalRate: totalItems > 0 ? archivedItems / totalItems : 0,
    oldestActive: oldestActive?.createdAt || null,
    newestArchived: newestArchived?.createdAt || null,
    estimatedNextArchival: {
      date: nextArchiveDate,
      itemCount: estimatedCount,
    },
  };
}
