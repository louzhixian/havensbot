/**
 * Editorial Skill - Discussion and Translation handlers
 *
 * Merged from:
 * - editorial-discussion.ts: Thread discussions for creative writing
 * - editorial-translation.ts: URL/text translation
 */

import { readFile } from "fs/promises";
import path from "path";
import {
  ThreadAutoArchiveDuration,
  type Message,
  type ThreadChannel,
} from "discord.js";
import type { GuildSettings } from "@prisma/client";
import type { Skill, SkillContext, MessageHandler } from "./types.js";
import { getConfigByRole } from "../channel-config.js";
import { loadConfig, type AppConfig } from "../config.js";
import { splitMessageContent } from "../messaging.js";
import {
  buildOpenAiCompatUrl,
  collapseWhitespace,
  fetchArticleText,
  stripHtml,
  truncate,
} from "../utils.js";

// ============================================================================
// Constants
// ============================================================================

const DISCUSSION_THREAD_TITLE = "创作讨论";
const TRANSLATION_THREAD_TITLE = "翻译";

const MAX_HISTORY = 20;
const MAX_MESSAGE_CHARS = 1200;
const TRANSLATION_CHUNK_CHARS = 3000;
const MIN_FETCHED_CHARS = 120;
const MAX_ATTACHMENT_CHARS = 60000;

const PROMPT_DIR = path.resolve(process.cwd(), "prompts");
const DISCUSSION_PROMPT_FILE = "editorial.thread_assistant.prompt.md";
const TRANSLATION_PROMPT_FILE = "editorial.translation.prompt.md";

// ============================================================================
// Prompt Loading (Shared)
// ============================================================================

const PROMPT_CACHE = new Map<string, { system: string; user: string }>();

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

// ============================================================================
// LLM Utilities (Shared)
// ============================================================================

const isLlmEnabled = (config: AppConfig): boolean =>
  config.llmProvider === "openai_compat" &&
  Boolean(config.llmApiKey) &&
  Boolean(config.llmModel);

