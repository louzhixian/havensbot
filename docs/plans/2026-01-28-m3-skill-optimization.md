# M3: Skill 优化点分析报告

> **目标**：审查所有现有 Skills，找出代码结构和功能流程上的优化点
> 
> **审查日期**：2026-01-28

---

## 📊 问题概览

| 优先级 | 数量 | 说明 |
|--------|------|------|
| **P0 必须修** | 5 | 影响核心功能或数据一致性 |
| **P1 应该修** | 18 | 影响用户体验或可维护性 |
| **P2 可以修** | 9 | 优化项，不影响功能 |

---

## 🎙️ Voice Skill (`voice.skill.ts`)

### V-01: 内存缓存无法跨实例共享 [P1]

**现状**：`retryCache` 使用内存 `Map` 存储重试记录
```typescript
export class RetryCache {
  private cache = new Map<string, RetryRecord>();
}
```

**问题**：
- 多实例部署时状态无法共享
- 服务重启后重试记录丢失
- 用户可能收到"已达最大重试次数"的错误，但实际上是缓存丢失

**建议方案**：
- 使用 Redis 存储重试记录
- 或存入数据库（VoiceTranscription 表）
- 添加 TTL 到存储层

---

### V-02: setInterval 清理在模块级别执行 [P1]

**现状**：
```typescript
setInterval(() => {
  retryCache.cleanup();
}, 60 * 60 * 1000);
```

**问题**：
- 无法停止，测试时会泄漏
- 不在 Skill 生命周期管理内
- 多实例会产生重复清理任务

**建议方案**：
- 添加 `onBotReady` / `onBotStop` 生命周期钩子到 Skill 类型
- 在生命周期中管理定时器
- 或使用 cron job 替代 setInterval

---

### V-03: 错误处理过于静默 [P1]

**现状**：
```typescript
try {
  await message.react(EMOJI_PROCESSING);
} catch {
  // Ignore reaction errors
}
```

**问题**：
- 大量 catch 块只是忽略错误
- 调试困难，问题不可追踪
- 无法区分临时错误和永久错误

**建议方案**：
- 所有 catch 块至少记录 `logger.debug`
- 对 reaction 错误可以静默，但记录日志
- 对关键错误（下载、转写）保持用户反馈

---

### V-04: 缺少网络请求重试逻辑 [P1]

**现状**：`downloadAudio`、`transcribe`、`polishTranscript` 都是单次调用

**问题**：
- 临时网络波动会导致失败
- 用户需要手动点击重试
- Whisper API 可能偶发 503

**建议方案**：
- 在 `downloadAudio` 添加 3 次重试（exponential backoff）
- `transcribe` 使用 llm/client 的重试机制
- 或使用统一的 `fetchWithRetry` 工具

---

### V-05: 配置在运行时重复读取 [P2]

**现状**：每次处理消息都调用 `loadConfig()`

**问题**：效率略低（虽然有缓存）

**建议方案**：
- 在 SkillContext 中传入 config
- 或在 Skill 初始化时缓存

---

## 🔖 Readings Skill (`readings.skill.ts`)

### R-01: 内存缓存无法跨实例共享 [P1]

**现状**：
```typescript
const bookmarkedMessages = new Map<string, { threadId: string; createdAt: number }>();
const threadArticleUrls = new Map<string, string>();
```

**问题**：同 V-01

**建议方案**：
- `bookmarkedMessages` 可存入 ReadingBookmark 数据库表
- `threadArticleUrls` 应该在创建帖子时写入数据库

---

### R-02: threadArticleUrls 缓存无持久化导致 Q&A 失效 [P0]

**现状**：URL 只存在内存中
```typescript
const articleUrl = getThreadArticleUrl(thread.id);
if (!articleUrl) {
  // No URL stored - might be an older thread
  return;
}
```

**问题**：
- 服务重启后所有 Q&A 功能失效
- 用户提问没有响应，但没有任何反馈
- 这是静默失败，用户体验很差

**建议方案**：
- 创建 `ReadingThread` 表，关联 threadId 和 articleUrl
- 创建帖子时写入数据库
- Q&A 时从数据库读取

