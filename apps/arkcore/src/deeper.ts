import { readFile } from "fs/promises";
import path from "path";
import { AppConfig } from "./config.js";
import { prisma } from "./db.js";
import { callLlmWithQuota } from "./services/llm.service.js";
import {
  collapseWhitespace,
  fetchArticleText,
  normalizeUrl,
  stripHtml,
  truncate,
} from "./utils.js";

export type DeepDiveResult = {
  status: "success" | "insufficient" | "missing" | "failed";
  content: string;
  itemId?: string;
};

const PROMPT_DIR = path.resolve(process.cwd(), "prompts");
const PROMPT_FILE = "deeper.article_summary.prompt.md";
const PROMPT_CACHE = new Map<string, { system: string; user: string }>();
const CONTENT_INSUFFICIENT_NOTICE =
  "内容不足：该来源未提供足够正文，无法生成深度解读。可尝试启用原文抓取或更换信息源。";
const LLM_INSUFFICIENT_NOTICE = "内容不足，无法生成深度解读。";

const loadPromptSections = async (
  fileName: string
): Promise<{ system: string; user: string }> => {
  const cached = PROMPT_CACHE.get(fileName);
  if (cached) return cached;

  const filePath = path.join(PROMPT_DIR, fileName);
  const content = await readFile(filePath, "utf8");
  const systemToken = "## System";
  const userToken = "## User";
  const systemIndex = content.indexOf(systemToken);
  const userIndex = content.indexOf(userToken);

  if (systemIndex < 0 || userIndex < 0 || userIndex <= systemIndex) {
    throw new Error(`Prompt missing System/User sections: ${fileName}`);
  }

  const system = content
    .slice(systemIndex + systemToken.length, userIndex)
    .trim();
  const user = content.slice(userIndex + userToken.length).trim();
  const result = { system, user };
  PROMPT_CACHE.set(fileName, result);
  return result;
};

const renderTemplate = (
  template: string,
  values: Record<string, string>
): string => {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match
  );
};

const isLlmEnabled = (config: AppConfig): boolean =>
  config.llmProvider === "openai_compat" &&
  Boolean(config.llmApiKey) &&
  Boolean(config.llmModel);

const resolveCanonicalUrl = (rawUrl: string): string => {
  try {
    return normalizeUrl(rawUrl);
  } catch {
    return rawUrl;
  }
};

const getGithubRawUrl = (rawUrl: string): string | null => {
  try {
    const url = new URL(rawUrl);
    if (url.hostname !== "github.com") return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 5) return null;
    if (parts[2] !== "blob") return null;
    const [owner, repo, , branch, ...rest] = parts;
    if (!owner || !repo || !branch || rest.length === 0) return null;
    return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${rest.join(
      "/"
    )}`;
  } catch {
    return null;
  }
};

const fetchRawText = async (
  url: string,
  options?: { timeoutMs?: number; maxLength?: number }
): Promise<string | null> => {
  const timeoutMs = options?.timeoutMs ?? 12000;
  const maxLength = options?.maxLength;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "ArkCore/0.1 (+https://example.invalid)",
        Accept: "text/plain,text/markdown,*/*;q=0.8",
      },
      redirect: "follow",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const text = await response.text();
    if (!text) return null;
    if (!maxLength || maxLength <= 0) return text;
    return truncate(text, maxLength);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
};

export const generateDeepDive = async (
  config: AppConfig,
  rawUrl: string,
  guildId?: string
): Promise<DeepDiveResult> => {
  const canonicalUrl = resolveCanonicalUrl(rawUrl);
  const item = await prisma.item.findFirst({
    where: { url: canonicalUrl },
    include: { source: { select: { name: true } } },
  });

  if (!item) {
    return {
      status: "missing",
      content: "未找到对应的条目，无法生成深度解读。",
    };
  }

  if (typeof item.deepDive === "string" && item.deepDive.trim()) {
    return { status: "success", content: item.deepDive, itemId: item.id };
  }

  const githubRawUrl = getGithubRawUrl(item.url);
  const maxChars =
    config.deeperFulltextMaxChars > 0 ? config.deeperFulltextMaxChars : undefined;
  let fetched =
    (githubRawUrl
      ? await fetchRawText(githubRawUrl, {
          timeoutMs: config.articleFetchTimeoutMs, // E-04: Use config value
          maxLength: maxChars,
        })
      : null) ?? "";
  if (!fetched) {
    fetched =
      (await fetchArticleText(item.url, {
        timeoutMs: config.articleFetchTimeoutMs, // E-04: Use config value
        maxLength: maxChars ?? config.articleFetchMaxLength, // E-04: Use config value
      })) ?? "";
  }
  const snippet = item.contentSnippet ?? "";
  const content = collapseWhitespace(stripHtml(fetched || snippet || ""));
  const now = new Date();

  if (content.length < config.minContentCharsForLlm) {
    await prisma.item.update({
      where: { id: item.id },
      data: {
        deepDive: CONTENT_INSUFFICIENT_NOTICE,
        deepDiveAt: now,
        deepDiveErrorReason: "content-insufficient",
      },
    });
    return {
      status: "insufficient",
      content: CONTENT_INSUFFICIENT_NOTICE,
      itemId: item.id,
    };
  }

  if (!isLlmEnabled(config) || !guildId) {
    const reason = !guildId ? "No guild context for LLM quota." : "LLM disabled or missing config.";
    await prisma.item.update({
      where: { id: item.id },
      data: { deepDiveErrorReason: reason },
    });
    return { status: "failed", content: reason, itemId: item.id };
  }

  try {
    const prompt = await loadPromptSections(PROMPT_FILE);
    const userPrompt = renderTemplate(prompt.user, {
      title: item.title,
      url: item.url,
      sourceName: item.source.name,
      publishedAt: item.publishedAt?.toISOString() ?? "",
      contentText:
        maxChars && maxChars > 0 ? truncate(content, maxChars) : content,
    });
    const response = await callLlmWithQuota({
      guildId,
      system: prompt.system,
      messages: [
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      maxTokens: config.llmMaxTokens,
    });
    const deepDive = response.content.trim();
    const llmInsufficient = deepDive.includes(LLM_INSUFFICIENT_NOTICE);
    const errorReason = llmInsufficient
      ? "llm-insufficient"
      : deepDive
        ? null
        : "empty-response";

    await prisma.item.update({
      where: { id: item.id },
      data: {
        deepDive: deepDive || null,
        deepDiveAt: now,
        deepDiveErrorReason: errorReason,
      },
    });

    return {
      status: llmInsufficient ? "insufficient" : deepDive ? "success" : "failed",
      content: deepDive || "LLM response was empty.",
      itemId: item.id,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Deep dive failed.";
    await prisma.item.update({
      where: { id: item.id },
      data: { deepDiveErrorReason: reason },
    });
    return { status: "failed", content: reason, itemId: item.id };
  }
};
