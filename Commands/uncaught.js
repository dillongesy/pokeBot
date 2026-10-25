'use strict';

/**
 * .uncaught - every species you have never caught.
 *
 * Counts species, not forms: an Alolan Vulpix counts as Vulpix, matching
 * .count and the quests. Can be filtered by region or rarity.
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const store = require('../Utils/store');
const rarity = require('../Utils/rarity');
const names = require('../Utils/names');
const pager = require('../Utils/pager');

const PAGE_SIZE = 30;

/** The regions in the imported data, in the order people think of them. */
const REGIONS = [
  'Kanto',
  'Johto',
  'Hoenn',
  'Sinnoh',
  'Unova',
  'Kalos',
  'Alola',
  'Galar',
  'Hisui',
  'Paldea',
];

const REGION_LOOKUP = new Map(REGIONS.map((region) => [region.toLowerCase(), region]));

/** Read ".uncaught kanto" or ".uncaught legendary" into a filter. */
function parseArgs(args = []) {
  const filter = { region: null, rarity: null };

  for (const raw of args) {
    const arg = String(raw ?? '').toLowerCase().trim();
    if (!arg) continue;

    if (REGION_LOOKUP.has(arg)) {
      filter.region = REGION_LOOKUP.get(arg);
      continue;
    }

    const bucket = rarity.parse(arg);
    if (bucket) filter.rarity = bucket;
  }

  return filter;
}

/** The droppable species a user is missing, in dex order. */
function missingFor(userId, filter = {}) {
  const caught = store.caughtSpeciesIds(userId);

  return names.allSpecies().filter((species) => {
    if (caught.has(species.id)) return false;
    if (filter.region && species.region !== filter.region) return false;
    if (filter.rarity && rarity.of(species.id) !== filter.rarity) return false;
    return true;
  });
}

function buildUncaught(user, args) {
  const filter = parseArgs(args);
  const missing = missingFor(user.id, filter);

  const scope = [filter.region, filter.rarity ? rarity.LABELS[filter.rarity] : null]
    .filter(Boolean)
    .join(' ');

  const title = scope ? `${user.username}'s uncaught ${scope}` : `${user.username}'s uncaught`;

  if (!missing.length) {
    return {
      empty: new EmbedBuilder()
        .setTitle(title)
        .setDescription(
          scope ? `You have caught every ${scope} Pokemon.` : 'You have caught them all.'
        )
        .setColor(0x57f287),
    };
  }

  const pages = Math.max(1, Math.ceil(missing.length / PAGE_SIZE));

  const render = (index) => {
    const slice = missing.slice(index * PAGE_SIZE, (index + 1) * PAGE_SIZE);
    const lines = slice.map((species) => `\`#${String(species.id).padStart(4, '0')}\` ${species.displayName}`);

    return new EmbedBuilder()
      .setTitle(title)
      .setDescription(lines.join('\n'))
      .setColor(0xed4245)
      .setFooter({ text: `${missing.length} still missing. Page ${index + 1}/${pages}` });
  };

  return { pages, page: 0, render, missing };
}

module.exports = {
  aliases: ['uncaught', 'u', 'missing'],

  data: new SlashCommandBuilder()
    .setName('uncaught')
    .setDescription('Lists the Pokemon you have never caught.')
    .addStringOption((option) =>
      option
        .setName('region')
        .setDescription('Only this region.')
        .addChoices(...REGIONS.map((region) => ({ name: region, value: region.toLowerCase() })))
    )
    .addStringOption((option) =>
      option
        .setName('rarity')
        .setDescription('Only this rarity.')
        .addChoices(
          { name: 'Legendary', value: 'legendary' },
          { name: 'Mythical', value: 'mythical' },
          { name: 'Ultra Beast', value: 'ultrabeast' },
          { name: 'Common', value: 'normal' }
        )
    ),

  async execute(interaction) {
    store.ensureUser(interaction.user.id);

    const args = [
      interaction.options.getString('region'),
      interaction.options.getString('rarity'),
    ].filter(Boolean);

    const built = buildUncaught(interaction.user, args);

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
    store.ensureUser(message.author.id);
    const built = buildUncaught(message.author, args);

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

  parseArgs,
  missingFor,
  buildUncaught,
  REGIONS,
  PAGE_SIZE,
};
