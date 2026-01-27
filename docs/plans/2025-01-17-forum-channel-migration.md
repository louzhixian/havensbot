# Forum Channel Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate ArkCore from text channel + thread to Discord Forum Channels for better content discoverability and organization.

**Architecture:** Create abstraction layer in `messaging.ts` for forum post creation, update config to support forum channel IDs, then migrate each feature (digest, editorial, deep-dive, diary) to use the new forum abstraction.

**Tech Stack:** TypeScript, discord.js v14, Prisma, PostgreSQL

---

## Task 1: Add Forum Channel Configuration

**Files:**
- Modify: `apps/arkcore/src/config.ts:1-165`

**Step 1: Add forum channel ID types to AppConfig**

In `config.ts`, add these fields to the `AppConfig` type after line 50 (after `diaryExportPath`):

```typescript
  // Forum channels
  digestForumId?: string;
  editorialForumId?: string;
  deepDiveForumId?: string;
  diaryForumId?: string;
```

**Step 2: Add forum channel parsing to loadConfig**

In the `loadConfig` function return object, add after `diaryExportPath` (around line 162):

```typescript
    // Forum channels
    digestForumId: process.env.DIGEST_FORUM_ID || undefined,
    editorialForumId: process.env.EDITORIAL_FORUM_ID || undefined,
    deepDiveForumId: process.env.DEEP_DIVE_FORUM_ID || undefined,
    diaryForumId: process.env.DIARY_FORUM_ID || undefined,
```

**Step 3: Verify build passes**

Run: `npm run build`
Expected: Build succeeds with no errors

**Step 4: Commit**

```bash
git add apps/arkcore/src/config.ts
git commit -m "feat(config): add forum channel ID configuration

Support for Discord Forum channels:
- DIGEST_FORUM_ID
- EDITORIAL_FORUM_ID
- DEEP_DIVE_FORUM_ID
- DIARY_FORUM_ID"
```

---

## Task 2: Add Forum Post Creation Abstraction

**Files:**
- Modify: `apps/arkcore/src/messaging.ts:1-355`

**Step 1: Add ForumChannel import**

At line 1, update the import to include `ForumChannel` and `AnyThreadChannel`:

```typescript
import {
  Client,
  EmbedBuilder,
  GuildTextBasedChannel,
  ThreadAutoArchiveDuration,
  ForumChannel,
  ChannelType,
  type AnyThreadChannel,
} from "discord.js";
```

**Step 2: Add ForumPostOptions interface**

After line 11 (after imports), add:

```typescript
export type ForumPostOptions = {
  title: string;
  content: string;
  embeds?: EmbedBuilder[];
  tags?: string[];
};

export type ForumPostResult = {
  thread: AnyThreadChannel;
  threadId: string;
};
```

**Step 3: Add ensureForumChannel helper**

After `ensureTextChannel` function (around line 56), add:

```typescript
const ensureForumChannel = async (
  client: Client,
  channelId: string
): Promise<ForumChannel> => {
  const channel = await client.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildForum) {
    throw new Error("Channel is not a forum channel or not found");
  }
  return channel as ForumChannel;
};
```

**Step 4: Add resolveTagIds helper**

After `ensureForumChannel`, add:

```typescript
const resolveTagIds = (
  forum: ForumChannel,
  tagNames: string[]
): string[] => {
  const availableTags = forum.availableTags;
  const resolvedIds: string[] = [];

  for (const name of tagNames) {
    const tag = availableTags.find(
      (t) => t.name.toLowerCase() === name.toLowerCase()
    );
    if (tag) {
      resolvedIds.push(tag.id);
    }
  }

  return resolvedIds;
};
```

**Step 5: Add createForumPost function**

After `resolveTagIds`, add:

```typescript
export const createForumPost = async (
  client: Client,
  forumChannelId: string,
  options: ForumPostOptions
): Promise<ForumPostResult> => {
  const forum = await ensureForumChannel(client, forumChannelId);

  const appliedTags = options.tags
    ? resolveTagIds(forum, options.tags)
    : [];

  const thread = await retryDiscordCall(
    () => forum.threads.create({
      name: options.title,
      message: {
        content: options.content || undefined,
        embeds: options.embeds,
      },
      appliedTags: appliedTags.length > 0 ? appliedTags : undefined,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    }),
    "create_forum_post"
  );

  return {
    thread,
    threadId: thread.id,
  };
};
```

