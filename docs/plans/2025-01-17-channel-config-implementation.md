# Channel Configuration & Diary Forum Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 channel/forum 配置从 env 迁移到数据库，实现 /config 命令管理，并将 Diary 改造为 forum + 按钮交互模式。

**Architecture:** 新增 ChannelConfig 表存储配置，实现固定 channel 名称查找机制，通过 /config 命令 CRUD 配置，改造各模块读取数据库配置，最后实现 Diary 按钮交互。

**Tech Stack:** TypeScript, Discord.js (Buttons/Components), Prisma, PostgreSQL

---

## Phase 1: 基础设施

### Task 1: 添加 ChannelConfig 数据库表

**Files:**
- Modify: `prisma/schema.prisma`

**Step 1: 添加 ChannelConfig model 到 schema**

在 `prisma/schema.prisma` 末尾添加：

```prisma
enum ChannelConfigRole {
  digest_source
  digest_output
  deep_dive_output
  diary
  favorites
  editorial
}

model ChannelConfig {
  id          String            @id @default(cuid())
  guildId     String
  channelId   String?
  categoryId  String?
  role        ChannelConfigRole
  digestCron  String?
  digestFormat String?
  enabled     Boolean           @default(true)
  createdAt   DateTime          @default(now())
  updatedAt   DateTime          @updatedAt

  @@unique([guildId, channelId, role])
  @@unique([guildId, categoryId, role])
  @@index([guildId, role])
}
```

**Step 2: 生成并运行迁移**

```bash
cd /Users/zhixian/Codes/ArkCore
npx prisma migrate dev --name add_channel_config
```

**Step 3: 验证生成的 Prisma Client**

```bash
npx prisma generate
pnpm build
```

**Step 4: Commit**

```bash
git add prisma/
git commit -m "feat(db): add ChannelConfig table for database-driven configuration"
```

---

### Task 2: 创建 channel-config 服务模块

**Files:**
- Create: `apps/arkcore/src/channel-config.ts`

**Step 1: 创建配置服务文件**

```typescript
import { Client, ChannelType, Guild, PermissionFlagsBits } from "discord.js";
import { prisma } from "./db.js";
import { logger } from "./observability/logger.js";

// 固定 channel 名称
export const ADMIN_CHANNEL_NAME = "arkcore-admin";
export const ALERTS_CHANNEL_NAME = "arkcore-alerts";

export type ChannelConfigRole =
  | "digest_source"
  | "digest_output"
  | "deep_dive_output"
  | "diary"
  | "favorites"
  | "editorial";

export type ChannelConfigData = {
  id: string;
  guildId: string;
  channelId: string | null;
  categoryId: string | null;
  role: ChannelConfigRole;
  digestCron: string | null;
  digestFormat: string | null;
  enabled: boolean;
};

/**
 * 查找固定名称的 channel
 */
export const findFixedChannel = async (
  guild: Guild,
  channelName: string
): Promise<string | null> => {
  const channel = guild.channels.cache.find(
    (ch) => ch.name === channelName && ch.isTextBased() && !ch.isThread()
  );
  return channel?.id ?? null;
};

/**
 * 配置固定 channel 的权限（仅管理员可见）
 */
export const setupAdminChannelPermissions = async (
  guild: Guild,
  channelId: string
): Promise<boolean> => {
  try {
    const channel = await guild.channels.fetch(channelId);
    if (!channel || !("permissionOverwrites" in channel)) return false;

    await channel.permissionOverwrites.set([
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel],
      },
    ]);

    logger.info({ channelId, guildId: guild.id }, "Admin channel permissions configured");
    return true;
  } catch (error) {
    logger.error({ error, channelId }, "Failed to configure admin channel permissions");
    return false;
  }
};

/**
 * 获取指定角色的配置
 */
export const getConfigByRole = async (
  guildId: string,
  role: ChannelConfigRole
): Promise<ChannelConfigData | null> => {
  const config = await prisma.channelConfig.findFirst({
    where: { guildId, role, enabled: true },
  });
  return config as ChannelConfigData | null;
};

/**
 * 获取所有 digest source categories
 */
export const getDigestSourceCategories = async (
  guildId: string
): Promise<ChannelConfigData[]> => {
  const configs = await prisma.channelConfig.findMany({
    where: { guildId, role: "digest_source", enabled: true },
  });
  return configs as ChannelConfigData[];
};

/**
 * 设置配置
 */
export const setConfig = async (
  guildId: string,
  role: ChannelConfigRole,
  data: {
    channelId?: string;
    categoryId?: string;
    digestCron?: string;
    digestFormat?: string;
  }
): Promise<ChannelConfigData> => {
  const where = data.channelId
    ? { guildId_channelId_role: { guildId, channelId: data.channelId, role } }
    : { guildId_categoryId_role: { guildId, categoryId: data.categoryId!, role } };

  const config = await prisma.channelConfig.upsert({
    where,
    create: {
      guildId,
      role,
      channelId: data.channelId ?? null,
      categoryId: data.categoryId ?? null,
      digestCron: data.digestCron ?? null,
      digestFormat: data.digestFormat ?? null,
    },
    update: {
      digestCron: data.digestCron,
      digestFormat: data.digestFormat,
      enabled: true,
    },
  });
  return config as ChannelConfigData;
};

/**
 * 删除配置
 */
export const removeConfig = async (id: string): Promise<boolean> => {
  try {
    await prisma.channelConfig.delete({ where: { id } });
    return true;
  } catch {
    return false;
  }
};

/**
 * 获取所有配置
 */
export const listConfigs = async (guildId: string): Promise<ChannelConfigData[]> => {
  const configs = await prisma.channelConfig.findMany({
    where: { guildId },
    orderBy: { role: "asc" },
  });
  return configs as ChannelConfigData[];
};
```

