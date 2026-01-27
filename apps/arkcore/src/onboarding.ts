import type { Client, Guild } from "discord.js";
import { getOrCreateGuildSettings } from "./guild-settings.js";
import { logger } from "./observability/logger.js";

const WELCOME_MESSAGE = `👋 **Haven 已加入服务器！**

我是你的信息避风港，帮你管理 RSS 订阅、收藏文章、生成每日摘要。

**🚀 一键开始：**
使用 \`/init\` 自动创建推荐的频道结构

**或者手动配置：**
• \`/setup\` - 配置时区和语言
• \`/source add rss url:订阅地址\` - 添加 RSS 源
• \`/skills list\` - 查看可用技能

**📚 需要帮助？**
• \`/help\` - 查看所有命令
• 文档：https://havens.bot/docs`;

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
