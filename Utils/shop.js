'use strict';

/**
 * The coin shop - the source of truth.
 *
 * Each entry refers to an item in Data/Items by slug, which supplies the name,
 * sprite and description. Only the price and section are set here.
 *
 * The importer writes this to Data/Shop/data.json and rejects slugs that
 * aren't in the imported item data. After editing, run
 * `node Utils/importdata.js shop`.
 *
 * There are no Poke Balls, since naming a Pokemon always catches it.
 *
 * An entry can carry a `define` block for items PokeAPI doesn't have, which
 * defines the name, description and effect directly (see Dragon Ascent).
 */

const incense = require('./incense');
const formitems = require('./formitems');
const names = require('./names');
const itemRules = require('./items');
const machines = require('./machines');
const battleeffects = require('./battleeffects');

/**
 * Every Mega Stone, generated rather than listed.
 *
 * Utils/items.megaStones() derives which stone belongs to which species and
 * Mega form from the artwork data (92 stones).
 */
function megaStoneEntries() {
  const rows = [];

  for (const [item, mega] of itemRules.megaStones()) {
    rows.push({ item, price: MEGA_STONE_PRICE, tier: 'common', speciesId: mega.speciesId });
  }

  // Dex order, for a stable listing.
  rows.sort((a, b) => a.speciesId - b.speciesId || a.item.localeCompare(b.item));

  return rows.map(({ item, price, tier }) => ({ item, price, tier }));
}

/**
 * The form-change items, as shop rows.
 *
 * Built from Utils/formitems.js. Items PokeAPI has (plates, orbs, masks,
 * nectars) keep their record and gain an `effect`; items it lacks (Rotom's
 * appliances, Furfrou's trims, the DNA splicers) are defined outright.
 */
function formItemEntries() {
  return formitems.items.map((entry) => {
    const species = entry.species === null ? null : names.speciesById(entry.species);
    const who = entry.species === null
      ? entry.who
      : (species ? species.displayName : `#${entry.species}`);

    const lasts = {
      consumed: 'Used up.',
      keep: 'Keeps working, so you only ever need one.',
      held: 'Held, so the form lasts as long as it does. `.take` gives it back.',
    }[entry.reuse];

    // Family items get their own description.
    const what = entry.describe || `Changes ${who} into its ${entry.form} form.`;

    const effect = {
      kind: 'form',
      speciesId: entry.species === null ? null : entry.species,
      form: entry.form,
      reuse: entry.reuse,
    };

    return {
      item: entry.item,
      price: entry.price,
      tier: entry.tier,
      define: {
        displayName: entry.name,
        category: 'form-change',
        shortEffect: `${what} ${lasts}`,

        // Mark held form items as holdable so .take and the party card treat
        // them correctly.
        attributes: entry.reuse === 'held' ? ['holdable'] : [],
        effect,
      },
    };
  });
}

/**
 * The type-boosting items, generated the same way the Mega Stones are.
 *
 * Utils/battleeffects.js derives which item boosts which type from the
 * PokeAPI effect text.
 *
 * Items already sold in another section are excluded automatically: the
 * plates (in Form Change) and the Metal Coat (in Trade Items).
 */
function typeBoosterEntries() {
  const alreadySold = new Set([
    ...formitems.items.map((entry) => entry.item),
    ...TRADE_ITEMS,
  ]);

  return [...battleeffects.typeBoostItems()]
    .filter(([slug]) => !alreadySold.has(slug))
    .map(([slug, boost]) => ({ item: slug, price: 3000, tier: 'common', type: boost.type }))
    .sort((a, b) => a.type.localeCompare(b.type))
    .map(({ item, price, tier }) => ({ item, price, tier }));
}

/**
 * Every TM, as a shop row.
 *
 * PokeAPI's TM item slugs ("tm01") collide across generations, so these are
 * defined outright and keyed by move (see Utils/machines.js).
 *
 * They use the `tm` lootbox tier rather than `common` (see Utils/lootbox.js).
 */
function tmEntries() {
  return machines.all({ teachableOnly: true }).map((tm) => ({
    item: tm.slug,
    price: tm.price,
    tier: 'tm',
    define: {
      displayName: tm.displayName,
      category: 'tm',
      shortEffect:
        `Teaches ${tm.moveDisplayName} to any Pokemon that can learn it. ` +
        'Reusable - teaching does not use it up.',
      attributes: [],
      effect: { kind: 'tm', move: tm.move },
    },
  }));
}

/**
 * The trade-evolution items, pulled out into a constant.
 *
 * A constant so typeBoosterEntries() can skip items already listed here (the
 * importer rejects duplicate slugs).
 */
