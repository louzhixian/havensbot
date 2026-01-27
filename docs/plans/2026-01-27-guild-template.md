# Guild Template 功能设计

## 概述

让新用户可以一键复刻成熟的 Guild 结构，无需手动创建频道和配置。

## 命令

### `/template apply <name>`
应用预设模板到当前 Guild

**流程**：
1. 检查用户权限（需要 MANAGE_CHANNELS）
2. 读取模板定义
3. 创建 categories
4. 创建 channels（带正确的 parent）
5. 写入 ChannelConfig 角色映射
6. 返回创建结果

### `/template list`
列出可用模板

## 内置模板：`havens-default`

```yaml
name: havens-default
description: Haven 标准布局

# 默认 Guild 设置
guildSettings:
  timezone: "Asia/Tokyo"
  locale: "zh"
  enabledSkills: ["digest", "favorites"]

categories:
  - name: "📰 信息源"
    slug: sources
    channels:
      - name: tech-news
        type: text
        role: digest_source
      - name: crypto-news
        type: text
        role: digest_source

  - name: "📋 输出"
    slug: outputs
    channels:
      - name: daily-digest
        type: forum
        role: digest_output
      - name: favorites
        type: text
        role: favorites
      - name: deep-dive
        type: forum
        role: deep_dive_output

  - name: "🔧 系统"
    slug: system
    channels:
      - name: havens-admin
        type: text
        role: admin
        permissions:
          # 只有管理员可见
          - type: role
            id: "@everyone"
            deny: ["VIEW_CHANNEL"]
      - name: havens-alerts
        type: text
        role: alerts
        permissions:
          - type: role
            id: "@everyone"
            deny: ["SEND_MESSAGES"]  # 只读
```

## 数据模型

```prisma
model GuildTemplate {
  id          String   @id @default(cuid())
  name        String   @unique
  description String
  structure   Json     // 模板结构
  isBuiltin   Boolean  @default(false)
  createdBy   String?  // guildId，内置模板为 null
  createdAt   DateTime @default(now())
}
```

## 实现步骤

### Task 15: Add GuildTemplate model
- 添加 Prisma model
- 生成 migration

### Task 16: Create template service
- `getTemplate(name)` 
- `listTemplates()`
- `applyTemplate(guildId, templateName)`

### Task 17: Add /template commands
- `/template list`
- `/template apply <name>`

### Task 18: Seed builtin template
- 创建 `arkcore-default` 模板
- 在启动时自动 seed

## 注意事项

- 创建频道需要 bot 有 MANAGE_CHANNELS 权限
- Forum channel 创建需要特殊处理
- 如果频道已存在，跳过并提示