**Step 2: 导出到 db.ts**

在 `apps/arkcore/src/db.ts` 添加导出（如果需要）。

**Step 3: Build 验证**

```bash
pnpm build
```

**Step 4: Commit**

```bash
git add apps/arkcore/src/channel-config.ts
git commit -m "feat: add channel-config service for database-driven configuration"
```

---

### Task 3: 实现固定 channel 初始化逻辑

**Files:**
- Modify: `apps/arkcore/src/index.ts`

**Step 1: 在 bot 启动时初始化固定 channel**

在 `index.ts` 的 `client.once("ready")` 中添加：

```typescript
import {
  ADMIN_CHANNEL_NAME,
  ALERTS_CHANNEL_NAME,
  findFixedChannel,
  setupAdminChannelPermissions,
} from "./channel-config.js";

// 在 ready 事件中添加
client.once("ready", async () => {
  console.log(`Logged in as ${client.user?.tag}`);

  // 初始化固定 channel
  const guild = client.guilds.cache.get(config.discordGuildId);
  if (guild) {
    const adminChannelId = await findFixedChannel(guild, ADMIN_CHANNEL_NAME);
    const alertsChannelId = await findFixedChannel(guild, ALERTS_CHANNEL_NAME);

    if (adminChannelId) {
      await setupAdminChannelPermissions(guild, adminChannelId);
      logger.info({ channelId: adminChannelId }, "Admin channel initialized");
    } else {
      logger.warn(`Admin channel #${ADMIN_CHANNEL_NAME} not found`);
    }

    if (alertsChannelId) {
      await setupAdminChannelPermissions(guild, alertsChannelId);
      logger.info({ channelId: alertsChannelId }, "Alerts channel initialized");
    } else {
      logger.warn(`Alerts channel #${ALERTS_CHANNEL_NAME} not found`);
    }
  }

  // ... 其余启动逻辑
});
```

**Step 2: Build 验证**

```bash
pnpm build
```

**Step 3: Commit**

```bash
git add apps/arkcore/src/index.ts
git commit -m "feat: initialize fixed admin/alerts channels on startup"
```

---

## Phase 2: 配置命令

### Task 4: 创建 /config 命令框架

**Files:**
- Modify: `apps/arkcore/src/commands.ts`

**Step 1: 添加 /config 命令定义**

在 `commandData` 数组中添加：

```typescript
new SlashCommandBuilder()
  .setName("config")
  .setDescription("Manage ArkCore configuration")
  .addSubcommandGroup((group) =>
    group
      .setName("digest")
      .setDescription("Digest configuration")
      .addSubcommand((sub) =>
        sub
          .setName("add-category")
          .setDescription("Add a digest source category")
          .addChannelOption((opt) =>
            opt.setName("category").setDescription("Category to add").setRequired(true)
          )
          .addStringOption((opt) =>
            opt.setName("cron").setDescription("Cron schedule (e.g., 0 9 * * *)").setRequired(false)
          )
          .addStringOption((opt) =>
            opt
              .setName("format")
              .setDescription("Digest format")
              .addChoices(
                { name: "Brief", value: "brief" },
                { name: "Detailed", value: "detailed" },
                { name: "Minimal", value: "minimal" }
              )
              .setRequired(false)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("set-output")
          .setDescription("Set digest output forum")
          .addChannelOption((opt) =>
            opt.setName("channel").setDescription("Forum channel").setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub.setName("list").setDescription("List digest configurations")
      )
      .addSubcommand((sub) =>
        sub
          .setName("remove")
          .setDescription("Remove a digest category")
          .addChannelOption((opt) =>
            opt.setName("category").setDescription("Category to remove").setRequired(true)
          )
      )
  )
  .addSubcommandGroup((group) =>
    group
      .setName("diary")
      .setDescription("Diary configuration")
      .addSubcommand((sub) =>
        sub
          .setName("set-channel")
          .setDescription("Set diary forum channel")
          .addChannelOption((opt) =>
            opt.setName("channel").setDescription("Forum channel").setRequired(true)
          )
      )
  )
  .addSubcommand((sub) =>
    sub.setName("list").setDescription("List all configurations")
  ),
```

**Step 2: 添加命令处理逻辑**

在 `handleInteraction` 函数中添加 config 命令处理：

```typescript
import {
  ADMIN_CHANNEL_NAME,
  findFixedChannel,
  setConfig,
  removeConfig,
  listConfigs,
  getConfigByRole,
  getDigestSourceCategories,
} from "./channel-config.js";

// 在 handleInteraction 中添加
if (commandName === "config") {
  // 检查是否在 admin channel
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
    return;
  }

  const adminChannelId = await findFixedChannel(guild, ADMIN_CHANNEL_NAME);
  if (interaction.channelId !== adminChannelId) {
    await interaction.reply({
      content: `This command can only be used in #${ADMIN_CHANNEL_NAME}`,
      ephemeral: true,
    });
    return;
  }

  const subcommandGroup = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand();

  if (subcommandGroup === "digest") {
    if (subcommand === "add-category") {
      const category = interaction.options.getChannel("category", true);
      const cron = interaction.options.getString("cron");
      const format = interaction.options.getString("format");

      if (category.type !== ChannelType.GuildCategory) {
        await interaction.reply({ content: "Please select a category, not a channel.", ephemeral: true });
        return;
      }

      await setConfig(guild.id, "digest_source", {
        categoryId: category.id,
        digestCron: cron ?? undefined,
        digestFormat: format ?? undefined,
      });

      await interaction.reply(`Added digest source category: ${category.name}`);
      return;
    }

    if (subcommand === "set-output") {
      const channel = interaction.options.getChannel("channel", true);

      if (channel.type !== ChannelType.GuildForum) {
        await interaction.reply({ content: "Please select a forum channel.", ephemeral: true });
        return;
      }

      await setConfig(guild.id, "digest_output", { channelId: channel.id });
      await interaction.reply(`Set digest output to: ${channel.name}`);
      return;
    }

    if (subcommand === "list") {
      const categories = await getDigestSourceCategories(guild.id);
      const output = await getConfigByRole(guild.id, "digest_output");

      let response = "**Digest Configuration**\n\n";
      response += `**Output:** ${output ? `<#${output.channelId}>` : "Not set"}\n\n`;
      response += "**Source Categories:**\n";

      if (categories.length === 0) {
        response += "None configured";
      } else {
        for (const cat of categories) {
          response += `- <#${cat.categoryId}> (cron: ${cat.digestCron ?? "default"}, format: ${cat.digestFormat ?? "default"})\n`;
        }
      }

      await interaction.reply(response);
      return;
    }

    if (subcommand === "remove") {
      const category = interaction.options.getChannel("category", true);
      const configs = await getDigestSourceCategories(guild.id);
      const config = configs.find((c) => c.categoryId === category.id);

      if (!config) {
        await interaction.reply({ content: "Category not found in configuration.", ephemeral: true });
        return;
      }

      await removeConfig(config.id);
      await interaction.reply(`Removed digest source category: ${category.name}`);
      return;
    }
  }

  if (subcommandGroup === "diary") {
    if (subcommand === "set-channel") {
      const channel = interaction.options.getChannel("channel", true);

      if (channel.type !== ChannelType.GuildForum) {
        await interaction.reply({ content: "Please select a forum channel.", ephemeral: true });
        return;
      }

      await setConfig(guild.id, "diary", { channelId: channel.id });
      await interaction.reply(`Set diary forum to: ${channel.name}`);
      return;
    }
  }

  if (subcommand === "list") {
    const configs = await listConfigs(guild.id);

    if (configs.length === 0) {
      await interaction.reply("No configurations found.");
      return;
    }

    let response = "**All Configurations**\n\n";
    for (const cfg of configs) {
      const target = cfg.channelId ? `<#${cfg.channelId}>` : `Category: ${cfg.categoryId}`;
      response += `- **${cfg.role}**: ${target}\n`;
    }

    await interaction.reply(response);
    return;
  }
}
```

**Step 3: Build 验证**

```bash
pnpm build
```

**Step 4: Commit**

```bash
git add apps/arkcore/src/commands.ts
git commit -m "feat: add /config command for database-driven configuration"
```

---

### Task 5: 添加其他功能配置命令

**Files:**
- Modify: `apps/arkcore/src/commands.ts`

**Step 1: 扩展 /config 命令支持 favorites, deep-dive, editorial**

在 SlashCommandBuilder 中添加更多 subcommand groups：

```typescript
.addSubcommandGroup((group) =>
  group
    .setName("favorites")
    .setDescription("Favorites configuration")
    .addSubcommand((sub) =>
      sub
        .setName("set-channel")
        .setDescription("Set favorites output channel")
        .addChannelOption((opt) =>
          opt.setName("channel").setDescription("Text channel").setRequired(true)
        )
    )
)
.addSubcommandGroup((group) =>
  group
    .setName("deep-dive")
    .setDescription("Deep-dive configuration")
    .addSubcommand((sub) =>
      sub
        .setName("set-output")
        .setDescription("Set deep-dive output forum")
        .addChannelOption((opt) =>
          opt.setName("channel").setDescription("Forum channel").setRequired(true)
        )
    )
)
.addSubcommandGroup((group) =>
  group
    .setName("editorial")
    .setDescription("Editorial configuration")
    .addSubcommand((sub) =>
      sub
        .setName("set-channel")
        .setDescription("Set editorial channel")
        .addChannelOption((opt) =>
          opt.setName("channel").setDescription("Text channel").setRequired(true)
        )
    )
)
```

**Step 2: 添加对应的处理逻辑**

```typescript
if (subcommandGroup === "favorites") {
  if (subcommand === "set-channel") {
    const channel = interaction.options.getChannel("channel", true);
    await setConfig(guild.id, "favorites", { channelId: channel.id });
    await interaction.reply(`Set favorites channel to: ${channel.name}`);
    return;
  }
}

if (subcommandGroup === "deep-dive") {
  if (subcommand === "set-output") {
    const channel = interaction.options.getChannel("channel", true);
    if (channel.type !== ChannelType.GuildForum) {
      await interaction.reply({ content: "Please select a forum channel.", ephemeral: true });
      return;
    }
    await setConfig(guild.id, "deep_dive_output", { channelId: channel.id });
    await interaction.reply(`Set deep-dive output to: ${channel.name}`);
    return;
  }
}

if (subcommandGroup === "editorial") {
  if (subcommand === "set-channel") {
    const channel = interaction.options.getChannel("channel", true);
    await setConfig(guild.id, "editorial", { channelId: channel.id });
    await interaction.reply(`Set editorial channel to: ${channel.name}`);
    return;
  }
}
```

**Step 3: Build 验证**

```bash
pnpm build
```

**Step 4: Commit**

```bash
git add apps/arkcore/src/commands.ts
git commit -m "feat: add config commands for favorites, deep-dive, editorial"
```

---

## Phase 3: 模块改造

### Task 6: 改造 favorites.ts 读取数据库配置

**Files:**
- Modify: `apps/arkcore/src/favorites.ts`

**Step 1: 修改 registerFavoriteReactionHandler 函数**

将 `config.favChannelId` 和 `config.deepDiveForumId` 改为从数据库读取：

```typescript
import { getConfigByRole } from "./channel-config.js";

export const registerFavoriteReactionHandler = (
  client: Client,
  config: AppConfig
): void => {
  client.on("messageReactionAdd", async (reaction, user) => {
    try {
      if (user.bot) return;

      const message = await ensureMessage(reaction);
      if (!message || !message.guild) return;

      const guildId = message.guild.id;

      // 从数据库获取配置
      const favConfig = await getConfigByRole(guildId, "favorites");
      const deepDiveConfig = await getConfigByRole(guildId, "deep_dive_output");

      const favChannelId = favConfig?.channelId;
      const deepDiveForumId = deepDiveConfig?.channelId;

      if (!favChannelId && !deepDiveForumId) return;

      const emojiName = normalizeEmoji(reaction.emoji.name);
      const isHeart = HEART_EMOJIS.has(emojiName);
      const isEyes = EYES_EMOJIS.has(emojiName);
      if (!isHeart && !isEyes) return;

      // ... 其余逻辑保持不变，使用 favChannelId 和 deepDiveForumId
    } catch (error) {
      console.error("favorite reaction handler failed", error);
    }
  });

  // ... messageReactionRemove 处理类似修改
};
```

**Step 2: Build 验证**

```bash
pnpm build
```

**Step 3: Commit**

```bash
git add apps/arkcore/src/favorites.ts
git commit -m "refactor(favorites): read config from database instead of env"
```

---

### Task 7: 改造 scheduler.ts 支持 category-based digest

**Files:**
- Modify: `apps/arkcore/src/scheduler.ts`

**Step 1: 修改 digest cron job 读取数据库配置**

```typescript
import { getDigestSourceCategories, getConfigByRole } from "./channel-config.js";

// 在 digest cron job 中
cron.schedule(
  config.digestCron, // 默认 cron，可被 category 配置覆盖
  async () => {
    console.log(`digest cron tick: ${new Date().toISOString()}`);
    if (digesting) return;
    digesting = true;

    try {
      const guild = client.guilds.cache.get(config.discordGuildId);
      if (!guild) {
        console.error("Guild not found");
        return;
      }

      // 获取 digest 输出配置
      const outputConfig = await getConfigByRole(guild.id, "digest_output");
      const digestForumId = outputConfig?.channelId;

      // 获取所有 digest source categories
      const categories = await getDigestSourceCategories(guild.id);

      if (categories.length === 0) {
        // 降级到旧逻辑：使用 Source 表的 channelId
        const channels = await prisma.source.findMany({
          where: { enabled: true },
          distinct: ["channelId"],
          select: { channelId: true },
        });

        for (const channel of channels) {
          await processDigestForChannel(client, config, channel.channelId, digestForumId);
        }
      } else {
        // 新逻辑：按 category 处理
        for (const catConfig of categories) {
          if (!catConfig.categoryId) continue;

          // 获取 category 下所有 text channel
          const category = guild.channels.cache.get(catConfig.categoryId);
          if (!category || category.type !== ChannelType.GuildCategory) continue;

          const textChannels = guild.channels.cache.filter(
            (ch) => ch.parentId === catConfig.categoryId && ch.type === ChannelType.GuildText
          );

          for (const [channelId] of textChannels) {
            await processDigestForChannel(
              client,
              config,
              channelId,
              digestForumId,
              catConfig.digestFormat ?? undefined
            );
          }
        }
      }
    } catch (error) {
      console.error("digest job failed", error);
    } finally {
      digesting = false;
    }
  },
  { timezone: config.tz, recoverMissedExecutions: true }
);
```

**Step 2: 抽取 processDigestForChannel 函数**

```typescript
const processDigestForChannel = async (
  client: Client,
  config: AppConfig,
  channelId: string,
  digestForumId: string | null | undefined,
  format?: string
): Promise<void> => {
  const channelStart = Date.now();
  try {
    // Fetch channel name for forum tagging
    let channelName: string | undefined;
    if (digestForumId) {
      try {
        const discordChannel = await client.channels.fetch(channelId);
        if (discordChannel && "name" in discordChannel && discordChannel.name) {
          channelName = discordChannel.name;
        }
      } catch {
        // Channel name is optional
      }
    }

    const { rangeStart, rangeEnd } = await resolveDigestRange(channelId);
    console.log(
      `digest channel start: channelId=${channelId} rangeStart=${rangeStart.toISOString()} rangeEnd=${rangeEnd.toISOString()}`
    );

    const digest = await createDigest(config, channelId, rangeStart, rangeEnd);

    if (digestForumId) {
      await sendDigestToForum(client, digestForumId, digest, config, channelName);
    } else if (config.digestThreadMode) {
      await sendDigestThreaded(client, channelId, digest, config);
    } else {
      await sendDigestOverview(client, channelId, digest, config);
    }

    console.log(
      `digest channel sent: channelId=${channelId} duration_ms=${Date.now() - channelStart}`
    );
  } catch (error) {
    console.error(`digest job failed for channel ${channelId}`, error);
  }
};
```

**Step 3: Build 验证**

```bash
pnpm build
```

**Step 4: Commit**

```bash
git add apps/arkcore/src/scheduler.ts
git commit -m "refactor(scheduler): support category-based digest from database config"
```

---

### Task 8: 改造 editorial-discussion.ts 读取数据库配置

**Files:**
- Modify: `apps/arkcore/src/editorial-discussion.ts`

**Step 1: 修改 registerEditorialDiscussionHandlers**

```typescript
import { getConfigByRole } from "./channel-config.js";

export const registerEditorialDiscussionHandlers = (
  client: Client,
  config: AppConfig
): void => {
  client.on("messageCreate", async (message) => {
    try {
      if (message.author.bot) return;
      if (!message.guild) return;

      // 从数据库获取配置
      const editorialConfig = await getConfigByRole(message.guild.id, "editorial");
      const editorialChannelId = editorialConfig?.channelId;

      if (!editorialChannelId) return;

      // ... 其余逻辑保持不变
    } catch (error) {
      console.error("editorial handler failed", error);
    }
  });
};
```

**Step 2: Build 验证**

```bash
pnpm build
```

**Step 3: Commit**

```bash
git add apps/arkcore/src/editorial-discussion.ts
git commit -m "refactor(editorial): read config from database instead of env"
```

---

## Phase 4: Diary Forum + 按钮

### Task 9: 添加 Diary 按钮组件

**Files:**
- Create: `apps/arkcore/src/diary/buttons.ts`

**Step 1: 创建按钮构建器**

```typescript
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type MessageActionRowComponentBuilder,
} from "discord.js";

