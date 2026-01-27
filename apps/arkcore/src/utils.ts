import crypto from "crypto";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

const DROP_QUERY_PARAMS = new Set(["ref", "fbclid", "gclid"]);
const DEFAULT_UA = "ArkCore/0.1 (+https://example.invalid)";

export const canonicalizeUrl = (rawUrl: string): string => {
  const url = new URL(rawUrl);
  url.hash = "";

  for (const key of Array.from(url.searchParams.keys())) {
    if (key.startsWith("utm_") || DROP_QUERY_PARAMS.has(key)) {
      url.searchParams.delete(key);
    }
  }

  url.searchParams.sort();

  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.toString();
};

export const normalizeUrl = (rawUrl: string): string => {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http/https URLs are supported");
  }
  return canonicalizeUrl(url.toString());
};

export const contentHash = (
  canonicalUrl: string,
  title: string,
  publishedAt: Date | null
): string => {
  const base = [canonicalUrl, title.trim(), publishedAt?.toISOString() ?? ""].join("|");
  return crypto.createHash("sha256").update(base).digest("hex");
};

export const parseDate = (value?: string | null): Date | null => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
};

export const collapseWhitespace = (value: string): string => {
  return value.replace(/\s+/g, " ").trim();
};

export const stripHtml = (value: string): string => {
  if (!value) return "";
  if (!value.includes("<")) return value;
  try {
    const dom = new JSDOM(`<!doctype html><body>${value}`);
    return dom.window.document.body.textContent || "";
  } catch {
    return value.replace(/<[^>]*>/g, " ");
  }
};

export const hasEnoughContent = (value: string, minChars: number): boolean => {
  const cleaned = collapseWhitespace(stripHtml(value));
  return cleaned.length >= minChars;
};

export const truncate = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
};

/**
 * Sanitize text for PostgreSQL storage by removing/escaping problematic escape sequences.
 * PostgreSQL interprets \x as hex escape - invalid sequences cause "unexpected end of hex escape" errors.
 */
export const sanitizeForDb = (value: string | null | undefined): string | null => {
  if (!value) return null;
  // Replace backslash followed by x (hex escape trigger) with escaped backslash
  // Also handle other problematic escape sequences
  return value
    .replace(/\\x/gi, "\\\\x") // Escape \x sequences
    .replace(/\\u(?![0-9a-fA-F]{4})/g, "\\\\u") // Escape invalid \u sequences
    .replace(/\x00/g, ""); // Remove null bytes
};

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const formatDateTimeWithZone = (date: Date, timeZone: string): string => {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });

  const parts = formatter.formatToParts(date);
  const lookup = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  const datePart = [lookup("year"), lookup("month"), lookup("day")]
    .filter(Boolean)
    .join("-");
  const timePart = [lookup("hour"), lookup("minute")].filter(Boolean).join(":");
  const zonePart = lookup("timeZoneName");
  const dateTime = [datePart, timePart].filter(Boolean).join(" ").trim();
  return zonePart ? `${dateTime} ${zonePart}`.trim() : dateTime;
};

export const formatRange = (
  start: Date,
  end: Date,
  timeZone?: string
): string => {
  if (!timeZone) {
    return `${start.toISOString()} - ${end.toISOString()}`;
  }

  try {
    return `${formatDateTimeWithZone(start, timeZone)} - ${formatDateTimeWithZone(
      end,
      timeZone
    )}`;
  } catch {
    return `${start.toISOString()} - ${end.toISOString()}`;
  }
};

export const buildOpenAiCompatUrl = (baseUrl: string): string => {
  const trimmed = baseUrl.replace(/\/$/, "");
  const apiBase = trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
  return `${apiBase}/chat/completions`;
};

export const fetchArticleText = async (
  url: string,
  options?: { timeoutMs?: number; maxLength?: number }
): Promise<string | null> => {
  const timeoutMs = options?.timeoutMs ?? 10000;
  const maxLength = options?.maxLength ?? 2000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": DEFAULT_UA,
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    const text = article?.textContent ? collapseWhitespace(article.textContent) : "";

    if (!text) return null;
    return truncate(text, maxLength);
  } catch (error) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
};
