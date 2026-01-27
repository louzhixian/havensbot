import { ChatInputCommandInteraction } from "discord.js";
import { prisma } from "./db.js";
import { buildBatchReply } from "./reply-utils.js";
import {
  fetchOfficialFeeds,
  parseGithubRepo,
  splitUrlInput,
} from "./source-utils.js";
import { normalizeUrl, truncate } from "./utils.js";

type CreateSourceResult = { status: "exists" } | { status: "created" };

const createRssSource = async (
  channelId: string,
  url: string,
  name: string
): Promise<CreateSourceResult> => {
  const existing = await prisma.source.findFirst({
    where: { channelId, type: "RSS", url },
  });

  if (existing) {
    return { status: "exists" };
  }

  await prisma.source.create({
    data: {
      channelId,
      type: "RSS",
      name,
      url,
    },
  });

  return { status: "created" };
};

export const handleSourceAddRss = async (
  interaction: ChatInputCommandInteraction
): Promise<void> => {
  const channelId = interaction.channelId!;
  const urlInput = interaction.options.getString("url", true);
  const nameInput = interaction.options.getString("name", false);
  const urlInputs = splitUrlInput(urlInput);
  const isBatch = urlInputs.length > 1;

  if (isBatch) {
    const lines: string[] = [];
    let added = 0;
    let exists = 0;
    let invalid = 0;
    let failed = 0;

    for (const raw of urlInputs) {
      let url: string;
      try {
        url = normalizeUrl(raw);
      } catch {
        invalid += 1;
        lines.push(`❌ Invalid: ${raw}`);
        continue;
      }

      const name = new URL(url).hostname;
      try {
        const result = await createRssSource(channelId, url, name);
        if (result.status === "exists") {
          exists += 1;
          lines.push(`⚠️ Exists: ${url}`);
        } else {
          added += 1;
          lines.push(`✅ Added: ${url}`);
        }
      } catch {
        failed += 1;
        lines.push(`❌ Failed: ${url}`);
      }
    }

    const nameNote = nameInput?.trim() ? " Note: name ignored for batch." : "";
    const summary = `Added ${added}, exists ${exists}, invalid ${invalid}, failed ${failed}.${nameNote}`;

    await interaction.reply({
      content: buildBatchReply("Batch add (rss) results:", summary, lines),
      ephemeral: true,
    });
    return;
  }

  let url: string;
  try {
    url = normalizeUrl(urlInputs[0] ?? urlInput);
  } catch {
    await interaction.reply({
      content: "Invalid URL. Please provide a valid http(s) feed URL.",
      ephemeral: true,
    });
    return;
  }

  const name = nameInput?.trim() || new URL(url).hostname;
  const result = await createRssSource(channelId, url, name);

  if (result.status === "exists") {
    await interaction.reply({
      content: "This source already exists for this channel.",
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({
    content: `Added RSS source: ${name}`,
    ephemeral: true,
  });
};

export const handleSourceAddOthers = async (
  interaction: ChatInputCommandInteraction
): Promise<void> => {
  const channelId = interaction.channelId!;
  const urlInput = interaction.options.getString("url", true);
  const nameInput = interaction.options.getString("name", false);
  const urlInputs = splitUrlInput(urlInput);
  const isBatch = urlInputs.length > 1;

  if (isBatch) {
    const lines: string[] = [];
    let added = 0;
    let exists = 0;
    let invalid = 0;
    let official = 0;
    let noFeed = 0;
    let failed = 0;

    for (const raw of urlInputs) {
      let inputUrl: string;
      try {
        inputUrl = new URL(raw).toString();
      } catch {
        invalid += 1;
        lines.push(`❌ Invalid: ${raw}`);
        continue;
      }

      const parsedInput = new URL(inputUrl);
      if (parsedInput.hostname === "github.com") {
        const repoInfo = parseGithubRepo(inputUrl);
        if (!repoInfo) {
          invalid += 1;
          lines.push(`❌ Invalid GitHub repo: ${inputUrl}`);
          continue;
        }

        const rssUrl = `https://github.com/${encodeURIComponent(
          repoInfo.owner
        )}/${encodeURIComponent(repoInfo.repo)}/commits.atom`;

        let url: string;
        try {
          url = normalizeUrl(rssUrl);
        } catch {
          failed += 1;
          lines.push(`❌ Invalid feed URL: ${inputUrl}`);
          continue;
        }

        const name = `GitHub · ${repoInfo.owner}/${repoInfo.repo} · commits`;
        const result = await createRssSource(channelId, url, name);
        if (result.status === "exists") {
          exists += 1;
          lines.push(`⚠️ Exists (GitHub commits): ${repoInfo.owner}/${repoInfo.repo}`);
        } else {
          added += 1;
          lines.push(`✅ Added (GitHub commits): ${repoInfo.owner}/${repoInfo.repo}`);
        }
        continue;
      }

      const officialFeeds = await fetchOfficialFeeds(inputUrl);
      if (officialFeeds.length > 0) {
        official += 1;
        lines.push(`⚠️ Official feed found (use /source add rss): ${inputUrl}`);
        continue;
      }

      noFeed += 1;
      lines.push(`❌ No RSS feed found: ${inputUrl}`);
    }

    const nameNote = nameInput?.trim() ? " Note: name ignored for batch." : "";
    const summary = `Added ${added}, exists ${exists}, invalid ${invalid}, official ${official}, no_feed ${noFeed}, failed ${failed}.${nameNote}`;

    await interaction.reply({
      content: buildBatchReply("Batch add (others) results:", summary, lines),
      ephemeral: true,
    });
    return;
  }

  const rawInput = urlInputs[0] ?? urlInput;

  let inputUrl: string;
  try {
    inputUrl = new URL(rawInput).toString();
  } catch {
    await interaction.reply({
      content: "Invalid URL. Please provide a valid http(s) URL.",
      ephemeral: true,
    });
    return;
  }

  const parsedInput = new URL(inputUrl);
  if (parsedInput.hostname === "github.com") {
    const repoInfo = parseGithubRepo(inputUrl);
    if (!repoInfo) {
      await interaction.reply({
        content: "Not a valid GitHub repository URL.",
        ephemeral: true,
      });
      return;
    }

    const rssUrl = `https://github.com/${encodeURIComponent(
      repoInfo.owner
    )}/${encodeURIComponent(repoInfo.repo)}/commits.atom`;

    let url: string;
    try {
      url = normalizeUrl(rssUrl);
    } catch {
      await interaction.reply({
        content: "Failed to construct GitHub feed URL.",
        ephemeral: true,
      });
      return;
    }

    const name =
      nameInput?.trim() || `GitHub · ${repoInfo.owner}/${repoInfo.repo} · commits`;
    const result = await createRssSource(channelId, url, name);

    if (result.status === "exists") {
      await interaction.reply({
        content: "This source already exists for this channel.",
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      content: `✅ Added GitHub repository (official Atom feed)\nRepository: ${repoInfo.owner}/${repoInfo.repo}\nFeed: commits\nTo use releases: /source add rss url:https://github.com/${repoInfo.owner}/${repoInfo.repo}/releases.atom name:GitHub · ${repoInfo.owner}/${repoInfo.repo} · releases\nTo use issues: /source add rss url:https://github.com/${repoInfo.owner}/${repoInfo.repo}/issues.atom name:GitHub · ${repoInfo.owner}/${repoInfo.repo} · issues`,
      ephemeral: true,
    });
    return;
  }

  const officialFeeds = await fetchOfficialFeeds(inputUrl);
  if (officialFeeds.length > 0) {
    const list = officialFeeds.slice(0, 5).join("\n- ");
    const extra = officialFeeds.length - 5;
    await interaction.reply({
      content: `✅ This site already provides an official RSS feed.\nPlease use /source add rss instead.\nFound feeds:\n- ${list}${extra > 0 ? `\n- +${extra} more` : ""}`,
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({
    content: `❌ No RSS feed found for this URL.\nTip: This site does not provide an RSS feed. Try finding an alternative source or use a third-party RSS service.`,
    ephemeral: true,
  });
};

export const handleSourceList = async (
  interaction: ChatInputCommandInteraction
): Promise<void> => {
  const channelId = interaction.channelId!;
  const sources = await prisma.source.findMany({
    where: { channelId },
    orderBy: { createdAt: "asc" },
  });

  if (sources.length === 0) {
    await interaction.reply({
      content: "No sources configured for this channel.",
      ephemeral: true,
    });
    return;
  }

  const lines = sources.map(
    (source) => `- ${source.enabled ? "[on]" : "[off]"} ${source.name}: ${source.url}`
  );

  await interaction.reply({
    content: truncate(lines.join("\n"), 1800),
    ephemeral: true,
  });
};

export const handleSourceRemove = async (
  interaction: ChatInputCommandInteraction
): Promise<void> => {
  const channelId = interaction.channelId!;
  const urlInput = interaction.options.getString("url", true);
  const urlInputs = splitUrlInput(urlInput);
  const isBatch = urlInputs.length > 1;

  if (isBatch) {
    const lines: string[] = [];
    let removed = 0;
    let notFound = 0;
    let invalid = 0;
    let failed = 0;

    for (const raw of urlInputs) {
      let url: string;
      try {
        url = normalizeUrl(raw);
      } catch {
        invalid += 1;
        lines.push(`❌ Invalid: ${raw}`);
        continue;
      }

      try {
        const source = await prisma.source.findFirst({
          where: { channelId, type: "RSS", url },
        });
        if (!source) {
          notFound += 1;
          lines.push(`⚠️ Not found: ${url}`);
          continue;
        }

        await prisma.source.delete({ where: { id: source.id } });
        removed += 1;
        lines.push(`✅ Removed: ${url}`);
      } catch {
        failed += 1;
        lines.push(`❌ Failed: ${url}`);
      }
    }

    const summary = `Removed ${removed}, not found ${notFound}, invalid ${invalid}, failed ${failed}.`;
    await interaction.reply({
      content: buildBatchReply("Batch remove results:", summary, lines),
      ephemeral: true,
    });
    return;
  }

  let url: string;
  try {
    url = normalizeUrl(urlInputs[0] ?? urlInput);
  } catch {
    await interaction.reply({
      content: "Invalid URL. Please provide a valid http(s) feed URL.",
      ephemeral: true,
    });
    return;
  }

  const source = await prisma.source.findFirst({
    where: { channelId, type: "RSS", url },
  });

  if (!source) {
    await interaction.reply({
      content: "Source not found for this channel.",
      ephemeral: true,
    });
    return;
  }

  await prisma.source.delete({ where: { id: source.id } });

  await interaction.reply({
    content: `Removed RSS source: ${source.name}`,
    ephemeral: true,
  });
};
