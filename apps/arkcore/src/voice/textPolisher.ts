import type { AppConfig } from "../config.js";
import { createLlmClient } from "../llm/client.js";
import { logger } from "../observability/logger.js";
import { loadPromptSections, renderTemplate } from "../utils/prompt-utils.js";

/**
 * Polish transcribed text using LLM to clean up spoken language patterns
 *
 * @param transcribedText - Raw text from Whisper transcription
 * @param config - Application configuration
 * @returns Polished text, or original text if LLM fails (graceful degradation)
 */
export async function polishTranscript(
  transcribedText: string,
  config: AppConfig
): Promise<string> {
  const log = logger.child({ operation: "voice_polish" });

  // Return original if text is empty
  if (!transcribedText.trim()) {
    log.debug("Empty transcribed text, skipping polish");
    return transcribedText;
  }

  try {
    const prompt = await loadPromptSections("voice.text_polish.prompt.md");
    const userPrompt = renderTemplate(prompt.user, {
      transcribedText,
    });

    const llmClient = createLlmClient(config);
    const response = await llmClient.callWithFallback<string>(
      {
        operation: "voice_polish",
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
        maxTokens: config.llmMaxTokens,
      },
      () => transcribedText // Fallback: return original text
    );

    if (response.success && response.data) {
      if (response.degraded) {
        log.info("LLM polish unavailable, using original transcript");
      } else {
        log.info(
          { latency: response.latency, cost: response.cost },
          "Transcript polished successfully"
        );
      }
      return response.data;
    }

    // Should not reach here due to fallback, but handle just in case
    log.warn({ error: response.error }, "LLM polish failed, using original");
    return transcribedText;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error({ error: errorMessage }, "Failed to polish transcript");
    return transcribedText;
  }
}
