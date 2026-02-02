import {
  Client,
  Message,
  AttachmentBuilder,
  type ThreadChannel,
} from "discord.js";
import { prisma, type DiarySession } from "../db.js";
import type { AppConfig } from "../config.js";
import { logger } from "../observability/logger.js";
import { generateDiaryResponse, generateOpeningMessage, generateFarewellMessage } from "./llm.js";
import { exportDiary, createAttachmentBuffer } from "./export.js";
import { formatDiaryDate } from "./context.js";
import type { DiaryMessage, DiaryStartResult, DiaryEndResult } from "./types.js";
import { createForumPost } from "../messaging.js";
import { getConfigByRole } from "../channel-config.js";
import { buildDiaryStartButton } from "./buttons.js";

// In-memory cache for active session message history
const sessionMessages = new Map<string, DiaryMessage[]>();

/**
 * Create a daily diary forum post with start button
 * This creates a forum thread that waits for user interaction to start
 */
export const createDailyDiaryPost = async (
  config: AppConfig,
  client: Client,
  guildId: string
): Promise<{ threadId: string } | null> => {
  try {
    const diaryConfig = await getConfigByRole(guildId, "diary");
    if (!diaryConfig?.channelId) {
      logger.warn("Diary forum not configured");
      return null;
    }

    const now = new Date();
    const dateStr = formatDiaryDate(now, config.tz);
    const threadName = `📔 Diary · ${dateStr}`;

    const { thread, threadId } = await createForumPost(client, diaryConfig.channelId, {
      title: threadName,
      content: "今天的日记还没开始，点击下方按钮开始记录。",
      tags: [],
    });

    // Send start button
    await thread.send({
      components: [buildDiaryStartButton()],
    });

    logger.info(
      { threadId, guildId, date: dateStr },
      "Daily diary forum post created"
    );

    return { threadId };
  } catch (error) {
    logger.error({ error, guildId }, "Failed to create daily diary post");
    return null;
  }
};

/**
 * Start a diary session in an existing thread (for forum post workflow)
 * @param userId - Discord user ID who is starting the session (D-04: for concurrency limit)
 */
export const startDiarySessionInThread = async (
  config: AppConfig,
  client: Client,
  guildId: string,
  threadId: string,
  userId: string
): Promise<DiaryStartResult> => {
  const now = new Date();

  // Check for existing session in this thread
  const existingSession = await prisma.diarySession.findUnique({
    where: { threadId },
  });

  if (existingSession && !existingSession.endedAt) {
    throw new Error("A diary session is already active in this thread");
  }

  // Get the thread channel to find the parent (for channelId reference)
  const thread = await client.channels.fetch(threadId);
  if (!thread || !("parentId" in thread) || !thread.parentId) {
    throw new Error("Invalid thread channel");
  }

  const channelId = thread.parentId;

  // D-04: Check if user already has an active session in this guild
  const userActiveSession = await prisma.diarySession.findFirst({
    where: {
      guildId,
      userId,
      endedAt: null,
    },
  });

  if (userActiveSession) {
    throw new Error(
      `You already have an active diary session in thread <#${userActiveSession.threadId}>. Please end that session first.`
    );
  }

  // Generate opening message
  const openingMessage = await generateOpeningMessage(config, guildId);

  // Set up today's date for session
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  // Create session in database
  const session = await prisma.diarySession.create({
    data: {
      guildId,
      userId, // D-04: Store user ID for concurrency checking
      date: todayStart,
      threadId,
      channelId,
      messageCount: 1,
    },
  });

  // Initialize message cache
  sessionMessages.set(session.id, [
    {
      role: "bot",
      content: openingMessage,
      timestamp: new Date(),
    },
  ]);

  logger.info(
    { sessionId: session.id, threadId },
    "Diary session started in existing thread"
  );

  return {
    session,
    threadId,
    openingMessage,
  };
};

/**
 * Handle incoming message in diary thread
 */
export const handleDiaryMessage = async (
  config: AppConfig,
  guildId: string,
  message: Message
): Promise<void> => {
  // Find active session for this thread
  const session = await prisma.diarySession.findUnique({
    where: { threadId: message.channelId },
  });

  if (!session || session.endedAt) {
    return; // Not an active diary thread
  }

  // Get or initialize message cache
  let messages = sessionMessages.get(session.id);
  if (!messages) {
    messages = [];
    sessionMessages.set(session.id, messages);
  }

  // Add user message to cache
  messages.push({
    role: "user",
    content: message.content,
    timestamp: new Date(),
  });

  // Update message count
  await prisma.diarySession.update({
    where: { id: session.id },
    data: { messageCount: { increment: 1 } },
  });

  // Show typing indicator
  try {
    if ('sendTyping' in message.channel) {
      await message.channel.sendTyping();
    }
  } catch {
    // Ignore typing errors (e.g., missing permissions)
  }

  // Generate response
  try {
    const response = await generateDiaryResponse(config, guildId, messages);

    // Add bot response to cache
    messages.push({
      role: "bot",
      content: response,
      timestamp: new Date(),
    });

    // Update message count
    await prisma.diarySession.update({
      where: { id: session.id },
      data: { messageCount: { increment: 1 } },
    });

    // Send response
    if ("send" in message.channel) {
      await message.channel.send(response);
    }
  } catch (error) {
    logger.error({ error, sessionId: session.id }, "Failed to generate diary response");
    if ("send" in message.channel) {
      await message.channel.send(
        "Sorry, I'm having trouble thinking of what to say. Feel free to keep sharing, and I'll try again!"
      );
    }
  }
};