export const DIARY_START_BUTTON_ID = "diary_start";
export const DIARY_END_BUTTON_ID = "diary_end";

export const buildDiaryStartButton = (): ActionRowBuilder<MessageActionRowComponentBuilder> => {
  const button = new ButtonBuilder()
    .setCustomId(DIARY_START_BUTTON_ID)
    .setLabel("📝 开始日记")
    .setStyle(ButtonStyle.Primary);

  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(button);
};

export const buildDiaryEndButton = (): ActionRowBuilder<MessageActionRowComponentBuilder> => {
  const button = new ButtonBuilder()
    .setCustomId(DIARY_END_BUTTON_ID)
    .setLabel("✅ 结束日记")
    .setStyle(ButtonStyle.Success);

  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(button);
};

export const buildDisabledButton = (label: string): ActionRowBuilder<MessageActionRowComponentBuilder> => {
  const button = new ButtonBuilder()
    .setCustomId("disabled")
    .setLabel(label)
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(true);

  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(button);
};
```

**Step 2: Build 验证**

```bash
pnpm build
```

**Step 3: Commit**

```bash
git add apps/arkcore/src/diary/buttons.ts
git commit -m "feat(diary): add button components for forum interaction"
```

---

### Task 10: 改造 diary/session.ts 支持 forum + 按钮

**Files:**
- Modify: `apps/arkcore/src/diary/session.ts`

**Step 1: 添加 forum 帖子创建逻辑**

```typescript
import { createForumPost } from "../messaging.js";
import { getConfigByRole } from "../channel-config.js";
import {
  buildDiaryStartButton,
  buildDiaryEndButton,
  buildDisabledButton,
  DIARY_START_BUTTON_ID,
  DIARY_END_BUTTON_ID,
} from "./buttons.js";

