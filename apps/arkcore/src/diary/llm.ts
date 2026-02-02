import type { AppConfig } from "../config.js";
import { callLlmWithQuota, QuotaExceededError, TierRestrictedError } from "../services/llm.service.js";
import { loadPromptSections, renderTemplate } from "../utils/prompt-utils.js";
import { loadRecentDiaryContext, getDayContext } from "./context.js";
import type { DiaryMessage } from "./types.js";

const PROMPT_FILE = "diary.companion.prompt.md";

/**
 * Generate LLM response for diary conversation
 */
export const generateDiaryResponse = async (
  config: AppConfig,
  guildId: string,
  conversationHistory: DiaryMessage[]
): Promise<string> => {
  const { system, user: userTemplate } = await loadPromptSections(PROMPT_FILE);

  // Load context
  const recentDiaryContext = await loadRecentDiaryContext(config);
  const { dayOfWeek, date } = getDayContext(config.tz);

  // Render system prompt with context
  const systemPrompt = renderTemplate(system, {
    recent_diary_context: recentDiaryContext,
    day_of_week: dayOfWeek,
    date: date,
  });

  // Build message history (Anthropic format: only user/assistant, system is separate)
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];

  // Add conversation history
  for (const msg of conversationHistory) {
    messages.push({
      role: msg.role === "bot" ? "assistant" : "user",
      content: msg.content,
    });
  }

  // If this is the start of conversation, add the user template as a trigger
  if (conversationHistory.length === 0) {
    messages.push({
      role: "user",
      content: renderTemplate(userTemplate, {
        day_of_week: dayOfWeek,
        date: date,
      }),
    });
  }

  const response = await callLlmWithQuota({
    guildId,
    system: systemPrompt,
    messages,
    temperature: 0.7, // More creative for conversation
    maxTokens: 300, // Keep responses concise
  });

  return response.content;
};

/**
 * Generate opening message for a new diary session
 */
export const generateOpeningMessage = async (
  config: AppConfig,
  guildId: string
): Promise<string> => {
  return generateDiaryResponse(config, guildId, []);
};

/**
 * Generate farewell message when ending diary session
 */
export const generateFarewellMessage = async (
  config: AppConfig,
  guildId: string,
  conversationHistory: DiaryMessage[]
): Promise<string> => {
  const { system } = await loadPromptSections(PROMPT_FILE);
  const recentDiaryContext = await loadRecentDiaryContext(config);
  const { dayOfWeek, date } = getDayContext(config.tz);

  const systemPrompt = renderTemplate(system, {
    recent_diary_context: recentDiaryContext,
    day_of_week: dayOfWeek,
    date: date,
  });

  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];

  // Add conversation history
  for (const msg of conversationHistory) {
    messages.push({
      role: msg.role === "bot" ? "assistant" : "user",
      content: msg.content,
    });
  }

  // Add farewell trigger
  messages.push({
    role: "user",
    content:
      "[The user is ending the diary session. Please give a warm, brief farewell that acknowledges what was discussed today. Keep it to 1-2 sentences.]",
  });

  try {
    const response = await callLlmWithQuota({
      guildId,
      system: systemPrompt,
      messages,
      temperature: 0.7,
      maxTokens: 150,
    });

    return response.content;
  } catch {
    return "Good night! Thanks for sharing your day with me.";
  }
};
