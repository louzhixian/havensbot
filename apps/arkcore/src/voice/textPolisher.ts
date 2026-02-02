import type { AppConfig } from "../config.js";
import { callLlmWithQuota, QuotaExceededError, TierRestrictedError } from "../services/llm.service.js";
import { logger } from "../observability/logger.js";
import { loadPromptSections, renderTemplate } from "../utils/prompt-utils.js";

/**
 * Polish transcribed text using LLM to clean up spoken language patterns
 *
 * @param transcribedText - Raw text from Whisper transcription
 * @param config - Application configuration
 * @param guildId - Guild ID for quota management
 * @returns Polished text, or original text if LLM fails (graceful degradation)
 */
export async function polishTranscript(
  transcribedText: string,
  config: AppConfig,
  guildId: string
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

    const response = await callLlmWithQuota({
      guildId,
      system: prompt.system,
      messages: [
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      maxTokens: config.llmMaxTokens,
    });

    log.info("Transcript polished successfully");
    return response.content;
  } catch (error) {
    if (error instanceof QuotaExceededError || error instanceof TierRestrictedError) {
      log.warn({ error: error.message }, "LLM quota/tier issue, using original transcript");
    } else {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error({ error: errorMessage }, "Failed to polish transcript");
    }
    // Graceful degradation: return original text
    return transcribedText;
  }
}
