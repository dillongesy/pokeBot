'use strict';

/**
 * .useitem <pokemon> <item> - use something out of your bag.
 *
 * Covers levelling (Rare Candy), effort training (vitamins), evolving
 * (stones), Mega Evolving (stones), and holding anything holdable.
 *
 * Held items move from the bag onto the Pokemon. `.useitem <id> clear` (or
 * `.take`) returns it to the bag.
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const store = require('../Utils/store');
const questengine = require('../Utils/questengine');
const incense = require('../Utils/incense');
const lootbox = require('../Utils/lootbox');
const content = require('../Utils/content');
const items = require('../Utils/items');
const { displayName, colorFor, titleCase, fitLines, clip, LIMITS } = require('../Utils/display');
const { describeItem } = require('./examine');
const { loadSpecies, loadForm, createPokemon } = require('../Utils/pokemon');
const evolution = require('../Utils/evolution');

/**
 * Take whatever a Pokemon is holding and put it back in the bag.
 *
 * Used by `.take`. Any form that depends on the held item (Mega Stones,
 * plates, memories, masks, orbs) reverts when it is removed.
 *
 * Utils/items.js decides which form to revert to. If the held item is not
 * what caused the current form, the form is kept.
 */
function unequip(userId, row) {
  if (!row.equipped_item) {
    const stuck = items.baseFormFolder(row);
    return {
      content:
        `${displayName(row)} is not holding anything.` +
        (stuck && row.form_folder !== stuck
          ? ` It is in its ${row.form_folder} form - \`.useitem ${row.party_number} default\`` +
            ' puts that back for nothing.'
          : ''),
    };
  }

  const held = row.equipped_item;
  const name = content.item(held) ? content.item(held).displayName : titleCase(held);
  const effect = items.classify(held);
  const changes = { equipped_item: null };

  const reverted = items.formWithoutHeldItem(row);

  if (reverted !== null && reverted !== row.form_folder) {
    changes.form_folder = reverted;

    // The ability reverts along with the form.
    const restored = evolution.remapAbility(row.species_id, reverted, row.ability_slot || 1);
    if (restored) changes.ability = restored.name;
  }

  const updated = store.updatePokemon(row.id, changes);

  // Dragon Ascent is a move, not a held item, so there is nothing to return.
  const returnable = effect.returnable !== false;
  if (returnable) store.addItem(userId, held);

  return {
    content:
      `Took the ${name} back off ${displayName(updated)}.` +
      (changes.form_folder ? ` It went back to its ${changes.form_folder} form.` : '') +
      (returnable ? '' : ` The ${name} was used up.`),
  };
}

/**
 * Revert a stored form change for free.
 *
 * Only applies to Rotom, Furfrou, Oricorio and the fusions; other forms revert
 * by removing the held item. Refuses on held-item forms rather than removing
 * the item.
 */
function revertForm(userId, row) {
  const result = items.revertToDefault(row);
  if (!result.ok) return { content: `${displayName(row)}: ${result.message}` };

  const updated = store.updatePokemon(row.id, result.changes);
  return { content: `${displayName(updated)} - ${result.message}` };
}

/**
 * Put an extra Pokemon in someone's party at the same level as the one that
 * caused it. Only Shedinja needs this today.
 */
function spawnExtra(userId, speciesId, level = 20) {
  const species = loadSpecies(speciesId);
  if (!species) return null;

  const forms = (species.forms || []);
  const form = forms.find((f) => f.percentage > 0) || forms[0];
  if (!form) return null;

  const formData = loadForm(speciesId, form.folder);
  if (!formData) return null;

  const mon = createPokemon(species, formData, { level });
  return store.grantPokemon(userId, mon, { gender: 'genderless', method: 'evolution' });
}

/** Maximum lootboxes opened per command. */
const MAX_OPENS = 20;

/**
 * Open lootboxes.
 *
 * Takes an optional count. Boxes are removed from the bag before prizes are
 * given, so concurrent commands cannot open more boxes than the player owns.
 */
