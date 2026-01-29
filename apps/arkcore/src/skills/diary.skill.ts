/**
 * Diary Skill - Daily diary conversation in forum threads
 *
 * Features:
 * - Daily forum post creation with start button
 * - Button-triggered diary sessions
 * - LLM-powered conversational responses
 * - Automatic session timeout handling
 * - Markdown export on session end
 *
 * TODO (D-03): 服务重启后恢复活跃会话
 * - 启动时检查数据库中的活跃会话 (status = 'active', endedAt = null)
 * - 对超过 1 天的未完成会话自动关闭
 * - 添加手动恢复指令 /diary recover
 * - 考虑在 onBotReady 生命周期钩子中实现会话恢复
 */

import { ChannelType, type Message, type ButtonInteraction } from "discord.js";
import type { GuildSettings } from "@prisma/client";
import type {
  Skill,
  SkillContext,
  MessageHandler,
  ButtonHandler,
  SkillCronJob,
} from "./types.js";
import { loadConfig } from "../config.js";
import { createLlmClient } from "../llm/client.js";
import { logger } from "../observability/logger.js";
import {
  getDiarySessionByThread,
  handleDiaryMessage,
  startDiarySessionInThread,
  endDiarySessionByThread,
  createDailyDiaryPost,
  checkTimeoutSessions,
} from "../diary/session.js";
import {
  DIARY_START_BUTTON_ID,
  DIARY_END_BUTTON_ID,
  buildDiaryEndButton,
  buildDisabledButton,
} from "../diary/buttons.js";

/**
 * Message handler for diary conversations in threads
 */
const diaryMessageHandler: MessageHandler = {
  channelRole: "diary",
  filter: (message: Message) => {
    // Ignore bot messages
    if (message.author.bot) return false;
    // Only handle messages in threads
    return (
      message.channel.type === ChannelType.PublicThread ||
      message.channel.type === ChannelType.PrivateThread
    );
  },
  execute: async (ctx, message, _settings) => {
    // Check if this is an active diary thread (by looking for session in database)
    const session = await getDiarySessionByThread(message.channelId);
    if (!session || session.endedAt) {
      return;
    }

    // TODO (D-01): 考虑在 SkillContext 中预创建 llmClient
    // 或添加 lazy 初始化的单例，避免重复创建
    const config = loadConfig();
    const llmClient = createLlmClient(config);

    // Handle the diary message
    try {
      await handleDiaryMessage(config, llmClient, message);
    } catch (error) {
      logger.error(
        { error, threadId: message.channelId },
        "Failed to handle diary message"
      );
    }
  },
};

/**
 * Button handler for starting diary session
 */
const diaryStartButtonHandler: ButtonHandler = {
  customIdPrefix: DIARY_START_BUTTON_ID,
  execute: async (ctx, interaction: ButtonInteraction, _settings) => {
    const { message, guild } = interaction;
    if (!guild) return;

    try {
      await interaction.deferReply();

      const threadId = message.channelId;

      // Check if session already exists for this thread
      const existingSession = await getDiarySessionByThread(threadId);
      if (existingSession && !existingSession.endedAt) {
        await interaction.editReply({
          content: "日记已经开始了，可以直接开始记录。",
        });
        return;
      }

      // TODO (D-01): 考虑在 SkillContext 中预创建 llmClient
      // 或添加 lazy 初始化的单例，避免重复创建
      const config = loadConfig();
      const llmClient = createLlmClient(config);

      // Start the session in this thread (D-04: pass userId for concurrency limit)
      const result = await startDiarySessionInThread(
        config,
        ctx.client,
        llmClient,
        threadId,
        interaction.user.id
      );

      // Disable the start button
      try {
        await message.edit({
          components: [buildDisabledButton("📝 已开始")],
        });
      } catch (editError) {
        logger.warn({ error: editError }, "Failed to update button state");
      }

      // Send opening message and end button
      await interaction.editReply({
        content: result.openingMessage,
        components: [buildDiaryEndButton()],
      });

      logger.info(
        { threadId, sessionId: result.session.id },
        "Diary session started via button"
      );
    } catch (error) {
      logger.error({ error }, "Failed to start diary session via button");
      try {
        await interaction.editReply({
          content: "无法开始日记，请稍后再试。",
        });
      } catch {
        // Interaction may have expired, ignore
      }
    }
  },
};

