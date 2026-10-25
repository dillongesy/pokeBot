'use strict';

/**
 * .buy <id> [quantity] - spend coins or gold.
 *
 * One command for both shops; the currency is determined by which shop the
 * id belongs to. Gold shop buffs apply immediately instead of going in the bag.
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const store = require('../Utils/store');
const content = require('../Utils/content');
const questengine = require('../Utils/questengine');
const { titleCase } = require('../Utils/display');

const money = (amount) => amount.toLocaleString('en-US');

/** Gold shop buffs are bought one at a time. */
const MAX_QUANTITY = 99;

/**
 * Recalculate quests after a purchase, and add a line if one finished.
 *
 * Errors are logged rather than thrown; the purchase has already gone through
 * and the next sync will catch up.
 */
function questComplete(userId, embed) {
  try {
    const line = questengine.announce(questengine.sync(userId).completed);
    if (line) embed.addFields({ name: 'Quest complete', value: line });
  } catch (err) {
    console.error('Quest sync failed after a purchase:', err);
  }
}

/**
 * Work out which tier of a tiered buff this player may buy next.
 *
 * ".goldbuy critical-drop" always means the next tier, and tiers must be
 * bought in order.
 *
 * @returns {{ entry?: object, owned?: object, error?: string }}
 */
function nextTier(userId, tiers) {
  const held = store.buffValue(userId, tiers[0].buff, 0);

  // The highest tier already owned. Compared with a tolerance because the
  // values are floating-point fractions.
  const owned = [...tiers].reverse().find((entry) => held >= entry.value - 1e-9) || null;

  const next = tiers.find((entry) => entry.value > held + 1e-9);

  if (!next) {
    return {
      owned,
      error:
        `You already have every **${tiers[0].name.replace(/ \d+$/, '')}** tier. ` +
        'There is nothing more to buy there.',
    };
  }

  return { entry: next, owned };
}

function purchase(userId, rawId, rawQuantity) {
  const listing = content.findForSale(rawId);

  if (!listing) {
    return {
      content:
        `Nothing called \`${rawId}\` is for sale. Check \`.shop\` or \`.shop gold\`.`,
    };
  }

  // ".goldbuy critical-drop" names a tier group; pick the next tier.
  if (listing.ladder) {
    const { entry, error } = nextTier(userId, listing.tiers);
    if (error) return { content: error };
    return purchase(userId, entry.id, 1);
  }

  // Each gold buff can only be bought once. Buffs are keyed by (user, buff), so
  // a repeat or out-of-order purchase could silently replace a stronger buff.
  if (listing.shop === 'gold') {
    const held = store.buffValue(userId, listing.entry.buff, 0);
    const wanted = listing.entry.value;

    if (held >= wanted - 1e-9) {
      return {
        content:
          `You already have **${listing.entry.name}**, or better. ` +
          'Buying it again would cost gold and change nothing.',
      };
    }

    // Tiers must be bought in order.
    if (listing.entry.tier != null) {
      const tiers = content.goldTiers(listing.entry.buff);
      const { entry: due } = nextTier(userId, tiers);

      if (due && due.id !== listing.entry.id) {
        return {
          content:
            `You need **${due.name}** first - they stack in order. ` +
            `Try \`.goldbuy ${due.id}\`, or just \`.goldbuy ${due.id.replace(/-\d+$/, '')}\` ` +
            'for whichever is next.',
        };
      }
    }
  }

  const quantity =
    listing.shop === 'gold' ? 1 : Math.max(1, Math.min(parseInt(rawQuantity, 10) || 1, MAX_QUANTITY));

  const total = listing.price * quantity;
  const user = store.ensureUser(userId);
  const balance = user[listing.currency];

  if (balance < total) {
    return {
      content:
        `That costs **${money(total)}** ${listing.currency} and you have **${money(balance)}**.` +
        (listing.currency === 'gold' ? ' Gold comes from finishing quests.' : ''),
    };
  }

  // spend() checks the balance inside the UPDATE, so concurrent purchases
  // cannot overdraw.
  if (!store.spend(userId, listing.currency, total)) {
    return { content: 'You cannot afford that.' };
  }

  if (listing.shop === 'gold') {
    const entry = listing.entry;
    const expires =
      entry.durationHours == null ? null : Date.now() + entry.durationHours * 60 * 60 * 1000;

    store.setBuff(userId, entry.buff, entry.value, expires);

    const embed = new EmbedBuilder()
      .setTitle(`Bought ${entry.name}`)
      .setColor(0xffd700)
      .setDescription(entry.description)
      .addFields(
        { name: 'Cost', value: `${money(total)} gold`, inline: true },
        {
          name: 'Lasts',
          value: entry.durationHours == null ? 'Permanent' : `${entry.durationHours} hours`,
          inline: true,
        },
        { name: 'Gold left', value: money(store.getUser(userId).gold), inline: true }
      );

    // Mention the next tier, if there is one.
    if (entry.tier != null) {
      const tiers = content.goldTiers(entry.buff);
      const { entry: due } = nextTier(userId, tiers);

      embed.addFields({
        name: 'Next',
        value: due
          ? `**${due.name}** - ${money(due.price)} gold, \`.goldbuy ${due.id}\``
          : 'That was the last tier. This buff is maxed out.',
      });
    }

    questComplete(userId, embed);
    return { embeds: [embed] };
  }

  store.addItem(userId, listing.id, quantity);

  const item = content.item(listing.id);
  const name = item ? item.displayName : titleCase(listing.id);

  const embed = new EmbedBuilder()
    .setTitle(`Bought ${quantity > 1 ? `${quantity}x ` : ''}${name}`)
    .setColor(0xf7d02c)
    .setDescription(item && item.shortEffect ? item.shortEffect : null)
    .addFields(
      { name: 'Cost', value: `${money(total)} coins`, inline: true },
      { name: 'You now have', value: `${store.itemQuantity(userId, listing.id)}`, inline: true },
      { name: 'Coins left', value: money(store.getUser(userId).coins), inline: true }
    )
    .setFooter({ text: `Use it with .useitem <pokemon> ${listing.id}` });

  // Lifetime spend is a quest goal, so a purchase can complete a quest.
  questComplete(userId, embed);

  return { embeds: [embed] };
}

module.exports = {
  // `.b` is reserved for `.battle`.
  aliases: ['buy', 'purchase'],

  data: new SlashCommandBuilder()
    .setName('buy')
    .setDescription('Buys something from the shop or the gold shop.')
    .addStringOption((option) =>
      option.setName('item').setDescription('The id shown in the shop.').setRequired(true)
    )
    .addIntegerOption((option) =>
      option
        .setName('quantity')
        .setDescription('How many. Ignored for gold shop buffs.')
        .setMinValue(1)
        .setMaxValue(MAX_QUANTITY)
    ),

  async execute(interaction) {
    await interaction.reply(
      purchase(
        interaction.user.id,
        interaction.options.getString('item'),
        interaction.options.getInteger('quantity')
      )
    );
  },

  async run(message, args) {
    if (!args[0]) {
      await message.channel.send('Buy what? Try `.buy fire-stone`, or `.shop` to see the list.');
      return;
    }
    await message.channel.send(purchase(message.author.id, args[0], args[1]));
  },

  purchase,
};
