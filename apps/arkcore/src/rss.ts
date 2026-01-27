import Parser from "rss-parser";
import type { Source } from "@prisma/client";
import { AppConfig } from "./config.js";
import { prisma } from "./db.js";
import {
  collapseWhitespace,
  contentHash,
  normalizeUrl,
  parseDate,
  sanitizeForDb,
  stripHtml,
  truncate,
} from "./utils.js";
import { withRetry } from "./utils/retry-utils.js";
import { logger } from "./observability/logger.js";
import { recordMetric } from "./observability/metrics.js";

const parser: Parser = new Parser();

export type FailedSource = {
  sourceId: string;
  channelId: string;
  name: string;
  url: string;
  reason: string;
};

type FetchResult =
  | { status: "not_modified" }
  | {
      status: "ok";
      feed: Parser.Output<Parser.Item>;
      etag?: string | null;
      lastModified?: string | null;
    };

type IngestResult = {
  newItems: number;
  failedSource?: FailedSource;
};

class SourceFetchError extends Error {
  reason: string;

  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

const failedSourcesById = new Map<string, FailedSource>();

const recordFailedSource = (source: Source, reason: string): FailedSource => {
  const entry: FailedSource = {
    sourceId: source.id,
    channelId: source.channelId,
    name: source.name,
    url: source.url,
    reason,
  };
  failedSourcesById.set(source.id, entry);
  return entry;
};

const clearFailedSource = (sourceId: string): void => {
  failedSourcesById.delete(sourceId);
};

export const getFailedSourcesForChannel = (channelId: string): FailedSource[] => {
  return Array.from(failedSourcesById.values()).filter(
    (entry) => entry.channelId === channelId
  );
};

export const detectRssHubError = (
  body: string,
  status: number,
  contentType: string | null
): string | null => {
  const text = body || "";
  const lower = text.toLowerCase();
  const normalizedType = (contentType || "").toLowerCase();
  const isXml =
    normalizedType.includes("xml") ||
    normalizedType.includes("rss") ||
    normalizedType.includes("atom");

  if (!isXml) {
    if (
      text.includes("Looks like something went wrong") ||
      text.includes("Welcome to RSSHub")
    ) {
      return "RSSHub error page";
    }
  }

  if (text.includes("Twitter API is not configured")) {
    return "Twitter API is not configured";
  }

  if (text.includes("ConfigNotFoundError") || lower.includes("confignotfounderror")) {
    return "RSSHub config not found";
  }

  if (status >= 400 && status < 600 && !isXml) {
    return `HTTP ${status}`;
  }

  return null;
};

const fetchFeed = async (source: Source): Promise<FetchResult> => {
  const headers: Record<string, string> = {
    "User-Agent": "ArkCore/0.1 (+https://example.invalid)",
    Accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
  };

  if (source.etag) headers["If-None-Match"] = source.etag;
  if (source.lastModified) headers["If-Modified-Since"] = source.lastModified;

  const response = await withRetry(
    async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      try {
        const res = await fetch(source.url, {
          method: "GET",
          headers,
          redirect: "follow",
          signal: controller.signal,
        });

        // Still throw on 5xx to trigger retry
        if (res.status >= 500) {
          throw new Error(`Server error: ${res.status}`);
        }

        return res;
      } finally {
        clearTimeout(timeout);
      }
    },
    {
      maxAttempts: 3,
      initialDelayMs: 1000,
      backoffMultiplier: 2,
      retryableErrors: (error: any) => {
        // Retry on network errors and 5xx
        if (error instanceof Error) {
          return (
            error.message.includes("Server error") ||
            error.message.includes("fetch failed") ||
            error.message.includes("aborted")
          );
        }
        return false;
      },
    }
  );

  if (response.status === 304) {
    return { status: "not_modified" };
  }

  const text = await response.text();
  const reason = detectRssHubError(
    text,
    response.status,
    response.headers.get("content-type")
  );

  if (!response.ok) {
    throw new SourceFetchError(reason ?? `HTTP ${response.status}`);
  }

  if (reason) {
    throw new SourceFetchError(reason);
  }

  const feed = await parser.parseString(text);

  return {
    status: "ok",
    feed,
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
  };
};

