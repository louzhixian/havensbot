# M4: Payment System (付费系统)

> 让 Haven 实现自我造血：Free tier 引流，Premium tier 收入覆盖成本

---

## 🎯 目标

构建完整的订阅付费系统，支持 Free → Premium 升级，管理 LLM 配额，实现收入正循环。

---

## 📋 功能需求

### 1. 订阅管理
- Free tier (默认)
  - Digest: 最多 10 个 RSS 源，无 LLM 摘要
  - Favorites: 完整功能
  - 其他 Skills: 不可用
  
- Premium tier ($9/月)
  - Digest: 最多 100 个 RSS 源，LLM 智能摘要
  - 所有 Premium Skills 解锁
  - LLM 每日配额: 100 次调用（约 $0.50/天成本）
  - 优先支持

### 2. 支付集成
- **选择 LemonSqueezy**（理由见技术决策）
- 支持信用卡、PayPal
- 月度订阅 + 自动续费
- 取消/暂停订阅
- 发票生成

### 3. 配额管理
- 每日 LLM 调用次数限制
- 超额处理：
  - 降级到非 LLM 版本（如 Digest 纯列表）
  - 或返回友好提示："今日配额用尽，明日重置"
- 管理员可手动调整配额

### 4. 用户命令
- `/subscribe` - 订阅 Premium
- `/billing` - 查看订阅状态、用量、续费日期
- `/cancel` - 取消订阅（保留到期末）

---

## 🏗️ 数据模型

```prisma
// 已有
model GuildSettings {
  id              String   @id @default(cuid())
  guildId         String   @unique
  
  tier            String   @default("free")  // free | premium | suspended
  tierExpiresAt   DateTime?                  // Premium 到期时间
  
  llmDailyQuota   Int      @default(0)       // 每日配额（Premium = 100）
  llmUsedToday    Int      @default(0)       // 今日已用
  llmQuotaResetAt DateTime?                  // 下次重置时间
  
  // ...
}

// 新增
model Subscription {
  id                String   @id @default(cuid())
  guildId           String   @unique
  
  // LemonSqueezy
  lemonSqueezyId    String   @unique         // subscription_id
  customerId        String                   // customer_id
  variantId         String                   // 价格/计划 ID
  
  status            String                   // active | past_due | canceled
  currentPeriodEnd  DateTime                 // 当前周期结束时间
  cancelAtPeriodEnd Boolean  @default(false)
  
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  
  guild             GuildSettings @relation(fields: [guildId], references: [guildId])
}

model BillingEvent {
  id              String   @id @default(cuid())
  guildId         String
  
  type            String                     // subscription_created | payment_success | subscription_canceled | ...
  lemonSqueezyId  String                     // event_id
  payload         Json                       // 完整 webhook payload
  
  createdAt       DateTime @default(now())
  
  @@index([guildId])
}
```

---

## 📐 架构设计

### 1. 支付流程

```
用户执行 /subscribe
        ↓
生成 LemonSqueezy Checkout URL
  - 包含 custom_data: { guildId, ownerId }
  - 成功后 redirect 到感谢页面
        ↓
用户完成支付
        ↓
LemonSqueezy 发送 webhook
  - subscription_created
  - order_created
        ↓
Haven 处理 webhook
  - 创建 Subscription 记录
  - 更新 GuildSettings
    - tier = "premium"
    - tierExpiresAt = currentPeriodEnd
    - llmDailyQuota = 100
  - 发送 Discord 通知
        ↓
用户开始使用 Premium
```

### 2. 配额重置机制

```typescript
// 每小时检查一次
cron.schedule("0 * * * *", async () => {
  const guilds = await db.guildSettings.findMany({
    where: {
      tier: "premium",
      llmQuotaResetAt: { lte: new Date() }
    }
  });
  
  for (const guild of guilds) {
    await db.guildSettings.update({
      where: { id: guild.id },
      data: {
        llmUsedToday: 0,
        llmQuotaResetAt: addDays(new Date(), 1)
      }
    });
  }
});
```

### 3. LLM 调用拦截

```typescript
// src/services/llm-client.ts
async function callLLM(guildId: string, messages: Message[]): Promise<string> {
  const guild = await db.guildSettings.findUnique({ where: { guildId } });
  
  // 检查 tier
  if (guild.tier === "free") {
    throw new Error("LLM not available on Free tier");
  }
  
  // 检查配额
  if (guild.llmUsedToday >= guild.llmDailyQuota) {
    throw new QuotaExceededError("Daily LLM quota exceeded");
  }
  
  // 调用 LLM
  const response = await anthropic.messages.create({ /* ... */ });
  
  // 更新用量
  await db.guildSettings.update({
    where: { id: guild.id },
    data: { llmUsedToday: { increment: 1 } }
  });
  
  return response.content[0].text;
}
```

---

## 🎯 任务拆解

### P0: 核心订阅流程

