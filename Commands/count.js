'use strict';

/**
 * .count - how many of each species you own.
 *
 * Groups the party into per-species totals, most-owned first.
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const store = require('../Utils/store');
const rarity = require('../Utils/rarity');
const pager = require('../Utils/pager');

const PAGE_SIZE = 20;

/** Build the paged view of one user's counts. */
function buildCount(user) {
  const rows = store.speciesCounts(user.id);

  if (!rows.length) {
    return {
      empty: new EmbedBuilder()
        .setTitle(`${user.username}'s counts`)
        .setDescription('Nothing caught yet. Type `.d` to drop one.')
        .setColor(0x888888),
    };
  }

  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const total = rows.reduce((sum, row) => sum + row.total, 0);

  const render = (index) => {
    const slice = rows.slice(index * PAGE_SIZE, (index + 1) * PAGE_SIZE);

    const lines = slice.map((row, i) => {
      const place = index * PAGE_SIZE + i + 1;
      const mark = row.rarity === 'normal' ? '' : ` · ${rarity.LABELS[row.rarity]}`;
      return `\`${String(place).padStart(3, ' ')}\` **${row.display_name}** ×${row.total}${mark}`;
    });

    return new EmbedBuilder()
      .setTitle(`${user.username}'s counts`)
      .setDescription(lines.join('\n'))
      .setColor(0x4287f5)
      .setFooter({
        text: `${rows.length} species · ${total} Pokemon · page ${index + 1}/${pages}`,
      });
  };

  return { pages, page: 0, render };
}

module.exports = {
  aliases: ['count', 'counts'],

  data: new SlashCommandBuilder()
    .setName('count')
    .setDescription('Shows how many of each Pokemon you have caught.'),

  async execute(interaction) {
    store.ensureUser(interaction.user.id);
    const built = buildCount(interaction.user);

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

  async run(message) {
    store.ensureUser(message.author.id);
    const built = buildCount(message.author);

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

  buildCount,
  PAGE_SIZE,
};