export const ingestSource = async (
  source: Source,
  config: AppConfig
): Promise<IngestResult> => {
  let newItems = 0;

  try {
    const result = await fetchFeed(source);

    if (result.status === "not_modified") {
      clearFailedSource(source.id);
      await prisma.source.update({
        where: { id: source.id },
        data: { lastFetchedAt: new Date() },
      });
      return { newItems: 0 };
    }

    const now = new Date();
    const items = (result.feed.items ?? [])
      .map((item) => {
        const rawUrl = item.link || item.guid;
        if (!rawUrl) return null;

        let canonicalUrl: string;
        try {
          canonicalUrl = normalizeUrl(rawUrl);
        } catch {
          return null;
        }

        const title = collapseWhitespace(item.title || "Untitled");
        const publishedAt = parseDate(item.isoDate || item.pubDate || null);
        const record = item as Record<string, unknown>;
        const encoded = record["content:encoded"];
        const summary = record.summary;
        const description = record.description;
        const snippetRaw =
          (typeof encoded === "string" && encoded) ||
          item.content ||
          item.contentSnippet ||
          (typeof summary === "string" && summary) ||
          (typeof description === "string" && description) ||
          "";
        const snippet = snippetRaw
          ? truncate(collapseWhitespace(stripHtml(snippetRaw)), 800)
          : null;

        // Sanitize text fields to prevent PostgreSQL hex escape errors
        const sanitizedTitle = sanitizeForDb(title) ?? "Untitled";
        const sanitizedSnippet = sanitizeForDb(snippet);

        return {
          sourceId: source.id,
          title: sanitizedTitle,
          url: canonicalUrl,
          publishedAt,
          contentSnippet: sanitizedSnippet,
          contentHash: contentHash(canonicalUrl, sanitizedTitle, publishedAt),
          createdAt: now,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));

    const isNewSource = !source.lastFetchedAt;
    const existingHashes = new Set<string>();
    if (!isNewSource && items.length > 0) {
      const hashes = items.map((item) => item.contentHash);
      const existing = await prisma.item.findMany({
        where: { sourceId: source.id, contentHash: { in: hashes } },
        select: { contentHash: true },
      });
      for (const entry of existing) {
        existingHashes.add(entry.contentHash);
      }
    }

    const filtered: typeof items = [];
    let existingStreak = 0;
    for (const item of items) {
      if (!isNewSource && existingHashes.has(item.contentHash)) {
        existingStreak += 1;
        if (existingStreak >= config.newSourceMaxItems) {
          break;
        }
        continue;
      }
      existingStreak = 0;
      filtered.push(item);
    }

    const limitedItems =
      isNewSource && filtered.length > config.newSourceMaxItems
        ? filtered.slice(0, config.newSourceMaxItems)
        : filtered;

    if (limitedItems.length > 0) {
      const resultInsert = await prisma.item.createMany({
        data: limitedItems,
        skipDuplicates: true,
      });
      newItems = resultInsert.count;
    }

    await prisma.source.update({
      where: { id: source.id },
      data: {
        etag: result.etag ?? source.etag,
        lastModified: result.lastModified ?? source.lastModified,
        lastFetchedAt: new Date(),
      },
    });

    clearFailedSource(source.id);

    await recordMetric({
      type: "rss_fetch",
      operation: source.id,
      status: "success",
      metadata: { itemCount: newItems, sourceUrl: source.url },
    });

    return { newItems };
  } catch (error) {
    const reason =
      error instanceof SourceFetchError
        ? error.reason
        : error instanceof Error
          ? error.message
          : "Fetch failed";
    const failedSource = recordFailedSource(source, reason);
    console.error(`rss ingest failed for ${source.url}`, reason);

    await recordMetric({
      type: "rss_fetch",
      operation: source.id,
      status: "failure",
      metadata: { error: reason, sourceUrl: source.url },
    });

    return { newItems: 0, failedSource };
  }
};

export const ingestAllSources = async (
  config: AppConfig
): Promise<{
  totalNew: number;
  failedSources: FailedSource[];
}> => {
  const sources = await prisma.source.findMany({ where: { enabled: true } });
  let totalNew = 0;
  const failedSources: FailedSource[] = [];

  for (const source of sources) {
    const result = await ingestSource(source, config);
    totalNew += result.newItems;
    if (result.failedSource) failedSources.push(result.failedSource);
  }

  return { totalNew, failedSources };
};

export const ingestSourcesForChannel = async (
  channelId: string,
  config: AppConfig
): Promise<{ totalNew: number; failedSources: FailedSource[] }> => {
  const sources = await prisma.source.findMany({
    where: { enabled: true, channelId },
    orderBy: { createdAt: "asc" },
  });
  let totalNew = 0;
  const failedSources: FailedSource[] = [];

  for (const source of sources) {
    const result = await ingestSource(source, config);
    totalNew += result.newItems;
    if (result.failedSource) failedSources.push(result.failedSource);
  }

  return { totalNew, failedSources };
};
