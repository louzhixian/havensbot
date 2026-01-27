import { prisma } from "../db.js";
import type { Prisma } from "@prisma/client";

/**
 * Get active (non-archived) items
 * This should be used for most business logic queries
 */
export async function getActiveItems(where: Prisma.ItemWhereInput = {}) {
  return prisma.item.findMany({
    where: {
      ...where,
      archivedAt: null,
    },
  });
}

/**
 * Get all items including archived
 * Use this for historical analysis or reporting
 */
export async function getAllItems(where: Prisma.ItemWhereInput = {}) {
  return prisma.item.findMany({ where });
}

/**
 * Count active (non-archived) items
 */
export async function countActiveItems(where: Prisma.ItemWhereInput = {}) {
  return prisma.item.count({
    where: {
      ...where,
      archivedAt: null,
    },
  });
}

/**
 * Count all items including archived
 */
export async function countAllItems(where: Prisma.ItemWhereInput = {}) {
  return prisma.item.count({ where });
}

/**
 * Find first active item
 */
export async function findFirstActiveItem(args: Prisma.ItemFindFirstArgs) {
  return prisma.item.findFirst({
    ...args,
    where: {
      ...args.where,
      archivedAt: null,
    },
  });
}

/**
 * Find many active items with pagination
 */
export async function findManyActiveItems(args: Prisma.ItemFindManyArgs) {
  return prisma.item.findMany({
    ...args,
    where: {
      ...args.where,
      archivedAt: null,
    },
  });
}
