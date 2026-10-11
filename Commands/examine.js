'use strict';

/**
 * .examine <item> - what an item does in this bot.
 *
 * Describes the bot's behaviour only, not the games' (PokeAPI effect text
 * describes mechanics that don't exist here).
 *
 * Uses Utils/items.classify, the same call .useitem makes, so the description
 * always matches what the item actually does. A new kind of item needs one
 * entry in EXPLAIN below.
 *
 * Accepts a slot number from .bag or an item name.
 */

const fs = require('fs');

const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');

const store = require('../Utils/store');
const content = require('../Utils/content');
const items = require('../Utils/items');
const evolution = require('../Utils/evolution');
const effects = require('../Utils/battleeffects');
const lootbox = require('../Utils/lootbox');
const machines = require('../Utils/machines');
const names = require('../Utils/names');
const inventory = require('../Utils/inventory');
const { clip, titleCase, fitLines, LIMITS } = require('../Utils/display');

/**
 * Which species a family form item (Dynamax Band, Reveal Glass) works on,
 * read from the form data.
 */
let familyCache = null;

function familyUsers(family) {
  if (!family) return [];

  if (!familyCache) familyCache = new Map();
  if (familyCache.has(family)) return familyCache.get(family);

  let forms = [];
  try {
    forms = JSON.parse(fs.readFileSync(`${content.DATA}/Pokemon/index.json`, 'utf8')).forms || [];
  } catch (err) {
    return [];
  }

  const seen = new Map();
  for (const form of forms) {
    if (form.folder !== family && !form.folder.endsWith(` ${family}`)) continue;
    if (seen.has(form.speciesId)) continue;

    const species = names.speciesById(form.speciesId);
    seen.set(form.speciesId, species ? species.displayName : `#${form.speciesId}`);
  }

  const list = [...seen.values()];
  familyCache.set(family, list);
  return list;
}

/**
 * One line per kind of item, and how you use it.
 *
 * Keyed by what Utils/items.classify returns.
 *
 *   summary  what it does, in a sentence
 *   usage    the command that does it, or null if it is not used directly
 */
const EXPLAIN = {
  level: {
    summary: () => 'Raises a Pokemon one level, and its stats with it.',
    usage: (slug) => `.useitem <pokemon> ${slug}`,
  },

  ev: {
    summary: (what) =>
      `Adds ${what.amount} ${titleCase(what.stat)} effort to a Pokemon. ` +
      `Effort caps at ${items.MAX_EV_PER_STAT} per stat and ${items.MAX_EV_TOTAL} in total.`,
    usage: (slug) => `.useitem <pokemon> ${slug}`,
  },

  mega: {
    summary: (what) => {
      const species = what.speciesId ? names.speciesById(what.speciesId) : null;
      const who = species ? species.displayName : 'the right Pokemon';

      // Dragon Ascent is a move, not an item, so there is nothing to return.
      return what.returnable === false
        ? `Give it to ${who} to Mega Evolve. One way: it is used up, and reverting does not return it.`
        : `Hold it on ${who} to Mega Evolve. Take it off to revert, and you get the stone back.`;
    },
    usage: (slug) => `.useitem <pokemon> ${slug}`,
  },

  evolve: {
    summary: () => 'Evolves one of your Pokemon. Used up when it works.',
    usage: (slug) => `.useitem <pokemon> ${slug}`,
  },

  form: {
    summary: (what, slug) => {
      const species = what.speciesId ? names.speciesById(what.speciesId) : null;

      const lasts = {
        consumed: 'Used up. `.useitem <id> default` puts the form back for nothing.',
        keep: 'Not used up - one is enough forever.',
        held: 'Held, not spent. The form lasts as long as it does, and `.take` gives it back.',
      }[what.reuse] || '';

      const rule = 'This is not an evolution - same Pokemon, new look, new typing and stats.';

      // Family items work on several species, so list or count them.
      if (!species) {
        const users = familyUsers(what.form);

        // Name them if there are only a few, otherwise give a count.
        let who = 'one Pokemon';
        if (users.length === 1) who = users[0];
        else if (users.length > 1 && users.length <= 4) {
          who = `${users.slice(0, -1).join(', ')} or ${users[users.length - 1]}`;
        } else if (users.length > 4) {
          who = `any of the ${users.length} Pokemon that has one`;
        }

        return `Changes ${who} into its ${what.form} form. ${rule} ${lasts}`;
      }

      return `Changes ${species.displayName} into its ${what.form} form. ${rule} ${lasts}`;
    },
    usage: (slug) => `.useitem <pokemon> ${slug}`,
  },

  slot: {
    summary: (what, slug) => {
      const item = content.item(slug);
      return (
        `${item && item.shortEffect ? item.shortEffect : 'Bends your next drop.'} ` +
        `Sits in your ${what.slot} slot until your next \`.drop\` spends it. ` +
        'One Repel and one Incense can be armed at the same time.'
      );
    },
    usage: (slug) => `.useitem ${slug}`,
  },

  hold: {
    summary: (what, slug) => {
      if (!effects.isHeldEffect(slug)) {
        return 'A Pokemon can hold it, but it has no effect in battle yet.';
      }

      // PokeAPI's short effect describes exactly what the battle engine does.
      const record = content.importedItem(slug);
      const effect = record && record.shortEffect
        ? record.shortEffect.replace(/^Held:\s*/i, '')
        : null;

      return effect
        ? `Give it to a Pokemon to hold in battle. ${effect}`
        : 'Give it to a Pokemon to hold. It has an effect in battle.';
    },
    usage: (slug) => `.useitem <pokemon> ${slug}`,
  },

  lootbox: {
    summary: () =>
      'Open it for a random item: usually a Mega Stone, evolution item or TM, and sometimes ' +
      'something rarer like Rare Candy, an incense or a Shiny Incense. Earned from quests.',
    usage: () => `.useitem ${lootbox.LOOTBOX} [count|all]`,
  },

  tm: {
    summary: (what, slug) => {
      const tm = machines.bySlug(slug);
      const move = tm ? tm.moveDisplayName : 'its move';
      return `Teaches ${move} to a Pokemon that can learn it. TMs are reusable and stay in your bag.`;
    },
    usage: () => '.tm <pokemon> <move> [slot]',
  },

  // Not kinds that classify returns (both are plain `hold` items), but they
  // deserve their own description.
  tradeHold: {
    summary: () =>
      'Give it to a Pokemon to hold, then trade that Pokemon away. It evolves on arrival and ' +
      'the item is used up.',
    usage: (slug) => `.useitem <pokemon> ${slug}`,
  },

  everstone: {
    summary: () =>
      'Hold it to stop a Pokemon evolving, however much it levels up. Take it off and it can ' +
      'evolve again.',
    usage: (slug) => `.useitem <pokemon> ${slug}`,
  },

  none: {
    summary: () =>
      'Nothing yet. Nothing in the bot uses this one - it is a reward you can hold on to.',
    usage: () => null,
  },
};