function openLootbox(userId, rawCount) {
  const held = store.itemQuantity(userId, lootbox.LOOTBOX);
  if (held < 1) {
    return { content: 'You have no Lootboxes. Finishing a quest is how you get one - try `.qp`.' };
  }

  const asked = /^(all|max)$/i.test(String(rawCount || '').trim())
    ? held
    : Math.max(1, parseInt(rawCount, 10) || 1);

  const wanted = Math.min(asked, held, MAX_OPENS);

  // removeItem checks the quantity inside the UPDATE, so this is race-safe.
  if (!store.removeItem(userId, lootbox.LOOTBOX, wanted)) {
    return { content: 'Those Lootboxes are no longer in your bag.' };
  }

  const got = [];
  for (let i = 0; i < wanted; i += 1) {
    const prize = lootbox.roll();

    // No prize available: return the box.
    if (!prize) {
      store.addItem(userId, lootbox.LOOTBOX, 1);
      continue;
    }

    store.addItem(userId, prize.item, 1);
    got.push(prize);
  }

  if (!got.length) {
    return { content: 'Nothing in the shop can come out of a Lootbox right now, so it stayed shut.' };
  }

  // The rarest prize sets the embed colour.
  const order = Object.keys(lootbox.TIERS);
  const best = got.reduce((a, b) => (order.indexOf(b.tier) > order.indexOf(a.tier) ? b : a));
  const look = lootbox.TIER_LOOK[best.tier] || { label: best.tier, color: 0x9b7653 };

  const embed = new EmbedBuilder()
    .setTitle(got.length === 1 ? 'Lootbox' : `${got.length} Lootboxes`)
    .setColor(look.color);

  if (got.length === 1) {
    const prize = got[0];
    const item = content.item(prize.item);
    const meta = lootbox.TIER_LOOK[prize.tier];

    embed
      .setDescription(
        `**${meta.label}** - you got a **${item ? item.displayName : titleCase(prize.item)}**!`
      )
      .addFields({
        name: 'What it does',
        // Same description .examine uses.
        value: clip(describeItem(prize.item), LIMITS.fieldValue),
      });
  } else {
    // Group identical prizes.
    const counts = new Map();
    for (const prize of got) {
      const key = `${prize.tier}|${prize.item}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }

    const lines = [...counts.entries()]
      .sort((a, b) => order.indexOf(b[0].split('|')[0]) - order.indexOf(a[0].split('|')[0]))
      .map(([key, n]) => {
        const [tier, slug] = key.split('|');
        const item = content.item(slug);
        return `**${lootbox.TIER_LOOK[tier].label}** · ${item ? item.displayName : titleCase(slug)}${n > 1 ? ` ×${n}` : ''}`;
      });

    embed.setDescription(fitLines(lines, 3500));
  }

  const left = store.itemQuantity(userId, lootbox.LOOTBOX);
  embed.setFooter({
    text:
      (left ? `${left} Lootbox${left === 1 ? '' : 'es'} left` : 'No Lootboxes left') +
      (asked > wanted ? ` · opened ${wanted}, the most in one go is ${MAX_OPENS}` : ''),
  });

  return { embeds: [embed] };
}

/**
 * Put a Repel or an Incense in its slot.
 *
 * These are not used on a Pokemon. Equipping moves the item out of the bag and
 * the next drop consumes it.
 */
function equipConsumable(userId, slug) {
  const slot = incense.slotOf(slug);
  const result = store.equipSlot(userId, slot, slug);

  if (!result.ok) {
    if (result.message === 'notCarried') {
      return { content: `You are not carrying a ${incense.nameOf(slug)}. Buy one with \`.buy ${slug}\`.` };
    }
    if (result.message === 'alreadyEquipped') {
      return { content: `Your ${incense.nameOf(slug)} is already equipped. Your next drop will use it.` };
    }
    return { content: result.message };
  }

  const embed = new EmbedBuilder()
    .setTitle(`Equipped ${incense.nameOf(slug)}`)
    .setColor(slot === 'repel' ? 0x6390f0 : 0xd685ad)
    .setDescription(incense.describe(slug))
    .setFooter({ text: 'Spent on your next .drop · .useitem clear-repel or clear-incense to take it off' });

  if (result.replaced) {
    embed.addFields({
      name: 'Swapped out',
      value: `Your ${incense.nameOf(result.replaced)} went back in your bag.`,
    });
  }

  // Both slots work at once, so say what the other one is doing.
  const slots = store.activeSlots(userId);
  const other = slot === 'repel' ? slots.incense : slots.repel;
  if (other) {
    embed.addFields({ name: 'Also equipped', value: incense.nameOf(other) });
  }

  return { embeds: [embed] };
}

/** Take one of the two slots off, putting the item back in the bag. */
function clearSlot(userId, slot) {
  const removed = store.unequipSlot(userId, slot);

  return {
    content: removed
      ? `Took off your ${incense.nameOf(removed)}. It is back in your bag.`
      : `You have no ${slot} equipped.`,
  };
}

