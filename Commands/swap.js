'use strict';

/**
 * .swap <a> <b> - swap two party slots.
 *
 * The same as `.p swap a b`: the Pokemon in slot a goes to slot b and the one
 * in b to a. Slot numbers are the ones `.party` shows. Not allowed during a
 * battle or trade.
 */

const { SlashCommandBuilder } = require('discord.js');

const store = require('../Utils/store');
const party = require('./party');

module.exports = {
  aliases: ['swap', 'sw'],

  data: new SlashCommandBuilder()
    .setName('swap')
    .setDescription('Swaps two of your party slots.')
    .addIntegerOption((option) =>
      option.setName('first').setDescription('A slot number, from /party.').setRequired(true).setMinValue(1)
    )
    .addIntegerOption((option) =>
      option.setName('second').setDescription('The other slot number.').setRequired(true).setMinValue(1)
    ),

  async execute(interaction) {
    store.ensureUser(interaction.user.id);
    const a = interaction.options.getInteger('first');
    const b = interaction.options.getInteger('second');
    await interaction.reply({ content: party.runSwap(interaction.user.id, [a, b]) });
  },

  async run(message, args) {
    store.ensureUser(message.author.id);
    const [a, b] = args.slice(0, 2).map((word) => store.parsePartyNumber(word));
    await message.channel.send({ content: party.runSwap(message.author.id, [a, b]) });
  },
};
