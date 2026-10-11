'use strict';

/**
 * Repels and incenses - the consumables that bend the next drop.
 *
 * Sixteen items in two slots. Both slots are persisted and consumed by the
 * next drop.
 *
 *   Repel slot    a percentage chance the drop is a species you do not own
 *   Incense slot  forces a rarity, a region, or a shiny
 *
 * The two stack: a Max Repel and a Kanto Incense together give a 90% chance of
 * an uncaught Kanto Pokemon.
 *
 * Narrowing never produces an empty pool. If a filter would leave nothing to
 * pick from, it is skipped and a note explains why, and the drop goes ahead
 * normally.
 */

/** The repel slot. Percentage is the chance the drop is a species you lack. */
const REPELS = {
  repel: { name: 'Repel', chance: 50, price: 1000 },
  'super-repel': { name: 'Super Repel', chance: 75, price: 2750 },
  'max-repel': { name: 'Max Repel', chance: 90, price: 5000 },
};

/**
 * The incense slot.
 *
 * `rarity` forces a bucket, `region` forces a region, `shiny` forces a shiny.
 * An incense sets exactly one of them.
 */
const INCENSES = {
  'legendary-incense': { name: 'Legendary Incense', rarity: 'legendary', price: 5000 },
  'ultra-beast-incense': { name: 'Ultra Beast Incense', rarity: 'ultraBeast', price: 5000 },
  'mythical-incense': { name: 'Mythical Incense', rarity: 'mythical', price: 7500 },
  'shiny-incense': { name: 'Shiny Incense', shiny: true, price: 20000 },

  'kanto-incense': { name: 'Kanto Incense', region: ['Kanto'], price: 1250 },
  'johto-incense': { name: 'Johto Incense', region: ['Johto'], price: 1250 },
  'hoenn-incense': { name: 'Hoenn Incense', region: ['Hoenn'], price: 1250 },
  'sinnoh-incense': { name: 'Sinnoh Incense', region: ['Sinnoh'], price: 1250 },
  'unova-incense': { name: 'Unova Incense', region: ['Unova'], price: 1250 },
  'kalos-incense': { name: 'Kalos Incense', region: ['Kalos'], price: 1250 },
  'alola-incense': { name: 'Alola Incense', region: ['Alola'], price: 1250 },

  // Galar and Hisui share one incense; Hisui has too few species of its own
  // to sell separately.
  'galar-hisui-incense': { name: 'Galar & Hisui Incense', region: ['Galar', 'Hisui'], price: 1250 },

  'paldea-incense': { name: 'Paldea Incense', region: ['Paldea'], price: 1250 },
};

/** Which slot a slug belongs to, or null if it is not one of these at all. */
function slotOf(slug) {
  if (REPELS[slug]) return 'repel';
  if (INCENSES[slug]) return 'incense';
  return null;
}

/** The definition behind a slug, whichever slot it is in. */
function definitionOf(slug) {
  return REPELS[slug] || INCENSES[slug] || null;
}

/** What to call one, falling back to the slug. */
function nameOf(slug) {
  const found = definitionOf(slug);
  return found ? found.name : slug;
}

/** Everything, for the shop and for .help. */
function all() {
  return [
    ...Object.entries(REPELS).map(([item, def]) => ({ item, slot: 'repel', ...def })),
    ...Object.entries(INCENSES).map(([item, def]) => ({ item, slot: 'incense', ...def })),
  ];
}

/** A one-line description, built from the definition. */
function describe(slug) {
  const def = definitionOf(slug);
  if (!def) return null;

  if (def.chance) return `${def.chance}% chance your next drop is a species you do not own.`;
  if (def.shiny) return 'Your next drop is shiny, and rarer species are likelier.';
  if (def.rarity) {
    const label = { legendary: 'Legendary', mythical: 'Mythical', ultraBeast: 'Ultra Beast' }[def.rarity];
    return `Your next drop is ${label}.`;
  }
  if (def.region) return `Your next drop is from ${def.region.join(' or ')}.`;

  return null;
}

// ---------------------------------------------------------------------------
// Narrowing the pool
// ---------------------------------------------------------------------------

/**
 * Cut a rarity bucket down to what the equipped items allow.
 *
 * The incense narrows by region first, then the repel prefers uncaught species
 * within what is left. Either step is skipped if it would empty the pool, and
 * a note is returned for the drop card.
 *
 * @param {object[]} pool          species entries from Data/Pokemon/index.json
 * @param {object}   options
 * @param {string[]} [options.region]    regions the incense allows
 * @param {number}   [options.chance]    the repel's percentage
 * @param {Set}      [options.caught]    species ids the player already owns
 * @returns {{ pool: object[], notes: string[] }}
 */
function narrow(pool, { region = null, chance = 0, caught = null } = {}) {
  const notes = [];
  let current = pool;

  if (region && region.length) {
    const wanted = new Set(region);
    const filtered = current.filter((species) => wanted.has(species.region));

    if (filtered.length) {
      current = filtered;
    } else {
      // e.g. every Ultra Beast is Alolan, so a Kanto Incense on the Ultra
      // Beast tier has nothing to choose from.
      notes.push(`no ${region.join('/')} Pokemon at this rarity, so the incense did nothing`);
    }
  }

  if (chance > 0 && caught) {
    const uncaught = current.filter((species) => !caught.has(species.id));

    if (!uncaught.length) {
      // Already owns every species in the pool.
      notes.push('you have caught all of them');
    } else if (Math.random() * 100 < chance) {
      current = uncaught;
      notes.push('the repel worked');
    } else {
      notes.push('the repel missed');
    }
  }

  return { pool: current, notes };
}

module.exports = { REPELS, INCENSES, slotOf, definitionOf, nameOf, all, describe, narrow };
