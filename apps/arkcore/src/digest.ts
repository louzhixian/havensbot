import type { Item, Source } from "@prisma/client";
import pLimit from "p-limit";
import { AppConfig } from "./config.js";
import { prisma } from "./db.js";
import { getFailedSourcesForChannel } from "./rss.js";
import {
  collapseWhitespace,
  fetchArticleText,
  formatRange,
  stripHtml,
  truncate,
} from "./utils.js";
import { callLlmWithQuota, QuotaExceededError } from "./services/llm.service.js";
import { recordMetric } from "./observability/metrics.js";

type SourceWithItems = Source & { items: Item[] };

type InternalItem = {
  sourceName: string;
  title: string;
  url: string;
  publishedAt?: string;
  content: string;
  contentSnippet: string | null;
  summary: string;
  hasContent: boolean;
};

export type DigestItem = {
  sourceName: string;
  title: string;
  url: string;
  publishedAt?: string;
  summary: string;
};

export type DigestSummaryMeta = {
  llmEnabled: boolean;
  llmUsed: boolean;
  llmItems: number;
  skippedLlmItems: number;
  promptItemsCount: number;
  usedFulltextCount: number;
  fallbackReason?: string;
  missingContentSources?: string[];
};

export type FailedSourceInfo = {
  sourceId: string;
  name: string;
  url: string;
  reason: string;
};

export type DigestData = {
  windowStart: Date;
  windowEnd: Date;
  items: DigestItem[];
  updatedSources: string[];
  failedSources: FailedSourceInfo[];
  summaryMeta: DigestSummaryMeta;
  overviewText: string;
};

const FULLTEXT_TIMEOUT_MS = 8000;
const FULLTEXT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const LLM_BATCH_SIZE = 1;

const fullTextCache = new Map<string, { text: string; expiresAt: number }>();
const isDebug = (process.env.LOG_LEVEL || "info").toLowerCase() === "debug";

const debugLog = (label: string, payload: unknown): void => {
  if (!isDebug) return;
  let text = "";
  if (typeof payload === "string") {
    text = payload;
  } else {
    try {
      text = JSON.stringify(payload);
    } catch {
      text = String(payload);
    }
  }
  console.debug(`llm debug ${label}: ${truncate(text, 800)}`);
};

const escapeRegExp = (value: string): string => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

const readJsonString = (value: string, startIndex: number): string => {
  let result = "";
  let escaped = false;
  for (let i = startIndex; i < value.length; i += 1) {
    const char = value[i];
    if (escaped) {
      if (char === "n") {
        result += "\n";
      } else if (char === "t") {
        result += "\t";
      } else {
        result += char;
      }
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      return result;
    }
    result += char;
  }
  return result;
};

const extractSummariesFallback = (
  content: string,
  urls: string[],
  maxSummaryChars: number
): Map<string, string> => {
  const summaries = new Map<string, string>();
  for (const url of urls) {
    const urlPattern = new RegExp(
      `"url"\\s*:\\s*"${escapeRegExp(url)}"`,
      "i"
    );
    const urlMatch = urlPattern.exec(content);
    if (!urlMatch) continue;
    const afterUrl = content.slice(urlMatch.index + urlMatch[0].length);
    const summaryMatch = /"summary"\s*:\s*"/i.exec(afterUrl);
    if (!summaryMatch) continue;
    const summaryStart = summaryMatch.index + summaryMatch[0].length;
    const raw = readJsonString(afterUrl, summaryStart);
    const cleaned = truncate(collapseWhitespace(stripHtml(raw)), maxSummaryChars);
    if (cleaned) {
      summaries.set(url, cleaned);
    }
  }
  return summaries;
};

const getCachedFullText = (url: string): string | null => {
  const entry = fullTextCache.get(url);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    fullTextCache.delete(url);
    return null;
  }
  return entry.text;
};

const setCachedFullText = (url: string, text: string): void => {
  fullTextCache.set(url, {
    text,
    expiresAt: Date.now() + FULLTEXT_CACHE_TTL_MS,
  });
};

const isSkippableFulltextUrl = (url: string): boolean => {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === "x.com" ||
      host === "www.x.com" ||
      host === "twitter.com" ||
      host === "www.twitter.com"
    );
  } catch {
    return false;
  }
};

const isFulltextError = (value: string): boolean => {
  const text = value.toLowerCase();
  return (
    text.includes("something went wrong") ||
    text.includes("privacy related extensions") ||
    text.includes("enable javascript") ||
    text.includes("try again later") ||
    text.includes("temporarily unavailable")
  );
};

const summarizeContent = (text: string, maxChars: number): string => {
  const cleaned = collapseWhitespace(stripHtml(text));
  if (!cleaned) return "";
  const sentences = cleaned.split(/(?<=[.!?])\s+/).filter(Boolean);
  const selected = sentences.slice(0, 2).join(" ");
  return truncate(selected || cleaned, maxChars);
};