/**
 * End a diary session
 */
export const endDiarySession = async (
  config: AppConfig,
  client: Client,
  guildId: string,
  sessionId: string,
  reason: string
): Promise<DiaryEndResult> => {
  const session = await prisma.diarySession.findUnique({
    where: { id: sessionId },
  });

  if (!session) {
    throw new Error("Session not found");
  }

  if (session.endedAt) {
    throw new Error("Session already ended");
  }

  const messages = sessionMessages.get(session.id) || [];
  const now = new Date();

  // Generate farewell message
  const farewell = await generateFarewellMessage(config, guildId, messages);

  // Export diary
  const exportResult = await exportDiary(
    config,
    session.date,
    messages,
    session.startedAt,
    now
  );

  // Update session
  const updatedSession = await prisma.diarySession.update({
    where: { id: session.id },
    data: {
      endedAt: now,
      endReason: reason,
      exportPath: exportResult.localPath,
    },
  });

  // Send farewell and attachment to thread
  try {
    const thread = (await client.channels.fetch(session.threadId)) as ThreadChannel;
    if (thread) {
      await thread.send(farewell);

      // Send markdown as attachment
      const attachment = new AttachmentBuilder(
        createAttachmentBuffer(exportResult.markdownContent),
        { name: `diary-${formatDiaryDate(session.date, config.tz)}.md` }
      );
      await thread.send({
        content: "Here's your diary entry for today:",
        files: [attachment],
      });
    }
  } catch (error) {
    logger.error({ error, sessionId: session.id }, "Failed to send farewell message");
  }

  // Clear message cache
  sessionMessages.delete(session.id);

  logger.info(
    { sessionId: session.id, reason, messageCount: messages.length },
    "Diary session ended"
  );

  return {
    session: updatedSession,
    exportResult,
    messageCount: messages.length,
  };
};

/**
 * End session by thread ID
 */
export const endDiarySessionByThread = async (
  config: AppConfig,
  client: Client,
  guildId: string,
  threadId: string,
  reason: string
): Promise<DiaryEndResult> => {
  const session = await prisma.diarySession.findUnique({
    where: { threadId },
  });

  if (!session) {
    throw new Error("No active diary session in this thread");
  }

  return endDiarySession(config, client, guildId, session.id, reason);
};

/**
 * Get active diary session for channel
 */
export const getActiveDiarySession = async (
  channelId: string
): Promise<DiarySession | null> => {
  return prisma.diarySession.findFirst({
    where: {
      channelId,
      endedAt: null,
    },
  });
};

/**
 * Get session by thread ID
 */
export const getDiarySessionByThread = async (
  threadId: string
): Promise<DiarySession | null> => {
  return prisma.diarySession.findUnique({
    where: { threadId },
  });
};

/**
 * Check and end timed-out sessions
 * @param guildId - If provided, only check sessions for this guild (D-02 fix)
 */
export const checkTimeoutSessions = async (
  config: AppConfig,
  client: Client,
  guildId?: string
): Promise<number> => {
  const timeoutMs = config.diaryTimeoutMinutes * 60 * 1000;
  const cutoff = new Date(Date.now() - timeoutMs);

  const timedOutSessions = await prisma.diarySession.findMany({
    where: {
      endedAt: null,
      updatedAt: { lt: cutoff },
      // D-02: Filter by guildId when provided to avoid duplicate processing
      ...(guildId ? { guildId } : {}),
    },
  });

  let endedCount = 0;
  for (const session of timedOutSessions) {
    try {
      await endDiarySession(config, client, session.guildId, session.id, "timeout");
      endedCount++;
    } catch (error) {
      logger.error(
        { error, sessionId: session.id },
        "Failed to end timed-out session"
      );
    }
  }

  if (endedCount > 0) {
    logger.info({ endedCount, guildId: guildId || "all" }, "Ended timed-out diary sessions");
  }

  return endedCount;
};

/**
 * List recent diary sessions
 */
export const listRecentDiarySessions = async (
  limit: number = 10
): Promise<DiarySession[]> => {
  return prisma.diarySession.findMany({
    orderBy: { date: "desc" },
    take: limit,
  });
};
