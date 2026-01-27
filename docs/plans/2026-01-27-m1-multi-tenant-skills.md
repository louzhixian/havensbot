# M1: Multi-Tenant + Skill Architecture Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable Haven bot to serve multiple Discord guilds independently, with a Skill abstraction for modular feature management.

**Architecture:** Single bot instance serves all guilds. Skills are singletons that receive `guildId` as parameter. GuildSettings table stores per-guild configuration (tier, timezone, enabled skills). Scheduler polls all guilds and executes skill cron jobs based on each guild's settings.

**Tech Stack:** TypeScript, Discord.js, Prisma (PostgreSQL), node-cron

---

## Task 1: Add GuildSettings Prisma Model

**Files:**
- Modify: `prisma/schema.prisma`

**Step 1: Add GuildSettings model to schema**

Add after the `ChannelConfig` model:

```prisma
model GuildSettings {
  id              String    @id @default(cuid())
  guildId         String    @unique

  // Basic config
  timezone        String    @default("UTC")
  locale          String    @default("en")

  // Subscription
  tier            String    @default("free")  // free | premium
  tierExpiresAt   DateTime?

  // Skills
  enabledSkills   String[]  @default(["digest", "favorites"])

  // Quotas
  rssSourceLimit  Int       @default(10)
  llmDailyQuota   Int       @default(0)
  llmUsedToday    Int       @default(0)

  // Skill-specific configs (JSON)
  skillConfigs    Json      @default("{}")

  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  @@index([tier])
}
```

**Step 2: Run Prisma migration**

Run: `cd apps/arkcore && npx prisma migrate dev --name add_guild_settings`
Expected: Migration created and applied successfully

**Step 3: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat: add GuildSettings model for multi-tenant support"
```

---

## Task 2: Create Skill Type Definitions

**Files:**
- Create: `apps/arkcore/src/skills/types.ts`

**Step 1: Create skills directory and types file**

```typescript
import type {
  Client,
  ChatInputCommandInteraction,
  MessageReaction,
  User,
  ApplicationCommandOptionData,
} from "discord.js";
import type { PrismaClient, GuildSettings } from "@prisma/client";
import type { Logger } from "pino";

export type SkillTier = "free" | "premium";

export interface SkillContext {
  client: Client;
  db: PrismaClient;
  logger: Logger;
}

export interface SkillCommand {
  name: string;
  description: string;
  options?: ApplicationCommandOptionData[];
  execute: (
    ctx: SkillContext,
    interaction: ChatInputCommandInteraction,
    guildSettings: GuildSettings
  ) => Promise<void>;
}

export interface ReactionHandler {
  emoji: string | string[];
  execute: (
    ctx: SkillContext,
    reaction: MessageReaction,
    user: User,
    guildSettings: GuildSettings
  ) => Promise<void>;
}

export interface SkillCronJob {
  id: string;
  defaultCron: string;
  configKey: string;
  execute: (
    ctx: SkillContext,
    guildId: string,
    settings: GuildSettings
  ) => Promise<void>;
}

export interface Skill {
  // Identity
  id: string;
  name: string;
  description: string;
  tier: SkillTier;

  // Lifecycle (optional)
  onGuildJoin?: (ctx: SkillContext, guildId: string) => Promise<void>;
  onGuildLeave?: (ctx: SkillContext, guildId: string) => Promise<void>;

  // Capabilities (optional)
  commands?: SkillCommand[];
  reactions?: ReactionHandler[];
  cron?: SkillCronJob[];
  channelRoles?: string[];
}
```

**Step 2: Commit**

```bash
git add apps/arkcore/src/skills/types.ts
git commit -m "feat: add Skill type definitions"
```

---

## Task 3: Create SkillRegistry

**Files:**
- Create: `apps/arkcore/src/skills/registry.ts`

**Step 1: Implement SkillRegistry class**

```typescript
import type { Skill, SkillCommand, ReactionHandler, SkillCronJob, SkillContext } from "./types.js";

export class SkillRegistry {
  private skills = new Map<string, Skill>();
  private ctx: SkillContext;

  constructor(ctx: SkillContext) {
    this.ctx = ctx;
  }

  register(skill: Skill): void {
    if (this.skills.has(skill.id)) {
      throw new Error(`Skill "${skill.id}" is already registered`);
    }
    this.skills.set(skill.id, skill);
    this.ctx.logger.info({ skillId: skill.id, tier: skill.tier }, "Skill registered");
  }

  get(id: string): Skill | undefined {
    return this.skills.get(id);
  }

  getAll(): Skill[] {
    return Array.from(this.skills.values());
  }

  async getEnabledForGuild(guildId: string): Promise<Skill[]> {
    const settings = await this.ctx.db.guildSettings.findUnique({
      where: { guildId },
    });
    const enabledIds = settings?.enabledSkills ?? ["digest", "favorites"];
    const guildTier = settings?.tier ?? "free";

    return enabledIds
      .map((id) => this.skills.get(id))
      .filter((s): s is Skill => s !== undefined)
      .filter((s) => this.canUseSkill(s, guildTier));
  }

