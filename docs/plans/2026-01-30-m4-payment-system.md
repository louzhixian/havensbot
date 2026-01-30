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

| # | 任务 | 预估 | 状态 |
|---|------|------|------|
| 1 | Prisma schema 更新（Subscription, BillingEvent） | 1h | ✅ |
| 2 | LemonSqueezy SDK 集成 + 测试 | 2h | ✅ |
| 3 | `/subscribe` 命令：生成 checkout URL | 2h | ✅ |
| 4 | Webhook endpoint: `/api/webhooks/lemonsqueezy` | 3h | ✅ |
| 5 | 处理 `subscription_created` 事件 | 2h | ✅ |
| 6 | 处理 `subscription_updated` 事件（续费） | 1h | ✅ |
| 7 | 处理 `subscription_canceled` 事件 | 1h | ✅ |
| 8 | 端到端测试：Free → Premium → Cancel | 2h | ⏸️ (需实际配置) |

### P1: 配额管理

| # | 任务 | 预估 | 状态 |
|---|------|------|------|
| 9 | LLM 调用拦截器（tier + quota 检查） | 2h | ✅ |
| 10 | 配额重置 cron job | 1h | ✅ |
| 11 | QuotaExceededError 友好提示 | 1h | ✅ |
| 12 | `/billing` 命令：展示用量 + 续费日期 | 2h | ✅ |

### P2: 完善体验

| # | 任务 | 预估 | 状态 |
|---|------|------|------|
| 13 | `/cancel` 命令：取消订阅（保留到期末） | 2h | ✅ |
| 14 | 订阅成功 Discord 通知（带欢迎 + 使用指南） | 1h | ✅ |
| 15 | 订阅到期提醒（提前 3 天） | 1h | ✅ |
| 16 | 支付失败处理 + 重试提示 | 2h | ✅ |
| 17 | 管理员命令：手动调整配额/tier | 1h | ✅ |

**完成度**: 16/17 (94%)

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

## ✅ 实施总结 (2026-01-30)

### 完成状态
- **P0**: 7/8 完成 (87.5%)
- **P1**: 4/4 完成 (100%) ✅
- **P2**: 5/5 完成 (100%) ✅
- **总计**: 16/17 完成 (94%)

### 已实现功能

**核心订阅流程**:
- ✅ Prisma schema (Subscription, BillingEvent, llmQuotaResetAt)
- ✅ LemonSqueezy SDK 集成 (`@lemonsqueezy/lemonsqueezy.js`)
- ✅ `/subscribe` 命令（生成 checkout URL）
- ✅ `/billing` 命令（显示订阅状态和用量）
- ✅ `/cancel` 命令（取消订阅，保留到期末）
- ✅ Webhook 处理（subscription_created/updated/cancelled/payment_success/payment_failed/payment_recovered）
- ✅ Express HTTP server（接收 webhooks）
- ✅ HMAC-SHA256 签名验证（防时序攻击）

**配额管理系统**:
- ✅ LLM Service (`llm.service.ts`) - 统一调用接口
- ✅ Tier 和 Quota 检查（Free tier 拒绝，Premium tier 检查配额）
- ✅ 自定义错误类型（QuotaExceededError, TierRestrictedError）
- ✅ 配额重置 cron job（每小时检查，重置过期配额）
- ✅ 订阅创建时初始化配额重置时间

**用户体验**:
- ✅ 订阅成功 Discord 通知（欢迎消息 + 功能介绍 + 快速开始）
- ✅ 订阅到期提醒（提前 3 天，每日 9:00 AM）
- ✅ 支付失败通知（故障排除步骤 + 支持资源）
- ✅ 支付恢复通知（确认消息）
- ✅ 管理员命令（`/admin set-tier/set-quota/reset-quota/info`）

**安全与审计**:
- ✅ Webhook 签名验证（crypto.timingSafeEqual）
- ✅ BillingEvent 审计日志（所有事件存储）
- ✅ 权限控制（管理员命令需 Administrator 权限）

### 技术债务与后续工作

**待完成**:
1. **P0 #8**: 端到端测试（需要实际 LemonSqueezy 账号和配置）
   - 创建测试商店和产品
   - 配置 webhook URL (需 ngrok 或公网域名)
   - 测试完整流程：注册 → 订阅 → 续费 → 取消

2. **迁移现有 LLM 调用**:
   - Digest skill
   - Editorial skill
   - Readings skill
   - Diary skill
   - 迁移到 `llm.service.ts` 的 `callLlmWithQuota()`

3. **生产部署配置**:
   - 设置环境变量（LEMONSQUEEZY_API_KEY, STORE_ID, VARIANT_ID, WEBHOOK_SECRET）
   - 配置 webhook URL（需 HTTPS）
   - 设置 HTTP_PORT（默认 3000）
   - 配置防火墙规则（开放 HTTP_PORT）

### 架构亮点

1. **工厂模式**: Webhook handler 接受 Discord client，避免全局依赖
2. **类型安全**: 自定义错误类型 + TypeScript 严格模式
3. **关注点分离**: Service 层（lemonsqueezy, llm, quota-reset, subscription-reminder）独立
4. **优雅降级**: Free tier 自动跳过 LLM 功能，避免崩溃
5. **定时任务**: Cron jobs 统一管理（配额重置、到期提醒）
6. **审计日志**: 所有 billing 事件持久化，可追溯

### 成本估算

**LemonSqueezy 费用**: 5% + $0.50/transaction  
**月度订阅**: $9/month  
→ LemonSqueezy 收取: $0.95/month  
→ Haven 收入: $8.05/month

**LLM 成本** (Claude 3.5 Sonnet):
- 100 calls/day × 30 天 = 3000 calls/month
- 假设平均每次 5K input + 1K output tokens
- Input: 3000 × 5K × $0.003/1K = $45/month
- Output: 3000 × 1K × $0.015/1K = $45/month
- **总 LLM 成本**: ~$90/month

**盈亏平衡**: 需约 12 个 Premium 用户（$8.05 × 12 = $96.60）

---

_创建于 2026-01-30_  
_完成于 2026-01-30_  
_预估工时：27h | 实际工时：~6h (heartbeat 自动执行)_