/**
 * Which Pokemon this item evolves, from the evolution data. Null if none.
 */
function evolutionTargets(slug) {
  const targets = evolution.itemTargets().get(slug);
  if (!targets || !targets.length) return null;

  const lines = [];
  const seen = new Set();

  for (const target of targets) {
    // Regional forms can produce duplicate rows, so collapse them.
    const line =
      `${target.from} → ${target.into}` +
      (target.quantity ? ` (needs ${target.quantity.toLocaleString('en-US')})` : '');

    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }

  return lines;
}

/**
 * Which explanation this item gets.
 *
 * Separate from classify, which decides how to apply an item. The two differ
 * for trade-evolution items.
 */
function explanationFor(what, slug, targets) {
  if (slug === lootbox.LOOTBOX) return EXPLAIN.lootbox;
  if (machines.isTm(slug)) return EXPLAIN.tm;
  if (slug === evolution.EVERSTONE) return EXPLAIN.everstone;
  if (what.kind === 'hold' && targets && targets.trade) return EXPLAIN.tradeHold;
  return EXPLAIN[what.kind] || EXPLAIN.none;
}

/**
 * What an item does, in one sentence.
 *
 * Used by .examine and by the lootbox card.
 */
function describeItem(slug) {
  const what = items.classify(slug);
  const raw = evolution.itemTargets().get(slug) || [];
  const explain = explanationFor(what, slug, { trade: raw.some((t) => t.trigger === 'trade') });

  return explain.summary(what, slug);
}

/** How the item is obtained here: which shop sells it, and for how much. */
function priceLine(slug) {
  for (const section of content.shop().sections || []) {
    for (const entry of section.items || []) {
      if (entry.item === slug) {
        return `**${entry.price.toLocaleString('en-US')}** coins · ${section.name}`;
      }
    }
  }
  return null;
}

function buildExamine(row) {
  const what = items.classify(row.item);

  const raw = evolution.itemTargets().get(row.item) || [];
  const lines = evolutionTargets(row.item);
  const explain = explanationFor(what, row.item, {
    trade: raw.some((t) => t.trigger === 'trade'),
  });

  const embed = new EmbedBuilder()
    .setTitle(row.displayName)
    .setColor(0x9b7653)
    .setDescription(clip(explain.summary(what, row.item), LIMITS.description));

  // Which Pokemon it works on. Only evolution-ish items have any.
  if (lines) {
    embed.addFields({
      name: `Works on (${lines.length})`,
      value: clip(fitLines(lines, LIMITS.fieldValue), LIMITS.fieldValue),
    });
  }

  embed.addFields(
    { name: 'You have', value: `×${row.quantity}`, inline: true },
    { name: 'Bag slot', value: `#${row.slot}`, inline: true },
    { name: 'Sold for', value: priceLine(row.item) || 'not sold', inline: true }
  );

  const usage = explain.usage(row.item);
  embed.setFooter({ text: usage ? `Use it:  ${usage}` : 'Nothing to use it on yet.' });

  const sprite = content.itemSprite(row.item);
  const files = [];

  if (sprite && fs.existsSync(sprite)) {
    const fileName = `${row.item}.png`;
    files.push(new AttachmentBuilder(sprite, { name: fileName }));
    embed.setThumbnail(`attachment://${fileName}`);
  }

  return { embeds: [embed], files };
}

/** Resolve the argument against the user's bag, or explain why not. */
function examine(userId, query) {
  const rows = inventory.bagRows(userId);

  if (!rows.length) {
    return { content: 'Your bag is empty, so there is nothing to examine. Try `.shop`.' };
  }

  const { row, error } = inventory.resolve(rows, query);
  if (error) return { content: error };

  return buildExamine(row);
}

module.exports = {
  aliases: ['examine', 'inventoryview', 'iv'],

  data: new SlashCommandBuilder()
    .setName('examine')
    .setDescription('Explains what an item in your bag does.')
    .addStringOption((option) =>
      option
        .setName('item')
        .setDescription('Its number from /bag, or its name.')
        .setRequired(true)
    ),

  async execute(interaction) {
    store.ensureUser(interaction.user.id);
    await interaction.reply(examine(interaction.user.id, interaction.options.getString('item')));
  },

  async run(message, args) {
    store.ensureUser(message.author.id);
    await message.channel.send(examine(message.author.id, args.join(' ')));
  },

  examine,
  describeItem,
  buildExamine,
  evolutionTargets,
  explanationFor,
  EXPLAIN,
};
