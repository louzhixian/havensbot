# Haven PRD

> AI 时代的「末日小屋」—— 多租户 Discord Bot 平台

## 1. 产品概述

### 1.1 定位
把 ArkCore 的工作流能力开放给所有人：用户把 Bot 拉进自己的 Discord Guild，即可复刻一套 AI 驱动的信息工作台。

### 1.2 核心价值
- **面包板**：灵活插拔，想用什么 Skill 就开什么
- **末日小屋**：信息荒野中一个确定能运转的地方
- **自我造血**：收入覆盖 token 成本，形成正循环

### 1.3 目标用户
- 信息重度消费者（RSS、Newsletter、社交媒体）
- 个人知识管理者
- 小型团队/社区

---

## 2. Skills 体系

### 2.1 架构设计

```typescript
interface Skill {
  id: string;                      // 'digest' | 'favorites' | 'deeper' | ...
  name: string;                    // 显示名称
  description: string;             // 一句话描述
  tier: 'free' | 'premium';        // 免费/付费
  
  // 生命周期
  register(ctx: SkillContext): void;    // 注册到 Guild
  unregister(): void;                   // 卸载
  
  // 配置
  getDefaultConfig(): SkillConfig;
  getConfigSchema(): ZodSchema;         // 配置校验
  
  // 可选
  commands?: SlashCommand[];            // 提供的命令
  reactions?: ReactionHandler[];        // 监听的 Reaction
  cron?: CronJob[];                     // 定时任务
  channels?: ChannelRole[];             // 需要的频道角色
}

interface SkillContext {
  guild: GuildSettings;
  client: Client;
  db: PrismaClient;
  llm: LlmClient | null;                // premium 才有
}
```

### 2.2 Skills 清单

| Skill | 层级 | 描述 | 核心能力 |
|-------|------|------|----------|
| **Digest** | Free | 每日信息摘要 | RSS 订阅 + 定时汇总 |
| **Favorites** | Free | ❤️ 收藏转发 | Reaction → 转发到收藏频道 |
| **DeepDive** | Premium | 👀 深度阅读 | LLM 分析 + 讨论帖 |
| **Readings** | Premium | 🔖 阅读管理 | 书签 + Q&A |
| **Editorial** | Premium | ✍️ 写作助手 | 翻译 + 润色 + 讨论 |
| **Diary** | Premium | 📔 AI 日记 | 定时创建 + LLM 陪伴 |
| **Voice** | Premium | 🎙️ 语音转文字 | Whisper 转录 + 润色 |

### 2.3 Free vs Premium 边界

**Free 用户：**
- Digest：最多 10 个 RSS 源，无 LLM 摘要（纯列表）
- Favorites：无限制
- 其他 Skill 不可用

**Premium 用户：**
- Digest：最多 100 个 RSS 源，LLM 智能摘要
- 所有 Skill 解锁
- LLM 每日配额（可配置）

---

## 3. 多租户架构

### 3.1 数据模型

```prisma
model GuildSettings {
  id              String   @id @default(cuid())
  guildId         String   @unique
  
  // 基础配置
  timezone        String   @default("UTC")
  locale          String   @default("en")
  
  // 订阅状态
  tier            String   @default("free")  // free | premium
  tierExpiresAt   DateTime?
  
  // Skill 开关
  enabledSkills   String[] @default(["digest", "favorites"])
  
  // 资源配额
  rssSourceLimit  Int      @default(10)
  llmDailyQuota   Int      @default(0)       // 0 = 无 LLM
  llmUsedToday    Int      @default(0)
  
  // Skill 配置（JSON）
  skillConfigs    Json     @default("{}")
  
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}
```

### 3.2 Scheduler 改造

```typescript
// 现在：单 Guild 硬编码
cron.schedule(config.digestCron, () => runDigest());

// 改后：多 Guild 感知
cron.schedule("* * * * *", async () => {
  const guilds = await db.guildSettings.findMany({
    where: { tier: { not: "suspended" } }
  });
  
  for (const guild of guilds) {
    // 检查该 Guild 的 digest cron 是否该执行
    if (shouldRunNow(guild.skillConfigs.digest?.cron, guild.timezone)) {
      await runDigestForGuild(guild);
    }
  }
});
```

### 3.3 Onboarding 流程

```
Bot 被拉进新 Guild
        ↓
guildCreate 事件触发
        ↓
创建 GuildSettings (默认 free)
        ↓
发送欢迎消息 + 引导
  - "👋 我是 Haven，你的信息避风港"
  - "用 /setup 开始配置"
  - "用 /skills 查看可用技能"
        ↓
用户执行 /setup
  - 选择 timezone
  - 选择语言
  - 引导添加第一个 RSS 源
```

---

## 4. M1 里程碑：多租户基础

### 4.1 目标
Bot 能被拉进多个 Guild，每个 Guild 独立运行 Digest + Favorites。

### 4.2 任务拆解

| # | 任务 | 预估 | 产出 |
|---|------|------|------|
| 1 | 创建 Haven repo（fork ArkCore） | 0.5h | 新 repo |
| 2 | GuildSettings 表 + Prisma migration | 1h | schema 更新 |
| 3 | 移除硬编码 GUILD_ID | 2h | 代码改造 |
| 4 | Skill 接口定义 | 1h | types + base class |
| 5 | 重构 Digest 为 Skill | 2h | digest.skill.ts |
| 6 | 重构 Favorites 为 Skill | 1h | favorites.skill.ts |
| 7 | Scheduler 多租户改造 | 2h | scheduler.ts 重写 |
| 8 | guildCreate 欢迎 + /setup 命令 | 2h | onboarding |
| 9 | /skills 命令（查看/开关） | 1h | commands |
| 10 | 测试：多 Guild 同时运行 | 2h | 测试验证 |

**预估总工时：14-16 小时**

### 4.3 验收标准
- [ ] Bot 加入新 Guild 自动创建配置
- [ ] 每个 Guild 可独立配置 timezone、cron
- [ ] Digest 按各 Guild 配置独立执行
- [ ] Favorites 在各 Guild 独立工作
- [ ] /setup, /skills 命令可用

---

## 5. 后续里程碑

### M2：Premium Skills
- DeepDive, Readings, Editorial 改造为 Skill
- LLM 配额系统
- Premium 标记

### M3：付费系统
- Stripe/LemonSqueezy 集成
- 订阅管理
- 额度充值

### M4：Landing Page
- havens.bot 官网
- 功能介绍
- 定价页面

### M5：运营上线
- 公开邀请链接
- Discord 社区
- 文档站

---

## 6. 技术决策

### 6.1 为什么 fork 而不是改造 ArkCore？
- ArkCore 保持个人使用版本
- Haven 可以大胆重构
- 避免两边互相影响

### 6.2 为什么不用微服务？
- 早期复杂度不值得
- 单体 + Skill 模块化已够用
- 流量大了再拆

### 6.3 LLM 成本控制
- Free 用户无 LLM
- Premium 按日配额
- 超额降级或暂停

---

_创建于 2026-01-27_
_版本：v0.1_
