'use strict';

/**
 * Evolving.
 *
 * PokeAPI describes each evolution as a trigger plus conditions. This decides
 * which ones the bot can act on, picks a target, and works out the row
 * changes.
 *
 * Supported triggers:
 *
 *   use-item   a stone, scroll, Sweet or other used item
 *   level-up   reaching the level (battles or Rare Candy)
 *   trade      changing hands, optionally while holding an item
 *
 * Some other PokeAPI triggers map onto these: "other" is a level
 * (Tandemaus), "spin" is giving Milcery a Sweet, "gimmighoul-coins" is giving
 * 999 coins, and the Kubfu towers are the scrolls. See HANDLED_ELSEWHERE.
 *
 * Triggers that would need detailed battle tracking (recoil taken, critical
 * hits landed, defeating three Bisharp) are listed in UNSUPPORTED.
 *
 * Run `node Utils/evolution.js` for a coverage report.
 */

const fs = require('fs');
const path = require('path');

const { loadSpecies, loadForm } = require('./pokemon');

const DATA = path.join(__dirname, '..', 'Data');

/**
 * Unsupported triggers, mapped to what they require.
 */
const UNSUPPORTED = {
  'three-critical-hits': 'land three critical hits in one battle',
  'take-damage': 'take a specific amount of damage',
  'recoil-damage': 'take recoil damage',
  'use-move': 'use a particular move enough times',
  'strong-style-move': 'use a move in strong style',
  'agile-style-move': 'use a move in agile style',
  'three-defeated-bisharp': "defeat three Bisharp holding a Leader's Crest",
};

/**
 * Triggers PokeAPI records under their own name that are really just "use this
 * item", and are handled as such.
 *
 *   shed              Nincada leaves a Shedinja when it levels into Ninjask
 *   spin              Milcery is given a Sweet
 *   gimmighoul-coins  Gimmighoul is given 999 coins
 *   tower-of-*        Kubfu is given a scroll, which is also a use-item
 *                     condition on the same link
 */
const HANDLED_ELSEWHERE = ['shed', 'spin', 'gimmighoul-coins', 'tower-of-darkness', 'tower-of-waters'];

/** Nincada leaves a Shedinja behind when it becomes Ninjask. */
const SHEDINJA = { fromSpecies: 290, becomes: 291, alsoCreates: 292 };

/** An Everstone prevents evolution. */
const EVERSTONE = 'everstone';

/** PokeAPI numbers genders on evolution conditions rather than naming them. */
const GENDERS = { 1: 'female', 2: 'male', 3: 'genderless' };

/**
 * Milcery spins with a Sweet to become Alcremie, and the Sweet decides the
 * decoration half of the form name.
 *
 * Only two of the seven Sweets are included, because PokeAPI only has artwork
 * for those Alcremie forms.
 */
const SPIN_SWEETS = {
  'strawberry-sweet': 'Strawberry Sweet',
  'berry-sweet': 'Berry Sweet',
};

/**
 * Gimmighoul needs many coins, the only evolution that consumes a quantity.
 */
const COIN_EVOLUTION = { item: 'gimmighoul-coin', quantity: 999 };

let indexCache = null;
function index() {
  if (!indexCache) {
    indexCache = JSON.parse(fs.readFileSync(path.join(DATA, 'Pokemon', 'index.json'), 'utf8'));
  }
  return indexCache;
}

let tradeItemsCache = null;

/**
 * Items that exist to be held while trading.
 *
 * PokeAPI doesn't mark these as holdable (e.g. Dragon Scale), so the set is
 * derived from the evolution data.
 */
function tradeHeldItems() {
  if (tradeItemsCache) return tradeItemsCache;

  const found = new Set();
  for (const species of index().species) {
    for (const link of optionsFrom(species.id)) {
      for (const condition of link.conditions || []) {
        if (condition.trigger === 'trade' && condition.heldItem) found.add(condition.heldItem);
      }
    }
  }

  tradeItemsCache = found;
  return found;
}

let useItemsCache = null;

/**
 * Items that evolve something when used.
 *
 * Derived from the evolution data rather than item categories, since some
 * (like the Scroll of Darkness) are not categorised as evolution items.
 */
function useItems() {
  if (useItemsCache) return useItemsCache;

  const found = new Set();
  for (const species of index().species) {
    for (const link of optionsFrom(species.id)) {
      for (const condition of link.conditions || []) {
        if (condition.trigger === 'use-item' && condition.item) found.add(condition.item);
      }
    }
  }

  // The Sweets and Gimmighoul's coins use triggers that name no item, so add
  // them by hand.
  for (const sweet of Object.keys(SPIN_SWEETS)) found.add(sweet);
  found.add(COIN_EVOLUTION.item);

  useItemsCache = found;
  return found;
}

