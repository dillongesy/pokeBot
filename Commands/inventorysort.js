'use strict';

/**
 * .inventorysort <mode> - decide what order your bag comes back in.
 *
 *   .is alphabetical      A-Z by name
 *   .is shop              the order the shop lists things in
 *   .is quantity          most-carried first
 *   .is swap <a> <b>      swap two slots by hand
 *
 * The choice is saved, so .bag, .trash and .examine agree on slot numbers.
 * Swapping switches the mode to "custom", otherwise the swap would be undone
 * by the next sort. With no argument, shows the current mode.
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const store = require('../Utils/store');
const inventory = require('../Utils/inventory');

/** The spellings each mode answers to. */
const MODES = {
  alphabetical: ['alphabetical', 'alpha', 'a', 'az', 'a-z', 'name', 'names'],
  shop: ['shop', 's', 'default'],
  quantity: ['quantity', 'q', 'qty', 'count', 'amount'],
  custom: ['custom', 'mine', 'manual', 'own'],
};

/** How each mode reads back. */
const LABELS = {
  alphabetical: 'A-Z by name',
  shop: 'the shop’s own order',
  quantity: 'most-carried first',
  custom: 'your own order',
};

function parseMode(word) {
  const wanted = String(word || '').toLowerCase();
  for (const [mode, spellings] of Object.entries(MODES)) {
    if (spellings.includes(wanted)) return mode;
  }
  return null;
}

/** The "here is where you are, here is what you can say" card. */
function buildHelp(userId) {
  const user = store.getUser(userId);
  const current = user ? user.bag_sort : 'shop';

  return {
    embeds: [
      new EmbedBuilder()
        .setTitle('Bag order')
        .setColor(0x9b7653)
        .setDescription(`Your bag is sorted by **${LABELS[current] || current}**.`)
        .addFields({
          name: 'Change it',
          value: Object.entries(LABELS)
            .map(([mode, label]) => `\`.is ${mode}\` - ${label}`)
            .join('\n') + '\n`.is swap <a> <b>` - move two slots by hand',
        }),
    ],
  };
}

/** ".is swap 1 4" - reorder, then say what moved. */
function runSwap(userId, rawA, rawB) {
  const a = parseInt(rawA, 10);
  const b = parseInt(rawB, 10);

  if (!Number.isInteger(a) || !Number.isInteger(b)) {
    return { content: 'Which two slots? Try `.is swap 1 4`, using the numbers from `.bag`.' };
  }

  // Swap against the bag as it is displayed right now, so the numbers the
  // player just read are the numbers that move.
  const rows = inventory.bagRows(userId);
  const result = store.swapInventoryPositions(userId, a, b, rows);

  if (!result.ok) return { content: result.message };

  store.setBagOrder(userId, 'custom');

  const [first, second] = result.moved;
  return {
    content:
      `Moved **${first.displayName}** into slot ${a} and **${second.displayName}** into slot ${b}.` +
      ' Your bag is now in your own order.',
  };
}

function sortBag(userId, args = []) {
  const words = args.filter((w) => w !== null && w !== undefined).map(String);

  if (!words.length) return buildHelp(userId);

  if (words[0].toLowerCase() === 'swap') return runSwap(userId, words[1], words[2]);

  const mode = parseMode(words[0]);
  if (!mode) {
    return {
      content:
        `No sort called "${words[0]}". There is: ${Object.keys(LABELS).join(', ')}, or ` +
        '`swap <a> <b>`.',
    };
  }

  // Switching to "your order" without ever having swapped anything would show
  // an arbitrary order, so number the bag as it looks now first.
  if (mode === 'custom') {
    const rows = inventory.bagRows(userId);
    if (!rows.length) return { content: 'Your bag is empty, so there is nothing to order.' };
    if (rows.every((row) => row.position == null)) {
      store.assignInventoryPositions(userId, rows.map((row) => row.item));
    }
  }

  store.setBagOrder(userId, mode);
  return { content: `Your bag is now sorted by **${LABELS[mode]}**.` };
}

module.exports = {
  aliases: ['inventorysort', 'is', 'io', 'oi', 'bagsort'],

  data: new SlashCommandBuilder()
    .setName('inventorysort')
    .setDescription('Sets what order your bag comes back in.')
    .addStringOption((option) =>
      option
        .setName('mode')
        .setDescription('How to order it.')
        .addChoices(...Object.entries(LABELS).map(([value, name]) => ({ name, value })))
    )
    .addIntegerOption((option) =>
      option.setName('swap_a').setDescription('First slot to swap.').setMinValue(1)
    )
    .addIntegerOption((option) =>
      option.setName('swap_b').setDescription('Second slot to swap.').setMinValue(1)
    ),

  async execute(interaction) {
    store.ensureUser(interaction.user.id);

    const a = interaction.options.getInteger('swap_a');
    const b = interaction.options.getInteger('swap_b');

    if (a || b) {
      await interaction.reply(runSwap(interaction.user.id, a, b));
      return;
    }

    const mode = interaction.options.getString('mode');
    await interaction.reply(sortBag(interaction.user.id, mode ? [mode] : []));
  },

  async run(message, args) {
    store.ensureUser(message.author.id);
    await message.channel.send(sortBag(message.author.id, args));
  },

  sortBag,
  runSwap,
  parseMode,
  MODES,
  LABELS,
};