/**
 * Button handler for ending diary session
 */
const diaryEndButtonHandler: ButtonHandler = {
  customIdPrefix: DIARY_END_BUTTON_ID,
  execute: async (ctx, interaction: ButtonInteraction, _settings) => {
    const { message, guild } = interaction;
    if (!guild) return;

    try {
      await interaction.deferReply();

      const threadId = message.channelId;

      // TODO (D-01): 考虑在 SkillContext 中预创建 llmClient
      // 或添加 lazy 初始化的单例，避免重复创建
      const config = loadConfig();
      const llmClient = createLlmClient(config);

      // End the session
      const result = await endDiarySessionByThread(
        config,
        ctx.client,
        llmClient,
        threadId,
        "user_ended"
      );

      // Disable the end button
      try {
        await message.edit({
          components: [buildDisabledButton("✅ 已结束")],
        });
      } catch (editError) {
        logger.warn({ error: editError }, "Failed to update button state");
      }

      await interaction.editReply({
        content: `日记已结束，共记录 ${result.messageCount} 条消息。`,
      });

      logger.info(
        { threadId, messageCount: result.messageCount },
        "Diary session ended via button"
      );
    } catch (error) {
      logger.error({ error }, "Failed to end diary session via button");
      try {
        await interaction.editReply({
          content: "无法结束日记，请稍后再试。",
        });
      } catch {
        // Interaction may have expired, ignore
      }
    }
  },
};

/**
 * Cron job for creating daily diary post
 */
const dailyDiaryPostCron: SkillCronJob = {
  id: "diary_daily_post",
  defaultCron: "0 6 * * *", // 6:00 AM by default
  configKey: "diaryCron",
  execute: async (ctx, guildId, settings) => {
    const config = loadConfig();

    if (!config.diaryEnabled) {
      return;
    }

    try {
      const result = await createDailyDiaryPost(config, ctx.client, guildId);
      if (result) {
        logger.info({ guildId, threadId: result.threadId }, "Daily diary post created");
      }
    } catch (error) {
      logger.error({ error, guildId }, "Failed to create daily diary post");
    }
  },
};

/**
 * Cron job for checking timed-out sessions
 * D-02: Now passes guildId to checkTimeoutSessions to avoid duplicate processing
 * across multiple guilds (previously each guild triggered a global check)
 */
const diaryTimeoutCheckCron: SkillCronJob = {
  id: "diary_timeout_check",
  defaultCron: "*/5 * * * *", // Every 5 minutes
  configKey: "diaryTimeoutCron",
  execute: async (ctx, guildId, settings) => {
    const config = loadConfig();

    if (!config.diaryEnabled) {
      return;
    }

    // TODO (D-01): 考虑在 SkillContext 中预创建 llmClient
    // 或添加 lazy 初始化的单例，避免重复创建
    const llmClient = createLlmClient(config);

    try {
      // D-02: Only check sessions for this specific guild
      await checkTimeoutSessions(config, ctx.client, llmClient, guildId);
    } catch (error) {
      logger.error({ error, guildId }, "Diary timeout check failed");
    }
  },
};

export const diarySkill: Skill = {
  id: "diary",
  name: "Diary",
  description: "Daily diary conversations with LLM-powered responses",
  tier: "premium",

  messages: [diaryMessageHandler],
  buttons: [diaryStartButtonHandler, diaryEndButtonHandler],
  cron: [dailyDiaryPostCron, diaryTimeoutCheckCron],

  channelRoles: ["diary"],
};