  canUseSkill(skill: Skill, guildTier: string): boolean {
    if (skill.tier === "free") return true;
    return guildTier === "premium";
  }

  getAllCommands(): SkillCommand[] {
    return this.getAll().flatMap((s) => s.commands ?? []);
  }

  getAllReactionHandlers(): Array<{ skill: Skill; handler: ReactionHandler }> {
    return this.getAll().flatMap((s) =>
      (s.reactions ?? []).map((h) => ({ skill: s, handler: h }))
    );
  }

  getAllCronJobs(): Array<{ skill: Skill; job: SkillCronJob }> {
    return this.getAll().flatMap((s) =>
      (s.cron ?? []).map((j) => ({ skill: s, job: j }))
    );
  }
}
```

**Step 2: Commit**

```bash
git add apps/arkcore/src/skills/registry.ts
git commit -m "feat: add SkillRegistry for skill management"
```

---

## Task 4: Create GuildSettings Service

**Files:**
- Create: `apps/arkcore/src/guild-settings.ts`

**Step 1: Implement guild settings service**

```typescript
import { prisma } from "./db.js";
import type { GuildSettings } from "@prisma/client";
import { logger } from "./observability/logger.js";

const DEFAULT_ENABLED_SKILLS = ["digest", "favorites"];

export type SkillConfigValue = string | number | boolean | null;
export type SkillConfigs = Record<string, Record<string, SkillConfigValue>>;

export const getOrCreateGuildSettings = async (
  guildId: string
): Promise<GuildSettings> => {
  let settings = await prisma.guildSettings.findUnique({
    where: { guildId },
  });

  if (!settings) {
    settings = await prisma.guildSettings.create({
      data: {
        guildId,
        enabledSkills: DEFAULT_ENABLED_SKILLS,
      },
    });
    logger.info({ guildId }, "Created new GuildSettings");
  }

  return settings;
};

export const getGuildSettings = async (
  guildId: string
): Promise<GuildSettings | null> => {
  return prisma.guildSettings.findUnique({
    where: { guildId },
  });
};

export const getAllGuildSettings = async (): Promise<GuildSettings[]> => {
  return prisma.guildSettings.findMany({
    where: {
      tier: { not: "suspended" },
    },
  });
};

export const updateGuildSettings = async (
  guildId: string,
  data: Partial<Pick<GuildSettings, "timezone" | "locale" | "tier" | "enabledSkills">>
): Promise<GuildSettings> => {
  return prisma.guildSettings.update({
    where: { guildId },
    data,
  });
};

export const isSkillEnabled = async (
  guildId: string,
  skillId: string
): Promise<boolean> => {
  const settings = await getGuildSettings(guildId);
  if (!settings) return DEFAULT_ENABLED_SKILLS.includes(skillId);
  return settings.enabledSkills.includes(skillId);
};

export const enableSkill = async (
  guildId: string,
  skillId: string
): Promise<GuildSettings> => {
  const settings = await getOrCreateGuildSettings(guildId);
  if (settings.enabledSkills.includes(skillId)) {
    return settings;
  }
  return prisma.guildSettings.update({
    where: { guildId },
    data: {
      enabledSkills: [...settings.enabledSkills, skillId],
    },
  });
};

export const disableSkill = async (
  guildId: string,
  skillId: string
): Promise<GuildSettings> => {
  const settings = await getOrCreateGuildSettings(guildId);
  return prisma.guildSettings.update({
    where: { guildId },
    data: {
      enabledSkills: settings.enabledSkills.filter((id) => id !== skillId),
    },
  });
};

export const getSkillConfig = <T extends SkillConfigValue>(
  settings: GuildSettings,
  skillId: string,
  key: string,
  defaultValue: T
): T => {
  const configs = settings.skillConfigs as SkillConfigs | null;
  if (!configs) return defaultValue;
  const skillConfig = configs[skillId];
  if (!skillConfig) return defaultValue;
  const value = skillConfig[key];
  if (value === undefined || value === null) return defaultValue;
  return value as T;
};

export const deleteGuildSettings = async (guildId: string): Promise<void> => {
  await prisma.guildSettings.delete({
    where: { guildId },
  }).catch(() => {
    // Ignore if doesn't exist
  });
};
```

**Step 2: Commit**

```bash
git add apps/arkcore/src/guild-settings.ts
git commit -m "feat: add GuildSettings service"
```

---

## Task 5: Refactor Favorites as Skill

**Files:**
- Create: `apps/arkcore/src/skills/favorites.skill.ts`
- Modify: `apps/arkcore/src/favorites.ts` (extract core logic)

**Step 1: Create FavoritesSkill**

```typescript
import type {
  Client,
  GuildTextBasedChannel,
  Message,
  MessageReaction,
  PartialMessageReaction,
  User,
} from "discord.js";
import type { GuildSettings } from "@prisma/client";
import type { Skill, SkillContext, ReactionHandler } from "./types.js";
import { getConfigByRole } from "../channel-config.js";
import { generateDeepDive } from "../deeper.js";
import { createDeepDiveForumPost } from "../deep-dive-forum.js";
import { splitMessageContent } from "../messaging.js";
import { sleep } from "../utils.js";
import { loadConfig, type AppConfig } from "../config.js";