const repairJson = (value: string): string => {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      result += char;
      escaped = true;
      continue;
    }
    if (char === "\"") {
      if (!inString) {
        inString = true;
        result += char;
        continue;
      }
      const rest = value.slice(index + 1);
      const nextMatch = rest.match(/\S/);
      const nextChar = nextMatch?.[0];
      if (nextChar && [",", "}", "]", ":"].includes(nextChar)) {
        inString = false;
        result += char;
        continue;
      }
      result += "\\\"";
      continue;
    }
    if (inString && (char === "\n" || char === "\r")) {
      result += "\\n";
      continue;
    }
    result += char;
  }

  return result.replace(/,\s*([}\]])/g, "$1");
};

const closeOpenStructures = (value: string): string => {
  let inString = false;
  let escaped = false;
  let openCurly = 0;
  let openSquare = 0;

  for (const char of value) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") openCurly += 1;
    if (char === "}") openCurly = Math.max(0, openCurly - 1);
    if (char === "[") openSquare += 1;
    if (char === "]") openSquare = Math.max(0, openSquare - 1);
  }

  let result = value;
  if (inString) result += "\"";
  if (openSquare > 0) result += "]".repeat(openSquare);
  if (openCurly > 0) result += "}".repeat(openCurly);
  return result;
};

const parseJsonBlock = (content: string): unknown | null => {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced?.[1] || content;
  const start = raw.indexOf("{");
  if (start < 0) return null;
  const end = raw.lastIndexOf("}");
  const primary = end > start ? raw.slice(start, end + 1) : raw.slice(start);
  const candidates = [
    primary,
    repairJson(primary),
    closeOpenStructures(repairJson(primary)),
  ];

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }

  return null;
};

const chunkItems = <T>(items: T[], size: number): T[][] => {
  if (size <= 0) return [items];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};

const fetchFullTextForItems = async (
  items: InternalItem[],
  options: { maxLength: number; timeoutMs: number }
): Promise<{ items: InternalItem[]; usedFulltextCount: number }> => {
  if (items.length === 0) {
    return { items, usedFulltextCount: 0 };
  }

  const updated = [...items];
  const limit = pLimit(3);
  let usedFulltextCount = 0;

  await Promise.all(
    items.map((item, index) =>
      limit(async () => {
        if (isSkippableFulltextUrl(item.url)) {
          return;
        }

        const cached = getCachedFullText(item.url);
        if (cached) {
          updated[index] = { ...item, content: cached };
          usedFulltextCount += 1;
          return;
        }

        const text = await fetchArticleText(item.url, {
          timeoutMs: options.timeoutMs,
          maxLength: options.maxLength,
        });

        if (!text) return;
        if (isFulltextError(text)) {
          debugLog("fulltext-error", { url: item.url, text });
          return;
        }

        updated[index] = { ...item, content: text };
        setCachedFullText(item.url, text);
        usedFulltextCount += 1;
      })
    )
  );

  return { items: updated, usedFulltextCount };
};

