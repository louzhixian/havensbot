# Forum Channel Migration Design

## Overview

将 ArkCore 从 text channel + thread 模式迁移到 Discord Forum Channel，以改善内容可发现性、组织结构和用户互动体验。

## 背景与动机

### 现有痛点

- **内容难以查找**：thread 容易被埋没，找旧内容麻烦
- **组织结构不清晰**：不同类型的内容混在一起
- **用户互动不便**：缺少按主题筛选、标记、排序等功能

### 目标

- 利用 Forum Channel 的帖子列表视图提升内容可发现性
- 通过 tags 系统实现内容分类和筛选
- 保持各功能独立，便于管理和扩展

## 设计方案

### Forum 结构

采用「按功能直接映射」方案，创建 4 个独立的 forum channel：

| Forum | 用途 | 帖子标题格式 |
|-------|------|-------------|
| `digest-forum` | 每日 RSS 摘要 | `📰 Daily Digest - 2024-01-17` |
| `editorial-forum` | 写作讨论 | `✍️ {用户自定义或自动生成}` |
| `deep-dive-forum` | 深度分析 | `🔍 {原文标题}` |
| `diary-forum` | 交互式日记 | `📔 Diary - 2024-01-17` |

**Favorites 保留为普通 text channel**——收藏本质是简单转发，不需要 forum 的重量级功能。

### Tags 设计

#### digest-forum
- 按周期：`weekday`, `weekend`
- 按内容量级：`light`（<5条）, `normal`, `heavy`（>20条）

#### editorial-forum
- 按阶段：`drafting`, `reviewing`, `published`, `archived`
- 按类型：`blog`, `newsletter`, `social`, `other`

#### deep-dive-forum
- 按来源：`tech`, `news`, `research`
- 按状态：`analyzing`, `completed`

#### diary-forum
- 按主题：`reflection`, `planning`, `freeform`

## 架构变更

### 配置层 (`config.ts`)

```typescript
// 新增 forum 配置结构
forums: {
  digest: { channelId: string, tags?: Record<string, string> }
  editorial: { channelId: string, tags?: Record<string, string> }
  deepDive: { channelId: string, tags?: Record<string, string> }
  diary: { channelId: string, tags?: Record<string, string> }
}
```

### Discord API 使用

```typescript
// Forum Channel 创建帖子
const forumChannel = channel as ForumChannel
const thread = await forumChannel.threads.create({
  name: '帖子标题',
  message: { content: '帖子内容' },
  appliedTags: ['tag-id-1', 'tag-id-2']
})
```

### 抽象层 (`messaging.ts`)

```typescript
interface ForumPostOptions {
  forum: 'digest' | 'editorial' | 'deepDive' | 'diary'
  title: string
  content: string
  tags?: string[]  // tag 名称，内部解析为 ID
}

async function createForumPost(options: ForumPostOptions): Promise<ThreadChannel>
```

### 模块影响

| 模块 | 变更程度 | 说明 |
|------|----------|------|
| `messaging.ts` | 中 | 新增 forum post 创建函数 |
| `digest.ts` | 低 | 调用新的发送函数 |
| `editorial-discussion.ts` | 中 | 改为创建 forum post |
| `deeper.ts` | 中 | 改为创建 forum post |
| `diary/` | 中 | 改为创建 forum post |
| `favorites.ts` | 无 | 保持 text channel |

## 数据模型变更

### Prisma Schema 调整

```prisma
model Digest {
  // ...existing fields
  threadId    String?   // forum post thread ID
}

model EditorialReport {
  // ...existing fields
  threadId    String?   // forum post thread ID
}

model DiarySession {
  // ...existing fields
  threadId    String?   // forum post thread ID
}
```

### 迁移策略

- 采用「全新开始」策略：旧 channel 保留归档，新内容进 forum
- 旧数据保留原有字段值
- 新数据使用 forum thread ID
- 可通过日期区分新旧数据

## 用户体验变化

### 内容发现

- 帖子列表视图，一目了然
- 支持按 tag 筛选
- 支持排序：最新、最近活跃、创建时间
- 帖子可以被 pin 到顶部

### 互动方式

| 操作 | Text Channel | Forum Channel |
|------|--------------|---------------|
| 回复讨论 | 在 thread 里回复 | 在帖子里回复（相同） |
| Reaction | 对消息 react | 对帖子首条消息 react |
| 关注更新 | 手动 follow thread | 回复后自动 follow |
| 标记已读 | 无 | 帖子级别的已读状态 |

### 通知行为

- 新帖子创建：channel 默认通知设置生效
- 帖子回复：只通知 follow 了该帖子的人
- 用户可以单独 mute 某个帖子

## 实现计划

### Phase 1：基础设施

- 在 Discord 服务器创建 4 个 forum channel，配置 tags
- 扩展 `config.ts` 支持 forum 配置结构
- 在 `messaging.ts` 实现 `createForumPost` 抽象函数
- 单元测试验证 forum 创建逻辑

