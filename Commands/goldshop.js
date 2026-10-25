'use strict';

/**
 * .goldshop - the buffs gold buys, and which of them you already have.
 *
 * Gold is earned only from quests and buys permanent buffs, some of which come
 * in tiers. `.shop gold` shows the same view.
 *
 *   .goldshop                what there is, and what you own
 *   .goldbuy <id>            buy one
 *   .goldbuy critical-drop   buy the next tier you don't own
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const store = require('../Utils/store');
const content = require('../Utils/content');
const buy = require('./buy');
const { clip, capFields, LIMITS } = require('../Utils/display');

const money = (amount) => Number(amount || 0).toLocaleString('en-US');

/** Group the catalogue into ladders and one-offs, keeping the shop's order. */
function groupItems() {
  const groups = [];
  const byBuff = new Map();

  for (const entry of content.goldShop().items || []) {
    if (entry.tier == null) {
      groups.push({ kind: 'single', buff: entry.buff, entries: [entry] });
      continue;
    }

    if (!byBuff.has(entry.buff)) {
      const group = { kind: 'ladder', buff: entry.buff, entries: [] };
      byBuff.set(entry.buff, group);
      groups.push(group);
    }

    byBuff.get(entry.buff).entries.push(entry);
  }

  for (const group of groups) group.entries.sort((a, b) => (a.tier || 0) - (b.tier || 0));
  return groups;
}

/** The name a ladder goes by, with the tier number trimmed off. */
const ladderName = (group) => group.entries[0].name.replace(/ \d+$/, '');

/** The id you type to buy the next rung of a ladder. */
const ladderId = (group) => group.entries[0].id.replace(/-\d+$/, '');

/**
 * The first sentence of a description.
 *
 * Splits on ". " rather than "." so decimals like "6.25%" stay intact.
 */
function firstSentence(text) {
  const match = /^(.*?\.)(\s|$)/s.exec(String(text || ''));
  return match ? match[1] : String(text || '');
}

/** One group as an embed field, showing what this player already owns. */
function describeGroup(userId, group, gold) {
  const held = store.buffValue(userId, group.buff, 0);

  if (group.kind === 'single') {
    const entry = group.entries[0];
    const owned = held >= entry.value - 1e-9;

    return {
      name: clip(`${owned ? '✅ ' : ''}${entry.name} - ${money(entry.price)} gold`, LIMITS.fieldName),
      value: clip(
        `${entry.description}\n` +
          (owned
            ? '*Owned. Permanent.*'
            : gold >= entry.price
              ? `\`.goldbuy ${entry.id}\``
              : `*${money(entry.price - gold)} more gold needed.*`),
        LIMITS.fieldValue
      ),
    };
  }

  const ownedTiers = group.entries.filter((e) => held >= e.value - 1e-9).length;
  const next = group.entries.find((e) => e.value > held + 1e-9);

  const rungs = group.entries
    .map((e) => {
      const have = held >= e.value - 1e-9;
      const mark = have ? '✅' : e === next ? '▶️' : '  ';
      return `${mark} \`${e.tier}\` ${money(e.price)} gold`;
    })
    .join('\n');

  const footer = !next
    ? '*Maxed out.*'
    : gold >= next.price
      ? `\`.goldbuy ${ladderId(group)}\` for tier ${next.tier}`
      : `*${money(next.price - gold)} more gold needed for tier ${next.tier}.*`;

  return {
    name: clip(
      `${ownedTiers === group.entries.length ? '✅ ' : ''}${ladderName(group)} - ` +
        `${ownedTiers}/${group.entries.length}`,
      LIMITS.fieldName
    ),
    value: clip(
      `${firstSentence(group.entries[0].description)} Each tier stacks.\n${rungs}\n${footer}`,
      LIMITS.fieldValue
    ),
  };
}

function buildGoldShop(user) {
  const account = store.ensureUser(user.id);
  const gold = account.gold || 0;

  const embed = new EmbedBuilder()
    .setTitle('Gold Shop')
    .setColor(0xffd700)
    .setDescription(
      `You have **${money(gold)}** gold.\n` +
        'Gold comes only from finishing quests - `.qp` shows what you are closest to. ' +
        'Every buff here is **permanent**.'
    );

  for (const group of groupItems()) {
    embed.addFields(describeGroup(user.id, group, gold));
  }

  embed.setFields(capFields(embed.data.fields || []));
  embed.setFooter({ text: 'Use .goldbuy <id> to buy, and .me to see what is active.' });

  return { embeds: [embed] };
}

module.exports = {
  aliases: ['goldshop', 'gs', 'gshop', 'goldbuy', 'gbuy', 'gb'],

  data: new SlashCommandBuilder()
    .setName('goldshop')
    .setDescription('Shows the buffs gold buys, and which you already have.')
    .addStringOption((option) =>
      option.setName('buy').setDescription('Buy one, by id. "critical-drop" buys the next tier.')
    ),

  async execute(interaction) {
    store.ensureUser(interaction.user.id);

    const wanted = interaction.options.getString('buy');
    if (wanted) {
      await interaction.reply(buy.purchase(interaction.user.id, wanted, 1));
      return;
    }

    await interaction.reply(buildGoldShop(interaction.user));
  },

  async run(message, args) {
    store.ensureUser(message.author.id);

    // .goldbuy and .gb are the same file, so which name was typed decides
    // whether this is a browse or a purchase.
    const invoked = String(message.content || '').slice(1).split(/\s+/)[0].toLowerCase();
    const buying = invoked === 'goldbuy' || invoked === 'gb';

    if (buying && !args.length) {
      await message.channel.send('Buy what? Try `.goldbuy amulet-coin`, or `.goldshop` to see the list.');
      return;
    }

    if (buying || args.length) {
      await message.channel.send(buy.purchase(message.author.id, args.join(' '), 1));
      return;
    }

    await message.channel.send(buildGoldShop(message.author));
  },

  buildGoldShop,
  groupItems,
  describeGroup,
};