---

### R-03: 并发创建可能产生重复帖子 [P1]

**现状**：使用简单的 `markPending` 机制
```typescript
if (wasBookmarked(message.id)) return;
markPending(message.id);
```

**问题**：
- 内存级别的检查，多实例无效
- 极端高并发下仍可能有竞态
- 目前靠 Discord 的消息 ID 唯一性兜底

**建议方案**：
- 使用数据库 unique constraint
- 或使用 Redis SETNX 作为分布式锁
- 创建前先查询数据库

---

### R-04: Q&A 没有文章长度限制 [P1]

**现状**：`generateReadingsResponse` 直接使用文章 URL

**问题**：
- 长文章可能超出 LLM token 限制
- 可能导致 API 错误或截断
- 用户看不到有意义的错误信息

**建议方案**：
- 在 `readings/llm.ts` 中添加长度截断
- 超长时使用摘要模式
- 告知用户"文章较长，仅基于前 N 字符回答"

---

### R-05: 错误时缺少用户反馈 [P1]

**现状**：
```typescript
logger.warn({ error: attachError }, "Failed to send attachments");
```

**问题**：
- 附件发送失败用户不知道
- 按钮发送失败用户不知道
- Link footer 发送失败用户不知道

**建议方案**：
- 关键操作失败时发送提示消息
- "⚠️ 部分内容未能发送，请查看原消息"

---

## ✍️ Editorial Skill (`editorial.skill.ts`)

### E-01: 重复的 LLM 调用实现 [P0]

**现状**：自定义 `callOpenAiCompat` 函数
```typescript
const callOpenAiCompat = async (config, systemPrompt, userPrompt, temperature) => {
  const endpoint = buildOpenAiCompatUrl(config.llmBaseUrl);
  const response = await fetch(endpoint, { ... });
  // ...
};
```

**问题**：
- 与 `llm/client.ts` 的 `createLlmClient` 功能重复
- 没有重试逻辑
- 没有超时处理
- 没有使用统一的错误处理

**建议方案**：
- 使用 `createLlmClient` 替换
- 删除 `callOpenAiCompat` 和 `isLlmEnabled`
- 统一所有 Skill 的 LLM 调用方式

---

### E-02: PROMPT_CACHE 没有失效机制 [P2]

**现状**：
```typescript
const PROMPT_CACHE = new Map<string, { system: string; user: string }>();
const loadPromptSections = async (fileName) => {
  const cached = PROMPT_CACHE.get(fileName);
  if (cached) return cached;
  // ...
};
```

**问题**：
- 修改 prompt 文件需要重启服务
- 开发时不方便调试

**建议方案**：
- 添加 TTL（如 5 分钟）
- 或使用 file watcher
- 或通过环境变量控制是否缓存

---

### E-03: 翻译长文章缺少进度反馈 [P1]

**现状**：只发送 "正在翻译，请稍候..."

**问题**：
- 长文章分多段翻译，可能需要几分钟
- 用户不知道进度
- 可能误以为卡住了

**建议方案**：
```typescript
await thread.send({ content: `正在翻译 (${index}/${total})...` });
// 或者每段翻译完成后更新
```

---

### E-04: 超时设置硬编码 [P1]

**现状**：
```typescript
await fetchArticleText(url, {
  timeoutMs: 12000,
  maxLength: Number.MAX_SAFE_INTEGER,
});
```

**问题**：
- 某些网站需要更长时间
- 无法按需调整
- `maxLength: Number.MAX_SAFE_INTEGER` 可能导致内存问题

**建议方案**：
- 从 config 读取 `articleFetchTimeoutMs`
- 设置合理的 `maxLength`（如 100KB）
- 添加配置文档

---

### E-05: Thread handler 缺少 channelRole 过滤 [P2]

**现状**：
```typescript
const editorialThreadHandler: MessageHandler = {
  // 没有 channelRole
  filter: (message) => { ... },
  execute: async (ctx, message, _settings) => {
    // 手动检查 isEditorialThread
  },
};
```

**问题**：
- 逻辑分散，需要手动判断
- 与其他 handler 风格不一致
- 增加了维护成本

