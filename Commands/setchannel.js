'use strict';

/**
 * .setchannel #channel [#channel ...] - confine the bot to certain channels.
 *
 *   .setchannel #pokemon             only #pokemon from now on
 *   .setchannel #pokemon #spam       both
 *   .setchannel remove #spam         take one back off
 *
 * Requires Manage Server. The bot owner can always run it.
 *
 * With no channels set the bot works everywhere, and removing the last
 * channel restores that. This command itself ignores the allowlist. See
 * Utils/channels.js.
 */

const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');

const channels = require('../Utils/channels');
const admin = require('../Utils/admin');

const DENIED = 'That needs the **Manage Server** permission.';

/**
 * May this person configure the bot here? Requires Manage Server rather than
 * Administrator, so servers don't have to hand out full admin rights.
 */
function mayConfigure(member, userId) {
  if (admin.isOwner(userId)) return true;
  if (!member || !member.permissions) return false;

  return (
    member.permissions.has(PermissionFlagsBits.ManageGuild) ||
    member.permissions.has(PermissionFlagsBits.Administrator)
  );
}

/** "<#1>, <#2> and <#3>" */
const listOf = (ids) => {
  const mentions = ids.map((id) => `<#${id}>`);
  if (mentions.length <= 1) return mentions.join('');
  return `${mentions.slice(0, -1).join(', ')} and ${mentions[mentions.length - 1]}`;
};

/**
 * Work out what to say, given a guild and the raw arguments.
 *
 * Kept separate from the handlers so it can be tested without Discord.
 */
function configure(guildId, args) {
  const words = (args || []).filter((word) => String(word ?? '').trim());

  // ".setchannel remove #x" is the only sub-verb. Everything else is channels.
  const removing = ['remove', 'rm', 'delete', 'off'].includes(
    String(words[0] ?? '').toLowerCase()
  );

  const { ids, bad } = channels.parseChannels(removing ? words.slice(1) : words);

  if (bad.length) {
    return {
      content:
        `Not a channel: ${bad.map((word) => `\`${word}\``).join(', ')}. ` +
        'Tag it with a `#`, or paste its id.',
    };
  }

  if (!ids.length) {
    const current = channels.count(guildId);
    return {
      content:
        `Which channel? Try \`.setchannel #general\`.` +
        (current
          ? ` This server currently allows ${current} channel${current === 1 ? '' : 's'} - \`.viewchannels\`.`
          : ' Right now the bot works in every channel it can see.'),
    };
  }

  if (removing) {
    const { removed, missing, remaining } = channels.disallow(guildId, ids);

    if (!removed.length) {
      return { content: `${listOf(missing)} ${missing.length === 1 ? 'was' : 'were'} not on the list anyway.` };
    }

    return {
      content:
        `Removed ${listOf(removed)}.` +
        (missing.length ? ` ${listOf(missing)} was not on the list.` : '') +
        (remaining === 0
          ? ' That was the last one, so the bot works in **every** channel again.'
          : ` ${remaining} channel${remaining === 1 ? '' : 's'} left - \`.viewchannels\`.`),
    };
  }

  const before = channels.count(guildId);
  const { added, already } = channels.allow(guildId, ids, null);

  const embed = new EmbedBuilder()
    .setTitle('Allowed channels updated')
    .setColor(0x5865f2)
    .setDescription(
      added.length
        ? `The bot will work in ${listOf(added)}.`
        : `${listOf(already)} ${already.length === 1 ? 'was' : 'were'} already allowed.`
    );

  if (added.length && already.length) {
    embed.addFields({ name: 'Already allowed', value: listOf(already) });
  }

  // Adding the first channel restricts the whole server, so point that out.
  if (before === 0 && added.length) {
    embed.addFields({
      name: 'Heads up',
      value:
        'The bot used to work in every channel. Now it works **only** in the ones listed here. ' +
        '`.resetchannels` puts it back.',
    });
  }

  embed.setFooter({ text: '.viewchannels to see them all · .setchannel remove #x to undo' });

  return { embeds: [embed] };
}

module.exports = {
  aliases: ['setchannel', 'setchannels'],

  data: new SlashCommandBuilder()
    .setName('setchannel')
    .setDescription('Confines the bot to certain channels.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((option) =>
      option.setName('channel').setDescription('The channel to allow.').setRequired(true)
    )
    .addBooleanOption((option) =>
      option.setName('remove').setDescription('Take it back off the list instead.')
    ),

  async execute(interaction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: 'That only makes sense in a server.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (!mayConfigure(interaction.member, interaction.user.id)) {
      await interaction.reply({ content: DENIED, flags: MessageFlags.Ephemeral });
      return;
    }

    const channel = interaction.options.getChannel('channel');
    const args = interaction.options.getBoolean('remove')
      ? ['remove', channel.id]
      : [channel.id];

    await interaction.reply(configure(interaction.guildId, args));
  },

  async run(message, args) {
    if (!message.guildId) {
      await message.channel.send('That only makes sense in a server.');
      return;
    }

    if (!mayConfigure(message.member, message.author.id)) {
      await message.channel.send(DENIED);
      return;
    }

    await message.channel.send(configure(message.guildId, args));
  },

  configure,
  mayConfigure,
  DENIED,
};
