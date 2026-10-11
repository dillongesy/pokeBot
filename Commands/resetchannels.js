'use strict';

/**
 * .resetchannels - let the bot work in every channel again.
 *
 * Clears the server's channel allowlist. Requires Manage Server (the bot owner
 * can always run it) and asks for confirmation with a button.
 */

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  PermissionFlagsBits,
} = require('discord.js');

const channels = require('../Utils/channels');
const { mayConfigure, DENIED } = require('./setchannel');

/** How long the confirmation button stays live. */
const CONFIRM_MS = 30_000;

function preview(guildId) {
  const rows = channels.list(guildId);

  if (!rows.length) {
    return {
      done: true,
      payload: {
        content: 'The bot already works in every channel here. Nothing to reset.',
      },
    };
  }

  const embed = new EmbedBuilder()
    .setTitle('Open the bot up to every channel?')
    .setColor(0xed4245)
    .setDescription(
      `This server currently allows ${rows.length} channel${rows.length === 1 ? '' : 's'}:\n` +
        rows
          .slice(0, 20)
          .map((row) => `<#${row.channel_id}>`)
          .join('\n') +
        (rows.length > 20 ? `\n…and ${rows.length - 20} more` : '')
    )
    .setFooter({ text: 'The bot will answer anywhere it can see after this.' });

  return { done: false, count: rows.length, payload: { embeds: [embed] } };
}

const buttons = () =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('resetchannels:yes')
      .setLabel('Open it up')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('resetchannels:no')
      .setLabel('Keep them')
      .setStyle(ButtonStyle.Secondary)
  );

/**
 * Ask for confirmation, wait for the button, then reset.
 *
 * Only the person who ran the command can press the button.
 */
async function askThenReset({ guildId, userId, send }) {
  const asked = preview(guildId);
  if (asked.done) return send(asked.payload);

  const prompt = await send({ ...asked.payload, components: [buttons()] });

  let choice = null;
  try {
    choice = await prompt.awaitMessageComponent({
      componentType: ComponentType.Button,
      time: CONFIRM_MS,
      filter: (button) => button.user.id === userId,
    });
  } catch {
    // Timed out: remove the buttons.
    await prompt.edit({ components: [] }).catch(() => {});
    return prompt;
  }

  if (choice.customId === 'resetchannels:no') {
    await choice.update({
      content: 'Left the channel list alone.',
      embeds: [],
      components: [],
    });
    return prompt;
  }

  const cleared = channels.reset(guildId);

  await choice.update({
    content:
      `Cleared ${cleared} channel${cleared === 1 ? '' : 's'}. ` +
      'The bot now works in every channel it can see. `.setchannel` narrows it again.',
    embeds: [],
    components: [],
  });

  return prompt;
}

module.exports = {
  aliases: ['resetchannels', 'clearchannels'],

  data: new SlashCommandBuilder()
    .setName('resetchannels')
    .setDescription('Lets the bot work in every channel again.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: 'That only makes sense in a server.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (!mayConfigure(interaction.member, interaction.user.id)) {
      await interaction.reply({ content: DENIED, flags: MessageFlags.Ephemeral });
      return;
    }

    await askThenReset({
      guildId: interaction.guildId,
      userId: interaction.user.id,
      send: async (payload) => {
        await interaction.reply({ ...payload, withResponse: true });
        return interaction.fetchReply();
      },
    });
  },

  async run(message) {
    if (!message.guildId) {
      await message.channel.send('That only makes sense in a server.');
      return;
    }

    if (!mayConfigure(message.member, message.author.id)) {
      await message.channel.send(DENIED);
      return;
    }

    await askThenReset({
      guildId: message.guildId,
      userId: message.author.id,
      send: (payload) => message.channel.send(payload),
    });
  },

  preview,
  CONFIRM_MS,
};