const TRADE_ITEM_ROWS = [
  { tier: 'common', item: 'metal-coat', price: 4000 },
  { tier: 'common', item: 'kings-rock', price: 4000 },
  { tier: 'common', item: 'dragon-scale', price: 4000 },
  { tier: 'common', item: 'up-grade', price: 4500 },
  { tier: 'common', item: 'dubious-disc', price: 4500 },
  { tier: 'common', item: 'protector', price: 4500 },
  { tier: 'common', item: 'electirizer', price: 4500 },
  { tier: 'common', item: 'magmarizer', price: 4500 },
  { tier: 'common', item: 'reaper-cloth', price: 4500 },
  { tier: 'common', item: 'prism-scale', price: 4000 },
  { tier: 'common', item: 'sachet', price: 4000 },
  { tier: 'common', item: 'whipped-dream', price: 4000 },
  { tier: 'common', item: 'deep-sea-tooth', price: 4000 },
  { tier: 'common', item: 'deep-sea-scale', price: 4000 },
];

const TRADE_ITEMS = TRADE_ITEM_ROWS.map((row) => row.item);

/**
 * Mega Stone price before rates.priceScale is applied (500 coins after
 * scaling).
 */
const MEGA_STONE_PRICE = 5000;

/**
 * The `define` block for a Repel or an Incense.
 *
 * Repels and incenses work differently here than in the games, so all sixteen
 * are defined from Utils/incense.js.
 *
 * `kind: 'slot'` marks items that are not used on a Pokemon.
 */
function repelItem(slug) {
  const def = incense.definitionOf(slug);

  return {
    displayName: def.name,
    category: 'drop-consumables',
    shortEffect: incense.describe(slug),
    attributes: [],
    effect: { kind: 'slot', slot: incense.slotOf(slug), returnable: false },
  };
}

