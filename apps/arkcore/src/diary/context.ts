import { readFile, readdir } from "fs/promises";
import path from "path";
import type { AppConfig } from "../config.js";
import { logger } from "../observability/logger.js";

/**
 * Load recent diary entries as context for LLM conversation
 */
export const loadRecentDiaryContext = async (
  config: AppConfig
): Promise<string> => {
  const contextDays = config.diaryContextDays;
  const exportPath = config.diaryExportPath;

  const now = new Date();
  const entries: { date: string; content: string }[] = [];

  // Try to load entries from the last N days
  for (let i = 1; i <= contextDays; i++) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);

    const year = date.getFullYear().toString();
    const month = (date.getMonth() + 1).toString().padStart(2, "0");
    const day = date.getDate().toString().padStart(2, "0");
    const fileName = `${year}-${month}-${day}.md`;
    const filePath = path.join(exportPath, year, month, fileName);

    try {
      const content = await readFile(filePath, "utf8");
      entries.push({
        date: `${year}-${month}-${day}`,
        content: extractConversationSummary(content),
      });
    } catch {
      // File doesn't exist, skip
      continue;
    }
  }

  if (entries.length === 0) {
    return "No recent diary entries found. This might be the first conversation.";
  }

  const contextLines = entries.map(
    (entry) => `### ${entry.date}\n${entry.content}`
  );

  return contextLines.join("\n\n");
};

/**
 * Extract a summary from diary content (first few exchanges or key points)
 */
const extractConversationSummary = (content: string): string => {
  // Split by conversation marker
  const conversationStart = content.indexOf("## Conversation");
  if (conversationStart === -1) {
    return content.slice(0, 500) + "...";
  }

  const conversationContent = content.slice(conversationStart);

  // Extract first few messages (up to ~500 chars)
  const lines = conversationContent.split("\n").slice(2); // Skip "## Conversation" header
  let summary = "";
  let charCount = 0;

  for (const line of lines) {
    if (charCount + line.length > 800) break;
    summary += line + "\n";
    charCount += line.length;
  }

  return summary.trim() || "Brief conversation.";
};

/**
 * Get the current day context (day of week, date)
 */
export const getDayContext = (tz: string): { dayOfWeek: string; date: string } => {
  const now = new Date();

  const dayOfWeek = now.toLocaleDateString("en-US", {
    weekday: "long",
    timeZone: tz,
  });

  const date = now.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: tz,
  });

  return { dayOfWeek, date };
};

/**
 * Format date for diary thread name
 */
export const formatDiaryDate = (date: Date, tz: string): string => {
  return date.toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD format
};
