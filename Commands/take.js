'use strict';

/**
 * .take <pokemon> - take back whatever one of your Pokemon is holding.
 *
 * Also reverts any form change caused by the item (Mega Stones, plates,
 * memories, masks and so on) and returns the item to the bag.
 *
 * An alias for ".useitem <id> clear"; both call `unequip` in Commands/useitem.js.
 */

const { SlashCommandBuilder } = require('discord.js');

const store = require('../Utils/store');
const { unequip } = require('./useitem');

function take(userId, rawPokemonId) {
  const pokemonId = store.parsePartyNumber(rawPokemonId);

  if (!Number.isInteger(pokemonId)) {
    return {
      content: 'Take from which Pokemon? Try `.take 12`, using the number from `.party`.',
    };
  }

  const row = store.getOwnedByNumber(userId, pokemonId);
  if (!row) return { content: store.noSuchNumber(userId, pokemonId) };

  return unequip(userId, row);
}

module.exports = {
  aliases: ['take', 'unequip'],

  data: new SlashCommandBuilder()
    .setName('take')
    .setDescription('Takes back whatever one of your Pokemon is holding.')
    .addIntegerOption((option) =>
      option
        .setName('pokemon')
        .setDescription('Its number, from /party.')
        .setRequired(true)
    ),

  async execute(interaction) {
    store.ensureUser(interaction.user.id);
    await interaction.reply(take(interaction.user.id, interaction.options.getInteger('pokemon')));
  },

  async run(message, args) {
    store.ensureUser(message.author.id);
    await message.channel.send(take(message.author.id, args[0]));
  },

  take,
};
