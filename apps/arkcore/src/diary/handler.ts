import { Client, Message, ChannelType, type Interaction } from "discord.js";
import type { AppConfig } from "../config.js";
import { createLlmClient, LlmClient } from "../llm/client.js";
import {
  handleDiaryMessage,
  getDiarySessionByThread,
  startDiarySessionInThread,
  endDiarySessionByThread,
} from "./session.js";
import {
  DIARY_START_BUTTON_ID,
  DIARY_END_BUTTON_ID,
  buildDiaryEndButton,
  buildDisabledButton,
} from "./buttons.js";
import { logger } from "../observability/logger.js";
import { getConfigByRole } from "../channel-config.js";

/**
 * Register message handler for diary conversations
 * Handles messages in diary forum threads
 */
export const registerDiaryMessageHandler = (
  client: Client,
  config: AppConfig
): void => {
  if (!config.diaryEnabled) {
    return;
  }

  const llmClient = createLlmClient(config);

  client.on("messageCreate", async (message: Message) => {
    // Ignore bot messages
    if (message.author.bot) return;

    // Only handle messages in threads
    if (
      message.channel.type !== ChannelType.PublicThread &&
      message.channel.type !== ChannelType.PrivateThread
    ) {
      return;
    }

    // Check if this is an active diary thread (by looking for session in database)
    const session = await getDiarySessionByThread(message.channelId);
    if (!session || session.endedAt) {
      return;
    }

    // Handle the diary message
    try {
      await handleDiaryMessage(config, llmClient, message);
    } catch (error) {
      logger.error(
        { error, threadId: message.channelId },
        "Failed to handle diary message"
      );
    }
  });

  logger.info("Diary message handler registered");
};

/**
 * Register button interaction handler for diary start/end buttons
 */
export const registerDiaryButtonHandler = (
  client: Client,
  config: AppConfig
): void => {
  if (!config.diaryEnabled) {
    return;
  }

  const llmClient = createLlmClient(config);

  client.on("interactionCreate", async (interaction: Interaction) => {
    if (!interaction.isButton()) return;

    const { customId, message, guild } = interaction;
    if (!guild) return;

    // Handle start diary button
    if (customId === DIARY_START_BUTTON_ID) {
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

        // Start the session in this thread (D-04: pass userId for concurrency limit)
        const result = await startDiarySessionInThread(
          config,
          client,
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
    }

    // Handle end diary button
    if (customId === DIARY_END_BUTTON_ID) {
      try {
        await interaction.deferReply();

        const threadId = message.channelId;

        // End the session
        const result = await endDiarySessionByThread(
          config,
          client,
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
    }
  });

  logger.info("Diary button handler registered");
};
