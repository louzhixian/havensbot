import { Client, EmbedBuilder, ChannelType, ForumChannel, type ThreadChannel } from "discord.js";
import { createForumPost } from "./messaging.js";
import { truncate } from "./utils.js";

export type DeepDiveForumResult = {
  thread: ThreadChannel;
  threadId: string;
  markCompleted: () => Promise<void>;
  markFailed: () => Promise<void>;
};

export const createDeepDiveForumPost = async (
  client: Client,
  forumId: string,
  title: string,
  url: string,
  content: string,
  sourceName?: string
): Promise<DeepDiveForumResult | null> => {
  if (!forumId) {
    return null;
  }

  // Ensure title is never empty (Discord requires at least 1 character)
  const safeTitle = title?.trim() || "Deep Dive";
  const postTitle = `🔍 ${truncate(safeTitle, 90)}`;

  const embed = new EmbedBuilder()
    .setTitle(truncate(safeTitle, 256))
    .setURL(url)
    .setTimestamp(new Date());

  // Only set description if content is non-empty
  if (content?.trim()) {
    embed.setDescription(truncate(content, 4000));
  }

  if (sourceName?.trim()) {
    embed.setFooter({ text: sourceName });
  }

  // Start with "analyzing" tag
  const tags: string[] = ["analyzing"];

  const { thread, threadId } = await createForumPost(client, forumId, {
    title: postTitle,
    content: "",
    embeds: [embed],
    tags,
  });

  // Helper to update tag to "completed" after content is generated
  const markCompleted = async (): Promise<void> => {
    try {
      const forum = await client.channels.fetch(forumId);
      if (!forum || forum.type !== ChannelType.GuildForum) return;

      const forumChannel = forum as ForumChannel;
      const completedTag = forumChannel.availableTags.find(
        (t) => t.name.toLowerCase() === "completed"
      );

      if (completedTag) {
        await thread.edit({ appliedTags: [completedTag.id] });
      }
    } catch (error) {
      console.error("Failed to update deep-dive tag to completed:", error);
    }
  };

  // Helper to update tag to "failed" when generation fails
  const markFailed = async (): Promise<void> => {
    try {
      const forum = await client.channels.fetch(forumId);
      if (!forum || forum.type !== ChannelType.GuildForum) return;

      const forumChannel = forum as ForumChannel;
      const failedTag = forumChannel.availableTags.find(
        (t) => t.name.toLowerCase() === "failed"
      );

      if (failedTag) {
        await thread.edit({ appliedTags: [failedTag.id] });
      }
    } catch (error) {
      console.error("Failed to update deep-dive tag to failed:", error);
    }
  };

  return {
    thread: thread as ThreadChannel,
    threadId,
    markCompleted,
    markFailed,
  };
};
