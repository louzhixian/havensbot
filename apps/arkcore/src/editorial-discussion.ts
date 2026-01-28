import {
  ThreadAutoArchiveDuration,
  type Client,
  type Message,
  type ThreadChannel,
} from "discord.js";
import { AppConfig } from "./config.js";
import { getConfigByRole } from "./channel-config.js";
import { collapseWhitespace, stripHtml, truncate } from "./utils.js";
import { splitMessageContent } from "./messaging.js";
import { createLlmClient, type LlmClient } from "./llm/client.js";
import { loadPromptSections, renderTemplate } from "./utils/prompt-utils.js";

const THREAD_TITLE = "创作讨论";
const MAX_HISTORY = 20;
const MAX_MESSAGE_CHARS = 1200;
const PROMPT_FILE = "editorial.thread_assistant.prompt.md";

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
  // Create LLM client once for reuse
  const llmClient: LlmClient | null =
    config.llmProvider !== "none" && config.llmApiKey && config.llmModel
      ? createLlmClient(config)
      : null;

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

      if (!llmClient) {
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

      const llmResponse = await llmClient.call({
        operation: "editorial_discussion",
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
      });

      if (!llmResponse.success || !llmResponse.data) {
        throw new Error(llmResponse.error || "LLM response missing content");
      }

      const chunks = splitMessageContent(llmResponse.data.trim(), 1800);
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
