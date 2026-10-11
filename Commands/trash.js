'use strict';

/**
 * .trash <item> [quantity] - destroy items you do not want.
 *
 * Two steps, like .release: the first shows what would go, the second does it.
 *
 * The confirmation uses the item's slug rather than its slot number, because
 * slot numbers can shift if the bag changes between the two steps.
 *
 *   .trash 3              what would happen
 *   .trash 3 5            ...to five of them
 *   .trash fire-stone all everything of that kind
 *   .trash fire-stone 5 yes   actually do it
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const store = require('../Utils/store');
const inventory = require('../Utils/inventory');

/** Words that count as "yes, I meant it". Matches .release. */
const CONFIRM = /^(yes|y|confirm|sure)$/i;

/** Words meaning the whole stack. */
const ALL = /^(all|every|max|\*)$/i;

/**
 * Split ".trash fire-stone 5 yes" into its three parts.
 *
 * The item name can be several words, so the quantity and confirmation are
 * taken from the end and the rest is the item name.
 */
function parseArgs(args = []) {
  const words = args.filter((w) => w !== null && w !== undefined).map(String);

  let confirmed = false;
  if (words.length && CONFIRM.test(words[words.length - 1])) {
    confirmed = true;
    words.pop();
  }

  let quantity = 1;
  let all = false;

  if (words.length > 1) {
    const last = words[words.length - 1];
    if (ALL.test(last)) {
      all = true;
      words.pop();
    } else if (/^\d+$/.test(last)) {
      quantity = Math.max(1, parseInt(last, 10));
      words.pop();
    }
  }

  return { query: words.join(' '), quantity, all, confirmed };
}

/** The "are you sure" card. */
function buildPreview(row, quantity) {
  const everything = quantity >= row.quantity;

  return {
    embeds: [
      new EmbedBuilder()
        .setTitle(`Trash ${quantity} × ${row.displayName}?`)
        .setColor(0xed4245)
        .setDescription(
          everything
            ? `That is **all ${row.quantity}** of them. Trashing is permanent and pays nothing.`
            : `You have ${row.quantity}. Trashing is permanent and pays nothing.`
        )
        .setFooter({
          text: `Type ".trash ${row.item} ${everything ? 'all' : quantity} yes" to confirm`,
        }),
    ],
  };
}

function trash(userId, args) {
  const { query, quantity, all, confirmed } = parseArgs(args);
  const rows = inventory.bagRows(userId);

  if (!rows.length) return { content: 'Your bag is empty, so there is nothing to trash.' };

  const { row, error } = inventory.resolve(rows, query);
  if (error) return { content: error };

  const wanted = all ? row.quantity : Math.min(quantity, row.quantity);

  if (!confirmed) return buildPreview(row, wanted);

  const result = store.trashItem(userId, row.item, wanted);

  if (!result.ok) return { content: `You are not carrying any ${row.displayName} any more.` };

  const left = row.quantity - result.removed;

  return {
    content:
      `Trashed **${result.removed} × ${row.displayName}**.` +
      (left > 0 ? ` ${left} left.` : ' None left.'),
  };
}

module.exports = {
  aliases: ['trash', 'discard'],

  data: new SlashCommandBuilder()
    .setName('trash')
    .setDescription('Destroys items in your bag. Permanent.')
    .addStringOption((option) =>
      option
        .setName('item')
        .setDescription('Its number from /bag, or its name.')
        .setRequired(true)
    )
    .addIntegerOption((option) =>
      option.setName('quantity').setDescription('How many. Defaults to one.').setMinValue(1)
    )
    .addBooleanOption((option) =>
      option.setName('confirm').setDescription('Set to true to actually trash them.')
    ),

  async execute(interaction) {
    store.ensureUser(interaction.user.id);

    const args = [interaction.options.getString('item')];
    const quantity = interaction.options.getInteger('quantity');
    if (quantity) args.push(String(quantity));
    if (interaction.options.getBoolean('confirm')) args.push('yes');

    await interaction.reply(trash(interaction.user.id, args));
  },

  async run(message, args) {
    store.ensureUser(message.author.id);
    await message.channel.send(trash(message.author.id, args));
  },

  trash,
  parseArgs,
  buildPreview,
};
