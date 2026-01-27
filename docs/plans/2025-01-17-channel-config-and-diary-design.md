# Channel Configuration & Diary Forum Design

## Overview

将 channel/forum 配置从 env 迁移到数据库，通过 Discord 命令管理；同时将 Diary 改造为 forum + 按钮交互模式。

## 设计目标

1. **配置灵活化**：所有 channel/forum 配置存入数据库，通过命令管理
2. **Category-based Digest**：支持按 Discord category 分组，每组可有不同的 cron 和格式
3. **Diary Forum + 按钮**：用 forum 替代 text channel，用按钮替代命令

## 数据模型

### ChannelConfig 表

```prisma
model ChannelConfig {
  id          String   @id @default(cuid())
  guildId     String   // Discord 服务器 ID
  channelId   String?  // 具体 channel ID（可选）
  categoryId  String?  // category ID（可选，二选一）

  // 功能角色
  role        String   // 见下方 Role 定义

  // Digest 专属配置
  digestCron  String?  // 覆盖全局 cron，如 "0 9 * * *"
  digestFormat String? // "brief" | "detailed" | "minimal"

  enabled     Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@unique([guildId, channelId])
  @@unique([guildId, categoryId, role])
  @@index([guildId, role])
}
```

### Role 定义

| Role | 说明 | channelId/categoryId |
|------|------|---------------------|
| `digest-source` | Digest 来源 category | categoryId |
| `digest-output` | Digest 输出 forum | channelId |
| `deep-dive-output` | Deep-dive 输出 forum | channelId |
| `diary` | Diary forum | channelId |
| `favorites` | 收藏输出 channel | channelId |
| `editorial` | Editorial 输入 channel | channelId |

## 固定 Channel（硬编码）

| Channel Name | 用途 | 权限 |
|--------------|------|------|
| `arkcore-admin` | 配置命令 | 仅管理员可见 |
| `arkcore-alerts` | 系统告警 | 仅管理员可见 |

Bot 启动时自动查找并配置权限，不需要任何 env 配置。

## 命令设计

### /config 命令

```bash
# Digest 配置
/config digest add-category category:#tech-news cron:"0 9 * * *" format:detailed
/config digest set-output channel:#digest-forum
/config digest list
/config digest remove category:#tech-news

# Diary 配置
/config diary set-channel channel:#diary-forum

# 其他功能
/config favorites set-channel channel:#favorites
/config deep-dive set-output channel:#deep-dive-forum
/config editorial set-channel channel:#editorial

# 通用
/config list
/config remove id:xxx
```

### 权限控制

- `/config` 命令只能在 `#arkcore-admin` channel 中使用
- Bot 自动将 `#arkcore-admin` 设为仅管理员可见

## Diary Forum + 按钮

### 交互流程

```
1. 定时/手动创建帖子
   📔 Diary · 2024-01-17
   [📝 开始日记]

2. 用户点击按钮，开始交互
   Tag: analyzing
   Bot 和用户在帖子里对话

3. 用户点击结束/超时
   Tag: completed
   导出文件，发送摘要
```

### 帖子生命周期

| 状态 | 触发 | Tag | 按钮 |
|------|------|-----|------|
| 等待 | 定时创建/手动创建 | - | [📝 开始日记] |
| 进行中 | 点击开始 | `analyzing` | [✅ 结束日记] |
| 已结束 | 点击结束/超时 | `completed` | (无) |

### 规则

- 每天只能有一个活跃 session
- 任何人都可以参与对话
- 结束时导出文件 + 发送摘要（保持现有行为）

## 配置迁移

### 从 ENV 迁移到数据库

| 原 ENV 变量 | 迁移到 | Role |
|------------|--------|------|
| `DIGEST_FORUM_ID` | ChannelConfig | `digest-output` |
| `DEEP_DIVE_FORUM_ID` | ChannelConfig | `deep-dive-output` |
| `EDITORIAL_CHANNEL_ID` | ChannelConfig | `editorial` |
| `DIARY_CHANNEL_ID` | ChannelConfig | `diary` |
| `FAV_CHANNEL_ID` | ChannelConfig | `favorites` |
| `DEEPER_CHANNEL_ID` | (移除) | - |

### 保留在 ENV

| ENV 变量 | 原因 |
|----------|------|
| `DISCORD_BOT_TOKEN` | 安全敏感 |
| `DISCORD_APPLICATION_ID` | 启动必需 |
| `DISCORD_GUILD_ID` | 启动必需 |
| `DATABASE_URL` | 启动必需 |
| `LLM_*` | LLM 配置 |

### 移除的 ENV

- ~~`OBSERVABILITY_CHANNEL_ID`~~ → 固定 channel name
- ~~`DEEPER_CHANNEL_ID`~~ → 不再需要 fallback

## 实现阶段

### Phase 1: 基础设施
- 创建 ChannelConfig 数据库表
- 实现固定 channel 查找 (arkcore-admin, arkcore-alerts)
- 自动配置权限逻辑

### Phase 2: 配置命令
- /config 命令框架
- digest 配置子命令
- 其他功能配置子命令
- 迁移现有 env 配置到数据库

### Phase 3: Digest 改造
- 调度器读取数据库配置
- 按 category 分组执行
- 支持不同 cron/format

### Phase 4: Diary Forum + 按钮
- 恢复 diary forum 配置
- 实现按钮交互 (ButtonBuilder)
- 改造 session 管理逻辑
- 测试完整流程

### Phase 5: 清理
- 移除废弃的 env 变量
- 更新文档
- 更新 .env.example

## Bot 权限要求

```
Send Messages
Embed Links
Attach Files
Read Message History
Add Reactions
Use Slash Commands
Create Public Threads
Send Messages in Threads
Manage Channels      # 新增：配置 channel 权限
Manage Roles         # 新增：设置 permission overwrites
```