**建议方案**：
- 框架层支持 `channelRole: "editorial"` + `threadOnly: true`
- 或定义 `parentChannelRole` 选项

---

## 📔 Diary Skill (`diary.skill.ts`)

### D-01: 配置和 LLM Client 重复创建 [P2]

**现状**：
```typescript
const config = loadConfig();
const llmClient = createLlmClient(config);
```
在 handler、button handler、cron job 中各出现一次

**问题**：效率略低，代码重复

**建议方案**：
- 在 SkillContext 中预创建 llmClient
- 或添加 lazy 初始化的单例

---

### D-02: 超时检查 cron 是全局的，但按 Guild 执行 [P1]

**现状**：
```typescript
const diaryTimeoutCheckCron: SkillCronJob = {
  execute: async (ctx, guildId, settings) => {
    await checkTimeoutSessions(config, ctx.client, llmClient);
    // checkTimeoutSessions 处理所有 Guild 的超时会话
  },
};
```

**问题**：
- 每个 Guild 都会触发一次全局检查
- 如果有 10 个 Guild，每 5 分钟会检查 10 次
- 可能导致重复处理

**建议方案**：
- 方案 A：`checkTimeoutSessions` 改为按 guildId 过滤
- 方案 B：改为全局 cron job（不绑定 Guild）
- 方案 C：使用 Redis 锁防止重复执行

---

### D-03: 缺少会话恢复机制 [P1]

**现状**：活跃会话只在内存中跟踪（通过 button 和 session 表）

**问题**：
- 服务重启后，已开始的会话按钮可能失效
- 用户需要重新开始

**建议方案**：
- 启动时检查数据库中的活跃会话
- 对超过一定时间（如 1 天）的未完成会话自动关闭
- 添加手动恢复指令

---

### D-04: 无并发会话数量限制 [P1]

**现状**：用户可以同时开启多个 diary session

**问题**：
- 资源浪费
- 可能导致混乱
- 没有业务上的需求支持

**建议方案**：
- 限制每个用户在每个 Guild 同时只能有一个活跃会话
- 在 `startDiarySessionInThread` 中检查

---

### D-05: sendTyping 错误处理不完整 [P2]

**现状**：
```typescript
if ('sendTyping' in message.channel) {
  await message.channel.sendTyping();
}
```

**问题**：sendTyping 可能失败（无权限等），但没有 try-catch

**建议方案**：
```typescript
try {
  await message.channel.sendTyping?.();
} catch { /* ignore */ }
```

---

## ❤️ Favorites Skill (`favorites.skill.ts`)

### F-01: 内存缓存无法跨实例共享 [P1]

**现状**：
```typescript
const deeperMessages = new Map<string, { ... }>();
// 在 favorites.ts 中还有 forwardedMessages
```

**问题**：同 V-01、R-01

**建议方案**：
- `forwardedMessages` 存入 Favorite 表
- `deeperMessages` 存入 DeepDive 表

---

### F-02: 重复的 ensureMessage 函数 [P1]

**现状**：
- `favorites.ts` 有 `ensureMessage`
- `favorites.skill.ts` 也有 `ensureMessage`

**问题**：代码重复，容易不一致

**建议方案**：
- 提取到 `utils/discord.ts`
- 导出供所有 Skill 使用

---

### F-03: DeepDive 生成失败没有错误恢复 [P0]

**现状**：
```typescript
await forumResult.thread.send({ content: "正在生成深度解读，请稍候..." });
const result = await generateDeepDive(config, itemUrl);
// 如果 generateDeepDive 抛异常...
```

**问题**：
- LLM 调用失败后帖子停留在 "正在生成" 状态
- 用户看到 "digesting" 标签但永远没有结果
- 没有任何错误反馈

**建议方案**：
```typescript
try {
  const result = await generateDeepDive(config, itemUrl);
  // 发送结果...
} catch (error) {
  await forumResult.thread.send({ content: `❌ 生成失败: ${error.message}` });
  // 移除 digesting 标签，添加 failed 标签
  await forumResult.markFailed();
}
```

