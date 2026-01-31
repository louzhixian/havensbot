# M5: 公开上线计划

> 目标：让 Haven 可以被外部用户发现、了解、使用

## 概述

M4（付费系统）已基本完成，下一步是准备公开上线所需的一切。

---

## 任务清单

### P0: 必须上线前完成

| # | 任务 | 预估 | 状态 |
|---|------|------|------|
| 1 | Landing page (havens.bot) - 单页介绍 + Add to Discord 按钮 | 3h | ⏳ |
| 2 | Discord OAuth2 Bot 邀请链接（正确 scope + permissions） | 0.5h | ⏳ |
| 3 | 生产部署配置（env vars, webhook URL, HTTPS） | 2h | ⏳ |
| 4 | LemonSqueezy 配置（商品、价格、webhook） | 1h | ⏳ |
| 5 | Bot 公开资料完善（头像、描述、Privacy Policy URL） | 1h | ⏳ |
| 6 | 端到端冒烟测试（新 Guild 加入 → setup → skills → subscribe） | 2h | ⏳ |

### P1: 上线后尽快

| # | 任务 | 预估 | 状态 |
|---|------|------|------|
| 7 | 文档站（Skills 说明、FAQ、Getting Started） | 4h | ⏳ |
| 8 | Discord 社区服务器（支持频道、公告频道） | 1h | ⏳ |
| 9 | 错误监控 + 告警（Sentry 或简单 webhook） | 2h | ⏳ |
| 10 | 基本分析（Guild 数量、活跃用户、LLM 用量仪表盘） | 2h | ⏳ |

### P2: 增长

| # | 任务 | 预估 | 状态 |
|---|------|------|------|
| 11 | Discord App Directory 提交 | 2h | ⏳ |
| 12 | 介绍文章 / Twitter thread | 2h | ⏳ |
| 13 | top.gg 等 Bot 列表站提交 | 1h | ⏳ |

---

## Landing Page 设计

### 结构（单页）
1. **Hero**: 标语 + Add to Discord CTA
2. **Skills 展示**: 卡片式展示各 Skill（Free/Premium 标签）
3. **定价**: Free vs Premium 对比表
4. **FAQ**: 常见问题
5. **Footer**: Links, Privacy Policy, Terms

### 技术方案
- 静态站点（Astro / plain HTML + Tailwind）
- 部署：Cloudflare Pages 或 VPS nginx
- 域名：havens.bot（需配置 DNS）

---

## 生产部署 Checklist

- [ ] 域名 DNS 配置（havens.bot → VPS IP）
- [ ] HTTPS 证书（Let's Encrypt / Cloudflare）
- [ ] 环境变量设置：
  - `LEMONSQUEEZY_API_KEY`
  - `LEMONSQUEEZY_STORE_ID`
  - `LEMONSQUEEZY_VARIANT_ID`
  - `LEMONSQUEEZY_WEBHOOK_SECRET`
  - `HTTP_PORT`
- [ ] 防火墙开放 HTTP_PORT
- [ ] Webhook URL 在 LemonSqueezy 注册
- [ ] 监控 / 健康检查端点

---

_创建日期：2026-01-31_
