'use strict';

/**
 * .compare @user - what they have that you do not.
 *
 * Compares by species, not by individual Pokemon. The default shows what you
 * are missing; `.compare @user mine` shows what you have that they don't.
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const store = require('../Utils/store');
const names = require('../Utils/names');
const rarity = require('../Utils/rarity');
const pager = require('../Utils/pager');

const PAGE_SIZE = 30;

/** Words that flip the comparison round. */
const FLIP = new Set(['mine', 'me', 'reverse', 'theirs', 'flip']);

/**
 * The species one side has and the other does not.
 *
 * @returns {object[]} species index entries, in dex order
 */
function difference(haveUserId, lackUserId) {
  const have = store.caughtSpeciesIds(haveUserId);
  const lack = store.caughtSpeciesIds(lackUserId);

  return [...have]
    .filter((id) => !lack.has(id))
    .map((id) => names.speciesById(id))
    .filter(Boolean)
    .sort((a, b) => a.id - b.id);
}

function buildCompare(viewer, other, args = []) {
  const flipped = args.some((arg) => FLIP.has(String(arg ?? '').toLowerCase()));

  // Default: what the other person has that the viewer is missing.
  const [haveUser, lackUser] = flipped ? [viewer, other] : [other, viewer];
  const missing = difference(haveUser.id, lackUser.id);

  const title = flipped
    ? `What you have that ${other.username} does not`
    : `What ${other.username} has that you do not`;

  if (!missing.length) {
    return {
      empty: new EmbedBuilder()
        .setTitle(title)
        .setDescription(
          flipped
            ? `${other.username} has everything you have.`
            : `You have everything ${other.username} has.`
        )
        .setColor(0x57f287),
    };
  }

  const pages = Math.max(1, Math.ceil(missing.length / PAGE_SIZE));

  const render = (index) => {
    const slice = missing.slice(index * PAGE_SIZE, (index + 1) * PAGE_SIZE);

    const lines = slice.map((species) => {
      const bucket = rarity.of(species.id);
      const mark = bucket === 'normal' ? '' : ` · ${rarity.LABELS[bucket]}`;
      return `\`#${String(species.id).padStart(4, '0')}\` ${species.displayName}${mark}`;
    });

    return new EmbedBuilder()
      .setTitle(title)
      .setDescription(lines.join('\n'))
      .setColor(0x5865f2)
      .setFooter({ text: `${missing.length} species · page ${index + 1}/${pages}` });
  };

  return { pages, page: 0, render, missing };
}

module.exports = {
  aliases: ['compare', 'diff'],

  data: new SlashCommandBuilder()
    .setName('compare')
    .setDescription('Compares your caught species against someone else.')
    .addUserOption((option) =>
      option.setName('user').setDescription('Who to compare against.').setRequired(true)
    )
    .addBooleanOption((option) =>
      option
        .setName('mine')
        .setDescription('Show what you have that they do not, instead.')
    ),

  async execute(interaction) {
    const other = interaction.options.getUser('user');

    if (other.id === interaction.user.id) {
      await interaction.reply('Comparing yourself with yourself will not tell you much.');
      return;
    }

    store.ensureUser(interaction.user.id);
    store.ensureUser(other.id);

    const args = interaction.options.getBoolean('mine') ? ['mine'] : [];
    const built = buildCompare(interaction.user, other, args);

    if (built.empty) {
      await interaction.reply({ embeds: [built.empty] });
      return;
    }

    await pager.sendPaged({
      send: pager.interactionSender(interaction),
      pages: built.pages,
      page: built.page,
      render: built.render,
      userId: interaction.user.id,
    });
  },

  async run(message, args) {
    const other = message.mentions.users.first();

    if (!other) {
      await message.channel.send('Compare with who? Try `.compare @someone`.');
      return;
    }

    if (other.id === message.author.id) {
      await message.channel.send('Comparing yourself with yourself will not tell you much.');
      return;
    }

    store.ensureUser(message.author.id);
    store.ensureUser(other.id);

    const built = buildCompare(message.author, other, args);

    if (built.empty) {
      await message.channel.send({ embeds: [built.empty] });
      return;
    }

    await pager.sendPaged({
      send: (payload) => message.channel.send(payload),
      pages: built.pages,
      page: built.page,
      render: built.render,
      userId: message.author.id,
    });
  },

  difference,
  buildCompare,
  PAGE_SIZE,
};