const HEART_EMOJIS = ["❤", "♥"];
const EYES_EMOJIS = ["👀"];
const MAX_FORWARD_CACHE = 1000;

const forwardedMessages = new Map<
  string,
  { forwardedId: string; channelId: string; createdAt: number }
>();
const deeperMessages = new Map<
  string,
  { forwardedId: string; channelId: string; threadId: string; createdAt: number }
>();

const normalizeEmoji = (value: string | null): string => {
  if (!value) return "";
  return value.replace(/\uFE0F/g, "");
};

const wasForwarded = (messageId: string): boolean =>
  forwardedMessages.has(messageId);

const markForwarded = (
  messageId: string,
  forwardedId: string,
  channelId: string
): void => {
  forwardedMessages.set(messageId, {
    forwardedId,
    channelId,
    createdAt: Date.now(),
  });
  if (forwardedMessages.size <= MAX_FORWARD_CACHE) return;
  const oldest = forwardedMessages.keys().next().value;
  if (oldest) {
    forwardedMessages.delete(oldest);
  }
};

const markDeeperForwarded = (
  messageId: string,
  forwardedId: string,
  channelId: string,
  threadId: string
): void => {
  deeperMessages.set(messageId, {
    forwardedId,
    channelId,
    threadId,
    createdAt: Date.now(),
  });
  if (deeperMessages.size <= MAX_FORWARD_CACHE) return;
  const oldest = deeperMessages.keys().next().value;
  if (oldest) {
    deeperMessages.delete(oldest);
  }
};

const ensureMessage = async (
  reaction: MessageReaction | PartialMessageReaction
): Promise<Message | null> => {
  const fullReaction = reaction.partial ? await reaction.fetch() : reaction;
  const message = fullReaction.message.partial
    ? await fullReaction.message.fetch()
    : fullReaction.message;
  return message ?? null;
};

const extractItemUrl = (message: Message): string | null => {
  const embedUrl = message.embeds.find((embed) => typeof embed.url === "string")?.url;
  if (embedUrl) return embedUrl;

  const content = message.content ?? "";
  const match = content.match(/https?:\/\/\S+/);
  if (!match) return null;

  return match[0].replace(/[>\])}.,!?]+$/, "");
};

const forwardMessage = async (
  message: Message,
  channel: GuildTextBasedChannel
): Promise<Message> => {
  const forwarder = (message as Message & {
    forward?: (target: GuildTextBasedChannel) => Promise<Message>;
  }).forward;
  if (typeof forwarder === "function") {
    return forwarder.call(message, channel);
  }

  const files = message.attachments.map((attachment) => attachment.url);
  return channel.send({
    content: message.content || undefined,
    embeds: message.embeds,
    files,
  });
};

const handleHeartReaction = async (
  ctx: SkillContext,
  reaction: MessageReaction,
  message: Message,
  guildId: string
): Promise<void> => {
  const favConfig = await getConfigByRole(guildId, "favorites");
  const favChannelId = favConfig?.channelId;
  if (!favChannelId) return;

  if (message.channelId === favChannelId) return;
  if (wasForwarded(message.id)) return;

  const channel = await ctx.client.channels.fetch(favChannelId);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    ctx.logger.error("Favorite channel is not text based or not found");
    return;
  }
  const textChannel = channel as GuildTextBasedChannel;

  const forwarded = await forwardMessage(message, textChannel);
  markForwarded(message.id, forwarded.id, textChannel.id);
};

const handleEyesReaction = async (
  ctx: SkillContext,
  reaction: MessageReaction,
  message: Message,
  guildId: string,
  settings: GuildSettings
): Promise<void> => {
  const deepDiveConfig = await getConfigByRole(guildId, "deep_dive_output");
  const deepDiveForumId = deepDiveConfig?.channelId;

  if (!deepDiveForumId) return;
  if (message.channelId === deepDiveForumId) return;
  if (deeperMessages.has(message.id)) return;

  const itemUrl = extractItemUrl(message);
  if (!itemUrl) return;

  const title = message.embeds[0]?.title || message.content?.slice(0, 90) || "Deep Dive";
  const sourceName = message.embeds[0]?.footer?.text;

  const forumResult = await createDeepDiveForumPost(
    ctx.client,
    deepDiveForumId,
    title,
    itemUrl,
    "",
    sourceName
  );

  if (forumResult) {
    markDeeperForwarded(message.id, forumResult.threadId, deepDiveForumId, forumResult.threadId);

    await forumResult.thread.send({ content: "正在生成深度解读，请稍候..." });

    // Load config for deep dive (TODO: move to skill config)
    const config = loadConfig();
    const result = await generateDeepDive(config, itemUrl);
    const chunks = splitMessageContent(result.content, 1800);
    for (const chunk of chunks) {
      await forumResult.thread.send({ content: chunk });
      await sleep(config.digestThreadThrottleMs);
    }
    await forumResult.markCompleted();
  }
};

