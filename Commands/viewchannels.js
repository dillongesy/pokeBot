'use strict';

/**
 * .viewchannels - which channels this server lets the bot work in.
 *
 * Available to everyone. Like the other channel commands, it works in every
 * channel regardless of the allowlist (see Utils/channels.js).
 */

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');

const channels = require('../Utils/channels');

/** Discord's embed description limit is 4096; 40 channels is well inside it. */
const PAGE = 40;

function view(guildId) {
  const rows = channels.list(guildId);

  if (!rows.length) {
    return {
      content:
        'This server has not restricted the bot, so it works in **every channel** ' +
        'it can see. `.setchannel #somewhere` narrows it down.',
    };
  }

  const shown = rows.slice(0, PAGE);

  const embed = new EmbedBuilder()
    .setTitle('Where the bot works')
    .setColor(0x5865f2)
    .setDescription(shown.map((row) => `<#${row.channel_id}>`).join('\n'))
    .setFooter({
      text:
        rows.length > PAGE
          ? `Showing ${PAGE} of ${rows.length} channels`
          : `${rows.length} channel${rows.length === 1 ? '' : 's'}. Use .resetchannels to open it back up.`,
    });

  return { embeds: [embed] };
}

module.exports = {
  aliases: ['viewchannels', 'channels'],

  data: new SlashCommandBuilder()
    .setName('viewchannels')
    .setDescription('Lists the channels this server lets the bot work in.'),

  async execute(interaction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: 'That only makes sense in a server.', flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.reply(view(interaction.guildId));
  },

  async run(message) {
    if (!message.guildId) {
      await message.channel.send('That only makes sense in a server.');
      return;
    }

    await message.channel.send(view(message.guildId));
  },

  view,
};
