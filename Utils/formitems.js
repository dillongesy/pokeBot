'use strict';

/**
 * Items that change a Pokemon's form without evolving it: Rotom's appliances,
 * Arceus' plates, Silvally's memories, Furfrou's trims, Oricorio's nectars,
 * Ogerpon's masks, the origin orbs and the DNA splicers.
 *
 * The species, id, IVs, level and nickname stay the same; only the form (and
 * with it typing, base stats and artwork) changes. Utils/pokemon.js
 * recalculateStats handles the rest, so this file only says which form.
 *
 * How long a change lasts:
 *
 *   held        the Pokemon holds the item and the form lasts as long as it
 *               does. `.take` returns the item and reverts the form. Most
 *               entries are this.
 *   keep        the item stays in the bag and can be reused;
 *               `.useitem <id> default` reverts for free (Rotom's appliances).
 *   consumed    the item is used up. The form stays until another item of the
 *               same family changes it.
 *
 * For held items the form follows the item: Arceus holding the Fist Plate is
 * Fighting, and taking the plate off makes it Normal again. This keeps the
 * held item and the form from ever disagreeing.
 *
 * Mega Stones are not listed here; Utils/items.js derives them from the
 * artwork data. They behave like `held`.
 *
 * A row with `species: null` names a form family instead (the Dynamax Band's
 * "Gmax", the Reveal Glass's "Therian") and works on any species that has
 * that form. When a species has several matching forms (Urshifu, Toxtricity),
 * the one matching its current form is chosen.
 *
 * To add one, add a row. The importer checks that the species and target form
 * exist and that the form has artwork.
 */

/** Arceus' plates and Silvally's memories both name a type. */
const TYPES = [
  'Normal', 'Fighting', 'Flying', 'Poison', 'Ground', 'Rock', 'Bug', 'Ghost',
  'Steel', 'Fire', 'Water', 'Grass', 'Electric', 'Psychic', 'Ice', 'Dragon',
  'Dark', 'Fairy',
];

/** Plate names by type. "Fist Plate" makes Arceus Fighting. */
const PLATE_NAMES = {
  Fighting: 'Fist', Flying: 'Sky', Poison: 'Toxic', Ground: 'Earth',
  Rock: 'Stone', Bug: 'Insect', Ghost: 'Spooky', Steel: 'Iron',
  Fire: 'Flame', Water: 'Splash', Grass: 'Meadow', Electric: 'Zap',
  Psychic: 'Mind', Ice: 'Icicle', Dragon: 'Draco', Dark: 'Dread', Fairy: 'Pixie',
};

/**
 * Build the plates and memories from the type list. Arceus has no Normal
 * plate since it is Normal by default.
 */
const plates = TYPES.filter((type) => PLATE_NAMES[type]).map((type) => ({
  item: `${PLATE_NAMES[type].toLowerCase()}-plate`,
  name: `${PLATE_NAMES[type]} Plate`,
  species: 493,
  form: type,
  price: 500,
  tier: 'common',
  reuse: 'held',
}));

const memories = TYPES.filter((type) => type !== 'Normal').map((type) => ({
  item: `${type.toLowerCase()}-memory`,
  name: `${type} Memory`,
  species: 773,
  form: type,
  price: 500,
  tier: 'common',
  reuse: 'held',
}));

/** Furfrou's nine cuts. The tenth look, Natural, is what it starts as. */
const TRIMS = ['Heart', 'Star', 'Diamond', 'Debutante', 'Matron', 'Dandy', 'La Reine', 'Kabuki', 'Pharaoh'];

const trims = TRIMS.map((trim) => ({
  item: `${trim.toLowerCase().replace(/\s+/g, '-')}-trim`,
  name: `${trim} Trim`,
  species: 676,
  form: trim,
  price: 250,
  tier: 'common',
  reuse: 'consumed',
  define: true,
}));

