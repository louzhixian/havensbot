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
