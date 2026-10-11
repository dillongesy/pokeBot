'use strict';

/**
 * .bag - what you are carrying.
 *
 * A flat numbered list. The slot numbers are used by .trash, .examine and
 * .is swap, so they must stay stable.
 *
 * The order is whatever .inventorysort last set (shop order by default).
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const store = require('../Utils/store');
const inventory = require('../Utils/inventory');
const pager = require('../Utils/pager');

const PAGE_SIZE = 20;

/** How each sort mode reads in the footer. */
const SORT_LABELS = {
  shop: 'shop order',
  alphabetical: 'A-Z',
  quantity: 'quantity',
  custom: 'your order',
};

const money = (amount) => Number(amount || 0).toLocaleString('en-US');

/**
 * Build the paged bag view.
 *
 * Returns either { empty } or { pages, page, render } for the pager, the same
 * shape .party and .compare use.
 */
function buildBag(user, sort = null) {
  const balance = store.getUser(user.id);
  const rows = inventory.bagRows(user.id, sort);
  const mode = sort || (balance ? balance.bag_sort : 'shop');

  const wallet =
    `**${money(balance ? balance.coins : 0)}** coins · ` +
    `**${money(balance ? balance.gold : 0)}** gold`;

  if (!rows.length) {
    return {
      empty: new EmbedBuilder()
        .setTitle(`${user.username}'s bag`)
        .setColor(0x9b7653)
        .setDescription(`${wallet}\n\nNothing yet. Have a look at \`.shop\`.`),
    };
  }

  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const width = String(rows.length).length;

  const render = (index) => {
    const slice = rows.slice(index * PAGE_SIZE, (index + 1) * PAGE_SIZE);

    const lines = slice.map(
      (row) =>
        `\`${String(row.slot).padStart(width, ' ')}\` **${row.displayName}** ×${row.quantity}` +
        ` · ${row.category}`
    );

    return new EmbedBuilder()
      .setTitle(`${user.username}'s bag`)
      .setColor(0x9b7653)
      .setDescription(`${wallet}\n\n${lines.join('\n')}`)
      .setFooter({
        text:
          `${rows.length} item${rows.length === 1 ? '' : 's'} · ${SORT_LABELS[mode] || mode}` +
          ` · page ${index + 1}/${pages}` +
          ' · .examine <n> to read one',
      });
  };

  return { pages, page: 0, render, rows };
}

module.exports = {
  aliases: ['bag', 'inventory', 'i', 'items'],

  data: new SlashCommandBuilder()
    .setName('bag')
    .setDescription('Shows the items you own.')
    .addStringOption((option) =>
      option
        .setName('sort')
        .setDescription('Order it differently, just for this look.')
        .addChoices(
          ...Object.entries(SORT_LABELS).map(([value, name]) => ({ name, value }))
        )
    ),

  async execute(interaction) {
    store.ensureUser(interaction.user.id);
    const built = buildBag(interaction.user, interaction.options.getString('sort'));

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

    // ".bag quantity" looks at it one way without changing the saved order.
    const asked = String(args[0] || '').toLowerCase();
    const built = buildBag(message.author, SORT_LABELS[asked] ? asked : null);

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

  buildBag,
  PAGE_SIZE,
  SORT_LABELS,
};
