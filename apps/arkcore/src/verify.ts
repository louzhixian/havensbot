import "dotenv/config";
import { loadConfig } from "./config.js";
import { prisma } from "./db.js";
import { buildDigestData } from "./digest.js";
import { buildOpenAiCompatUrl } from "./utils.js";

const checkDiscord = async (token: string): Promise<void> => {
  const response = await fetch("https://discord.com/api/v10/users/@me", {
    headers: {
      Authorization: `Bot ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Discord auth failed (${response.status})`);
  }
};

const checkLlm = async (config: ReturnType<typeof loadConfig>): Promise<void> => {
  if (config.llmProvider !== "openai_compat") {
    console.log("verify: llm skipped (provider=none)");
    return;
  }

  if (!config.llmApiKey || !config.llmModel) {
    console.log("verify: llm skipped (missing config)");
    return;
  }

  const endpoint = buildOpenAiCompatUrl(config.llmBaseUrl);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.llmApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.llmModel,
      messages: [
        {
          role: "system",
          content: "Return 'ok' only.",
        },
        {
          role: "user",
          content: "ok",
        },
      ],
      max_tokens: 5,
      temperature: 0,
    }),
  });

  if (!response.ok) {
    throw new Error(`LLM smoke test failed (${response.status})`);
  }

  console.log("verify: llm ok");
};

const main = async (): Promise<void> => {
  const config = loadConfig();
  const safeConfig = { ...config, llmProvider: "none" as const };

  await prisma.$queryRaw`SELECT 1`;
  await checkDiscord(config.discordToken);

  const channel = await prisma.source.findFirst({
    select: { channelId: true },
    orderBy: { createdAt: "asc" },
  });
  const channelId = channel?.channelId ?? config.discordGuildId ?? "";
  if (!channelId) {
    console.log("verify: no channel found and GUILD_ID not set, skipping digest check");
    return;
  }

  const rangeEnd = new Date();
  const rangeStart = new Date(rangeEnd.getTime() - 24 * 60 * 60 * 1000);
  const digest = await buildDigestData(safeConfig, channelId, rangeStart, rangeEnd);

  console.log(
    `verify: db ok, discord ok, digest ok (items=${digest.items.length})`
  );
  await checkLlm(config);
};

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error("verify failed", error);
    await prisma.$disconnect();
    process.exit(1);
  });