### Phase 2：Digest 迁移

- 修改 `digest.ts` 使用新的 forum 发送
- 更新 `Digest` 模型存储 `threadId`
- 验证 scheduler 正常触发
- 观察确认稳定性

### Phase 3：其余功能迁移

- `editorial-discussion.ts` → editorial-forum
- `deeper.ts` → deep-dive-forum
- `diary/` → diary-forum
- 各功能独立测试

### Phase 4：清理与文档

- 归档旧 text channel
- 更新用户文档
- 移除废弃配置项

## 风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| Forum API 权限不足 | 确认 bot 有 `SendMessages`、`CreatePublicThreads`、`ManageThreads` 权限 |
| Tag ID 硬编码易出错 | 启动时自动 fetch forum tags，按名称匹配 ID |
| Reaction 事件行为不同 | 在 Phase 2 期间测试 favorites 的 reaction 监听 |
| 回滚困难 | 保留旧 channel 配置，可快速切换回去 |

## 配置示例

```bash
# .env
DIGEST_FORUM_ID=123456789
EDITORIAL_FORUM_ID=123456790
DEEP_DIVE_FORUM_ID=123456791
DIARY_FORUM_ID=123456792
```

---

## Implementation Notes

### Design Decision: Forum Only for Digest and Deep-Dive

After evaluation, **only Digest and Deep-Dive use forum channels**. Editorial and Diary remain on text channels because:
- Editorial requires heavy interaction (translate, voice transcription, commands)
- Diary requires command triggers and interactive sessions
- Forum channels are display-only and don't support these interactive workflows

### Completed Changes

1. **config.ts**: Added `digestForumId`, `deepDiveForumId` (editorial/diary forums removed)
2. **messaging.ts**: Added `createForumPost`, `sendDigestToForum` functions
3. **scheduler.ts**: Updated digest job to use forum when configured
4. **commands.ts**: Updated `/digest run` to use forum when configured
5. **favorites.ts**: Integrated `createDeepDiveForumPost` for 👀 reactions
6. **deep-dive-forum.ts**: New helper for creating deep-dive forum posts

### Migration Checklist

- [x] Create forum channels in Discord server
- [x] Configure tags on each forum:
  - digest-forum: `weekday`, `weekend`, `light`, `normal`, `heavy`, plus channel names
  - deep-dive-forum: `analyzing`, `completed`
- [x] Set environment variables: `DIGEST_FORUM_ID`, `DEEP_DIVE_FORUM_ID`
- [x] Test each feature with forum enabled
- [ ] Archive old text channels (optional)

---

## Implementation Complete

*Completed: 2025-01-17*

The forum channel migration has been fully implemented with additional enhancements for database-driven configuration and improved functionality.

### Summary of Changes

#### 1. Database-Driven Configuration via ChannelConfig Table

Instead of relying solely on environment variables, channel configurations are now managed through a `ChannelConfig` database table:

```prisma
model ChannelConfig {
  id          String   @id @default(cuid())
  guildId     String
  channelKey  String   // e.g., "digest", "deepDive", "diary"
  channelId   String
  channelType String   // "forum" or "text"
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@unique([guildId, channelKey])
}
```

This enables:
- Per-guild channel configuration
- Runtime configuration changes without restarts
- Easy migration between channel types

#### 2. `/config` Commands for Managing Settings

New admin commands for channel configuration:

| Command | Description |
|---------|-------------|
| `/config channel set <key> <channel>` | Set a channel for a specific feature |
| `/config channel get <key>` | View current channel configuration |
| `/config channel list` | List all configured channels |
| `/config channel remove <key>` | Remove a channel configuration |

#### 3. Fixed Channel Names

Administrative channels use fixed, predictable names:
- `arkcore-admin` - Admin command channel
- `arkcore-alerts` - System alerts and notifications

#### 4. Diary Forum with Button Interaction Mode

The diary feature has been enhanced with interactive button-based workflows:
- Forum posts created in `diary-forum`
- Button interactions for session management
- Seamless user experience within forum threads

#### 5. Category-Based Digest Support

Digest now supports category-based organization:
- RSS sources can be assigned to categories
- Digest posts are organized by category
- Tags applied based on source categories

### Architecture Updates

| Component | Change |
|-----------|--------|
| `prisma/schema.prisma` | Added `ChannelConfig` model |
| `src/lib/channel-config.ts` | New service for channel configuration |
| `src/commands/config.ts` | New `/config` command group |
| `src/lib/messaging.ts` | Updated to use database configuration |
| `src/features/diary/` | Enhanced with button interactions |
| `src/features/digest.ts` | Category-based organization |

### Environment Variables (Legacy Support)

The following environment variables are still supported for backwards compatibility but database configuration takes precedence:

```bash
DIGEST_FORUM_ID=...
DEEP_DIVE_FORUM_ID=...
DIARY_FORUM_ID=...
```

### Next Steps (Optional)

- Archive legacy text channels after confirming stability
- Add more forum tag automation
- Implement forum post analytics
