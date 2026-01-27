# Readings Feature Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 实现 🔖 bookmark reaction 触发的阅读收藏功能，使用 forum post + 标签管理已读/未读状态

**Architecture:** 监听 messageReactionAdd 事件，创建 forum post 复制消息内容，使用 forum 标签（unread/read）管理状态，按钮交互切换标签

**Tech Stack:** Discord.js, TypeScript, Forum Channel API

---

## Overview

Readings 是一个阅读收藏功能，用户可以在任意消息上添加 🔖 (`:bookmark:`) reaction，Bot 会自动将消息收藏到 readings forum channel，并提供"标为已读/未读"按钮来管理阅读状态。

## 触发方式

- 在 Discord 任意消息上添加 🔖 reaction
- Bot 监听 `messageReactionAdd` 事件

## 数据流

```
用户添加 🔖 reaction
    ↓
Bot 获取 readings forum channel（ChannelConfig role="readings"）
    ↓
创建 Forum Post:
  - 标题: embed.title || 消息前50字 || "[附件]"
  - 内容: 原消息 embeds/内容/附件
  - 附加: 原消息跳转链接
  - 标签: unread
  - 按钮: "标为已读"
    ↓
用户点击"标为已读"
    ↓
标签切换: unread → read
按钮切换: "标为已读" → "标为未读"
```

## Forum Post 结构

```
📌 [文章标题或消息内容前50字]     <- post 标题
标签: [unread]                    <- 初始标签

[复制的消息内容/embeds/附件]
───────────────────
📎 原消息: https://discord.com/channels/...  <- 跳转链接

[标为已读] 按钮
```

## 标题生成规则

| 消息类型 | 标题来源 |
|---------|---------|
| 带 embed | `embed.title` |
| 纯文本 | 消息前 50 字符 + `...` |
| 仅附件 | `[附件]` |

## 按钮交互

**按钮 ID 格式**: `readings_toggle_<postId>`

| 当前标签 | 按钮文字 | 点击后标签 | 点击后按钮 |
|---------|---------|-----------|-----------|
| unread  | 标为已读 | read      | 标为未读   |
| read    | 标为未读 | unread    | 标为已读   |

**标签切换实现**:
```typescript
const currentTags = thread.appliedTags;
const newTags = currentTags
  .filter(id => id !== unreadTagId && id !== readTagId)
  .concat(targetTagId);
await thread.setAppliedTags(newTags);
```

## 边界情况处理

| 情况 | 处理方式 |
|-----|---------|
| readings forum 未配置 | 静默忽略 🔖 reaction |
| unread/read 标签不存在 | 创建 post 但不打标签，按钮仍可用 |
| 消息无内容（纯附件） | 标题显示 "[附件]"，复制附件 |
| 消息已被 bookmark 过 | 内存 Map 检查，静默忽略 |
| Bot 重启后 Map 丢失 | 允许重复创建（可接受，用户可手动删除） |

## 文件结构

```
apps/arkcore/src/
├── readings.ts              # Reaction handler + forum post 创建
└── readings/
    └── buttons.ts           # 按钮交互处理
```

## 所需配置

- ChannelConfig: `role="readings"` 指向 readings forum channel

## Discord 准备工作

1. 创建 readings forum channel
2. 在 forum 中创建 `unread` 和 `read` 两个标签
3. 运行 `/config set readings <forum-channel>`

## 不需要数据库

- 状态完全由 forum 标签承载
- 内存 Map 仅用于防止短期重复，丢失可接受

---

## Implementation Tasks

### Task 1: Create readings/buttons.ts - Button builders

**Files:**
- Create: `apps/arkcore/src/readings/buttons.ts`

**Step 1: Create the buttons module**

```typescript
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type MessageActionRowComponentBuilder,
} from "discord.js";

export const READINGS_TOGGLE_PREFIX = "readings_toggle_";

export const buildMarkAsReadButton = (): ActionRowBuilder<MessageActionRowComponentBuilder> => {
  const button = new ButtonBuilder()
    .setCustomId(`${READINGS_TOGGLE_PREFIX}read`)
    .setLabel("标为已读")
    .setStyle(ButtonStyle.Secondary);

  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(button);
};

export const buildMarkAsUnreadButton = (): ActionRowBuilder<MessageActionRowComponentBuilder> => {
  const button = new ButtonBuilder()
    .setCustomId(`${READINGS_TOGGLE_PREFIX}unread`)
    .setLabel("标为未读")
    .setStyle(ButtonStyle.Primary);

  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(button);
};
```

