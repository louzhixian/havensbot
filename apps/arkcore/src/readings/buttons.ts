import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type MessageActionRowComponentBuilder,
} from "discord.js";

export const READINGS_TOGGLE_PREFIX = "readings_toggle_";

export const buildMarkAsReadButton = (): ActionRowBuilder<MessageActionRowComponentBuilder> => {
  const button = new ButtonBuilder()
    .setCustomId(`${READINGS_TOGGLE_PREFIX}read`)
    .setLabel("标为已读")
    .setStyle(ButtonStyle.Secondary);

  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(button);
};

export const buildMarkAsUnreadButton = (): ActionRowBuilder<MessageActionRowComponentBuilder> => {
  const button = new ButtonBuilder()
    .setCustomId(`${READINGS_TOGGLE_PREFIX}unread`)
    .setLabel("标为未读")
    .setStyle(ButtonStyle.Primary);

  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(button);
};