---

### F-04: DeepDive 缺少进度指示 [P1]

**现状**：只有初始的 "正在生成深度解读，请稍候..."

**问题**：
- 长文章处理可能需要 30 秒以上
- 用户不知道是否在处理

**建议方案**：
- 添加 typing indicator（每 5 秒）
- 或分阶段反馈："正在抓取文章..." → "正在分析..." → "正在生成..."

---

### F-05: forwardMessage fallback 可能丢失元数据 [P2]

**现状**：
```typescript
const forwarder = (message as any).forward;
if (typeof forwarder === "function") {
  return forwarder.call(message, channel);
}
// fallback: 手动重建消息
return channel.send({ content, embeds, files });
```

**问题**：
- 手动重建丢失原始消息的元数据（时间戳、作者等）
- 类型断言 `as any` 不安全

**建议方案**：
- 检查 Discord.js 版本是否支持 forward
- 如果不支持，添加更完整的消息复制逻辑
- 移除 any，使用类型守卫

---

## 📊 Digest Skill (`digest.skill.ts`)

### G-01: 缺少增量摘要机制 [P1]

**现状**：每次 cron 运行都全量处理

**问题**：
- 如果手动运行两次，会重复生成
- 消耗 LLM 资源
- 可能产生重复内容

**建议方案**：
- 记录每个频道最后处理的消息 ID
- 或使用 "今日是否已处理" 标记
- 在 forum post 中查找是否已有今日帖子（已部分实现）

---

### G-02: 单个频道失败没有重试机制 [P0]

**现状**：
```typescript
for (const { channelId } of channelsToProcess) {
  try {
    // 处理摘要
  } catch (error) {
    ctx.logger.error({ error, channelId }, "Failed to process channel digest");
    // 继续下一个频道，不重试
  }
}
```

**问题**：
- 临时错误导致整个频道摘要缺失
- 用户不知道哪些频道失败了
- 没有自动恢复机制

**建议方案**：
- 添加失败队列，稍后重试
- 在 forum post 中标记失败的频道
- 或使用重试装饰器

---

### G-03: /run 命令缺少幂等性 [P1]

**现状**：`/digest run` 总是执行

**问题**：
- 多次运行会产生重复内容
- 或覆盖已有内容

**建议方案**：
- 检测今日是否已有 digest post
- 提供 `--force` 选项覆盖
- 或追加而不是创建新帖子

---

### G-04: 时区处理逻辑分散 [P2]

**现状**：
```typescript
const timezone = settings.timezone || config.tz;
```

**问题**：多处重复，可能不一致

**建议方案**：
```typescript
// utils/timezone.ts
export const getGuildTimezone = (settings: GuildSettings, config: AppConfig): string => {
  return settings.timezone || config.tz;
};
```

---

### G-05: 进度反馈不足 [P2]

**现状**：日志记录但用户看不到处理进度

**问题**：
- 多频道处理时用户不知道进度
- 大 Guild 可能需要几分钟

**建议方案**：
- 在 forum post 第一条消息中实时更新
- "正在处理: 3/10 频道..."

---

## 🔧 通用问题

### C-01: 缺少统一的 LLM 调用层 [P0]

**现状**：
- Editorial 使用自定义 `callOpenAiCompat`
- Diary、Readings 使用 `createLlmClient`
- Voice 使用专用的 Whisper client

**问题**：
- 行为不一致（重试、超时、错误处理）
- 维护成本高
- 难以添加统一的 metrics

**建议方案**：
- 所有 Skill 统一使用 `llm/client.ts`
- Editorial 移除 `callOpenAiCompat`
- 在 client 层统一添加重试、超时、metrics

---

### C-02: 内存缓存需要持久化 [P0]

**现状**：5 个 Skill 中有 4 个使用内存 Map 作为缓存

| Skill | 缓存 | 影响 |
|-------|------|------|
| Voice | retryCache | 重试记录丢失 |
| Readings | bookmarkedMessages, threadArticleUrls | 重复创建、Q&A 失效 |
| Favorites | forwardedMessages, deeperMessages | 重复转发 |