let itemTargetsCache = null;

/**
 * The reverse of optionsFrom: which species each item affects, and how.
 *
 * Used by .examine. Built from the same evolution data used for evolving.
 *
 * @returns {Map<string, Array<{ fromId, from, into, trigger }>>}
 */
function itemTargets() {
  if (itemTargetsCache) return itemTargetsCache;

  const map = new Map();

  const add = (slug, entry) => {
    if (!map.has(slug)) map.set(slug, []);
    map.get(slug).push(entry);
  };

  for (const species of index().species) {
    for (const link of optionsFrom(species.id)) {
      const into = link.displayName || link.name;

      for (const condition of link.conditions || []) {
        if (condition.trigger === 'use-item' && condition.item) {
          add(condition.item, { fromId: species.id, from: species.displayName, into, trigger: 'use' });
        }

        if (condition.trigger === 'trade' && condition.heldItem) {
          add(condition.heldItem, { fromId: species.id, from: species.displayName, into, trigger: 'trade' });
        }

        // Sweets and Gimmighoul's coins are matched on the trigger instead,
        // as in useItems().
        if (condition.trigger === 'spin') {
          for (const sweet of Object.keys(SPIN_SWEETS)) {
            add(sweet, { fromId: species.id, from: species.displayName, into, trigger: 'spin' });
          }
        }

        if (condition.trigger === 'gimmighoul-coins') {
          add(COIN_EVOLUTION.item, {
            fromId: species.id,
            from: species.displayName,
            into,
            trigger: 'coins',
            quantity: COIN_EVOLUTION.quantity,
          });
        }
      }
    }
  }

  itemTargetsCache = map;
  return map;
}

/** Everything this species can evolve into. */
function optionsFrom(speciesId) {
  const species = loadSpecies(speciesId);
  if (!species || !species.evolution) return [];

  const chain = species.evolution.chain || [];
  return chain.filter((link) => link.evolvesFrom === species.name);
}

/**
 * Does one condition fire?
 *
 * Conditions the bot doesn't track (happiness, time of day, location,
 * affection, known moves) are ignored rather than treated as failing. Players
 * can use an Everstone to opt out.
 */
function conditionMatches(condition, trigger, context) {
  if (condition.trigger !== trigger) {
    // "spin" and "gimmighoul-coins" are item uses.
    const viaItem =
      trigger === 'use-item' &&
      ((condition.trigger === 'spin' && SPIN_SWEETS[context.item]) ||
        (condition.trigger === 'gimmighoul-coins' && context.item === COIN_EVOLUTION.item));

    // Tandemaus is the only user of "other", and it only wants a level.
    const viaLevel = trigger === 'level-up' && condition.trigger === 'other';

    if (!viaItem && !viaLevel) return false;

    // No other requirements to check for these.
    if (viaItem) return true;
  }

  if (condition.minLevel != null && (context.level ?? 0) < condition.minLevel) return false;

  // Gender requirements (Combee and Salandit female only, Kirlia to Gallade
  // for males, Burmy to Wormadam or Mothim).
  if (condition.gender != null && GENDERS[condition.gender] !== context.gender) return false;

  if (trigger === 'use-item' && condition.item !== context.item) return false;

  if (trigger === 'trade') {
    // "Trade while holding X" needs X actually held.
    if (condition.heldItem && condition.heldItem !== context.heldItem) return false;
  }

  return true;
}

/**
 * Which species this one could evolve into right now.
 *
 * Several can match when they differ only by something the bot doesn't track
 * (Espeon and Umbreon differ by time of day), so the caller picks.
 */
function candidates(row, trigger, context = {}) {
  if (row.equipped_item === EVERSTONE) return [];

  const level = context.level ?? row.level;
  const heldItem = context.heldItem ?? row.equipped_item;
  const gender = context.gender ?? row.gender;

  const matches = [];

  for (const link of optionsFrom(row.species_id)) {
    const condition = (link.conditions || []).find((c) =>
      conditionMatches(c, trigger, { ...context, level, heldItem, gender })
    );

    if (condition) matches.push({ link, condition });
  }

  return matches;
}

/**
 * Which form an item forces on its target.
 *
 * PokeAPI records the item on the species link, not the form, so e.g. the
 * Scroll of Waters -> Rapid Strike Urshifu mapping is listed here.
 */
const ITEM_FORMS = {
  'scroll-of-darkness': 'Single Strike',
  'scroll-of-waters': 'Rapid Strike',
};

