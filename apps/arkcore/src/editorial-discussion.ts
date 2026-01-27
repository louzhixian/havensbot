import { readFile } from "fs/promises";
import path from "path";
import {
  ThreadAutoArchiveDuration,
  type Client,
  type Message,
  type ThreadChannel,
} from "discord.js";
import { AppConfig } from "./config.js";
import { getConfigByRole } from "./channel-config.js";
import { buildOpenAiCompatUrl, collapseWhitespace, stripHtml, truncate } from "./utils.js";
import { splitMessageContent } from "./messaging.js";

const THREAD_TITLE = "创作讨论";
const MAX_HISTORY = 20;
const MAX_MESSAGE_CHARS = 1200;
const PROMPT_DIR = path.resolve(process.cwd(), "prompts");
const PROMPT_FILE = "editorial.thread_assistant.prompt.md";
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

const isLlmEnabled = (config: AppConfig): boolean =>
  config.llmProvider === "openai_compat" &&
  Boolean(config.llmApiKey) &&
  Boolean(config.llmModel);

const callOpenAiCompat = async (
  config: AppConfig,
  systemPrompt: string,
  userPrompt: string
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
      temperature: 0.3,
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

const hasThread = (message: Message): boolean => {
  return "hasThread" in message ? Boolean(message.hasThread) : false;
};

const isForwardedMessage = (message: Message): boolean => {
  return message.messageSnapshots.size > 0;
};

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

const formatConversationLine = (message: Message, botId?: string): string | null => {
  if (message.author.bot && botId && message.author.id !== botId) return null;
  if (!message.content && message.attachments.size === 0) return null;

  const role = message.author.bot ? "Assistant" : `User(${message.author.username})`;
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
    if (message.author.bot && message.content.includes(THREAD_TITLE)) continue;
    const line = formatConversationLine(message, botId);
    if (line) lines.push(line);
  }

  return lines.join("\n");
};

const isEditorialThread = (thread: ThreadChannel, editorialChannelId: string): boolean => {
  if (!thread.parentId) return false;
  if (thread.parentId !== editorialChannelId) return false;
  return thread.name === THREAD_TITLE;
};

export const registerEditorialDiscussionHandlers = (
  client: Client,
  config: AppConfig
): void => {
  client.on("messageCreate", async (message) => {
    try {
      if (message.author.bot) return;
      if (!message.guild) return;

      // 从数据库获取配置
      let editorialConfig;
      try {
        editorialConfig = await getConfigByRole(message.guild.id, "editorial");
      } catch (error) {
        console.error("Failed to fetch editorial config", error);
        // Continue - treat as if no config exists
      }
      const editorialChannelId = editorialConfig?.channelId;

      if (!editorialChannelId) return;

      // Handle text channel mode: forward creates thread
      if (message.channelId === editorialChannelId && !message.channel.isThread()) {
        if (!isForwardedMessage(message)) return;
        if (hasThread(message)) return;

        const thread = await message.startThread({
          name: THREAD_TITLE,
          autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
        });
        await thread.send({ content: "已创建创作讨论线程，请在此给出写作需求或方向。" });
        return;
      }

      // Handle messages in threads
      if (!message.channel.isThread()) return;
      const thread = message.channel;

      // Check if it's an editorial thread
      if (!isEditorialThread(thread, editorialChannelId)) return;

      if (!message.content?.trim() && message.attachments.size === 0) {
        return;
      }

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

      const prompt = await loadPromptSections(PROMPT_FILE);
      const sourceMessage = buildSourceMessage(starter);
      const conversation = await buildConversation(thread, client.user?.id);
      const userPrompt = renderTemplate(prompt.user, {
        sourceMessage,
        conversation: conversation || "User: (no additional instructions)",
      });

      await thread.send({ content: "正在生成内容，请稍候..." });
      const response = await callOpenAiCompat(config, prompt.system, userPrompt);
      const chunks = splitMessageContent(response.trim(), 1800);
      for (const chunk of chunks) {
        await thread.send({ content: chunk });
      }
    } catch (error) {
      console.error("editorial discussion handler failed", error);
      if (message.channel.isThread()) {
        await message.channel.send({
          content: "内容生成失败，请稍后重试或检查日志。",
        });
      }
    }
  });
};