**Step 6: Verify build passes**

Run: `npm run build`
Expected: Build succeeds with no errors

**Step 7: Commit**

```bash
git add apps/arkcore/src/messaging.ts
git commit -m "feat(messaging): add forum post creation abstraction

- Add ForumPostOptions and ForumPostResult types
- Add ensureForumChannel helper
- Add resolveTagIds for tag name to ID mapping
- Add createForumPost function with retry logic"
```

---

## Task 3: Add Forum-based Digest Sending

**Files:**
- Modify: `apps/arkcore/src/messaging.ts`

**Step 1: Add sendDigestToForum function**

After `createForumPost` function, add:

```typescript
export const sendDigestToForum = async (
  client: Client,
  forumChannelId: string,
  digest: DigestData,
  config: AppConfig
): Promise<DigestThreadResult> => {
  const dateStr = formatDate(digest.windowEnd, config.tz);
  const title = `📰 Daily Digest - ${dateStr}`;

  // Determine tags based on content
  const tags: string[] = [];
  const dayOfWeek = digest.windowEnd.getDay();
  tags.push(dayOfWeek === 0 || dayOfWeek === 6 ? "weekend" : "weekday");

  if (digest.items.length < 5) {
    tags.push("light");
  } else if (digest.items.length > 20) {
    tags.push("heavy");
  } else {
    tags.push("normal");
  }

  const overviewEmbed = new EmbedBuilder()
    .setTitle(buildDigestTitle(digest.items.length))
    .setDescription(buildOverviewDescription(digest, config.tz))
    .setTimestamp(new Date());

  const { thread, threadId } = await createForumPost(client, forumChannelId, {
    title,
    content: "",
    embeds: [overviewEmbed],
    tags,
  });

  if (digest.items.length === 0) {
    return {
      threadId,
      threadName: title,
      failedItems: 0,
      totalItems: 0,
    };
  }

  const failed: DigestItem[] = [];

  for (const item of digest.items) {
    try {
      const embed = buildItemEmbed(item, config);
      await retryDiscordCall(
        () => thread.send({ embeds: [embed] }),
        "send_digest_item_forum"
      );
    } catch (error) {
      logger.warn(
        { error, itemTitle: item.title, itemUrl: item.url },
        "Failed to post digest item to forum"
      );
      failed.push(item);
    }
    await sleep(config.digestThreadThrottleMs);
  }

  if (failed.length > 0) {
    const names = failed
      .slice(0, 5)
      .map((item) => truncate(item.title, 80))
      .join(", ");
    const extra = failed.length - 5;
    await retryDiscordCall(
      () => thread.send({
        content: `Failed to post ${failed.length} items: ${names}${
          extra > 0 ? ` +${extra}` : ""
        }`,
      }),
      "send_digest_failure_summary_forum"
    );
  }

  return {
    threadId,
    threadName: title,
    failedItems: failed.length,
    totalItems: digest.items.length,
  };
};
```

**Step 2: Verify build passes**

Run: `npm run build`
Expected: Build succeeds with no errors

**Step 3: Commit**

```bash
git add apps/arkcore/src/messaging.ts
git commit -m "feat(messaging): add sendDigestToForum function

Creates digest as forum post with:
- Date-based title format
- Auto-tagging: weekday/weekend, light/normal/heavy
- Individual items as thread replies"
```

---

## Task 4: Update Scheduler to Use Forum for Digest

**Files:**
- Modify: `apps/arkcore/src/scheduler.ts:1-217`

**Step 1: Add sendDigestToForum import**

Update line 6-9 to include `sendDigestToForum`:

```typescript
import {
  sendDigestOverview,
  sendDigestThreaded,
  sendDigestToForum,
} from "./messaging.js";
```

**Step 2: Update digest cron job to check for forum**

Replace lines 90-94 (the digest sending logic) with:

```typescript
            if (config.digestForumId) {
              await sendDigestToForum(client, config.digestForumId, digest, config);
            } else if (config.digestThreadMode) {
              await sendDigestThreaded(client, channel.channelId, digest, config);
            } else {
              await sendDigestOverview(client, channel.channelId, digest, config);
            }
```