/**
 * Does this form have artwork to show?
 *
 * Forms without artwork are avoided when choosing an evolution target.
 */
function hasArtwork(speciesId, formFolder) {
  const form = loadForm(speciesId, formFolder);
  if (!form || !form.images) return false;
  return !!(form.images.artwork || form.images.artworkShiny);
}

/** Roll one of these forms using the drop percentages set in formrates.js. */
function rollForm(forms) {
  const droppable = forms.filter((f) => f.percentage > 0);
  if (!droppable.length) return null;
  if (droppable.length === 1) return droppable[0];

  const total = droppable.reduce((sum, f) => sum + f.percentage, 0);
  let roll = Math.random() * total;

  for (const form of droppable) {
    roll -= form.percentage;
    if (roll < 0) return form;
  }

  return droppable[droppable.length - 1];
}

/**
 * Describe a target, working out which of its forms this one becomes.
 *
 * Rules, tried in order:
 *
 *   1. the same form name (Alolan Vulpix -> Alolan Ninetales)
 *   2. a form chosen by the item (Urshifu's scrolls)
 *   3. a form matching its gender (Unfezant, Basculegion)
 *   4. a form from the same region (Kantonian Pikachu -> Kantonian Raichu)
 *   5. otherwise, a roll on the drop percentages (Maushold, Dudunsparce)
 */
function describe(row, link, context = {}) {
  const forms = index().forms.filter((f) => f.speciesId === link.id);
  if (!forms.length) return null;

  // The Sweet sets the decoration; the cream is rolled from forms with artwork.
  const sweet = context.item ? SPIN_SWEETS[context.item] : null;
  if (sweet) {
    const drawn = forms.filter(
      (f) => f.folder.endsWith(sweet) && hasArtwork(link.id, f.folder)
    );

    if (drawn.length) {
      const picked = drawn[Math.floor(Math.random() * drawn.length)];
      const species = loadSpecies(link.id);
      return {
        speciesId: link.id,
        form: picked.folder,
        name: picked.displayName,
        speciesName: species ? species.name : picked.slug,
      };
    }
  }

  const wantedForm = context.item ? ITEM_FORMS[context.item] : null;

  // Only keep the form name if the target has artwork for it (Mothim is
  // listed in all three Burmy cloaks but only one has artwork).
  const sameName = forms.find((f) => f.folder === row.form_folder);

  const form =
    (sameName && hasArtwork(link.id, sameName.folder) ? sameName : null) ||
    (wantedForm ? forms.find((f) => f.folder === wantedForm) : null) ||
    (row.gender ? forms.find((f) => f.genderLock === row.gender) : null) ||
    rollForm(forms.filter((f) => f.region && f.region === row.region)) ||
    rollForm(forms) ||
    forms.find((f) => f.isDefault) ||
    forms[0];

  const species = loadSpecies(link.id);

  return {
    speciesId: link.id,
    form: form.folder,
    name: form.displayName,
    speciesName: species ? species.name : form.slug,
  };
}

/**
 * Keep the ability slot rather than the ability.
 *
 * Slots 1 and 2 are normal abilities and 3 is hidden. If the target has no
 * matching slot (Eevee's slot 2, for example), the first ability is used.
 *
 * Mega forms have a single ability; the stored slot restores the original
 * ability on reverting.
 */
function remapAbility(speciesId, formFolder, slot) {
  const form = loadForm(speciesId, formFolder);
  const abilities = (form && form.abilities) || [];

  if (!abilities.length) return null;

  const sameSlot = abilities.find((a) => a.slot === slot);
  return sameSlot || abilities[0];
}

/**
 * The row changes for evolving into `target`.
 *
 * @returns {object} columns to write
 */
function changesFor(row, target) {
  const { normaliseName } = require('./pokemon');
  const ability = remapAbility(target.speciesId, target.form, row.ability_slot || 1);

  return {
    species_id: target.speciesId,
    form_folder: target.form,
    species_name: target.speciesName,
    // Update the normalised name used for name matching.
    species_key: normaliseName(target.speciesName),
    display_name: target.name,
    ability: ability ? ability.name : row.ability,
    ability_slot: ability ? ability.slot : row.ability_slot,
  };
}

const pickRandom = (list) => list[Math.floor(Math.random() * list.length)];

/**
 * Work out whether a Pokemon evolves, and into what.
 *
 * @returns {null | { target, condition, changes, consumesHeldItem, alsoCreates }}
 */