const callOpenAiCompat = async (
  config: AppConfig,
  systemPrompt: string,
  userPrompt: string,
  temperature = 0.3
): Promise<string> => {
  if (!config.llmApiKey || !config.llmModel) {
    throw new Error("LLM missing API key or model");
  }

  const endpoint = buildOpenAiCompatUrl(config.llmBaseUrl);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.llmApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.llmModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature,
      max_tokens: config.llmMaxTokens,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`LLM request failed (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("LLM response missing content");
  }
  return content;
};

// ============================================================================
// Message Helpers (Shared)
// ============================================================================

const hasThread = (message: Message): boolean => {
  return "hasThread" in message ? Boolean(message.hasThread) : false;
};

const isForwardedMessage = (message: Message): boolean => {
  return message.messageSnapshots.size > 0;
};

// ============================================================================
// Discussion Helpers
// ============================================================================

const getSourceMessage = (message: Message): Message => {
  const snapshot = message.messageSnapshots.first();
  if (!snapshot) return message;
  return snapshot as unknown as Message;
};

const buildSourceMessage = (message: Message): string => {
  const source = getSourceMessage(message);
  const parts: string[] = [];
  const content = source.content?.trim();
  if (content) {
    parts.push(content);
  }

  for (const embed of source.embeds) {
    if (embed.title) parts.push(`Title: ${embed.title}`);
    if (embed.description) parts.push(`Description: ${embed.description}`);
    if (embed.url) parts.push(`URL: ${embed.url}`);
  }

  if (source.attachments.size > 0) {
    const attachments = Array.from(source.attachments.values())
      .map((attachment) => attachment.url)
      .join(" ");
    parts.push(`Attachments: ${attachments}`);
  }

  const raw = parts.join("\n");
  return truncate(collapseWhitespace(stripHtml(raw)), 4000);
};

const formatConversationLine = (
  message: Message,
  botId?: string
): string | null => {
  if (message.author.bot && botId && message.author.id !== botId) return null;
  if (!message.content && message.attachments.size === 0) return null;

  const role = message.author.bot
    ? "Assistant"
    : `User(${message.author.username})`;
  const parts: string[] = [];
  if (message.content?.trim()) {
    parts.push(message.content.trim());
  }
  if (message.attachments.size > 0) {
    const attachments = Array.from(message.attachments.values())
      .map((attachment) => attachment.url)
      .join(" ");
    parts.push(`Attachments: ${attachments}`);
  }
  const combined = parts.join("\n");
  if (!combined) return null;
  return `${role}: ${truncate(combined, MAX_MESSAGE_CHARS)}`;
};

const buildConversation = async (
  thread: ThreadChannel,
  botId?: string
): Promise<string> => {
  const messages = await thread.messages.fetch({ limit: MAX_HISTORY });
  const sorted = Array.from(messages.values()).sort(
    (a, b) => a.createdTimestamp - b.createdTimestamp
  );

  const lines: string[] = [];
  for (const message of sorted) {
    if (message.system) continue;
    if (message.author.bot && message.content.includes(DISCUSSION_THREAD_TITLE))
      continue;
    const line = formatConversationLine(message, botId);
    if (line) lines.push(line);
  }

  return lines.join("\n");
};

const isEditorialThread = (
  thread: ThreadChannel,
  editorialChannelId: string
): boolean => {
  if (!thread.parentId) return false;
  if (thread.parentId !== editorialChannelId) return false;
  return thread.name === DISCUSSION_THREAD_TITLE;
};

// ============================================================================
// Translation Helpers
// ============================================================================

const normalizeUrl = (raw: string): string => raw.replace(/[>\])}.,!?]+$/, "");

const extractUrlOnly = (content: string): string | null => {
  const trimmed = content.trim();
  const match = trimmed.match(/^<?(https?:\/\/\S+)>?$/);
  if (!match) return null;
  return normalizeUrl(match[1]);
};

const extractAnyUrl = (content: string): string | null => {
  const match = content.match(/https?:\/\/\S+/);
  if (!match) return null;
  return normalizeUrl(match[0]);
};

const isTextAttachment = (
  name: string | null,
  contentType: string | null
): boolean => {
  if (contentType && contentType.toLowerCase().startsWith("text/")) return true;
  if (!name) return false;
  return /\.(txt|md|markdown|rst|json|csv)$/i.test(name);
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

const fetchRawText = async (url: string): Promise<string | null> => {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "ArkCore/0.1 (+https://example.invalid)",
        Accept: "text/plain,text/markdown,*/*;q=0.8",
      },
      redirect: "follow",
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const text = await response.text();
    return text || null;
  } catch {
    return null;
  }
};

const fetchAttachmentText = async (url: string): Promise<string | null> => {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "ArkCore/0.1 (+https://example.invalid)",
        Accept: "text/plain,text/markdown,text/*;q=0.8,*/*;q=0.5",
      },
      redirect: "follow",
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const text = await response.text();
    const trimmed = text.trim();
    if (!trimmed) return null;
    return truncate(trimmed, MAX_ATTACHMENT_CHARS);
  } catch {
    return null;
  }
};

const resolveTranslationInput = async (
  message: Message
): Promise<{
  content: string;
  sourceUrl?: string;
  insufficient?: boolean;
} | null> => {
  const textAttachment = message.attachments.find((attachment) =>
    isTextAttachment(attachment.name ?? null, attachment.contentType ?? null)
  );
  if (textAttachment?.url) {
    const text = await fetchAttachmentText(textAttachment.url);
    if (text) {
      return { content: text };
    }
  }

  const content = message.content ?? "";
  const urlOnly = content ? extractUrlOnly(content) : null;
  const embedUrl =
    message.embeds.find((embed) => typeof embed.url === "string")?.url ?? null;
  const url = urlOnly || embedUrl || (content ? extractAnyUrl(content) : null);

  if (urlOnly || embedUrl) {
    const rawUrl = getGithubRawUrl(url ?? "");
    const fetched =
      (rawUrl ? await fetchRawText(rawUrl) : null) ||
      (url
        ? await fetchArticleText(url, {
            timeoutMs: 12000,
            maxLength: Number.MAX_SAFE_INTEGER,
          })
        : null);
    if (!fetched) return null;
    const cleaned = collapseWhitespace(stripHtml(fetched));
    if (cleaned.length < MIN_FETCHED_CHARS) {
      return {
        content: cleaned,
        sourceUrl: url ?? undefined,
        insufficient: true,
      };
    }
    return { content: cleaned, sourceUrl: url ?? undefined };
  }

  const trimmed = content.trim();
  if (!trimmed) return null;
  return { content: trimmed, sourceUrl: url ?? undefined };
};

const splitInputText = (content: string): string[] => {
  if (!content.trim()) return [];
  const paragraphs = content.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  const pushCurrent = () => {
    if (current.trim()) {
      chunks.push(current.trim());
    }
    current = "";
  };

  for (const paragraph of paragraphs) {
    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length <= TRANSLATION_CHUNK_CHARS) {
      current = next;
      continue;
    }
    if (current) {
      pushCurrent();
    }
    if (paragraph.length <= TRANSLATION_CHUNK_CHARS) {
      current = paragraph;
    } else {
      let offset = 0;
      while (offset < paragraph.length) {
        const slice = paragraph.slice(
          offset,
          offset + TRANSLATION_CHUNK_CHARS
        );
        chunks.push(slice.trim());
        offset += TRANSLATION_CHUNK_CHARS;
      }
    }
  }

  pushCurrent();
  return chunks;
};

// ============================================================================
// Message Handlers
// ============================================================================

/**
 * Handler for messages in the editorial channel (not threads).
 * - Forwarded messages → Create discussion thread
 * - Non-forwarded messages with URL/content → Create translation thread
 */
const editorialChannelHandler: MessageHandler = {
  channelRole: "editorial",
  filter: (message) => {
    // Skip bot messages
    if (message.author.bot) return false;
    // Skip thread messages (handled separately)
    if (message.channel.isThread()) return false;
    // Skip voice messages (handled by voice skill)
    if (message.attachments.some((a) => a.contentType?.startsWith("audio/")))
      return false;
    return true;
  },
  execute: async (ctx, message, _settings) => {
    const config = loadConfig();

    // Forwarded message → Discussion thread
    if (isForwardedMessage(message)) {
      if (hasThread(message)) return;

      const thread = await message.startThread({
        name: DISCUSSION_THREAD_TITLE,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      });
      await thread.send({
        content: "已创建创作讨论线程，请在此给出写作需求或方向。",
      });
      return;
    }

    // Non-forwarded message → Translation
    if (hasThread(message)) return;

    const input = await resolveTranslationInput(message);
    if (!input) return;

    if (!isLlmEnabled(config)) {
      await message.reply({
        content: "LLM 未启用或缺少配置，无法翻译。",
      });
      return;
    }

    const thread = await message.startThread({
      name: TRANSLATION_THREAD_TITLE,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    });

    const prompt = await loadPromptSections(TRANSLATION_PROMPT_FILE);
    const chunks = splitInputText(input.content);
    const total = chunks.length || 1;

    if (chunks.length === 0) {
      await thread.send({ content: "没有可翻译的内容。" });
      return;
    }

    if (input.insufficient) {
      await thread.send({
        content:
          "抓取到的原文内容过短，无法可靠翻译。请提供文章原站链接或直接粘贴正文。",
      });
      return;
    }

    await thread.send({ content: "正在翻译，请稍候..." });

    let index = 0;
    for (const chunk of chunks) {
      index += 1;
      const userPrompt = renderTemplate(prompt.user, {
        partIndex: String(index),
        totalParts: String(total),
        sourceUrl: input.sourceUrl ?? "",
        contentText: truncate(chunk, TRANSLATION_CHUNK_CHARS),
      });
      const response = await callOpenAiCompat(
        config,
        prompt.system,
        userPrompt,
        0.2
      );
      const outputChunks = splitMessageContent(response.trim(), 1800);
      for (const output of outputChunks) {
        await thread.send({ content: output });
      }
    }
  },
};

/**
 * Handler for messages in editorial discussion threads.
 * Responds to user messages with LLM-generated content.
 */
const editorialThreadHandler: MessageHandler = {
  // No channelRole - we check internally for thread parent
  filter: (message) => {
    // Skip bot messages
    if (message.author.bot) return false;
    // Must be in a thread
    if (!message.channel.isThread()) return false;
    // Must have content or attachments
    if (!message.content?.trim() && message.attachments.size === 0) return false;
    return true;
  },
  execute: async (ctx, message, _settings) => {
    if (!message.guild) return;
    if (!message.channel.isThread()) return;

    const thread = message.channel;

    // Get editorial channel config to verify this is an editorial thread
    const editorialConfig = await getConfigByRole(message.guild.id, "editorial");
    const editorialChannelId = editorialConfig?.channelId;
    if (!editorialChannelId) return;

    // Check if this is a discussion thread
    if (!isEditorialThread(thread, editorialChannelId)) return;

    const config = loadConfig();

    if (!isLlmEnabled(config)) {
      await thread.send({
        content: "LLM 未启用或缺少配置，无法生成内容。",
      });
      return;
    }

    const starter = await thread.fetchStarterMessage().catch(() => null);
    if (!starter) {
      await thread.send({ content: "无法获取原始消息，无法生成内容。" });
      return;
    }

    const prompt = await loadPromptSections(DISCUSSION_PROMPT_FILE);
    const sourceMessage = buildSourceMessage(starter);
    const conversation = await buildConversation(thread, ctx.client.user?.id);
    const userPrompt = renderTemplate(prompt.user, {
      sourceMessage,
      conversation: conversation || "User: (no additional instructions)",
    });

    await thread.send({ content: "正在生成内容，请稍候..." });
    const response = await callOpenAiCompat(
      config,
      prompt.system,
      userPrompt,
      0.3
    );
    const chunks = splitMessageContent(response.trim(), 1800);
    for (const chunk of chunks) {
      await thread.send({ content: chunk });
    }
  },
};

// ============================================================================
// Skill Export
// ============================================================================

export const editorialSkill: Skill = {
  id: "editorial",
  name: "Editorial",
  description: "Creative writing discussions and translation",
  tier: "free",

  messages: [editorialChannelHandler, editorialThreadHandler],

  channelRoles: ["editorial"],
};