const heartReactionHandler: ReactionHandler = {
  emoji: HEART_EMOJIS,
  execute: async (ctx, reaction, user, settings) => {
    if (user.bot) return;

    const message = await ensureMessage(reaction);
    if (!message || !message.guild) return;

    await handleHeartReaction(ctx, reaction, message, message.guild.id);
  },
};

const eyesReactionHandler: ReactionHandler = {
  emoji: EYES_EMOJIS,
  execute: async (ctx, reaction, user, settings) => {
    if (user.bot) return;

    const message = await ensureMessage(reaction);
    if (!message || !message.guild) return;

    await handleEyesReaction(ctx, reaction, message, message.guild.id, settings);
  },
};

export const favoritesSkill: Skill = {
  id: "favorites",
  name: "Favorites",
  description: "Forward ❤️ reacted messages to favorites channel, 👀 for deep dive",
  tier: "free",

  reactions: [heartReactionHandler, eyesReactionHandler],

  channelRoles: ["favorites", "deep_dive_output"],
};
```

**Step 2: Commit**

```bash
git add apps/arkcore/src/skills/favorites.skill.ts
git commit -m "feat: refactor Favorites as Skill"
```

---

## Task 6: Refactor Digest as Skill

**Files:**
- Create: `apps/arkcore/src/skills/digest.skill.ts`

**Step 1: Create DigestSkill**

```typescript
import { ChannelType } from "discord.js";
import type { GuildSettings } from "@prisma/client";
import type { Skill, SkillContext, SkillCronJob, SkillCommand } from "./types.js";
import { getDigestSourceCategories, getConfigByRole } from "../channel-config.js";
import { createDigest, resolveDigestRange } from "../digest.js";
import {
  sendDigestThreaded,
  sendDigestOverview,
  findTodayDigestPost,
  createDailyDigestPost,
  sendChannelDigestToThread,
  removeDigestingTag,
} from "../messaging.js";
import { loadConfig } from "../config.js";
import { getSkillConfig } from "../guild-settings.js";

const formatDigestDate = (date: Date, timeZone: string): string => {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
};

const runDigestForGuild = async (
  ctx: SkillContext,
  guildId: string,
  settings: GuildSettings
): Promise<void> => {
  const config = loadConfig();
  const guild = ctx.client.guilds.cache.get(guildId);
  if (!guild) {
    ctx.logger.warn({ guildId }, "Guild not found for digest");
    return;
  }

  const digestOutputConfig = await getConfigByRole(guildId, "digest_output");
  const digestForumId = digestOutputConfig?.channelId;
  const sourceCategories = await getDigestSourceCategories(guildId);

  if (sourceCategories.length === 0) {
    ctx.logger.info({ guildId }, "No source categories configured, skipping digest");
    return;
  }

  // Collect all text channels from configured categories
  const channelsToProcess: Array<{ channelId: string; channelName: string }> = [];

  for (const categoryConfig of sourceCategories) {
    if (!categoryConfig.categoryId) continue;

    try {
      const category = await guild.channels.fetch(categoryConfig.categoryId);
      if (!category || category.type !== ChannelType.GuildCategory) {
        ctx.logger.warn({ categoryId: categoryConfig.categoryId }, "Category not found");
        continue;
      }

      const textChannels = guild.channels.cache.filter(
        (ch) =>
          ch.parentId === categoryConfig.categoryId &&
          ch.type === ChannelType.GuildText
      );

      for (const [channelId, channel] of textChannels) {
        const channelName = "name" in channel ? channel.name : channelId;
        channelsToProcess.push({ channelId, channelName });
      }
    } catch (error) {
      ctx.logger.error({ error, categoryId: categoryConfig.categoryId }, "Failed to fetch category");
    }
  }

  if (channelsToProcess.length === 0) {
    ctx.logger.info({ guildId }, "No channels to process for digest");
    return;
  }

  const timezone = settings.timezone || config.tz;

  // Forum mode
  if (digestForumId) {
    const now = new Date();
    const dateStr = formatDigestDate(now, timezone);

    let thread = await findTodayDigestPost(ctx.client, digestForumId, dateStr);

    if (!thread) {
      const { rangeStart, rangeEnd } = await resolveDigestRange(channelsToProcess[0].channelId);
      thread = await createDailyDigestPost(
        ctx.client,
        digestForumId,
        dateStr,
        channelsToProcess.length,
        rangeStart,
        rangeEnd,
        timezone
      );
      ctx.logger.info({ guildId, threadId: thread.id }, "Created forum digest post");
    }

    for (const { channelId } of channelsToProcess) {
      try {
        const { rangeStart, rangeEnd } = await resolveDigestRange(channelId);
        const digest = await createDigest(config, channelId, rangeStart, rangeEnd);
        await sendChannelDigestToThread(thread, channelId, digest, config);
        ctx.logger.info({ guildId, channelId, items: digest.items.length }, "Digest sent to thread");
      } catch (error) {
        ctx.logger.error({ error, channelId }, "Failed to process channel digest");
      }
    }

    await removeDigestingTag(ctx.client, digestForumId, thread);
  } else {
    // Non-forum mode
    for (const { channelId } of channelsToProcess) {
      try {
        const { rangeStart, rangeEnd } = await resolveDigestRange(channelId);
        const digest = await createDigest(config, channelId, rangeStart, rangeEnd);

        if (config.digestThreadMode) {
          await sendDigestThreaded(ctx.client, channelId, digest, config);
        } else {
          await sendDigestOverview(ctx.client, channelId, digest, config);
        }
        ctx.logger.info({ guildId, channelId, items: digest.items.length }, "Digest sent");
      } catch (error) {
        ctx.logger.error({ error, channelId }, "Failed to process channel digest");
      }
    }
  }
};

