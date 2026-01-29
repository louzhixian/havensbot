export type LlmProvider = "none" | "openai_compat";

export type AppConfig = {
  discordToken: string;
  discordApplicationId: string;
  discordGuildId?: string;
  databaseUrl: string;
  digestThreadMode: boolean;
  digestThreadThrottleMs: number;
  digestMaxItems: number;
  digestTrendsMax: number;
  digestItemSummaryMaxChars: number;
  fulltextMaxChars: number;
  deeperFulltextMaxChars: number;
  minContentCharsForLlm: number;
  missingContentNotice: string;
  llmProvider: LlmProvider;
  llmApiKey?: string;
  llmBaseUrl: string;
  llmModel?: string;
  llmMaxTokens: number;
  llmTimeoutMs: number;
  fetchIntervalMinutes: number;
  digestCron: string;
  maxItemsPerSource: number;
  newSourceMaxItems: number;
  tz: string;
  // Observability
  alertMentionUserId?: string;
  llmDailyBudget: number;
  storageWarningGB: number;
  dailyReportEnabled: boolean;
  dailyReportCron: string;
  // Archival
  archiveEnabled: boolean;
  archiveAfterDays: number;
  archiveCheckCron: string;
  metricsRetentionDays: number;
  // Voice-to-text
  voiceToTextEnabled: boolean;
  whisperApiUrl?: string;
  whisperTimeoutMs: number;
  whisperMaxRetries: number;
  // Diary
  diaryEnabled: boolean;
  diaryCron: string;
  diaryTimeoutMinutes: number;
  diaryContextDays: number;
  diaryExportPath: string;
  // Article fetching (E-04: Editorial/DeepDive timeout configuration)
  articleFetchTimeoutMs: number;
  articleFetchMaxLength: number;
};

const requireEnv = (key: string): string => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env: ${key}`);
  }
  return value;
};

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
};

const parseNonNegativeInt = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
};

const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) return true;
  if (["false", "0", "no", "n"].includes(normalized)) return false;
  return fallback;
};

export const loadConfig = (): AppConfig => {
  const llmProvider = (process.env.LLM_PROVIDER ?? "none").toLowerCase();
  const normalizedProvider: LlmProvider =
    llmProvider === "openai_compat" ? "openai_compat" : "none";
  const llmBaseUrl = process.env.LLM_BASE_URL || "https://api.openai.com";
  const llmEnabled =
    normalizedProvider === "openai_compat" &&
    Boolean(process.env.LLM_API_KEY) &&
    Boolean(process.env.LLM_MODEL);

  if ((process.env.LOG_LEVEL || "info").toLowerCase() === "debug") {
    console.debug(
      `LLM enabled=${llmEnabled} provider=${normalizedProvider} model=${process.env.LLM_MODEL || "unset"} base_url=${llmBaseUrl}`
    );
  }

  return {
    discordToken: requireEnv("DISCORD_BOT_TOKEN"),
    discordApplicationId: requireEnv("DISCORD_APPLICATION_ID"),
    discordGuildId: process.env.DISCORD_GUILD_ID || undefined,
    databaseUrl: requireEnv("DATABASE_URL"),
    digestThreadMode: parseBoolean(process.env.DIGEST_THREAD_MODE, true),
    digestThreadThrottleMs: parsePositiveInt(process.env.DIGEST_THREAD_THROTTLE_MS, 400),
    digestMaxItems: parsePositiveInt(process.env.DIGEST_MAX_ITEMS, 30),
    digestTrendsMax: parsePositiveInt(process.env.DIGEST_TRENDS_MAX, 6),
    digestItemSummaryMaxChars: parsePositiveInt(
      process.env.DIGEST_ITEM_SUMMARY_MAX_CHARS,
      320
    ),
    fulltextMaxChars: parsePositiveInt(process.env.FULLTEXT_MAX_CHARS, 2000),
    deeperFulltextMaxChars: parseNonNegativeInt(
      process.env.DEEPER_FULLTEXT_MAX_CHARS,
      parsePositiveInt(process.env.FULLTEXT_MAX_CHARS, 2000)
    ),
    minContentCharsForLlm: parsePositiveInt(process.env.MIN_CONTENT_CHARS_FOR_LLM, 120),
    missingContentNotice:
      process.env.MISSING_CONTENT_NOTICE ||
      "(No summary available: full text fetch failed.)",
    llmProvider: normalizedProvider,
    llmApiKey: process.env.LLM_API_KEY || undefined,
    llmBaseUrl,
    llmModel: process.env.LLM_MODEL || undefined,
    llmMaxTokens: parsePositiveInt(process.env.LLM_MAX_TOKENS, 4000),
    llmTimeoutMs: parsePositiveInt(process.env.LLM_TIMEOUT_MS, 120000),
    fetchIntervalMinutes: parsePositiveInt(process.env.FETCH_INTERVAL_MINUTES, 10),
    digestCron: process.env.DIGEST_CRON || "0 9 * * *",
    maxItemsPerSource: parsePositiveInt(process.env.MAX_ITEMS_PER_SOURCE, 10),
    newSourceMaxItems: parsePositiveInt(process.env.NEW_SOURCE_MAX_ITEMS, 3),
    tz: process.env.TZ || "Asia/Tokyo",
    // Observability
    alertMentionUserId: process.env.ALERT_MENTION_USER_ID || undefined,
    llmDailyBudget: parseFloat(process.env.LLM_DAILY_BUDGET || "5.0"),
    storageWarningGB: parseFloat(process.env.STORAGE_WARNING_GB || "10"),
    dailyReportEnabled: parseBoolean(process.env.DAILY_REPORT_ENABLED, true),
    dailyReportCron: process.env.DAILY_REPORT_CRON || "0 20 * * *",
    // Archival
    archiveEnabled: parseBoolean(process.env.ARCHIVE_ENABLED, true),
    archiveAfterDays: parsePositiveInt(process.env.ARCHIVE_AFTER_DAYS, 180),
    archiveCheckCron: process.env.ARCHIVE_CHECK_CRON || "0 2 * * 0",
    metricsRetentionDays: parsePositiveInt(process.env.METRICS_RETENTION_DAYS, 90),
    // Voice-to-text
    voiceToTextEnabled: parseBoolean(process.env.VOICE_TO_TEXT_ENABLED, false),
    whisperApiUrl: process.env.WHISPER_API_URL || undefined,
    whisperTimeoutMs: parsePositiveInt(process.env.WHISPER_TIMEOUT_MS, 60000),
    whisperMaxRetries: parsePositiveInt(process.env.WHISPER_MAX_RETRIES, 2),
    // Diary
    diaryEnabled: parseBoolean(process.env.DIARY_ENABLED, false),
    diaryCron: process.env.DIARY_CRON || "0 23 * * *",
    diaryTimeoutMinutes: parsePositiveInt(process.env.DIARY_TIMEOUT_MINUTES, 180),
    diaryContextDays: parsePositiveInt(process.env.DIARY_CONTEXT_DAYS, 7),
    diaryExportPath: process.env.DIARY_EXPORT_PATH || "/data/diaries",
    // Article fetching (E-04: Editorial/DeepDive timeout configuration)
    articleFetchTimeoutMs: parsePositiveInt(process.env.ARTICLE_FETCH_TIMEOUT_MS, 12000),
    articleFetchMaxLength: parsePositiveInt(process.env.ARTICLE_FETCH_MAX_LENGTH, 100000), // 100KB
  };
};