**Step 3: Verify build passes**

Run: `npm run build`
Expected: Build succeeds with no errors

**Step 4: Commit**

```bash
git add apps/arkcore/src/scheduler.ts
git commit -m "feat(scheduler): use forum channel for digest when configured

Digest now posts to forum channel if DIGEST_FORUM_ID is set,
falls back to existing thread/overview mode otherwise."
```

---

## Task 5: Add Forum Support for Editorial Discussion

**Files:**
- Modify: `apps/arkcore/src/editorial-discussion.ts:1-255`

**Step 1: Add imports**

Update imports at line 1-8:

```typescript
import { readFile } from "fs/promises";
import path from "path";
import {
  ThreadAutoArchiveDuration,
  ChannelType,
  type Client,
  type Message,
  type ThreadChannel,
  type ForumChannel,
} from "discord.js";
import { AppConfig } from "./config.js";
import { buildOpenAiCompatUrl, collapseWhitespace, stripHtml, truncate } from "./utils.js";
import { splitMessageContent, createForumPost } from "./messaging.js";
```

**Step 2: Add createEditorialForumPost helper**

After `isForwardedMessage` function (around line 108), add:

```typescript
const createEditorialForumPost = async (
  client: Client,
  forumChannelId: string,
  sourceContent: string
): Promise<ThreadChannel> => {
  // Generate title from source content (first 50 chars or "创作讨论")
  const titlePreview = sourceContent.slice(0, 50).replace(/\n/g, " ").trim();
  const title = `✍️ ${titlePreview || "创作讨论"}`;

  const { thread } = await createForumPost(client, forumChannelId, {
    title,
    content: "已创建创作讨论，请在此给出写作需求或方向。",
    tags: ["drafting"],
  });

  return thread as ThreadChannel;
};
```

**Step 3: Add isEditorialForumThread helper**

After `createEditorialForumPost`, add:

```typescript
const isEditorialForumThread = async (
  client: Client,
  thread: ThreadChannel,
  editorialForumId: string
): Promise<boolean> => {
  if (!thread.parentId) return false;
  if (thread.parentId !== editorialForumId) return false;

  // Verify parent is a forum channel
  try {
    const parent = await client.channels.fetch(thread.parentId);
    return parent?.type === ChannelType.GuildForum;
  } catch {
    return false;
  }
};
```

**Step 4: Update registerEditorialDiscussionHandlers**

Replace the function starting at line 187 with:

```typescript
export const registerEditorialDiscussionHandlers = (
  client: Client,
  config: AppConfig
): void => {
  const editorialChannelId = config.editorialChannelId;
  const editorialForumId = config.editorialForumId;

  // If neither is configured, skip registration
  if (!editorialChannelId && !editorialForumId) return;

  client.on("messageCreate", async (message) => {
    try {
      if (message.author.bot) return;

      // Handle forum mode: forward in editorial channel creates forum post
      if (editorialForumId && message.channelId === editorialChannelId && !message.channel.isThread()) {
        if (!isForwardedMessage(message)) return;
        if (hasThread(message)) return;

        const sourceContent = buildSourceMessage(message);
        const thread = await createEditorialForumPost(client, editorialForumId, sourceContent);

        // Store reference to original message in first reply
        await thread.send({
          content: `原始内容:\n${truncate(sourceContent, 1000)}`,
        });
        return;
      }

      // Handle legacy text channel mode
      if (editorialChannelId && message.channelId === editorialChannelId && !message.channel.isThread()) {
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

      // Check if it's an editorial thread (forum or legacy)
      const isForumThread = editorialForumId
        ? await isEditorialForumThread(client, thread, editorialForumId)
        : false;
      const isLegacyThread = editorialChannelId
        ? isEditorialThread(thread, editorialChannelId)
        : false;

      if (!isForumThread && !isLegacyThread) return;

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
```

**Step 5: Verify build passes**

Run: `npm run build`
Expected: Build succeeds with no errors

**Step 6: Commit**