module.exports = {
  currency: 'coins',

  sections: [
    {
      name: 'Mega Stones',
      description:
        'Megas never drop. Hold the stone to take the form, remove it to revert.',
      items: [
        ...megaStoneEntries(),

        {
          // Rayquaza Mega Evolves by knowing Dragon Ascent rather than holding
          // a stone. `returnable: false`: it is not given back on revert.
          item: 'dragon-ascent',
          price: 750,
          // Excluded from lootboxes since it only works on Rayquaza.
          tier: 'none',
          define: {
            displayName: 'Dragon Ascent',
            category: 'special-moves',
            shortEffect:
              'Teaches Dragon Ascent to Rayquaza, letting it Mega Evolve. Not returned if it reverts.',
            attributes: ['holdable'],
            effect: {
              kind: 'mega',
              speciesId: 384,
              form: 'Mega',
              returnable: false,
            },
          },
        },
      ],
    },

    {
      // One repel and one incense can be active at once. Effects are defined
      // in Utils/incense.js.
      name: 'Repels & Incenses',
      description:
        'Equip with `.useitem <item>`. Your next drop spends it. ' +
        'One Repel and one Incense can be equipped at the same time.',
      items: [
        // Repel slot - a chance at a species you do not own.
        { tier: 'common', item: 'repel', price: 1000, define: repelItem('repel') },
        { tier: 'rare', item: 'super-repel', price: 2750, define: repelItem('super-repel') },
        { tier: 'rare', item: 'max-repel', price: 5000, define: repelItem('max-repel') },

        // Incense slot - forces a rarity, a region, or a shiny.
        { tier: 'epic', item: 'legendary-incense', price: 5000, define: repelItem('legendary-incense') },
        { tier: 'epic', item: 'ultra-beast-incense', price: 5000, define: repelItem('ultra-beast-incense') },
        { tier: 'epic', item: 'mythical-incense', price: 7500, define: repelItem('mythical-incense') },
        { tier: 'ssr', item: 'shiny-incense', price: 20000, define: repelItem('shiny-incense') },

        { tier: 'common', item: 'kanto-incense', price: 1250, define: repelItem('kanto-incense') },
        { tier: 'common', item: 'johto-incense', price: 1250, define: repelItem('johto-incense') },
        { tier: 'common', item: 'hoenn-incense', price: 1250, define: repelItem('hoenn-incense') },
        { tier: 'common', item: 'sinnoh-incense', price: 1250, define: repelItem('sinnoh-incense') },
        { tier: 'common', item: 'unova-incense', price: 1250, define: repelItem('unova-incense') },
        { tier: 'common', item: 'kalos-incense', price: 1250, define: repelItem('kalos-incense') },
        { tier: 'common', item: 'alola-incense', price: 1250, define: repelItem('alola-incense') },
        { tier: 'common', item: 'galar-hisui-incense', price: 1250, define: repelItem('galar-hisui-incense') },
        { tier: 'common', item: 'paldea-incense', price: 1250, define: repelItem('paldea-incense') },
      ],
    },

    {
      // A form change keeps the species, id, IVs and nickname; only the form
      // (and its typing and stats) changes.
      name: 'Form Change',
      description:
        'Changes a Pokemon\'s form without evolving it. `.useitem <pokemon> <item>`. ' +
        'Most of these are HELD: `.take <pokemon>` gives the item back and the form ' +
        'reverts. For the rest, `.useitem <pokemon> default` puts the form back for free.',

      // Held-item forms revert for free with .take, which returns the item.
      items: [...formItemEntries()],
    },

    {
      name: 'Evolution Items',
      items: [
        { tier: 'common', item: 'fire-stone', price: 3000 },
        { tier: 'common', item: 'water-stone', price: 3000 },
        { tier: 'common', item: 'thunder-stone', price: 3000 },
        { tier: 'common', item: 'leaf-stone', price: 3000 },
        { tier: 'common', item: 'moon-stone', price: 3000 },
        { tier: 'common', item: 'ice-stone', price: 3500 },
        { tier: 'common', item: 'sun-stone', price: 3000 },
        { tier: 'common', item: 'shiny-stone', price: 3500 },
        { tier: 'common', item: 'dusk-stone', price: 3500 },
        { tier: 'common', item: 'dawn-stone', price: 3500 },
      ],
    },

    {
      name: 'Special Evolution',
      description:
        'The one-offs. Each of these evolves exactly one line, and the shop is the only way to get them.',
      items: [
        // Kubfu picks its Urshifu style from which scroll it is given.
        { tier: 'common', item: 'scroll-of-darkness', price: 8000 },
        { tier: 'common', item: 'scroll-of-waters', price: 8000 },

        // Charcadet becomes Armarouge or Ceruledge depending on the armour.
        { tier: 'common', item: 'auspicious-armor', price: 6000 },
        { tier: 'common', item: 'malicious-armor', price: 6000 },

        // Galarian Slowpoke needs one of these rather than a stone.
        { tier: 'common', item: 'galarica-cuff', price: 5000 },
        { tier: 'common', item: 'galarica-wreath', price: 5000 },

        { tier: 'common', item: 'black-augurite', price: 5000 },
        { tier: 'common', item: 'metal-alloy', price: 6000 },
        { tier: 'common', item: 'peat-block', price: 5000 },

        // Applin goes three ways.
        { tier: 'common', item: 'sweet-apple', price: 4000 },
        { tier: 'common', item: 'tart-apple', price: 4000 },
        { tier: 'common', item: 'syrupy-apple', price: 4000 },

        // Poltchageist and Sinistea each take a real or a fake vessel.
        { tier: 'common', item: 'cracked-pot', price: 3000 },
        { tier: 'common', item: 'chipped-pot', price: 6000 },
        { tier: 'common', item: 'unremarkable-teacup', price: 3000 },
        { tier: 'common', item: 'masterpiece-teacup', price: 6000 },

        // Milcery spins with a Sweet to become Alcremie. Only the two Sweets
        // with artwork available are sold.
        { tier: 'common', item: 'strawberry-sweet', price: 4000 },
        { tier: 'common', item: 'berry-sweet', price: 4000 },

        // Gholdengo costs 999 of these, so they are priced to add up to
        // roughly what a Mega Stone costs.
        { tier: 'common', item: 'gimmighoul-coin', price: 10 },
      ],
    },

    {
      name: 'Held Gear',
      description: 'An Everstone stops a Pokemon evolving, however much it levels up.',
      items: [{ tier: 'common', item: 'everstone', price: 2000 }],
    },

    {
      name: 'Trade Items',
      description:
        'Hold one of these and trade the Pokemon away - it evolves on arrival and the item is used up.',
      items: TRADE_ITEM_ROWS,
    },

    {
      name: 'Training',
      description:
        'Vitamins add 10 effort to one stat; the berries take 10 back off and the ' +
        'Pokemon likes you a little more for it. A Reset Bag clears the lot.',
      items: [
        { tier: 'rare', item: 'rare-candy', price: 5000 },
        { tier: 'common', item: 'hp-up', price: 1200 },
        { tier: 'common', item: 'protein', price: 1200 },
        { tier: 'common', item: 'iron', price: 1200 },
        { tier: 'common', item: 'calcium', price: 1200 },
        { tier: 'common', item: 'zinc', price: 1200 },
        { tier: 'common', item: 'carbos', price: 1200 },

        // EV-lowering berries. Cheaper than vitamins, since battles award EVs
        // automatically. Also the only current source of friendship.
        { tier: 'common', item: 'pomeg-berry', price: 600 },
        { tier: 'common', item: 'kelpsy-berry', price: 600 },
        { tier: 'common', item: 'qualot-berry', price: 600 },
        { tier: 'common', item: 'hondew-berry', price: 600 },
        { tier: 'common', item: 'grepa-berry', price: 600 },
        { tier: 'common', item: 'tamato-berry', price: 600 },

        {
          // Resets all EVs.
          item: 'reset-bag',
          price: 500,
          tier: 'none',
          define: {
            displayName: 'Reset Bag',
            category: 'training',
            shortEffect: 'Clears all six effort values at once. Used up.',
            attributes: [],
            effect: { kind: 'ev-reset' },
          },
        },
      ],
    },

    {
      name: 'Held Items',
      description:
        'Battle gear. Every one of these does something in a fight - see ' +
        'Utils/battleeffects.js for exactly what. `.useitem <pokemon> <item>` to ' +
        'equip, `.take <pokemon>` to get it back.',
      items: [
        { tier: 'rare', item: 'leftovers', price: 8000 },
        { tier: 'rare', item: 'choice-band', price: 9000 },
        { tier: 'rare', item: 'choice-specs', price: 9000 },
        { tier: 'rare', item: 'choice-scarf', price: 9000 },
        { tier: 'epic', item: 'life-orb', price: 10000 },
        { tier: 'rare', item: 'focus-sash', price: 6000 },

        // Other held items supported by the battle engine.
        { tier: 'rare', item: 'assault-vest', price: 9000 },
        { tier: 'rare', item: 'eviolite', price: 9000 },
        { tier: 'rare', item: 'rocky-helmet', price: 7000 },
        { tier: 'rare', item: 'weakness-policy', price: 9000 },
        { tier: 'rare', item: 'expert-belt', price: 8000 },
        { tier: 'rare', item: 'shell-bell', price: 6000 },
        { tier: 'common', item: 'muscle-band', price: 5000 },
        { tier: 'common', item: 'wise-glasses', price: 5000 },
        { tier: 'common', item: 'scope-lens', price: 6000 },
        { tier: 'common', item: 'focus-band', price: 4000 },
        { tier: 'common', item: 'air-balloon', price: 5000 },
        { tier: 'common', item: 'black-sludge', price: 3000 },
        { tier: 'common', item: 'iron-ball', price: 2000 },

        // The orbs burn or poison their own holder on purpose, which is only
        // sensible next to Guts, Quick Feet, Poison Heal or Toxic Boost.
        { tier: 'common', item: 'flame-orb', price: 5000 },
        { tier: 'common', item: 'toxic-orb', price: 5000 },

        // Species-locked, and worth a great deal to exactly one Pokemon each.
        { tier: 'epic', item: 'light-ball', price: 8000 },
        { tier: 'epic', item: 'thick-club', price: 8000 },
        { tier: 'epic', item: 'soul-dew', price: 12000 },
        { tier: 'common', item: 'lucky-punch', price: 4000 },
        { tier: 'common', item: 'stick', price: 4000 },
        { tier: 'common', item: 'large-leek', price: 4000 },
        { tier: 'common', item: 'metal-powder', price: 3000 },
        { tier: 'common', item: 'quick-powder', price: 3000 },
      ],
    },

    {
      name: 'Type Boosters',
      description:
        'Held: moves of one type do 20% more damage. One for every type, plus the ' +
        'five breeding incenses, which do the same thing. The elemental PLATES do it ' +
        'too and are in Form Change, because they also change what Arceus is.',
      items: typeBoosterEntries(),
    },

    {
      name: 'Berries',
      description:
        'Held, and eaten on their own when they are needed. A cure berry goes off the ' +
        'moment the status lands; a pinch berry at a quarter health.',
      items: [
        { tier: 'common', item: 'sitrus-berry', price: 1500 },
        { tier: 'common', item: 'oran-berry', price: 800 },
        { tier: 'common', item: 'berry-juice', price: 800 },
        { tier: 'common', item: 'lum-berry', price: 2500 },
        { tier: 'common', item: 'cheri-berry', price: 800 },
        { tier: 'common', item: 'chesto-berry', price: 800 },
        { tier: 'common', item: 'pecha-berry', price: 800 },
        { tier: 'common', item: 'rawst-berry', price: 800 },
        { tier: 'common', item: 'aspear-berry', price: 800 },
        { tier: 'common', item: 'liechi-berry', price: 2000 },
        { tier: 'common', item: 'ganlon-berry', price: 2000 },
        { tier: 'common', item: 'petaya-berry', price: 2000 },
        { tier: 'common', item: 'apicot-berry', price: 2000 },
        { tier: 'common', item: 'salac-berry', price: 2000 },
      ],
    },

    {
      name: 'TMs',
      description:
        'Every TM there has ever been, 340 of them, and each one is REUSABLE - ' +
        'teaching a move does not spend it. `.tm <pokemon>` lists what one can learn; ' +
        '`.tm <pokemon> <move>` teaches it.',
      items: tmEntries(),
    },
  ],
};
