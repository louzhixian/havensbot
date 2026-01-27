import { PrismaClient } from "@prisma/client";
export type { DiarySession } from "@prisma/client";

export const prisma = new PrismaClient();

export const disconnect = async (): Promise<void> => {
  await prisma.$disconnect();
};