/**
 * 创建每日 diary 帖子（带开始按钮）
 */
export const createDailyDiaryPost = async (
  config: AppConfig,
  client: Client,
  guildId: string
): Promise<{ threadId: string } | null> => {
  const diaryConfig = await getConfigByRole(guildId, "diary");
  if (!diaryConfig?.channelId) {
    logger.warn("Diary forum not configured");
    return null;
  }

  const now = new Date();
  const dateStr = formatDiaryDate(now, config.tz);
  const threadName = `📔 Diary · ${dateStr}`;

  const { thread, threadId } = await createForumPost(client, diaryConfig.channelId, {
    title: threadName,
    content: "今天的日记还没开始，点击下方按钮开始记录。",
    tags: [],
  });

  // 发送开始按钮
  await thread.send({
    components: [buildDiaryStartButton()],
  });

  return { threadId };
};
```

**Step 2: 添加按钮交互处理**

在 `apps/arkcore/src/diary/handler.ts` 中添加：

```typescript
import {
  DIARY_START_BUTTON_ID,
  DIARY_END_BUTTON_ID,
  buildDiaryEndButton,
  buildDisabledButton,
} from "./buttons.js";

export const registerDiaryButtonHandler = (
  client: Client,
  config: AppConfig,
  llmClient: LlmClient
): void => {
  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isButton()) return;

    const { customId, message, guild } = interaction;
    if (!guild) return;

    if (customId === DIARY_START_BUTTON_ID) {
      await interaction.deferUpdate();

      // 检查是否已有活跃 session
      const thread = message.channel;
      if (!thread.isThread()) return;

      const existingSession = await prisma.diarySession.findFirst({
        where: { threadId: thread.id, endedAt: null },
      });

      if (existingSession) {
        await interaction.followUp({ content: "日记已经在进行中！", ephemeral: true });
        return;
      }

      // 创建 session
      const now = new Date();
      const todayStart = new Date(now);
      todayStart.setHours(0, 0, 0, 0);

      await prisma.diarySession.create({
        data: {
          date: todayStart,
          threadId: thread.id,
          channelId: thread.parentId!,
        },
      });

      // 更新按钮为结束按钮
      await message.edit({
        content: "日记已开始！",
        components: [buildDiaryEndButton()],
      });

      // 发送开场白
      const openingMessage = await generateOpeningMessage(config, llmClient);
      await thread.send(openingMessage);

      // 更新 forum tag 为 analyzing
      // ... tag 更新逻辑

      return;
    }

    if (customId === DIARY_END_BUTTON_ID) {
      await interaction.deferUpdate();

      const thread = message.channel;
      if (!thread.isThread()) return;

      const session = await prisma.diarySession.findFirst({
        where: { threadId: thread.id, endedAt: null },
      });

      if (!session) {
        await interaction.followUp({ content: "没有活跃的日记 session", ephemeral: true });
        return;
      }

      // 结束 session
      await endDiarySession(config, client, llmClient, session.id, "button");

      // 更新按钮为禁用状态
      await message.edit({
        content: "日记已结束并保存！",
        components: [buildDisabledButton("已完成")],
      });

      return;
    }
  });
};
```

**Step 3: Build 验证**

```bash
pnpm build
```

**Step 4: Commit**

```bash
git add apps/arkcore/src/diary/
git commit -m "feat(diary): implement forum + button interaction mode"
```

---

### Task 11: 更新 scheduler.ts 添加 diary forum 定时创建

**Files:**
- Modify: `apps/arkcore/src/scheduler.ts`

**Step 1: 添加 diary 帖子定时创建**

```typescript
import { createDailyDiaryPost } from "./diary/session.js";