**Step 2: Commit**

```bash
git add apps/arkcore/src/readings/buttons.ts
git commit -m "feat(readings): add button builders for read/unread toggle"
```

---

### Task 2: Create readings.ts - Core reaction handler

**Files:**
- Create: `apps/arkcore/src/readings.ts`

**Step 1: Create the readings module with reaction handler**

```typescript
import type {
  Client,
  Message,
  MessageReaction,
  PartialMessageReaction,
  ForumChannel,
  AnyThreadChannel,
} from "discord.js";
import { ChannelType } from "discord.js";
import { getConfigByRole } from "./channel-config.js";
import { AppConfig } from "./config.js";
import { createForumPost } from "./messaging.js";
import { truncate } from "./utils.js";
import { buildMarkAsReadButton, READINGS_TOGGLE_PREFIX } from "./readings/buttons.js";
import { logger } from "./observability/logger.js";

const BOOKMARK_EMOJI = "🔖";
const MAX_BOOKMARK_CACHE = 1000;
const bookmarkedMessages = new Map<string, { threadId: string; createdAt: number }>();

const normalizeEmoji = (value: string | null): string => {
  if (!value) return "";
  return value.replace(/\uFE0F/g, "");
};

const wasBookmarked = (messageId: string): boolean =>
  bookmarkedMessages.has(messageId);

const markBookmarked = (messageId: string, threadId: string): void => {
  bookmarkedMessages.set(messageId, { threadId, createdAt: Date.now() });
  if (bookmarkedMessages.size <= MAX_BOOKMARK_CACHE) return;
  const oldest = bookmarkedMessages.keys().next().value;
  if (oldest) {
    bookmarkedMessages.delete(oldest);
  }
};

const ensureMessage = async (
  reaction: MessageReaction | PartialMessageReaction
): Promise<Message | null> => {
  const fullReaction = reaction.partial ? await reaction.fetch() : reaction;
  const message = fullReaction.message.partial
    ? await fullReaction.message.fetch()
    : fullReaction.message;
  return message ?? null;
};

const generatePostTitle = (message: Message): string => {
  // Priority 1: embed title
  const embedTitle = message.embeds[0]?.title;
  if (embedTitle) {
    return truncate(embedTitle, 90);
  }

  // Priority 2: message content (first 50 chars)
  if (message.content && message.content.trim()) {
    const firstLine = message.content.split("\n")[0];
    return truncate(firstLine, 50);
  }

  // Priority 3: attachments
  if (message.attachments.size > 0) {
    return "[附件]";
  }

  return "[无标题]";
};

const buildMessageLink = (message: Message): string => {
  return `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`;
};

export const registerReadingsReactionHandler = (
  client: Client,
  config: AppConfig
): void => {
  client.on("messageReactionAdd", async (reaction, user) => {
    try {
      if (user.bot) return;

      const emojiName = normalizeEmoji(reaction.emoji.name);
      if (emojiName !== BOOKMARK_EMOJI) return;

      const message = await ensureMessage(reaction);
      if (!message || !message.guild) return;

      const guildId = message.guild.id;

      // Get readings forum config
      let readingsConfig;
      try {
        readingsConfig = await getConfigByRole(guildId, "readings");
      } catch (error) {
        logger.error({ error }, "Failed to fetch readings config");
        return;
      }

      const readingsForumId = readingsConfig?.channelId;
      if (!readingsForumId) return;

      // Don't bookmark messages from the readings forum itself
      if (message.channelId === readingsForumId) return;

      // Check if already bookmarked (in memory)
      if (wasBookmarked(message.id)) return;

      // Generate post title
      const title = generatePostTitle(message);
      const messageLink = buildMessageLink(message);

      // Build content with original message link
      const linkFooter = `\n\n───────────────────\n📎 原消息: ${messageLink}`;

      // Create forum post
      const { thread } = await createForumPost(client, readingsForumId, {
        title,
        content: (message.content || "") + linkFooter,
        embeds: message.embeds.length > 0 ? [...message.embeds] : undefined,
        tags: ["unread"],
      });

      // Send attachments if any
      if (message.attachments.size > 0) {
        const files = message.attachments.map((a) => a.url);
        await thread.send({ files });
      }

      // Send the toggle button
      await thread.send({ components: [buildMarkAsReadButton()] });

      markBookmarked(message.id, thread.id);
      logger.info({ messageId: message.id, threadId: thread.id }, "Bookmark created");
    } catch (error) {
      logger.error({ error }, "readings reaction handler failed");
    }
  });
};

export const registerReadingsButtonHandler = (
  client: Client,
  config: AppConfig
): void => {
  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith(READINGS_TOGGLE_PREFIX)) return;

    try {
      await interaction.deferUpdate();

      const channel = interaction.channel;
      if (!channel || !("parent" in channel)) return;

      const parent = channel.parent;
      if (!parent || parent.type !== ChannelType.GuildForum) return;

      const forum = parent as ForumChannel;
      const thread = channel as AnyThreadChannel;

      // Find tag IDs
      const unreadTag = forum.availableTags.find(
        (t) => t.name.toLowerCase() === "unread"
      );
      const readTag = forum.availableTags.find(
        (t) => t.name.toLowerCase() === "read"
      );

      if (!unreadTag || !readTag) {
        logger.warn("unread or read tag not found in forum");
        return;
      }

      const currentTags = thread.appliedTags || [];
      const hasUnread = currentTags.includes(unreadTag.id);

      // Toggle: unread -> read, or read -> unread
      const newTags = currentTags
        .filter((id) => id !== unreadTag.id && id !== readTag.id)
        .concat(hasUnread ? readTag.id : unreadTag.id);

      await thread.setAppliedTags(newTags);

      // Update button
      const { buildMarkAsReadButton, buildMarkAsUnreadButton } = await import(
        "./readings/buttons.js"
      );
      const newButton = hasUnread
        ? buildMarkAsUnreadButton()
        : buildMarkAsReadButton();

      await interaction.editReply({ components: [newButton] });

      logger.info(
        { threadId: thread.id, newState: hasUnread ? "read" : "unread" },
        "Reading status toggled"
      );
    } catch (error) {
      logger.error({ error }, "readings button handler failed");
    }
  });
};
```