const digestCronJob: SkillCronJob = {
  id: "digest-daily",
  defaultCron: "0 9 * * *",
  configKey: "digestCron",
  execute: runDigestForGuild,
};

const runDigestCommand: SkillCommand = {
  name: "run",
  description: "Run digest now for this guild",
  execute: async (ctx, interaction, settings) => {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({ content: "This command can only be used in a guild.", ephemeral: true });
      return;
    }

    await interaction.deferReply();

    try {
      await runDigestForGuild(ctx, guildId, settings);
      await interaction.editReply({ content: "Digest completed!" });
    } catch (error) {
      ctx.logger.error({ error, guildId }, "Digest command failed");
      await interaction.editReply({ content: "Digest failed. Check logs for details." });
    }
  },
};

export const digestSkill: Skill = {
  id: "digest",
  name: "Digest",
  description: "Daily RSS digest summaries",
  tier: "free",

  commands: [runDigestCommand],
  cron: [digestCronJob],

  channelRoles: ["digest_source", "digest_output"],
};
```

**Step 2: Commit**

```bash
git add apps/arkcore/src/skills/digest.skill.ts
git commit -m "feat: refactor Digest as Skill"
```

---

## Task 7: Create Skills Index

**Files:**
- Create: `apps/arkcore/src/skills/index.ts`

**Step 1: Create index file**

```typescript
export * from "./types.js";
export * from "./registry.js";
export { digestSkill } from "./digest.skill.js";
export { favoritesSkill } from "./favorites.skill.js";
```

**Step 2: Commit**

```bash
git add apps/arkcore/src/skills/index.ts
git commit -m "feat: add skills index"
```

---

## Task 8: Refactor Scheduler for Multi-Tenant

**Files:**
- Modify: `apps/arkcore/src/scheduler.ts`

**Step 1: Update scheduler to poll all guilds**

Replace the digest cron section with multi-tenant logic. The key changes:

1. Import `getAllGuildSettings`, `getSkillConfig`
2. Import `SkillRegistry`
3. Create `runSkillCronJobs` function that:
   - Fetches all guild settings
   - For each guild, checks each skill's cron jobs
   - Uses `shouldRunNow()` to check if cron matches current time
   - Executes matching jobs

Add this new function and modify `startSchedulers`:

```typescript
// Add imports at top
import { getAllGuildSettings, getSkillConfig } from "./guild-settings.js";
import type { SkillRegistry } from "./skills/index.js";
import type { SkillContext } from "./skills/index.js";

// Add cron matching helper
const shouldRunNow = (cronExpr: string, timezone: string): boolean => {
  // Simple minute-level check - cron.validate then check if matches
  try {
    const now = new Date();
    const options: Intl.DateTimeFormatOptions = {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    };
    const timeStr = new Intl.DateTimeFormat("en-US", options).format(now);
    const [hour, minute] = timeStr.split(":").map(Number);

    // Parse cron (simple: minute hour * * *)
    const parts = cronExpr.split(" ");
    if (parts.length < 5) return false;

    const cronMinute = parts[0] === "*" ? minute : parseInt(parts[0], 10);
    const cronHour = parts[1] === "*" ? hour : parseInt(parts[1], 10);

    return cronMinute === minute && cronHour === hour;
  } catch {
    return false;
  }
};