// 在 diary scheduler 部分
if (config.diaryEnabled) {
  cron.schedule(
    config.diaryCron,
    async () => {
      try {
        logger.info("Creating daily diary post");
        const guild = client.guilds.cache.get(config.discordGuildId);
        if (!guild) return;

        const result = await createDailyDiaryPost(config, client, guild.id);
        if (result) {
          logger.info({ threadId: result.threadId }, "Daily diary post created");
        }
      } catch (error) {
        logger.error({ error }, "Failed to create daily diary post");
      }
    },
    { timezone: config.tz, recoverMissedExecutions: false }
  );
}
```

**Step 2: Build 验证**

```bash
pnpm build
```

**Step 3: Commit**

```bash
git add apps/arkcore/src/scheduler.ts
git commit -m "feat(scheduler): add daily diary forum post creation"
```

---

## Phase 5: 清理

### Task 12: 移除废弃的 ENV 变量

**Files:**
- Modify: `apps/arkcore/src/config.ts`
- Modify: `.env.example`

**Step 1: 从 AppConfig 移除废弃字段**

```typescript
// 移除这些字段：
// favChannelId?: string;
// deeperChannelId?: string;
// editorialChannelId?: string;
// diaryChannelId?: string;
// digestForumId?: string;
// deepDiveForumId?: string;
```

**Step 2: 从 loadConfig 移除对应的 env 读取**

**Step 3: 更新 .env.example**

移除：
```bash
# FAV_CHANNEL_ID=
# DEEPER_CHANNEL_ID=
# EDITORIAL_CHANNEL_ID=
# DIARY_CHANNEL_ID=
# DIGEST_FORUM_ID=
# DEEP_DIVE_FORUM_ID=
# OBSERVABILITY_CHANNEL_ID=
```

**Step 4: Build 验证**

```bash
pnpm build
```

**Step 5: Commit**

```bash
git add apps/arkcore/src/config.ts .env.example
git commit -m "chore: remove deprecated channel env variables"
```

---

### Task 13: 更新文档

**Files:**
- Modify: `docs/plans/2025-01-17-forum-channel-migration-design.md`
- Modify: `AGENTS.md` (如果需要)

**Step 1: 更新设计文档**

添加关于数据库配置和 /config 命令的说明。

**Step 2: Commit**

```bash
git add docs/
git commit -m "docs: update documentation for database-driven configuration"
```

---

## Verification Checklist

### Phase 1 验证
- [ ] `pnpm build` 通过
- [ ] `npx prisma migrate dev` 成功
- [ ] Bot 启动时能找到 #arkcore-admin 和 #arkcore-alerts

### Phase 2 验证
- [ ] `/config digest add-category` 命令工作
- [ ] `/config digest set-output` 命令工作
- [ ] `/config list` 显示所有配置
- [ ] 命令只能在 #arkcore-admin 中使用

### Phase 3 验证
- [ ] Favorites 使用数据库配置
- [ ] Digest 按 category 分组执行
- [ ] Editorial 使用数据库配置

### Phase 4 验证
- [ ] Diary forum 帖子自动创建
- [ ] 点击开始按钮启动 session
- [ ] 点击结束按钮保存并导出
- [ ] Tag 正确切换 (analyzing → completed)

### Phase 5 验证
- [ ] 移除的 ENV 变量不再使用
- [ ] Bot 正常启动运行
- [ ] 文档已更新
