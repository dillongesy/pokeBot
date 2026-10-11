'use strict';

/**
 * .hint - reveal some letters of the Pokemon currently dropped here.
 *
 * Each hint shows a newly randomised half of the letters, so repeated hints
 * reveal more of the name. This is intentional.
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const store = require('../Utils/store');
const rates = require('../Utils/rates');

/** Punctuation that is never masked. */
const PUNCTUATION = /[^\p{L}\p{N}]/u;

/**
 * Mask a name, leaving a random half of its letters showing.
 *
 * Punctuation and spaces are always shown and are not counted, so names like
 * "Ho-Oh" and "Mr. Mime" keep their shape.
 */
function maskName(name) {
  const characters = [...name];
  const positions = characters
    .map((character, position) => ({ character, position }))
    .filter(({ character }) => !PUNCTUATION.test(character))
    .map(({ position }) => position);

  if (!positions.length) return name;

  const target = Math.max(1, Math.floor(positions.length * rates.hintRevealFraction));

  // Shuffle a copy and take the first `target`, so the count is always exact.
  const pool = [...positions];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  const shown = new Set(pool.slice(0, target));

  return characters
    .map((character, position) => {
      // A space still reads as a space; every other mark shows as itself.
      if (character === ' ') return ' ';
      if (PUNCTUATION.test(character)) return character;
      return shown.has(position) ? character.toUpperCase() : '\\_';
    })
    .join(' ');
}

function buildHint(channelId) {
  const drop = store.newestOpenDrop(channelId);

  if (!drop) {
    return { content: 'Nothing is waiting to be caught here. Type `.d` to drop one.' };
  }

  const name = drop.species_name;
  const letters = [...name].filter((c) => !PUNCTUATION.test(c)).length;

  const embed = new EmbedBuilder()
    .setTitle('Hint')
    .setColor(0x9b59b6)
    .setDescription(`${maskName(name)}`)
    .addFields(
      { name: 'Letters', value: String(letters), inline: true },
      { name: 'Region', value: drop.region || 'Unknown', inline: true },
      { name: 'Type', value: String(drop.types || '').split(',').join(' / '), inline: true }
    );

  return { embeds: [embed] };
}

module.exports = {
  // .h is short for hint. Use .help or .commands for the help card.
  aliases: ['hint', 'h'],

  data: new SlashCommandBuilder()
    .setName('hint')
    .setDescription('Reveals some letters of the Pokemon dropped here.'),

  async execute(interaction) {
    await interaction.reply(buildHint(interaction.channelId));
  },

  async run(message) {
    await message.channel.send(buildHint(message.channelId));
  },

  buildHint,
  maskName,
  PUNCTUATION,
};