**建议方案**：
- 方案 A：使用 Redis（推荐，支持 TTL 和分布式）
- 方案 B：使用数据库（已有 Prisma）
- 短期可以先用数据库，长期考虑 Redis

---

### C-03: 类型安全不足 [P1]

**现状**：多处使用 `any` 或类型断言

```typescript
// eslint-disable-next-line @typescript-eslint/no-explicit-any
return (channel as any).send({ ... });

const forwarder = (message as Message & {
  forward?: (target: GuildTextBasedChannel) => Promise<Message>;
}).forward;
```

**问题**：
- 运行时错误风险
- IDE 提示不准确
- 代码不够健壮

**建议方案**：
- 为 Discord.js 扩展定义完整类型
- 使用类型守卫而不是断言
- 启用更严格的 TypeScript 配置

---

### C-04: 缺少统一的错误边界 [P1]

**现状**：每个 Skill 自己处理错误，风格不一致

**问题**：
- 某些地方静默失败
- 某些地方记录日志但没有用户反馈
- 没有统一的错误格式

**建议方案**：
- 在 SkillRegistry 层包装 try-catch
- 定义 SkillError 类型
- 统一的错误消息格式
- 可配置的错误通知渠道

---

### C-05: 缺少 Skill 生命周期钩子 [P1]

**现状**：Skill 只有 `onGuildJoin` / `onGuildLeave`

**问题**：
- 无法管理定时器（如 V-02）
- 无法做初始化/清理
- 无法响应 bot 重启

**建议方案**：
添加以下钩子：
```typescript
interface Skill {
  // 现有
  onGuildJoin?: (ctx, guildId) => Promise<void>;
  onGuildLeave?: (ctx, guildId) => Promise<void>;
  
  // 新增
  onBotReady?: (ctx) => Promise<void>;  // bot 启动完成
  onBotStop?: (ctx) => Promise<void>;   // bot 正在关闭
  onSkillEnable?: (ctx, guildId) => Promise<void>;  // skill 被启用
  onSkillDisable?: (ctx, guildId) => Promise<void>; // skill 被禁用
}
```

---

## 📋 优先级分类汇总

### P0 必须修（5 项）

| ID | 问题 | Skill |
|----|------|-------|
| R-02 | threadArticleUrls 无持久化导致 Q&A 失效 | Readings |
| E-01 | 重复的 LLM 调用实现 | Editorial |
| F-03 | DeepDive 生成失败没有错误恢复 | Favorites |
| G-02 | 单个频道失败没有重试机制 | Digest |
| C-01/C-02 | 统一 LLM 层 + 持久化缓存 | 通用 |

### P1 应该修（18 项）

| ID | 问题 | Skill | 状态 |
|----|------|-------|------|
| V-01 | 内存缓存无法跨实例共享 | Voice | ✅ 2026-01-29 |
| V-02 | setInterval 在模块级别 | Voice | ✅ 2026-01-30 |
| V-03 | 错误处理过于静默 | Voice | ✅ 2026-01-29 |
| V-04 | 缺少网络请求重试 | Voice | ✅ 2026-01-30 |
| R-01 | 内存缓存无法跨实例共享 | Readings | ✅ 2026-01-29 |
| R-03 | 并发创建可能重复 | Readings | ✅ 2026-01-30 |
| R-04 | Q&A 没有长度限制 | Readings | ✅ 2026-01-30 |
| R-05 | 错误时缺少用户反馈 | Readings | ✅ 2026-01-29 |
| E-03 | 翻译长文章缺少进度 | Editorial | ✅ 2026-01-29 |
| E-04 | 超时设置硬编码 | Editorial | ✅ 2026-01-30 |
| D-02 | 超时检查 cron 全局 vs Guild | Diary | ✅ 2026-01-29 |
| D-03 | 缺少会话恢复机制 | Diary | |
| D-04 | 无并发会话限制 | Diary | ✅ 2026-01-30 |
| F-01 | 内存缓存无法跨实例共享 | Favorites | ✅ 2026-01-29 |
| F-02 | 重复的 ensureMessage | Favorites | ✅ 2026-01-30 |
| F-04 | DeepDive 缺少进度指示 | Favorites | ✅ 2026-01-29 |
| G-01 | 缺少增量摘要机制 | Digest | ✅ 2026-01-30 |
| G-03 | /run 命令缺少幂等性 | Digest | ✅ 2026-01-30 |
| C-03 | 类型安全不足 | 通用 | |
| C-04 | 缺少统一错误边界 | 通用 | |
| C-05 | 缺少 Skill 生命周期钩子 | 通用 | ✅ 2026-01-28 |

