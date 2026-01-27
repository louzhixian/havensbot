import { mkdir, writeFile } from "fs/promises";
import path from "path";
import type { AppConfig } from "../config.js";
import type { DiaryMessage, DiaryExportResult } from "./types.js";
import { logger } from "../observability/logger.js";

/**
 * Export diary conversation to Markdown file
 */
export const exportDiary = async (
  config: AppConfig,
  date: Date,
  messages: DiaryMessage[],
  startedAt: Date,
  endedAt: Date
): Promise<DiaryExportResult> => {
  const markdown = generateMarkdown(date, messages, startedAt, endedAt, config.tz);

  // Build file path: /data/diaries/YYYY/MM/YYYY-MM-DD.md
  const year = date.getFullYear().toString();
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  const fileName = `${year}-${month}-${day}.md`;

  const dirPath = path.join(config.diaryExportPath, year, month);
  const filePath = path.join(dirPath, fileName);

  // Ensure directory exists
  await mkdir(dirPath, { recursive: true });

  // Write file
  await writeFile(filePath, markdown, "utf8");

  logger.info({ filePath, messageCount: messages.length }, "Diary exported");

  return {
    localPath: filePath,
    markdownContent: markdown,
  };
};

/**
 * Generate Markdown content for diary
 */
const generateMarkdown = (
  date: Date,
  messages: DiaryMessage[],
  startedAt: Date,
  endedAt: Date,
  tz: string
): string => {
  const dateStr = date.toLocaleDateString("en-CA", { timeZone: tz });
  const dayOfWeek = date.toLocaleDateString("en-US", {
    weekday: "long",
    timeZone: tz,
  });
  const fullDate = date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: tz,
  });

  const durationMs = endedAt.getTime() - startedAt.getTime();
  const durationMinutes = Math.round(durationMs / 60000);

  const lines: string[] = [
    `# Diary - ${dateStr}`,
    "",
    `**Date**: ${dayOfWeek}, ${fullDate}`,
    `**Duration**: ${durationMinutes} minutes`,
    `**Messages**: ${messages.length}`,
    "",
    "---",
    "",
    "## Conversation",
    "",
  ];

  for (const msg of messages) {
    const time = msg.timestamp.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: tz,
    });

    const role = msg.role === "bot" ? "Bot" : "User";
    lines.push(`**${role}** (${time}):`);
    lines.push(msg.content);
    lines.push("");
  }

  return lines.join("\n");
};

/**
 * Create a Buffer from markdown content for Discord attachment
 */
export const createAttachmentBuffer = (markdown: string): Buffer => {
  return Buffer.from(markdown, "utf8");
};