| # | 任务 | 预估 | 依赖 |
|---|------|------|------|
| 1 | Prisma schema 更新（Subscription, BillingEvent） | 1h | - |
| 2 | LemonSqueezy SDK 集成 + 测试 | 2h | 1 |
| 3 | `/subscribe` 命令：生成 checkout URL | 2h | 2 |
| 4 | Webhook endpoint: `/api/webhooks/lemonsqueezy` | 3h | 2 |
| 5 | 处理 `subscription_created` 事件 | 2h | 4 |
| 6 | 处理 `subscription_updated` 事件（续费） | 1h | 4 |
| 7 | 处理 `subscription_canceled` 事件 | 1h | 4 |
| 8 | 端到端测试：Free → Premium → Cancel | 2h | 7 |

### P1: 配额管理

| # | 任务 | 预估 | 依赖 |
|---|------|------|------|
| 9 | LLM 调用拦截器（tier + quota 检查） | 2h | 1 |
| 10 | 配额重置 cron job | 1h | 1 |
| 11 | QuotaExceededError 友好提示 | 1h | 9 |
| 12 | `/billing` 命令：展示用量 + 续费日期 | 2h | 1 |

### P2: 完善体验

| # | 任务 | 预估 | 依赖 |
|---|------|------|------|
| 13 | `/cancel` 命令：取消订阅（保留到期末） | 2h | 2 |
| 14 | 订阅成功 Discord 通知（带欢迎 + 使用指南） | 1h | 5 |
| 15 | 订阅到期提醒（提前 3 天） | 1h | 6 |
| 16 | 支付失败处理 + 重试提示 | 2h | 4 |
| 17 | 管理员命令：手动调整配额/tier | 1h | - |

---

## 🧪 测试场景

### 1. 订阅流程
- [ ] Free Guild 执行 `/subscribe`
- [ ] 完成支付，收到 webhook
- [ ] GuildSettings 更新为 Premium
- [ ] Discord 收到欢迎消息
- [ ] Premium Skills 解锁

### 2. 配额管理
- [ ] Premium Guild 调用 LLM 99 次 ✅
- [ ] 第 100 次调用成功 ✅
- [ ] 第 101 次调用失败，返回友好提示
- [ ] 24h 后配额重置

### 3. 订阅管理
- [ ] `/billing` 显示正确的用量和到期日
- [ ] `/cancel` 标记取消，但保留到期末
- [ ] 到期后自动降级到 Free

---

## 🛡️ 技术决策

### 为什么选 LemonSqueezy 而不是 Stripe？

| 维度 | LemonSqueezy | Stripe |
|------|--------------|--------|
| **费率** | 5% + $0.50 | 2.9% + $0.30 |
| **税务** | 自动处理全球 VAT/GST | 需要自己处理 |
| **合规** | Merchant of Record | 需要自己注册 |
| **集成复杂度** | 简单，开箱即用 | 灵活但复杂 |
| **适用场景** | SaaS、数字产品 | 通用 |

**结论**：Haven 早期重点是快速上线，LemonSqueezy 的自动税务处理和简化合规是巨大优势。Stripe 更灵活但需要更多法务/财务投入。

### LLM 配额设计

**为什么按次数而不是 token？**
- 用户更容易理解"每天 100 次调用"
- 避免复杂的 token 计费和展示
- 成本可控：即使每次调用 10K tokens，成本约 $0.005 × 100 = $0.50/天

**为什么是每日而不是每月？**
- 防止用户集中使用导致成本爆炸
- 更符合日常使用模式（每天检查 digest、问几个问题）
- 技术实现简单（每日重置）

---

## 📊 定价策略

### MVP 定价
- **Free**: $0/月
  - 基础 Digest（无 LLM）
  - Favorites
  
- **Premium**: $9/月
  - 所有 Skills
  - 每日 100 次 LLM 调用
  - 优先支持

### 后续考虑
- **Pro**: $29/月（团队版，多管理员）
- **Enterprise**: 定制定价（白标、私有部署）

---

## 🚀 上线计划

### Phase 1: 内测（2 周）
- 邀请 10 个测试用户
- 免费 Premium 试用
- 收集反馈，修 bug

### Phase 2: 公开 Beta（1 个月）
- 开放订阅
- 前 100 个用户享 50% 折扣（$4.5/月）
- 持续优化

### Phase 3: 正式上线
- 全价 $9/月
- 推广计划启动

---

## 📝 待讨论

1. **Free tier 是否需要信用卡？**
   - 优点：防止滥用，收集支付信息
   - 缺点：提高注册门槛
   - **建议**：MVP 不需要，后续根据滥用情况决定

2. **LLM 配额是否需要"加购"？**
   - 如：额外 $5 = 100 次调用
   - **建议**：MVP 先不做，观察用户是否有需求

3. **是否需要免费试用？**
   - 如：新用户免费 7 天 Premium
   - **建议**：MVP 不做，用折扣码代替

---

## 🔗 参考资料

- [LemonSqueezy Docs](https://docs.lemonsqueezy.com/)
- [Discord Billing Best Practices](https://discord.com/developers/docs/monetization/overview)
- [Pricing SaaS Products](https://www.lennysnewsletter.com/p/how-to-price-your-product)

---

_创建于 2026-01-30_
_预估总工时：P0 (14h) + P1 (6h) + P2 (7h) = 27h_