function resolve(row, trigger, context = {}) {
  const matches = candidates(row, trigger, context);
  if (!matches.length) return null;

  // Ties are broken at random (e.g. Eevee levelling up can match several
  // eeveelutions).
  const chosen = pickRandom(matches);
  const target = describe(row, chosen.link, context);
  if (!target) return null;

  return {
    target,
    condition: chosen.condition,
    changes: changesFor(row, target),
    // Trade evolutions consume the required held item.
    consumesHeldItem: trigger === 'trade' && !!chosen.condition.heldItem,
    // Nincada leaves a Shedinja behind.
    alsoCreates:
      row.species_id === SHEDINJA.fromSpecies && target.speciesId === SHEDINJA.becomes
        ? SHEDINJA.alsoCreates
        : null,
  };
}

// ---------------------------------------------------------------------------
// What could plausibly exist at a level
// ---------------------------------------------------------------------------

/**
 * The lowest level this species can naturally be.
 *
 * Takes the highest level requirement along its chain (Venusaur: 32,
 * Mienshao: 50). Only level requirements count; stone and trade evolutions
 * add no minimum.
 *
 * @returns {number} 1 for anything with nothing to climb
 */
const minimumLevelCache = new Map();

function minimumLevelFor(speciesId) {
  if (minimumLevelCache.has(speciesId)) return minimumLevelCache.get(speciesId);

  const species = loadSpecies(speciesId);
  const chain = (species && species.evolution && species.evolution.chain) || [];

  // Index the chain by name for lookups.
  const byName = new Map(chain.map((link) => [link.name, link]));

  let needed = 1;
  let current = species && species.evolution ? { name: species.name, ...species.evolution } : null;
  let guard = 0;

  while (current && guard < 10) {
    guard += 1;

    for (const condition of current.conditions || []) {
      if (condition.minLevel) needed = Math.max(needed, condition.minLevel);
    }

    current = current.evolvesFrom ? byName.get(current.evolvesFrom) : null;
  }

  minimumLevelCache.set(speciesId, needed);
  return needed;
}

/**
 * The species to use for an opponent of a given level.
 *
 * Walks down the evolution chain to the highest stage that can exist at this
 * level, so a level 11 Venusaur becomes an Ivysaur and a level 8 one a
 * Bulbasaur. This keeps the encounter table's weighting intact, unlike
 * re-rolling.
 *
 * @param {number} speciesId
 * @param {number} level
 * @returns {number} the species id to actually use - possibly the same one
 */
function speciesAtLevel(speciesId, level) {
  if (minimumLevelFor(speciesId) <= level) return speciesId;

  const species = loadSpecies(speciesId);
  const chain = (species && species.evolution && species.evolution.chain) || [];
  if (!chain.length) return speciesId;

  // Stages on this line that can be this level, highest stage first. Sorted
  // by stage, not id, since chains aren't always in dex order (babies).
  const legal = chain
    .filter((link) => link.id && minimumLevelFor(link.id) <= level)
    .sort((a, b) => (b.stage || 1) - (a.stage || 1));

  return legal.length ? legal[0].id : speciesId;
}

module.exports = {
  minimumLevelFor,
  speciesAtLevel,
  UNSUPPORTED,
  HANDLED_ELSEWHERE,
  EVERSTONE,
  SHEDINJA,
  tradeHeldItems,
  useItems,
  itemTargets,
  optionsFrom,
  conditionMatches,
  candidates,
  describe,
  rollForm,
  hasArtwork,
  GENDERS,
  ITEM_FORMS,
  SPIN_SWEETS,
  COIN_EVOLUTION,
  remapAbility,
  changesFor,
  resolve,
};

// `node Utils/evolution.js` - what is and is not reachable.
if (require.main === module) {
  const data = index();
  const triggers = new Map();

  for (const species of data.species) {
    for (const link of optionsFrom(species.id)) {
      for (const condition of link.conditions || []) {
        const key = condition.trigger;
        if (!triggers.has(key)) triggers.set(key, new Set());
        triggers.get(key).add(`${species.name} -> ${link.name}`);
      }
    }
  }

  const supported = ['use-item', 'level-up', 'trade', 'other', ...HANDLED_ELSEWHERE];

  console.log('Supported:');
  for (const trigger of supported) {
    const set = triggers.get(trigger);
    if (set) console.log(`  ${trigger.padEnd(24)} ${String(set.size).padStart(4)} pairs`);
  }

  console.log('');
  console.log('Needs a battle system:');
  let blocked = 0;
  for (const [trigger, set] of triggers) {
    if (supported.includes(trigger)) continue;
    blocked += set.size;
    console.log(`  ${trigger.padEnd(24)} ${String(set.size).padStart(4)}  ${[...set].join(', ')}`);
  }
  console.log(`\n${blocked} pairs blocked.`);
}
