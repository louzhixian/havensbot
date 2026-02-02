import type { AppConfig } from "../config.js";
import { callLlmWithQuota } from "../services/llm.service.js";
import { loadPromptSections, renderTemplate } from "../utils/prompt-utils.js";
import { fetchArticleText } from "../utils.js";
import { logger } from "../observability/logger.js";

const PROMPT_FILE = "readings.qa.prompt.md";
const MAX_ARTICLE_LENGTH = 8000; // Leave room for conversation

export const generateReadingsResponse = async (
  config: AppConfig,
  guildId: string,
  articleUrl: string,
  userQuestion: string
): Promise<string> => {
  // Fetch article content
  let articleContent: string;
  let wasTruncated = false;
  
  try {
    const content = await fetchArticleText(articleUrl, {
      maxLength: MAX_ARTICLE_LENGTH,
      timeoutMs: 15000
    });
    
    if (!content) {
      articleContent = "[无法获取文章内容]";
    } else {
      articleContent = content;
      // R-04: Detect if article was likely truncated
      wasTruncated = content.length >= MAX_ARTICLE_LENGTH;
    }
  } catch (error) {
    logger.warn({ error, articleUrl }, "Failed to fetch article for Q&A");
    articleContent = "[无法获取文章内容]";
  }

  const { system } = await loadPromptSections(PROMPT_FILE);

  const systemPrompt = renderTemplate(system, {
    article_content: articleContent,
  });

  const response = await callLlmWithQuota({
    guildId,
    system: systemPrompt,
    messages: [
      { role: "user", content: userQuestion },
    ],
    temperature: 0.3, // More factual for Q&A
    maxTokens: 500,
  });

  let answer = response.content;
  
  // R-04: Inform user if article was truncated
  if (wasTruncated) {
    answer += `\n\n_注：文章较长，仅基于前 ${MAX_ARTICLE_LENGTH.toLocaleString()} 字符回答。完整内容请查看原文。_`;
  }

  return answer;
};