```bash
git add apps/arkcore/src/editorial-discussion.ts
git commit -m "feat(editorial): add forum channel support

- Forward in editorial channel creates forum post when EDITORIAL_FORUM_ID set
- Auto-generates title from source content
- Tags posts with 'drafting' status
- Maintains backward compatibility with text channel mode"
```

---

## Task 6: Add Forum Support for Diary

**Files:**
- Modify: `apps/arkcore/src/diary/session.ts:1-356`

**Step 1: Update imports**

Update imports at lines 1-9:

```typescript
import {
  Client,
  Message,
  ThreadAutoArchiveDuration,
  AttachmentBuilder,
  ChannelType,
  type TextChannel,
  type ThreadChannel,
  type ForumChannel,
} from "discord.js";
```

**Step 2: Add createDiaryForumPost helper**

After imports (around line 18), add:

```typescript
import { createForumPost } from "../messaging.js";

const createDiaryThread = async (
  config: AppConfig,
  client: Client,
  dateStr: string,
  openingMessage: string
): Promise<ThreadChannel> => {
  const threadName = `📔 Diary · ${dateStr}`;

  // Use forum if configured
  if (config.diaryForumId) {
    const { thread } = await createForumPost(client, config.diaryForumId, {
      title: threadName,
      content: openingMessage,
      tags: ["freeform"],
    });
    return thread as ThreadChannel;
  }

  // Fall back to text channel
  if (!config.diaryChannelId) {
    throw new Error("Neither diary forum nor channel configured");
  }

  const channel = await client.channels.fetch(config.diaryChannelId);
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error("Invalid diary channel - must be a text channel");
  }

  const textChannel = channel as TextChannel;
  const thread = await textChannel.threads.create({
    name: threadName,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    reason: "Daily diary session",
  });

  await thread.send(openingMessage);
  return thread;
};
```

**Step 3: Update startDiarySession to use helper**

Replace the thread creation logic in `startDiarySession` (lines 34-86) with:

```typescript
export const startDiarySession = async (
  config: AppConfig,
  client: Client,
  llmClient: LlmClient
): Promise<DiaryStartResult> => {
  if (!config.diaryChannelId && !config.diaryForumId) {
    throw new Error("Diary channel or forum not configured");
  }

  const now = new Date();
  const dateStr = formatDiaryDate(now, config.tz);

  // Check for existing session today
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(todayStart);
  todayEnd.setDate(todayEnd.getDate() + 1);

  const channelId = config.diaryForumId || config.diaryChannelId!;

  const existingSession = await prisma.diarySession.findFirst({
    where: {
      channelId,
      date: {
        gte: todayStart,
        lt: todayEnd,
      },
      endedAt: null,
    },
  });

  if (existingSession) {
    throw new Error("A diary session is already active today");
  }

  // Generate opening message
  const openingMessage = await generateOpeningMessage(config, llmClient);

  // Create thread (forum or text channel)
  const thread = await createDiaryThread(config, client, dateStr, openingMessage);

  // Create session in database
  const session = await prisma.diarySession.create({
    data: {
      date: todayStart,
      threadId: thread.id,
      channelId,
      messageCount: 1,
    },
  });

  // Initialize message cache (opening message already sent by createDiaryThread)
  sessionMessages.set(session.id, [
    {
      role: "bot",
      content: openingMessage,
      timestamp: new Date(),
    },
  ]);

  logger.info(
    { sessionId: session.id, threadId: thread.id },
    "Diary session started"
  );

  return {
    session,
    threadId: thread.id,
    openingMessage,
  };
};
```

**Step 4: Verify build passes**

Run: `npm run build`
Expected: Build succeeds with no errors

**Step 5: Commit**

```bash
git add apps/arkcore/src/diary/session.ts
git commit -m "feat(diary): add forum channel support

- Use DIARY_FORUM_ID when configured
- Create forum posts with 'freeform' tag
- Fall back to text channel if forum not set
- Update session channelId to use forum when available"
```

---

## Task 7: Add Deep-Dive Forum Integration

**Files:**
- Create: `apps/arkcore/src/deep-dive-forum.ts`
- Modify: `apps/arkcore/src/commands.ts` (if deep-dive has slash command)

**Step 1: Create deep-dive forum helper**

Create new file `apps/arkcore/src/deep-dive-forum.ts`:

```typescript
import { Client, EmbedBuilder, type ThreadChannel } from "discord.js";
import { AppConfig } from "./config.js";
import { createForumPost } from "./messaging.js";
import { truncate } from "./utils.js";

export type DeepDiveForumResult = {
  thread: ThreadChannel;
  threadId: string;
};

export const createDeepDiveForumPost = async (
  client: Client,
  config: AppConfig,
  title: string,
  url: string,
  content: string,
  sourceName?: string
): Promise<DeepDiveForumResult | null> => {
  if (!config.deepDiveForumId) {
    return null;
  }

  const postTitle = `🔍 ${truncate(title, 90)}`;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setURL(url)
    .setDescription(truncate(content, 4000))
    .setTimestamp(new Date());

  if (sourceName) {
    embed.setFooter({ text: sourceName });
  }

  const tags: string[] = ["completed"];

  const { thread, threadId } = await createForumPost(client, config.deepDiveForumId, {
    title: postTitle,
    content: "",
    embeds: [embed],
    tags,
  });

  return {
    thread: thread as ThreadChannel,
    threadId,
  };
};
```

**Step 2: Verify build passes**

Run: `npm run build`
Expected: Build succeeds with no errors

**Step 3: Commit**

```bash
git add apps/arkcore/src/deep-dive-forum.ts
git commit -m "feat(deep-dive): add forum post creation helper

Creates deep-dive analysis as forum post with:
- Title prefixed with magnifying glass emoji
- Content in embed format
- Tagged as 'completed'"
```

---

## Task 8: Update .env.example

**Files:**
- Modify: `.env.example` (if exists) or create documentation

**Step 1: Check if .env.example exists**

Run: `ls -la .env.example 2>/dev/null || echo "not found"`

**Step 2: Add forum configuration documentation**

If `.env.example` exists, add:

```bash
# Forum Channels (optional - enables forum mode for each feature)
# DIGEST_FORUM_ID=
# EDITORIAL_FORUM_ID=
# DEEP_DIVE_FORUM_ID=
# DIARY_FORUM_ID=
```

**Step 3: Commit**

```bash
git add .env.example 2>/dev/null || true
git commit -m "docs: add forum channel configuration to env example" --allow-empty
```

---

## Task 9: Update Design Document with Implementation Notes

**Files:**
- Modify: `docs/plans/2025-01-17-forum-channel-migration-design.md`

**Step 1: Add implementation notes section**

Append to the design document:

```markdown

---

## Implementation Notes

### Completed Changes

1. **config.ts**: Added `digestForumId`, `editorialForumId`, `deepDiveForumId`, `diaryForumId`
2. **messaging.ts**: Added `createForumPost`, `sendDigestToForum` functions
3. **scheduler.ts**: Updated digest job to use forum when configured
4. **editorial-discussion.ts**: Added forum support with backward compatibility
5. **diary/session.ts**: Added forum support with fallback to text channel
6. **deep-dive-forum.ts**: New helper for creating deep-dive forum posts

### Migration Checklist

- [ ] Create forum channels in Discord server
- [ ] Configure tags on each forum:
  - digest-forum: `weekday`, `weekend`, `light`, `normal`, `heavy`
  - editorial-forum: `drafting`, `reviewing`, `published`, `archived`
  - deep-dive-forum: `analyzing`, `completed`
  - diary-forum: `reflection`, `planning`, `freeform`
- [ ] Set environment variables for forum channel IDs
- [ ] Test each feature with forum enabled
- [ ] Archive old text channels
```

**Step 2: Commit**

```bash
git add docs/plans/2025-01-17-forum-channel-migration-design.md
git commit -m "docs: add implementation notes to forum migration design"
```

---

## Task 10: Final Verification

**Step 1: Run full build**

Run: `npm run build`
Expected: Build succeeds with no errors

**Step 2: Check for TypeScript errors**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Verify git status**

Run: `git log --oneline -10`
Expected: See all commits from this implementation

**Step 4: Summary**

The forum channel migration is complete. To activate:

1. Create forum channels in Discord
2. Set up tags on each forum
3. Add `*_FORUM_ID` environment variables
4. Deploy and verify

Old text channel behavior is preserved as fallback when forum IDs are not configured.