// New function for skill cron execution
const runSkillCronJobs = async (
  registry: SkillRegistry,
  ctx: SkillContext
): Promise<void> => {
  const guilds = await getAllGuildSettings();
  const cronJobs = registry.getAllCronJobs();

  for (const guildSettings of guilds) {
    const enabledSkills = await registry.getEnabledForGuild(guildSettings.guildId);
    const enabledSkillIds = new Set(enabledSkills.map((s) => s.id));

    for (const { skill, job } of cronJobs) {
      if (!enabledSkillIds.has(skill.id)) continue;

      const cronExpr = getSkillConfig(
        guildSettings,
        skill.id,
        job.configKey,
        job.defaultCron
      );

      if (shouldRunNow(cronExpr, guildSettings.timezone)) {
        try {
          ctx.logger.info(
            { guildId: guildSettings.guildId, skillId: skill.id, jobId: job.id },
            "Running skill cron job"
          );
          await job.execute(ctx, guildSettings.guildId, guildSettings);
        } catch (error) {
          ctx.logger.error(
            { error, guildId: guildSettings.guildId, skillId: skill.id, jobId: job.id },
            "Skill cron job failed"
          );
        }
      }
    }
  }
};

// Update startSchedulers signature and add skill cron loop
export const startSchedulers = (
  config: AppConfig,
  client: Client,
  registry?: SkillRegistry,
  skillCtx?: SkillContext
): void => {
  // ... existing fetch scheduler ...

  // Replace hardcoded digest cron with skill-based polling
  if (registry && skillCtx) {
    cron.schedule(
      "* * * * *", // Every minute
      async () => {
        try {
          await runSkillCronJobs(registry, skillCtx);
        } catch (error) {
          logger.error({ error }, "Skill cron polling failed");
        }
      },
      { timezone: config.tz, recoverMissedExecutions: false }
    );
    logger.info("Skill cron polling scheduled (every minute)");
  }

  // ... rest of existing schedulers (alerts, archival, etc.) ...
};
```

**Step 2: Commit**

```bash
git add apps/arkcore/src/scheduler.ts
git commit -m "feat: refactor scheduler for multi-tenant skill cron jobs"
```

---

## Task 9: Add guildCreate Handler for Onboarding

**Files:**
- Create: `apps/arkcore/src/onboarding.ts`

**Step 1: Create onboarding handler**

```typescript
import type { Client, Guild, TextChannel } from "discord.js";
import { getOrCreateGuildSettings } from "./guild-settings.js";
import { logger } from "./observability/logger.js";

const WELCOME_MESSAGE = `👋 **Haven 已加入服务器！**

我是你的信息避风港，帮你管理 RSS 订阅、收藏文章、生成每日摘要。

**快速开始：**
• \`/setup\` - 配置时区和基础设置
• \`/skills list\` - 查看可用技能
• \`/source add rss\` - 添加第一个 RSS 源

**需要帮助？** 访问 https://havens.bot/docs`;

