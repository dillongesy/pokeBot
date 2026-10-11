'use strict';

/**
 * .give - hand out coins, gold or items, or take them back. Admin only.
 *
 *   .give @user 500              500 coins
 *   .give @user -500             takes 500 coins back
 *   .give @user 5 gold           gold instead
 *   .give @user 3 lootbox        three lootboxes
 *   .give @user -1 fire-stone    takes one back
 *   .give @user all fire-stone   ...or the whole stack
 *
 * Removing never goes below zero, and the reply reports the amount actually
 * removed. Removing coins does not count toward the player's lifetime spend.
 */

const { SlashCommandBuilder, MessageFlags } = require('discord.js');

const admin = require('../Utils/admin');
const store = require('../Utils/store');
const content = require('../Utils/content');
const inventory = require('../Utils/inventory');
const { titleCase } = require('../Utils/display');

/** What the third argument can say when it means a currency. */
const CURRENCIES = {
  coin: 'coins', coins: 'coins', c: 'coins', money: 'coins', currency: 'coins',
  gold: 'gold', g: 'gold',
};

const ALL = /^(all|every|max|\*)$/i;

/** "<@123>" or a bare id. The same parser .trade uses. */
function parseUserId(raw) {
  const text = String(raw || '').trim();
  const match = /^<@!?(\d+)>$/.exec(text);
  if (match) return match[1];
  return /^\d{15,25}$/.test(text) ? text : null;
}

const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${Math.abs(n) === 1 ? '' : 's'}`;

/**
 * Split ".give @user -3 fire stone" into its parts.
 *
 * The amount is always the second word. Everything after it is a currency or
 * an item name, which may be several words.
 *
 * @returns {{ userId, amount, all, what }}
 */
function parseArgs(args = []) {
  const words = args.map(String).filter((w) => w.length);

  const userId = parseUserId(words[0]);
  const rawAmount = words[1];
  const what = words.slice(2).join(' ').trim();

  const all = ALL.test(String(rawAmount || ''));
  const amount = all ? null : parseInt(rawAmount, 10);

  return { userId, amount, all, what, rawAmount };
}

/**
 * Apply the grant or removal.
 *
 * @returns {{ content: string }}
 */
function give(args = []) {
  const { userId, amount, all, what, rawAmount } = parseArgs(args);

  if (!userId) return { content: 'Give to who? Try `.give @someone 500`.' };

  if (!all && !Number.isInteger(amount)) {
    return { content: `"${rawAmount ?? ''}" is not a number. Try \`.give @someone 500\`.` };
  }
  if (!all && amount === 0) return { content: 'Nothing to give.' };

  // ------------------------------------------------------------ currency ---
  const currency = CURRENCIES[what.toLowerCase()] || (what ? null : 'coins');

  if (currency) {
    if (all) return { content: 'Use a number for coins and gold. `all` is for items.' };

    const result = store.adjustCurrency(userId, currency, amount);

    if (result.moved === 0) {
      return { content: `<@${userId}> has no ${currency} to take.` };
    }

    const verb = result.moved > 0 ? 'Gave' : 'Took';
    return {
      content:
        `${verb} ${plural(Math.abs(result.moved), currency === 'gold' ? 'gold' : 'coin')
          .replace('golds', 'gold')} ` +
        `${result.moved > 0 ? 'to' : 'from'} <@${userId}>. ` +
        `They now have ${result.after.toLocaleString('en-US')}.`,
    };
  }

  // ---------------------------------------------------------------- item ---
  // Validate against every known slug so typos are rejected.
  const item = resolveItem(what);

  if (!item) {
    return { content: `There is no item called "${what}". Use its slug, as \`.shop\` prints it.` };
  }

  const held = store.itemQuantity(userId, item);
  const delta = all ? -held : amount;

  if (all && !held) return { content: `<@${userId}> has no ${titleCase(item)} to take.` };

  const result = store.adjustItem(userId, item, delta);
  const name = (content.item(item) || {}).displayName || titleCase(item);

  if (result.moved === 0) return { content: `<@${userId}> has no ${name} to take.` };

  const verb = result.moved > 0 ? 'Gave' : 'Took';
  return {
    content:
      `${verb} ${Math.abs(result.moved)} × **${name}** ` +
      `${result.moved > 0 ? 'to' : 'from'} <@${userId}>. They now have ${result.after}.`,
  };
}

const fold = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

let knownCache = null;

/**
 * Every item slug this bot knows about.
 *
 * The shop, everything imported from PokeAPI, and anything a quest can award
 * (lootboxes, for example, exist only as quest rewards).
 */
function knownItems() {
  if (knownCache) return knownCache;

  const known = new Set(inventory.shopIndex().keys());

  for (const [slug] of content.items()) known.add(slug);

  const quests = content.quests();
  for (const quest of Array.isArray(quests) ? quests : quests.quests || []) {
    for (const item of (quest.reward && quest.reward.items) || []) {
      known.add(typeof item === 'string' ? item : item.item);
    }
  }

  known.delete(undefined);
  knownCache = known;
  return known;
}

/** An item by slug, or by its display name, case and punctuation forgiven. */
function resolveItem(text) {
  const raw = String(text || '').trim();
  const known = knownItems();

  if (known.has(raw)) return raw;

  const wanted = fold(raw);
  if (!wanted) return null;

  for (const slug of known) {
    if (fold(slug) === wanted) return slug;

    const item = content.item(slug);
    if (item && item.displayName && fold(item.displayName) === wanted) return slug;
  }

  return null;
}

module.exports = {
  aliases: ['give', 'grant'],

  data: new SlashCommandBuilder()
    .setName('give')
    .setDescription('Admin only. Hands out coins, gold or items - or takes them back.')
    .addUserOption((option) =>
      option.setName('user').setDescription('Who.').setRequired(true)
    )
    .addIntegerOption((option) =>
      option
        .setName('amount')
        .setDescription('How many. Negative takes them away.')
        .setRequired(true)
    )
    .addStringOption((option) =>
      option.setName('what').setDescription('coins, gold, or an item slug. Defaults to coins.')
    ),

  async execute(interaction) {
    if (!admin.isAdmin(interaction.user.id)) {
      await interaction.reply({ content: admin.DENIED, flags: MessageFlags.Ephemeral });
      return;
    }

    const args = [
      interaction.options.getUser('user').id,
      String(interaction.options.getInteger('amount')),
    ];

    const what = interaction.options.getString('what');
    if (what) args.push(what);

    await interaction.reply({ ...give(args), flags: MessageFlags.Ephemeral });
  },

  async run(message, args) {
    if (!admin.isAdmin(message.author.id)) {
      await message.channel.send(admin.DENIED);
      return;
    }

    await message.channel.send(give(args));
  },

  give,
  parseArgs,
  parseUserId,
  resolveItem,
};