### P2 可以修（9 项）

| ID | 问题 | Skill | 状态 |
|----|------|-------|------|
| V-05 | 配置运行时重复读取 | Voice | 📝 2026-01-29 |
| E-02 | PROMPT_CACHE 没有 TTL | Editorial | ✅ 2026-01-29 |
| E-05 | Thread handler 缺少 channelRole | Editorial | 📝 2026-01-29 |
| D-01 | 配置和 LLM Client 重复创建 | Diary | 📝 2026-01-29 |
| D-05 | sendTyping 错误处理不完整 | Diary | ✅ 2026-01-29 |
| F-05 | forwardMessage fallback 丢失元数据 | Favorites | 📝 2026-01-29 |
| G-04 | 时区处理逻辑分散 | Digest | ✅ 2026-01-29 |
| G-05 | 进度反馈不足 | Digest | ✅ 2026-01-29 |

---

## 🎯 建议执行顺序

### Phase 1: 基础设施（1-2 天）
1. **C-01**: 统一 LLM 调用层，Editorial 使用 createLlmClient ✅
2. **C-02**: 设计缓存持久化方案（Redis 或 DB） ✅
3. **C-05**: 添加 Skill 生命周期钩子 ✅

#### Phase 1 进度
- C-01 ✅ (2026-01-28): Editorial 的 `editorial-translation.ts` 和 `editorial-discussion.ts` 已改用 `createLlmClient`，移除了自定义的 `callOpenAiCompat` 和 `isLlmEnabled` 函数
- C-01 ✅ (2026-01-29): 补漏 - `editorial.skill.ts` 中的 `callOpenAiCompat` 已替换为 `createLlmClient` 工厂函数，使用 `callLlm` 包装函数
- C-02 ✅ (2026-01-28): 创建 `CacheEntry` Prisma model 和 `CacheStore` 工具类
  - 添加 `prisma/schema.prisma` 中的 `CacheEntry` model（支持 namespace 隔离、TTL）
  - 创建 `apps/arkcore/src/utils/cache-store.ts`，提供 get/set/delete/cleanup/getMany/setMany/touch API
  - 提供 `cleanupAllExpiredCacheEntries()` 全局清理函数
  - **注意**: 数据库迁移 `npx prisma migrate dev --name add_cache_entry` 需要在数据库可用时执行
- C-05 ✅ (2026-01-28): 添加 Skill 生命周期钩子
  - 在 `skills/types.ts` 中添加 `onBotReady` 和 `onBotStop` 钩子
  - 在 `skills/registry.ts` 中实现 `invokeOnBotReady()` 和 `invokeOnBotStop()` 方法
  - 在 `index.ts` 的 `client.once('ready')` 中调用 `invokeOnBotReady()`
  - 在 `shutdown()` 函数中调用 `invokeOnBotStop()`，实现 graceful shutdown

### Phase 2: 关键修复（2-3 天）
4. **R-02**: Readings Q&A URL 持久化
5. **F-03**: DeepDive 错误恢复
6. **G-02**: Digest 重试机制

#### Phase 2 进度
- R-02 ✅ (2026-01-28): 修复 threadArticleUrls 持久化问题
  - 将内存 Map 替换为 `CacheStore`（使用 `readings_thread_url` namespace）
  - `setThreadArticleUrl()` 和 `getThreadArticleUrl()` 改为异步函数，从数据库读写
  - 添加 30 天 TTL 防止无限增长
  - 服务重启后 Q&A 功能将正常工作