**Step 2: Commit**

```bash
git add apps/arkcore/src/readings.ts
git commit -m "feat(readings): add bookmark reaction handler and button toggle"
```

---

### Task 3: Register handlers in index.ts

**Files:**
- Modify: `apps/arkcore/src/index.ts`

**Step 1: Add import**

Add after line 12 (after diary import):
```typescript
import { registerReadingsReactionHandler, registerReadingsButtonHandler } from "./readings.js";
```

**Step 2: Register handlers**

Add after line 29 (after `registerDiaryButtonHandler`):
```typescript
registerReadingsReactionHandler(client, config);
registerReadingsButtonHandler(client, config);
```

**Step 3: Commit**

```bash
git add apps/arkcore/src/index.ts
git commit -m "feat(readings): register handlers in main entry"
```

---

### Task 4: Build and verify

**Step 1: Run build**

```bash
pnpm build
```

Expected: No TypeScript errors

**Step 2: Commit all changes**

```bash
git add -A
git commit -m "feat(readings): complete implementation" --allow-empty
```

---

### Task 5: Create PR

**Step 1: Create feature branch and push**

```bash
git checkout -b feat/readings
git push -u origin feat/readings
```

**Step 2: Create PR**

```bash
gh pr create --title "feat: add readings bookmark feature" --body "$(cat <<'EOF'
## Summary

- Add 🔖 bookmark reaction to save messages to readings forum
- Each bookmarked message becomes a forum post with unread/read tags
- Toggle button to switch between read/unread status
- Tag-based state management (no database needed)

## Files Changed

- `apps/arkcore/src/readings.ts` - Main reaction handler + button handler
- `apps/arkcore/src/readings/buttons.ts` - Button builders
- `apps/arkcore/src/index.ts` - Handler registration

## Test Plan

- [ ] Create readings forum channel in Discord
- [ ] Add `unread` and `read` tags to the forum
- [ ] Run `/config set readings <forum-channel>`
- [ ] Add 🔖 reaction to any message
- [ ] Verify forum post is created with unread tag
- [ ] Click "标为已读" button
- [ ] Verify tag switches to read and button changes to "标为未读"
- [ ] Click "标为未读" button
- [ ] Verify tag switches back to unread

## Review

@codex
EOF
)"
```

**Step 3: Address review feedback, then merge**