const callLlmForDigest = async (
  config: AppConfig,
  items: InternalItem[],
  maxSummaryChars: number,
  guildId?: string
): Promise<Map<string, string> | null> => {
  if (!config.llmApiKey || !config.llmModel) return null;
  if (items.length === 0) return null;
  if (!guildId) return null;

  const payloadItems = items.map((item) => ({
    url: item.url,
    title: item.title,
    source: item.sourceName,
    content: item.content,
  }));

  const systemPrompt =
    "Return JSON only (no markdown fences). Escape newlines in strings as \\n. Summarize items using provided content. Do not repeat titles. For each item summary: 用 一句话 告诉我：这条内容为什么值得关注 / 争论点是什么？ Keep each summary under the configured character limit.";

  const userPrompt = `Output format:\n{\n  "items": [{"url":"...","summary":"..."}]\n}\n\nSummary instruction: 用 一句话 告诉我：这条内容为什么值得关注 / 争论点是什么？\nSummary max chars: ${maxSummaryChars}\n\nItems:\n${JSON.stringify(
    payloadItems
  )}`;

  let content: string;
  try {
    const response = await callLlmWithQuota({
      guildId,
      system: systemPrompt,
      messages: [
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      maxTokens: config.llmMaxTokens,
    });
    content = response.content;
  } catch (error) {
    if (error instanceof QuotaExceededError) {
      debugLog("llm-quota-exceeded", { guildId });
    }
    return null;
  }

  if (!content) {
    debugLog("llm-null-response", { items: items.length });
    return null;
  }

  const parsed = parseJsonBlock(content);
  if (!parsed || typeof parsed !== "object") {
    const extracted = extractSummariesFallback(
      content,
      items.map((item) => item.url),
      maxSummaryChars
    );
    if (extracted.size > 0) {
      debugLog("parse-failed-fallback", {
        extracted: extracted.size,
        total: items.length,
      });
      return extracted;
    }
    debugLog("parse-failed", content);
    return null;
  }

  const obj = parsed as {
    items?: Array<{ url?: string; summary?: string }>;
  };

  const summaries = new Map<string, string>();
  if (Array.isArray(obj.items)) {
    for (const item of obj.items) {
      if (!item?.url || !item.summary) continue;
      if (typeof item.url !== "string" || typeof item.summary !== "string") continue;
      const cleaned = truncate(collapseWhitespace(stripHtml(item.summary)), maxSummaryChars);
      if (cleaned) {
        summaries.set(item.url, cleaned);
      }
    }
  }

  debugLog("llm-success", {
    requestedCount: items.length,
    returnedCount: summaries.size,
  });

  return summaries.size > 0 ? summaries : null;
};

const buildOverviewText = (
  rangeText: string,
  failedSources: FailedSourceInfo[],
  updatedSources: string[],
  itemsCount: number
): string => {
  const lines = [`Digest window: ${rangeText}`];
  if (itemsCount === 0) {
    lines.push("No new items today.");
  } else if (updatedSources.length > 0) {
    const list = updatedSources.slice(0, 10).join(", ");
    const extra = updatedSources.length - 10;
    lines.push(`Updated sources: ${list}${extra > 0 ? ` +${extra}` : ""}`);
  }
  if (failedSources.length > 0) {
    const list = failedSources
      .slice(0, 5)
      .map((entry) => `${entry.name} (${entry.reason})`)
      .join(", ");
    const extra = failedSources.length - 5;
    lines.push("", `Failed sources: ${list}${extra > 0 ? ` +${extra}` : ""}`);
  }
  return lines.join("\n");
};

export const buildDigestData = async (
  config: AppConfig,
  channelId: string,
  rangeStart: Date,
  rangeEnd: Date,
  guildId?: string
): Promise<DigestData> => {
  const startTime = Date.now();
  console.log(`digest build: start channelId=${channelId}`);

  const failedSourcesRaw = getFailedSourcesForChannel(channelId);
  const failedSources: FailedSourceInfo[] = failedSourcesRaw.map((entry) => ({
    sourceId: entry.sourceId,
    name: entry.name,
    url: entry.url,
    reason: entry.reason,
  }));
  const failedSourceIds = new Set(failedSources.map((entry) => entry.sourceId));

  console.log(`digest build: querying sources elapsed=${Date.now() - startTime}ms`);
  const sources = await prisma.source.findMany({
    where: { channelId, enabled: true },
    include: {
      items: {
        where: {
          createdAt: {
            gte: rangeStart,
            lt: rangeEnd,
          },
        },
        orderBy: { createdAt: "desc" },
        take: config.maxItemsPerSource,
      },
    },
    orderBy: { createdAt: "asc" },
  });
  console.log(`digest build: sources found=${sources.length} elapsed=${Date.now() - startTime}ms`);

  const updatedSources = sources
    .filter((source) => source.items.length > 0 && !failedSourceIds.has(source.id))
    .map((source) => source.name);

  const items: InternalItem[] = [];

  for (const source of sources) {
    if (source.items.length === 0) continue;

    for (const item of source.items) {
      items.push({
        sourceName: source.name,
        title: item.title,
        url: item.url,
        publishedAt: item.publishedAt ? item.publishedAt.toISOString() : undefined,
        content: "",
        contentSnippet: item.contentSnippet,
        summary: "",
        hasContent: false,
      });
    }
  }

  const limitedItems = items.slice(0, config.digestMaxItems);

  const llmEnabled =
    config.llmProvider === "openai_compat" &&
    Boolean(config.llmApiKey) &&
    Boolean(config.llmModel);

  const meta: DigestSummaryMeta = {
    llmEnabled,
    llmUsed: false,
    llmItems: 0,
    skippedLlmItems: 0,
    promptItemsCount: 0,
    usedFulltextCount: 0,
    missingContentSources: [],
  };

  console.log(`digest build: fetching fulltext items=${limitedItems.length} elapsed=${Date.now() - startTime}ms`);
  const enriched = await fetchFullTextForItems(limitedItems, {
    maxLength: config.fulltextMaxChars,
    timeoutMs: FULLTEXT_TIMEOUT_MS,
  });
  console.log(`digest build: fulltext done usedCount=${enriched.usedFulltextCount} elapsed=${Date.now() - startTime}ms`);
  meta.usedFulltextCount = enriched.usedFulltextCount;

  const missingContentSources = new Set<string>();
  const llmCandidates: InternalItem[] = [];

  for (const item of enriched.items) {
    if (
      !item.content &&
      item.contentSnippet &&
      isSkippableFulltextUrl(item.url)
    ) {
      const cleaned = collapseWhitespace(stripHtml(item.contentSnippet));
      if (
        cleaned.length >= config.minContentCharsForLlm &&
        !isFulltextError(cleaned)
      ) {
        item.content = truncate(cleaned, config.fulltextMaxChars);
      }
    }

    item.hasContent = Boolean(item.content);
    if (item.hasContent) {
      llmCandidates.push(item);
    } else {
      missingContentSources.add(item.sourceName);
    }
  }

  meta.llmItems = llmCandidates.length;
  meta.skippedLlmItems = enriched.items.length - llmCandidates.length;
  meta.promptItemsCount = llmCandidates.length;
  meta.missingContentSources = Array.from(missingContentSources);

  let llmSummaries: Map<string, string> | null = null;

  if (llmEnabled && llmCandidates.length > 0) {
    console.log(`digest build: calling LLM candidates=${llmCandidates.length} elapsed=${Date.now() - startTime}ms`);
    llmSummaries = new Map<string, string>();
    let hadResult = false;
    let anyError = false;
    let anyEmpty = false;

    for (const batch of chunkItems(llmCandidates, LLM_BATCH_SIZE)) {
      try {
        const result = await callLlmForDigest(
          config,
          batch,
          config.digestItemSummaryMaxChars,
          guildId
        );
        if (!result) {
          anyEmpty = true;
          continue;
        }
        hadResult = true;
        for (const [url, summary] of result) {
          llmSummaries.set(url, summary);
        }
      } catch (error) {
        anyError = true;
      }
    }

    console.log(`digest build: LLM done hadResult=${hadResult} elapsed=${Date.now() - startTime}ms`);
    if (hadResult) {
      meta.llmUsed = true;
      if (anyError || anyEmpty) {
        meta.fallbackReason = "llm-partial";
      }
    } else {
      meta.fallbackReason = anyError ? "llm-failed" : "llm-empty";
    }
  } else if (llmEnabled && llmCandidates.length === 0) {
    meta.fallbackReason = "llm-no-fulltext";
  } else {
    meta.fallbackReason = llmEnabled ? "llm-missing-config" : "llm-disabled";
  }

  const digestItems: DigestItem[] = enriched.items.map((item) => {
    let summary = "";
    if (!item.hasContent) {
      summary = config.missingContentNotice;
    } else if (llmSummaries && llmSummaries.has(item.url)) {
      summary = llmSummaries.get(item.url) || "";
    }

    if (!summary) {
      summary = summarizeContent(item.content, config.digestItemSummaryMaxChars);
    }

    if (!summary) {
      summary = config.missingContentNotice;
    }

    return {
      sourceName: item.sourceName,
      title: item.title,
      url: item.url,
      publishedAt: item.publishedAt,
      summary,
    };
  });

  const seenUrls = new Set<string>();
  const dedupedItems = digestItems.filter((item) => {
    if (seenUrls.has(item.url)) return false;
    seenUrls.add(item.url);
    return true;
  });

  const rangeText = formatRange(rangeStart, rangeEnd, config.tz);
  const overviewText = buildOverviewText(
    rangeText,
    failedSources,
    updatedSources,
    dedupedItems.length
  );

  console.log(`digest build: complete items=${dedupedItems.length} elapsed=${Date.now() - startTime}ms`);
  return {
    windowStart: rangeStart,
    windowEnd: rangeEnd,
    items: dedupedItems,
    updatedSources,
    failedSources,
    summaryMeta: meta,
    overviewText,
  };
};

export const createDigest = async (
  config: AppConfig,
  channelId: string,
  rangeStart: Date,
  rangeEnd: Date,
  guildId?: string
): Promise<DigestData> => {
  try {
    const digest = await buildDigestData(config, channelId, rangeStart, rangeEnd, guildId);

    await prisma.digest.create({
      data: {
        channelId,
        rangeStart,
        rangeEnd,
        content: digest.overviewText,
      },
    });

    await recordMetric({
      type: "digest_run",
      operation: channelId,
      status: "success",
      metadata: { itemCount: digest.items.length },
    });

    return digest;
  } catch (error) {
    await recordMetric({
      type: "digest_run",
      operation: channelId,
      status: "failure",
      metadata: { error: error instanceof Error ? error.message : String(error) },
    });
    throw error;
  }
};

export const resolveDigestRange = async (channelId: string): Promise<{
  rangeStart: Date;
  rangeEnd: Date;
}> => {
  const lastDigest = await prisma.digest.findFirst({
    where: { channelId },
    orderBy: { rangeEnd: "desc" },
  });

  const rangeEnd = new Date();
  const rangeStart = lastDigest
    ? lastDigest.rangeEnd
    : new Date(Date.now() - 24 * 60 * 60 * 1000);

  return { rangeStart, rangeEnd };
};
