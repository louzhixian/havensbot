import {
  ThreadAutoArchiveDuration,
  type Client,
  type Message,
} from "discord.js";
import { AppConfig } from "./config.js";
import { getConfigByRole } from "./channel-config.js";
import {
  collapseWhitespace,
  fetchArticleText,
  stripHtml,
  truncate,
} from "./utils.js";
import { splitMessageContent } from "./messaging.js";
import { createLlmClient, type LlmClient } from "./llm/client.js";
import { loadPromptSections, renderTemplate } from "./utils/prompt-utils.js";

const THREAD_TITLE = "翻译";
const TRANSLATION_CHUNK_CHARS = 3000;
const MIN_FETCHED_CHARS = 120;
const MAX_ATTACHMENT_CHARS = 60000;
const PROMPT_FILE = "editorial.translation.prompt.md";

const hasThread = (message: Message): boolean => {
  return "hasThread" in message ? Boolean(message.hasThread) : false;
};

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

const isTextAttachment = (name: string | null, contentType: string | null): boolean => {
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
): Promise<
  | { content: string; sourceUrl?: string; insufficient?: boolean }
  | null
> => {
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
      return { content: cleaned, sourceUrl: url ?? undefined, insufficient: true };
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
        const slice = paragraph.slice(offset, offset + TRANSLATION_CHUNK_CHARS);
        chunks.push(slice.trim());
        offset += TRANSLATION_CHUNK_CHARS;
      }
    }
  }

  pushCurrent();
  return chunks;
};

export const registerEditorialTranslationHandlers = (
  client: Client,
  config: AppConfig
): void => {
  // Create LLM client once for reuse
  const llmClient: LlmClient | null =
    config.llmProvider !== "none" && config.llmApiKey && config.llmModel
      ? createLlmClient(config)
      : null;

  client.on("messageCreate", async (message) => {
    try {
      if (message.author.bot) return;
      if (message.channel.isThread()) return;

      // Get editorial channel from database config
      if (!message.guild) return;
      const editorialConfig = await getConfigByRole(message.guild.id, "editorial");
      const editorialChannelId = editorialConfig?.channelId;
      if (!editorialChannelId) return;

      if (message.channelId !== editorialChannelId) return;
      if (message.messageSnapshots.size > 0) return;
      if (hasThread(message)) return;

      const input = await resolveTranslationInput(message);
      if (!input) return;

      if (!llmClient) {
        await message.reply({
          content: "LLM 未启用或缺少配置，无法翻译。",
        });
        return;
      }

      const thread = await message.startThread({
        name: THREAD_TITLE,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      });

      const prompt = await loadPromptSections(PROMPT_FILE);
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

        const llmResponse = await llmClient.call({
          operation: "editorial_translation",
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.2,
        });

        if (!llmResponse.success || !llmResponse.data) {
          throw new Error(llmResponse.error || "LLM response missing content");
        }

        const outputChunks = splitMessageContent(llmResponse.data.trim(), 1800);
        for (const output of outputChunks) {
          await thread.send({ content: output });
        }
      }
    } catch (error) {
      console.error("editorial translation handler failed", error);
      if (message.channel.isThread()) {
        await message.channel.send({
          content: "翻译失败，请稍后重试或检查日志。",
        });
      } else {
        await message.reply({ content: "翻译失败，请稍后重试或检查日志。" });
      }
    }
  });
};