module.exports = {
  TYPES,
  PLATE_NAMES,
  TRIMS,

  items: [
    // -- Rotom's appliances ---------------------------------------------------
    { item: 'rotom-stove', name: 'Stove', species: 479, form: 'Heat', price: 500, tier: 'common', reuse: 'keep', define: true },
    { item: 'rotom-washer', name: 'Washing Machine', species: 479, form: 'Wash', price: 500, tier: 'common', reuse: 'keep', define: true },
    { item: 'rotom-fridge', name: 'Fridge', species: 479, form: 'Frost', price: 500, tier: 'common', reuse: 'keep', define: true },
    { item: 'rotom-fan', name: 'Fan', species: 479, form: 'Fan', price: 500, tier: 'common', reuse: 'keep', define: true },
    { item: 'rotom-mower', name: 'Lawn Mower', species: 479, form: 'Mow', price: 500, tier: 'common', reuse: 'keep', define: true },

    ...plates,
    ...memories,
    ...trims,

    // -- Oricorio's nectars ---------------------------------------------------
    { item: 'red-nectar', name: 'Red Nectar', species: 741, form: 'Baile', price: 250, tier: 'common', reuse: 'consumed' },
    { item: 'yellow-nectar', name: 'Yellow Nectar', species: 741, form: 'Pom Pom', price: 250, tier: 'common', reuse: 'consumed' },
    { item: 'pink-nectar', name: 'Pink Nectar', species: 741, form: 'Pau', price: 250, tier: 'common', reuse: 'consumed' },
    { item: 'purple-nectar', name: 'Purple Nectar', species: 741, form: 'Sensu', price: 250, tier: 'common', reuse: 'consumed' },

    // -- Ogerpon's masks ------------------------------------------------------
    { item: 'wellspring-mask', name: 'Wellspring Mask', species: 1017, form: 'Wellspring Mask', price: 500, tier: 'common', reuse: 'held' },
    { item: 'hearthflame-mask', name: 'Hearthflame Mask', species: 1017, form: 'Hearthflame Mask', price: 500, tier: 'common', reuse: 'held' },
    { item: 'cornerstone-mask', name: 'Cornerstone Mask', species: 1017, form: 'Cornerstone Mask', price: 500, tier: 'common', reuse: 'held' },

    // -- The origin orbs ------------------------------------------------------
    { item: 'adamant-crystal', name: 'Adamant Crystal', species: 483, form: 'Origin', price: 500, tier: 'common', reuse: 'held' },
    { item: 'lustrous-globe', name: 'Lustrous Globe', species: 484, form: 'Origin', price: 500, tier: 'common', reuse: 'held' },
    { item: 'griseous-core', name: 'Griseous Core', species: 487, form: 'Origin', price: 500, tier: 'common', reuse: 'held' },

    // -- Primal reversion -----------------------------------------------------
    { item: 'red-orb', name: 'Red Orb', species: 383, form: 'Primal', price: 500, tier: 'common', reuse: 'held' },
    { item: 'blue-orb', name: 'Blue Orb', species: 382, form: 'Primal', price: 500, tier: 'common', reuse: 'held' },

    // -- The legendary one-offs -----------------------------------------------
    { item: 'rusted-sword', name: 'Rusted Sword', species: 888, form: 'Crowned', price: 500, tier: 'common', reuse: 'held' },
    { item: 'rusted-shield', name: 'Rusted Shield', species: 889, form: 'Crowned', price: 500, tier: 'common', reuse: 'held' },

    { item: 'n-solarizer', name: 'N-Solarizer', species: 800, form: 'Dusk', price: 1000, tier: 'none', reuse: 'keep', define: true },
    { item: 'n-lunarizer', name: 'N-Lunarizer', species: 800, form: 'Dawn', price: 1000, tier: 'none', reuse: 'keep', define: true },
    { item: 'ultranecrozium-z', name: 'Ultranecrozium Z', species: 800, form: 'Ultra', price: 500, tier: 'common', reuse: 'consumed' },

    { item: 'prison-bottle', name: 'Prison Bottle', species: 720, form: 'Unbound', price: 1000, tier: 'none', reuse: 'keep' },
    { item: 'gracidea', name: 'Gracidea Flower', species: 492, form: 'Sky', price: 1000, tier: 'none', reuse: 'keep' },

    { item: 'white-dna-splicer', name: 'White DNA Splicer', species: 646, form: 'White', price: 750, tier: 'none', reuse: 'keep', define: true },
    { item: 'black-dna-splicer', name: 'Black DNA Splicer', species: 646, form: 'Black', price: 750, tier: 'none', reuse: 'keep', define: true },

    // -- The two that work on a whole group -----------------------------------
    // `species: null` means "any species that has this form". Both are
    // reusable.
    {
      item: 'dynamax-band', name: 'Dynamax Band', species: null, form: 'Gmax',
      describe: 'Gigantamaxes any Pokemon that has a Gigantamax form.',
      price: 1000, tier: 'none', reuse: 'keep', define: true,
    },
    {
      item: 'reveal-glass', name: 'Reveal Glass', species: null, form: 'Therian',
      describe: 'Turns Tornadus, Thundurus, Landorus or Enamorus Therian.',
      price: 1000, tier: 'none', reuse: 'keep', define: true,
    },
  ],
};