export const registerGuildCreateHandler = (client: Client): void => {
  client.on("guildCreate", async (guild: Guild) => {
    logger.info({ guildId: guild.id, guildName: guild.name }, "Bot joined new guild");

    try {
      // Create GuildSettings
      await getOrCreateGuildSettings(guild.id);
      logger.info({ guildId: guild.id }, "GuildSettings created");

      // Send welcome message to system channel
      const systemChannel = guild.systemChannel;
      if (systemChannel) {
        await systemChannel.send(WELCOME_MESSAGE);
        logger.info({ guildId: guild.id, channelId: systemChannel.id }, "Welcome message sent");
      } else {
        logger.info({ guildId: guild.id }, "No system channel, skipped welcome message");
      }
    } catch (error) {
      logger.error({ error, guildId: guild.id }, "Failed to handle guildCreate");
    }
  });

  client.on("guildDelete", async (guild: Guild) => {
    logger.info({ guildId: guild.id, guildName: guild.name }, "Bot removed from guild");
    // Note: We don't delete GuildSettings immediately to allow re-join
  });
};
```

**Step 2: Commit**

```bash
git add apps/arkcore/src/onboarding.ts
git commit -m "feat: add guildCreate handler for onboarding"
```

---

## Task 10: Add /setup Command

**Files:**
- Modify: `apps/arkcore/src/commands.ts`

**Step 1: Add setup command definition**

Add to the commands array:

```typescript
{
  name: "setup",
  description: "Configure Haven for this server",
  options: [
    {
      name: "timezone",
      description: "Set server timezone (e.g., Asia/Tokyo, UTC)",
      type: ApplicationCommandOptionType.String,
      required: false,
    },
    {
      name: "locale",
      description: "Set language (en, zh, ja)",
      type: ApplicationCommandOptionType.String,
      required: false,
      choices: [
        { name: "English", value: "en" },
        { name: "中文", value: "zh" },
        { name: "日本語", value: "ja" },
      ],
    },
  ],
},
```

**Step 2: Add setup command handler**

```typescript
// In handleInteraction function
case "setup": {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: "This command can only be used in a guild.", ephemeral: true });
    return;
  }

  const timezone = interaction.options.getString("timezone");
  const locale = interaction.options.getString("locale");

  const settings = await getOrCreateGuildSettings(guildId);

  const updates: Partial<{ timezone: string; locale: string }> = {};
  if (timezone) updates.timezone = timezone;
  if (locale) updates.locale = locale;

  if (Object.keys(updates).length > 0) {
    await updateGuildSettings(guildId, updates);
  }

  const currentSettings = await getGuildSettings(guildId);

  await interaction.reply({
    content: `**Haven 设置**\n\n` +
      `时区: \`${currentSettings?.timezone || "UTC"}\`\n` +
      `语言: \`${currentSettings?.locale || "en"}\`\n` +
      `订阅层级: \`${currentSettings?.tier || "free"}\`\n` +
      `已启用技能: ${(currentSettings?.enabledSkills || []).map(s => `\`${s}\``).join(", ") || "无"}\n\n` +
      `使用 \`/skills list\` 查看所有可用技能`,
    ephemeral: true,
  });
  return;
}
```

**Step 3: Commit**

```bash
git add apps/arkcore/src/commands.ts
git commit -m "feat: add /setup command"
```

---

## Task 11: Add /skills Command

**Files:**
- Modify: `apps/arkcore/src/commands.ts`

**Step 1: Add skills command definition**

Add to the commands array:

```typescript
{
  name: "skills",
  description: "Manage Haven skills",
  options: [
    {
      name: "list",
      description: "List all available skills",
      type: ApplicationCommandOptionType.Subcommand,
    },
    {
      name: "enable",
      description: "Enable a skill",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "skill",
          description: "Skill to enable",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
      ],
    },
    {
      name: "disable",
      description: "Disable a skill",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "skill",
          description: "Skill to disable",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
      ],
    },
  ],
},
```

**Step 2: Add skills command handler**

```typescript
// In handleInteraction function
case "skills": {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: "This command can only be used in a guild.", ephemeral: true });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  const settings = await getOrCreateGuildSettings(guildId);

  // Get registry from somewhere (pass to handleInteraction or use global)
  const allSkills = registry.getAll();

  switch (subcommand) {
    case "list": {
      const lines = allSkills.map((skill) => {
        const enabled = settings.enabledSkills.includes(skill.id);
        const tierBadge = skill.tier === "premium" ? "💎" : "🆓";
        const statusBadge = enabled ? "✅" : "⬜";
        const canUse = registry.canUseSkill(skill, settings.tier);
        const lockBadge = canUse ? "" : "🔒";
        return `${statusBadge} ${tierBadge} **${skill.name}** ${lockBadge}\n   ${skill.description}`;
      });

      await interaction.reply({
        content: `**Haven Skills**\n\n${lines.join("\n\n")}\n\n` +
          `使用 \`/skills enable <skill>\` 或 \`/skills disable <skill>\` 管理技能`,
        ephemeral: true,
      });
      return;
    }

    case "enable": {
      const skillId = interaction.options.getString("skill", true);
      const skill = registry.get(skillId);

      if (!skill) {
        await interaction.reply({ content: `未知技能: ${skillId}`, ephemeral: true });
        return;
      }

      if (!registry.canUseSkill(skill, settings.tier)) {
        await interaction.reply({
          content: `技能 **${skill.name}** 需要 Premium 订阅`,
          ephemeral: true,
        });
        return;
      }

      await enableSkill(guildId, skillId);
      await interaction.reply({
        content: `✅ 已启用技能: **${skill.name}**`,
        ephemeral: true,
      });
      return;
    }

    case "disable": {
      const skillId = interaction.options.getString("skill", true);
      const skill = registry.get(skillId);

      if (!skill) {
        await interaction.reply({ content: `未知技能: ${skillId}`, ephemeral: true });
        return;
      }

      await disableSkill(guildId, skillId);
      await interaction.reply({
        content: `⬜ 已禁用技能: **${skill.name}**`,
        ephemeral: true,
      });
      return;
    }
  }
  return;
}
```

**Step 3: Commit**

```bash
git add apps/arkcore/src/commands.ts
git commit -m "feat: add /skills command"
```

---

## Task 12: Update index.ts for Multi-Tenant

**Files:**
- Modify: `apps/arkcore/src/index.ts`

**Step 1: Initialize SkillRegistry and wire everything together**

Update `main()` function:

```typescript
import { SkillRegistry, digestSkill, favoritesSkill } from "./skills/index.js";
import { registerGuildCreateHandler } from "./onboarding.js";
import { prisma } from "./db.js";

