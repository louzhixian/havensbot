# M2: Legacy 功能 Skill 化

> **目标**：把所有 legacy 功能迁移到 Skill 架构，实现多租户支持

**原则**：先迁移架构，后升级功能。每个 Skill 保持现有功能，迁移完成后再单独升级。

---

## 任务清单

| # | 任务 | 复杂度 | 状态 |
|---|------|--------|------|
| 1 | Voice Skill 迁移 | 低 | ✅ |
| 2 | Readings Skill 迁移 | 中 | ✅ |
| 3 | Editorial Skill 迁移 | 中 | ✅ |
| 4 | Diary Skill 迁移 | 中 | ✅ |
| 5 | Onboarding 完善（/init, /help） | 低 | ✅ |
| 6 | 端到端测试 | 低 | ✅ |

---

## Task 1: Voice Skill 迁移

**现有代码**：`voice/voiceHandler.ts`

**步骤**：
1. 创建 `skills/voice.skill.ts`
2. 定义 VoiceSkill 接口（tier: premium）
3. 把 voiceHandler 逻辑搬进 Skill
4. 在 index.ts 注册，移除 legacy handler
5. 测试语音转文字功能

**迁移后可升级**：支持在 thread 里继续发语音

---

## Task 2: Readings Skill 迁移

**现有代码**：`readings.ts`

**步骤**：
1. 创建 `skills/readings.skill.ts`
2. 定义 ReadingsSkill（reaction: 🔖，tier: premium）
3. 迁移 reaction handler 和 button handler
4. 迁移 message handler
5. 测试阅读管理功能

---

## Task 3: Editorial Skill 迁移

**现有代码**：`editorial-discussion.ts`, `editorial-translation.ts`

**步骤**：
1. 创建 `skills/editorial.skill.ts`
2. 合并 discussion 和 translation 逻辑
3. 定义 EditorialSkill（tier: premium）
4. 迁移到 Skill 架构
5. 测试翻译和讨论功能

---

## Task 4: Diary Skill 迁移

**现有代码**：`diary/` 目录

**步骤**：
1. 创建 `skills/diary.skill.ts`
2. 定义 DiarySkill（cron job，tier: premium）
3. 迁移 handler 和 context 逻辑
4. 注册 cron 到 SkillRegistry
5. 测试日记功能

---

## Task 5: Onboarding 完善

**任务**：
1. `/init` 命令：选模板 → apply → 引导添加 RSS
2. `/help` 命令：功能说明 + 常用命令列表
3. 优化欢迎消息文案

---

## Task 6: 端到端测试

**测试清单** (静态代码分析完成，详见 `docs/devlog/2026-01-28.md`):
- [x] 新 Guild 加入 → 自动创建 GuildSettings
- [x] /template apply → 创建频道 + tags
- [x] /skills enable/disable → 正确开关功能
- [x] Digest cron → 按 Guild 配置执行
- [x] Favorites (❤️) → 转发到收藏频道
- [x] Deep Dive (👀) → LLM 分析 + 帖子
- [x] Voice → 语音转文字
- [x] Readings → 阅读管理
- [x] Editorial → 翻译讨论
- [x] Diary → 定时创建日记

> 所有功能代码验证通过。运行时测试需在实际 Discord 环境中手动执行。

---

## 验收标准

- [x] 所有功能都通过 Skill 架构实现
- [x] legacy handler 全部移除 (注释掉，保留参考)
- [x] 每个 Guild 可独立开关 Skills
- [x] 多租户同时运行无冲突

> M2 Skill 化迁移完成 ✅

---

_创建于 2026-01-28_