- F-03 ✅ (2026-01-28): DeepDive 错误恢复
  - 在 `favorites.skill.ts` 的 `handleEyesReaction` 中添加 try-catch
  - 生成失败时发送错误消息给用户："❌ 生成失败: {error}"
  - 在 `deep-dive-forum.ts` 添加 `markFailed()` 方法，将标签从 "analyzing" 改为 "failed"
  - 用户不再看到永远卡在 "正在生成" 状态的帖子
- G-02 ✅ (2026-01-28): Digest 重试机制
  - 添加 `processChannelWithRetry()` 函数，支持最多 2 次重试（共 3 次尝试）
  - 重试间隔 5 秒，使用 exponential backoff 可防止临时网络波动
  - 失败频道记录在 `failedChannels` 数组中
  - Forum 模式下，在帖子中发送失败通知："⚠️ 以下频道摘要生成失败: #channel1, #channel2"
  - 添加详细的日志记录：每次重试都有 warn 日志，最终失败有 error 日志
  - 运行完成后输出汇总日志（总频道数、成功数、失败数、失败频道列表）

### Phase 2.5: 内存缓存迁移（2026-01-29）
- V-01 ✅ (2026-01-29): voice/retryCache.ts 迁移到 CacheStore
  - 使用 `voice_retry` namespace，TTL 24 小时
  - 所有方法改为异步（set/get/canRetry/incrementAttempts/cleanup）
  - 更新 voice.skill.ts 和 voiceHandler.ts 中的调用为 await
- F-01 ✅ (2026-01-29): favorites.skill.ts 的 deeperMessages 迁移到 CacheStore
  - 使用 `favorites_deeper` namespace，TTL 1 小时
  - 添加 `wasDeeperForwarded()` 异步函数替代 `deeperMessages.has()`
- R-01 ✅ (2026-01-29): readings.skill.ts 的 bookmarkedMessages 迁移到 CacheStore
  - 使用 `readings_bookmarked` namespace，TTL 1 小时
  - `wasBookmarked/markPending/clearPending/markBookmarked` 全部改为异步

### Phase 3: 体验优化（2-3 天）
7. **E-03, F-04**: 进度反馈
8. **V-03, R-05**: 错误消息改善
9. **D-02, D-03**: Diary 会话管理

#### Phase 3 进度
- E-03 ✅ (2026-01-29): 翻译长文章进度反馈
  - 在 `editorial-translation.ts` 中添加分段翻译进度显示
  - 单段翻译显示 "正在翻译，请稍候..."
  - 多段翻译显示 "翻译中 (1/3)...", "翻译中 (2/3)...", "翻译中 (3/3)..."
  - 用户可以实时了解翻译进度
- F-04 ✅ (2026-01-29): DeepDive 进度指示
  - 在 `favorites.skill.ts` 的 `handleEyesReaction` 中添加 typing indicator
  - 每 5 秒发送一次 typing indicator，持续到生成完成或失败
  - 使用 `finally` 块确保 interval 总是被清除
  - 用户可以看到 Discord 的 "xxx is typing..." 提示，知道系统正在处理
- V-03 ✅ (2026-01-29): Voice 错误处理改善
  - 所有静默 catch 块添加 `logger.debug` 日志
  - 包括: updateReaction、handleVoiceMessage 中的 reaction 操作、error thread 创建、retry 成功后的 reaction 更新
  - 调试时可以追踪 reaction 失败原因
- R-05 ✅ (2026-01-29): Readings 错误用户反馈
  - 附件发送失败时显示 "⚠️ 部分附件发送失败，请查看原消息"
  - 按钮发送失败时显示 "⚠️ 状态切换按钮加载失败"
  - 用户能够知道操作未完全成功
- D-02 ✅ (2026-01-29): 超时检查 cron 全局 vs Guild 问题
  - 在 `DiarySession` 模型中添加 `guildId` 字段
  - 修改 `checkTimeoutSessions()` 函数接受可选的 `guildId` 参数
  - 更新 `diaryTimeoutCheckCron` 传入当前 guildId，只处理该 guild 的会话
  - 解决了 10 个 Guild 每 5 分钟重复检查 10 次的问题
  - **注意**: 需要执行 `npx prisma migrate dev --name add_diary_session_guild_id`
