/**
 * Whisper API client for voice transcription
 */

import type { AppConfig } from "../config.js";
import { logger } from "../observability/logger.js";
import { recordMetric } from "../observability/metrics.js";

/** Response from Whisper ASR API */
type WhisperResponse = {
  text: string;
};

/** Error with HTTP status code */
type HttpError = Error & {
  status?: number;
  code?: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Check if an error is retryable (network errors or 5xx responses)
 */
const isRetryableError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const httpError = error as HttpError;

  // Network errors
  if (
    httpError.code === "ECONNRESET" ||
    httpError.code === "ETIMEDOUT" ||
    httpError.code === "ENOTFOUND" ||
    httpError.code === "ECONNREFUSED"
  ) {
    return true;
  }

  // HTTP 5xx errors
  if (httpError.status && httpError.status >= 500) {
    return true;
  }

  // Fetch/network errors
  if (httpError.name === "FetchError" || httpError.name === "AbortError") {
    return true;
  }

  return false;
};

/**
 * Create an error with HTTP status
 */
const createHttpError = (message: string, status?: number): HttpError => {
  const error = new Error(message) as HttpError;
  error.status = status;
  return error;
};

/**
 * Transcribe audio using the Whisper API with auto-retry
 *
 * @param audioBuffer - The audio data as a Buffer
 * @param config - Application configuration containing Whisper API settings
 * @returns The transcribed text
 * @throws Error if transcription fails after all retry attempts
 */
export async function transcribe(
  audioBuffer: Buffer,
  config: AppConfig
): Promise<string> {
  if (!config.whisperApiUrl) {
    throw new Error("Whisper API URL not configured");
  }

  const maxRetries = config.whisperMaxRetries;
  const timeoutMs = config.whisperTimeoutMs;
  const baseUrl = config.whisperApiUrl.replace(/\/$/, "");
  const endpoint = `${baseUrl}/asr?encode=true&task=transcribe&language=zh&word_timestamps=false&output=json`;
  const startTime = Date.now();

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const attemptLogger = logger.child({
      operation: "whisper_transcribe",
      attempt,
      maxAttempts: maxRetries + 1,
      audioSize: audioBuffer.length,
    });

    try {
      attemptLogger.info("Starting transcription attempt");

      // Create FormData with audio file
      const formData = new FormData();
      const blob = new Blob([audioBuffer as BlobPart], { type: "audio/ogg" });
      formData.append("audio_file", blob, "audio.ogg");

      // Create abort controller for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          body: formData,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorText = await response.text().catch(() => "");
          const error = createHttpError(
            `Whisper API request failed (${response.status}): ${errorText}`,
            response.status
          );

          // Check if this is a retryable error
          if (response.status >= 500 && attempt <= maxRetries) {
            throw error;
          }

          // Non-retryable error (4xx), throw immediately
          attemptLogger.error(
            { status: response.status, errorText },
            "Whisper API returned non-retryable error"
          );
          throw error;
        }

        const data = (await response.json()) as WhisperResponse;

        if (typeof data.text !== "string") {
          throw new Error("Whisper API response missing text field");
        }

        const transcribedText = data.text.trim();
        attemptLogger.info(
          { textLength: transcribedText.length },
          "Transcription successful"
        );

        await recordMetric({
          type: "whisper_transcribe",
          operation: "transcribe",
          status: "success",
          metadata: { latency: Date.now() - startTime, audioSize: audioBuffer.length },
        });

        return transcribedText;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Handle abort (timeout)
      if (lastError.name === "AbortError") {
        lastError = createHttpError(
          `Whisper API request timed out after ${timeoutMs}ms`
        );
        (lastError as HttpError).code = "ETIMEDOUT";
      }

      attemptLogger.warn(
        { error: lastError.message },
        "Transcription attempt failed"
      );

      // Check if we should retry
      if (attempt <= maxRetries && isRetryableError(lastError)) {
        // Backoff: 3s, 6s (for default maxRetries=2)
        const delayMs = 3000 * Math.pow(2, attempt - 1);
        attemptLogger.info(
          { delayMs, nextAttempt: attempt + 1 },
          "Scheduling retry"
        );
        await sleep(delayMs);
        continue;
      }

      // No more retries, throw the error
      break;
    }
  }

  logger.error(
    {
      operation: "whisper_transcribe",
      error: lastError?.message,
      totalAttempts: maxRetries + 1,
    },
    "All transcription attempts failed"
  );

  await recordMetric({
    type: "whisper_transcribe",
    operation: "transcribe",
    status: "failure",
    metadata: { latency: Date.now() - startTime, error: lastError?.message ?? "Unknown error" },
  });

  throw lastError || new Error("Transcription failed");
}
