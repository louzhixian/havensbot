/**
 * Discord.js utility functions
 * F-02: Centralized Discord helpers to avoid duplication
 */

import { Message, MessageReaction, PartialMessageReaction } from "discord.js";

/**
 * Ensure a reaction and its message are fully fetched (not partial)
 * Returns null if fetching fails
 */
export const ensureMessage = async (
  reaction: MessageReaction | PartialMessageReaction
): Promise<Message | null> => {
  try {
    const fullReaction = reaction.partial ? await reaction.fetch() : reaction;
    const message = fullReaction.message.partial
      ? await fullReaction.message.fetch()
      : fullReaction.message;
    return message ?? null;
  } catch (error) {
    // Reaction or message might have been deleted
    return null;
  }
};
