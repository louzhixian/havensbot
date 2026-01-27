import type { AppConfig } from "../config.js";
import { LlmClient, type LlmMessage } from "../llm/client.js";
import { loadPromptSections, renderTemplate } from "../utils/prompt-utils.js";
import { fetchArticleText } from "../utils.js";
import { logger } from "../observability/logger.js";

const PROMPT_FILE = "readings.qa.prompt.md";
const MAX_ARTICLE_LENGTH = 8000; // Leave room for conversation

export const generateReadingsResponse = async (
  config: AppConfig,
  llmClient: LlmClient,
  articleUrl: string,
  userQuestion: string
): Promise<string> => {
  // Fetch article content
  let articleContent: string;
  try {
    const content = await fetchArticleText(articleUrl, {
      maxLength: MAX_ARTICLE_LENGTH,
      timeoutMs: 15000
    });
    articleContent = content || "[无法获取文章内容]";
  } catch (error) {
    logger.warn({ error, articleUrl }, "Failed to fetch article for Q&A");
    articleContent = "[无法获取文章内容]";
  }

  const { system } = await loadPromptSections(PROMPT_FILE);

  const systemPrompt = renderTemplate(system, {
    article_content: articleContent,
  });

  const messages: LlmMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userQuestion },
  ];

  const response = await llmClient.call({
    operation: "readings_qa",
    messages,
    temperature: 0.3, // More factual for Q&A
    maxTokens: 500,
  });

  if (!response.success || !response.data) {
    throw new Error(response.error || "Failed to generate readings response");
  }

  return response.data;
};
