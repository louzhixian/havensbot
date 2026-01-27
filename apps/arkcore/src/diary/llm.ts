import type { AppConfig } from "../config.js";
import { LlmClient, type LlmMessage } from "../llm/client.js";
import { loadPromptSections, renderTemplate } from "../utils/prompt-utils.js";
import { loadRecentDiaryContext, getDayContext } from "./context.js";
import type { DiaryMessage } from "./types.js";

const PROMPT_FILE = "diary.companion.prompt.md";

/**
 * Generate LLM response for diary conversation
 */
export const generateDiaryResponse = async (
  config: AppConfig,
  llmClient: LlmClient,
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

  // Build message history
  const messages: LlmMessage[] = [{ role: "system", content: systemPrompt }];

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

  const response = await llmClient.call({
    operation: "diary_conversation",
    messages,
    temperature: 0.7, // More creative for conversation
    maxTokens: 300, // Keep responses concise
  });

  if (!response.success || !response.data) {
    throw new Error(response.error || "Failed to generate diary response");
  }

  return response.data;
};

/**
 * Generate opening message for a new diary session
 */
export const generateOpeningMessage = async (
  config: AppConfig,
  llmClient: LlmClient
): Promise<string> => {
  return generateDiaryResponse(config, llmClient, []);
};

/**
 * Generate farewell message when ending diary session
 */
export const generateFarewellMessage = async (
  config: AppConfig,
  llmClient: LlmClient,
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

  const messages: LlmMessage[] = [{ role: "system", content: systemPrompt }];

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

  const response = await llmClient.call({
    operation: "diary_farewell",
    messages,
    temperature: 0.7,
    maxTokens: 150,
  });

  if (!response.success || !response.data) {
    return "Good night! Thanks for sharing your day with me.";
  }

  return response.data;
};