function use(userId, rawPokemonId, rawItem) {
  // ".useitem max-repel": repels and incenses take no Pokemon argument.
  const first = String(rawPokemonId ?? '').toLowerCase().trim();

  if (first === 'clear-repel' || first === 'clear-incense') {
    return clearSlot(userId, first.slice('clear-'.length));
  }

  if (incense.slotOf(first)) return equipConsumable(userId, first);

  // ".use lootbox [n|all]": also takes no Pokemon argument.
  if (first === lootbox.LOOTBOX || first === 'lootboxes') return openLootbox(userId, rawItem);

  const pokemonId = store.parsePartyNumber(rawPokemonId);

  if (!Number.isInteger(pokemonId)) {
    return { content: 'Which Pokemon? Try `.useitem 12 rare-candy`, using the number from `.party`.' };
  }

  const row = store.getOwnedByNumber(userId, pokemonId);
  if (!row) return { content: store.noSuchNumber(userId, pokemonId) };

  const slug = String(rawItem ?? '').toLowerCase().trim();
  if (!slug) return { content: 'Use what? Check `.bag` for what you have.' };

  if (slug === 'clear' || slug === 'none' || slug === 'off') return unequip(userId, row);

  // Revert a stored form change.
  if (slug === 'default' || slug === 'revert') return revertForm(userId, row);

  if (!content.item(slug)) {
    return { content: `There is no item called \`${slug}\`. Check \`.bag\`.` };
  }

  const held = store.itemQuantity(userId, slug);
  if (held < 1) {
    return { content: `You do not have a ${content.item(slug).displayName}.` };
  }

  const result = items.apply(row, slug);
  if (!result.ok) return { content: result.message };

  // Almost everything costs one. Gimmighoul's coins are the exception.
  const cost = result.consumedQuantity || 1;

  if (held < cost) {
    return {
      content:
        `That needs **${cost}** ${content.item(slug).displayName}, and you have **${held}**.`,
    };
  }

  /**
   * Does the item leave the bag?
   *
   * Different from `consumed`: a Mega Stone is not consumed but does leave the
   * bag, because the Pokemon holds it. Form items marked `reuse: 'keep'` stay
   * in the bag (e.g. Rotom's appliances).
   */
  const goesOntoThePokemon = Boolean(result.changes.equipped_item);
  const leavesTheBag = result.consumed !== false || goesOntoThePokemon;

  // Remove the item before writing the change, and stop if that fails.
  if (leavesTheBag && !store.removeItem(userId, slug, cost)) {
    return { content: `You do not have ${cost} ${content.item(slug).displayName}.` };
  }

  // Swapping held items returns the old one to the bag.
  if (result.changes.equipped_item && row.equipped_item && row.equipped_item !== slug) {
    store.addItem(userId, row.equipped_item);
  }

  // If the Pokemon ends up holding nothing, still return the old item.
  if (result.returnHeldItem) store.addItem(userId, result.returnHeldItem);

  const updated = store.updatePokemon(row.id, result.changes);
  const item = content.item(slug);

  // Nincada evolving into Ninjask also produces a Shedinja.
  let extra = null;
  if (result.alsoCreates) extra = spawnExtra(userId, result.alsoCreates);

  const embed = new EmbedBuilder()
    .setTitle(`Used ${item.displayName}`)
    .setColor(colorFor(updated))
    .setDescription(`${displayName(row)} - ${result.message}`)
    .setFooter({ text: `.view ${pokemonId} to see it` });

  if (extra) {
    embed.addFields({
      name: 'And something else appeared',
      value: `A **${extra.display_name}** was left behind - #${extra.party_number}.`,
    });
  }

  if (result.evolvedInto || updated.level !== row.level) {
    embed.addFields(
      { name: 'Level', value: String(updated.level), inline: true },
      { name: 'HP', value: String(updated.stat_hp), inline: true },
      { name: 'Attack', value: String(updated.stat_attack), inline: true }
    );
  }

  // Evolving or changing form changes which species are owned, so recalculate
  // quest progress (recalculated rather than incremented, so the old species
  // isn't treated as lost).
  try {
    const line = questengine.announce(questengine.sync(userId).completed);
    if (line) embed.addFields({ name: 'Quest complete', value: line });
  } catch (err) {
    console.error('Quest sync failed after using an item:', err);
  }

  return { embeds: [embed] };
}

module.exports = {
  aliases: ['useitem', 'use'],

  data: new SlashCommandBuilder()
    .setName('useitem')
    .setDescription('Uses an item on one of your Pokemon.')
    .addStringOption((option) =>
      option
        .setName('item')
        .setDescription('The item id. A Repel or Incense goes straight to its slot.')
        .setRequired(true)
    )
    .addIntegerOption((option) =>
      option
        .setName('pokemon')
        .setDescription('Its number, from /party. Not needed for a Repel or Incense.')
    ),

  async execute(interaction) {
    store.ensureUser(interaction.user.id);
    const item = interaction.options.getString('item');
    const pokemon = interaction.options.getInteger('pokemon');

    // Slot items take no Pokemon, so the item is the first argument.
    await interaction.reply(
      pokemon === null
        ? use(interaction.user.id, item, null)
        : use(interaction.user.id, pokemon, item)
    );
  },

  async run(message, args) {
    store.ensureUser(message.author.id);
    await message.channel.send(use(message.author.id, args[0], args[1]));
  },

  use,
  unequip,
  revertForm,
  equipConsumable,
  clearSlot,
  openLootbox,
  MAX_OPENS,
};