const main = async (): Promise<void> => {
  const config = loadConfig();
  const client = createClient();

  // Initialize skill context and registry
  const skillCtx: SkillContext = {
    client,
    db: prisma,
    logger,
  };

  const registry = new SkillRegistry(skillCtx);
  registry.register(digestSkill);
  registry.register(favoritesSkill);

  // Register skill reaction handlers
  const reactionHandlers = registry.getAllReactionHandlers();
  client.on("messageReactionAdd", async (reaction, user) => {
    try {
      const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
      if (!message.guild) return;

      const settings = await getOrCreateGuildSettings(message.guild.id);
      const enabledSkills = await registry.getEnabledForGuild(message.guild.id);
      const enabledSkillIds = new Set(enabledSkills.map((s) => s.id));

      const emojiName = reaction.emoji.name?.replace(/\uFE0F/g, "") ?? "";

      for (const { skill, handler } of reactionHandlers) {
        if (!enabledSkillIds.has(skill.id)) continue;

        const emojis = Array.isArray(handler.emoji) ? handler.emoji : [handler.emoji];
        if (emojis.includes(emojiName)) {
          await handler.execute(skillCtx, reaction as MessageReaction, user as User, settings);
        }
      }
    } catch (error) {
      logger.error({ error }, "Reaction handler failed");
    }
  });

  // Register onboarding
  registerGuildCreateHandler(client);

  // Update interaction handler to pass registry
  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
      await handleInteraction(interaction, config, client, registry);
    } catch (error) {
      // ... existing error handling
    }
  });

  client.once("ready", async () => {
    console.log(`Logged in as ${client.user?.tag}`);

    // Initialize settings for all guilds bot is already in
    for (const [guildId, guild] of client.guilds.cache) {
      await getOrCreateGuildSettings(guildId);
      logger.info({ guildId, guildName: guild.name }, "Initialized GuildSettings");
    }

    await ingestAllSources(config);
    startSchedulers(config, client, registry, skillCtx);
  });

  await registerCommands(config);
  await client.login(config.discordToken);

  // ... existing shutdown handler
};
```

**Step 2: Commit**

```bash
git add apps/arkcore/src/index.ts
git commit -m "feat: wire up multi-tenant skill system in index.ts"
```

---

## Task 13: Remove Hardcoded GUILD_ID

**Files:**
- Modify: `apps/arkcore/src/config.ts`
- Modify: `apps/arkcore/src/discord.ts`

**Step 1: Make discordGuildId optional in config**

In `config.ts`, change:
```typescript
discordGuildId: requireEnv("DISCORD_GUILD_ID"),
```
to:
```typescript
discordGuildId: process.env.DISCORD_GUILD_ID || undefined,
```

And update the type:
```typescript
discordGuildId?: string;
```

**Step 2: Update discord.ts for global command registration**

Change command registration to global:
```typescript
export const registerCommands = async (config: AppConfig): Promise<void> => {
  const rest = new REST({ version: "10" }).setToken(config.discordToken);

  // Register globally instead of per-guild
  await rest.put(
    Routes.applicationCommands(config.discordApplicationId),
    { body: commands }
  );

  logger.info("Global slash commands registered");
};
```

**Step 3: Commit**

```bash
git add apps/arkcore/src/config.ts apps/arkcore/src/discord.ts
git commit -m "feat: remove hardcoded GUILD_ID, use global commands"
```

---

## Task 14: Integration Testing

**Files:**
- Manual testing steps

**Step 1: Start the bot locally**

```bash
cd apps/arkcore
npm run dev
```

**Step 2: Test guildCreate**

1. Add the bot to a new test Discord server
2. Verify welcome message appears in system channel
3. Check database: `SELECT * FROM "GuildSettings" WHERE "guildId" = '<test-guild-id>';`

**Step 3: Test /setup command**

```
/setup timezone:Asia/Shanghai
```
Verify settings are updated.

**Step 4: Test /skills command**

```
/skills list
/skills disable favorites
/skills enable favorites
```

**Step 5: Test multi-guild isolation**

1. Add bot to second test server
2. Configure different timezone in each server
3. Verify digest runs at correct local time for each
4. Verify ❤️ reactions only forward within same guild

**Step 6: Commit test notes**

```bash
git add docs/
git commit -m "docs: add M1 testing notes"
```

---

## Summary

This plan implements M1 with the following components:

1. **GuildSettings** - Per-guild configuration (Task 1, 4)
2. **Skill Interface** - Type definitions (Task 2)
3. **SkillRegistry** - Skill management (Task 3)
4. **DigestSkill** - Digest refactored as skill (Task 6)
5. **FavoritesSkill** - Favorites refactored as skill (Task 5)
6. **Multi-tenant Scheduler** - Poll-based cron execution (Task 8)
7. **Onboarding** - guildCreate handler (Task 9)
8. **Commands** - /setup and /skills (Tasks 10-11)
9. **Integration** - Wire everything in index.ts (Task 12)
10. **Cleanup** - Remove hardcoded GUILD_ID (Task 13)

After M1, each guild can:
- Have independent timezone and settings
- Enable/disable skills individually
- Run digest on its own schedule
- Use favorites independently