- D-03 ✅ (2026-01-29): 会话恢复机制 (TODO)
  - 在 `diary.skill.ts` 添加 TODO 注释，描述后续实现计划
  - 包括: 启动时检查活跃会话、自动关闭超时会话、添加 /diary recover 指令

### Phase 4: 代码质量（持续）
10. P2 优化项逐步处理

#### Phase 4 进度
- E-02 ✅ (2026-01-29): PROMPT_CACHE 添加 TTL 机制
  - 修改 `editorial.skill.ts` 中的 `PROMPT_CACHE` 类型，添加 `timestamp: number` 字段
  - 添加 `CACHE_TTL_MS = 5 * 60 * 1000` 常量（5 分钟）
  - 在 `loadPromptSections()` 函数中添加 TTL 检查逻辑
  - 缓存过期后会重新加载 prompt 文件
  - 修改 prompt 文件后 5 分钟内自动生效，无需重启服务
  - 编译验证通过 ✅
- V-05 📝 (2026-01-29): 配置运行时重复读取 (TODO 标记)
  - 在 `voice.skill.ts` 的 2 个位置添加 TODO 注释
  - 位置: voiceMessageHandler.execute (line 161)、retryReactionHandler.execute (line 220)
  - 注释内容: "考虑在 SkillContext 中预传入 config 或在 Skill 模块级别缓存，避免重复调用 loadConfig()"
  - 编译验证通过 ✅
  - **需要后续实现**: 这是架构级别的优化，需要与其他 Skills 一起统一处理
- D-01 📝 (2026-01-29): 配置和 LLM Client 重复创建 (TODO 标记)
  - 在 `diary.skill.ts` 的 4 个位置添加 TODO 注释
  - 位置: diaryMessageHandler、diaryStartButtonHandler、diaryEndButtonHandler、diaryTimeoutCheckCron
  - 注释内容: "考虑在 SkillContext 中预创建 llmClient 或添加 lazy 初始化的单例，避免重复创建"
  - 编译验证通过 ✅
  - **需要后续实现**: 这是标记优化点，实际重构需要修改 SkillContext，可能影响其他 Skills
- D-05 ✅ (2026-01-29): Diary sendTyping 错误处理
  - 在 `diary/session.ts` 的 `handleDiaryMessage` 函数中添加 sendTyping 调用
  - 包装在 try-catch 中，忽略权限错误等异常
  - 用户在日记会话中可以看到 "正在输入" 提示
  - 即使 sendTyping 失败也不影响正常功能
- G-04 ✅ (2026-01-29): 时区处理逻辑统一化
  - 创建 `apps/arkcore/src/utils/timezone.ts` 工具函数
  - 导出 `getGuildTimezone(settings, config)` 统一处理时区逻辑
  - 在 `digest.skill.ts` 中导入并使用该函数替换重复代码
  - 消除了 `settings.timezone || config.tz` 的分散重复
  - 编译验证通过 ✅
- G-05 ✅ (2026-01-29): Digest 进度反馈改善
  - 在 forum 模式下添加实时进度反馈机制
  - 创建初始状态消息: "📊 正在生成每日摘要 (0/N 频道)，请稍候..."
  - 处理每个频道时更新进度: "📊 正在处理: 1/N 频道 (#channel-name)..."
  - 所有频道处理完成后删除状态消息
  - 添加错误处理，状态消息更新失败不影响主流程
  - 用户可以实时看到 Digest 处理进度，大 Guild 不再困惑
  - 编译验证通过 ✅
- E-05 📝 (2026-01-29): Thread handler channelRole 过滤 (TODO 标记)
  - 在 `editorial.skill.ts` 的 `editorialThreadHandler` 定义处添加 TODO 注释
  - 注释内容: "考虑框架层支持 channelRole + threadOnly 选项或定义 parentChannelRole，避免手动检查 isEditorialThread"
  - 编译验证通过 ✅
  - **需要后续实现**: 这是架构级别的改动，需要修改 MessageHandler 类型定义和框架层

---

_生成于 2026-01-28_
