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

const { loadSpecies, loadForm, rollSpeciesGender } = require('./pokemon');
const rates = require('./rates');

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

let levelItemsCache = null;

/**
 * Items held while levelling up to evolve (Happiny's Oval Stone, Gligar's
 * Razor Fang). Using one equips it; the evolution uses it up.
 */
function levelHeldItems() {
  if (levelItemsCache) return levelItemsCache;

  const found = new Set();
  for (const species of index().species) {
    for (const link of optionsFrom(species.id)) {
      for (const condition of link.conditions || []) {
        if (condition.trigger === 'level-up' && condition.heldItem) found.add(condition.heldItem);
      }
    }
  }

  levelItemsCache = found;
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
 * Checked as in the games: level, gender, friendship (Pichu, Golbat, Eevee),
 * known moves (Sylveon, Lickilicky), and items used or held (Happiny levels
 * up holding an Oval Stone, Onix is traded holding a Metal Coat).
 *
 * Time of day has no clock here: a single timed evolution (Riolu by day)
 * ignores it, and where the time decides between targets (Espeon or Umbreon)
 * the player picks - see resolve(). `context.timeOfDay` is that pick.
 *
 * Never fire: affection (not tracked) and location level-ups, which all have
 * a stone instead (Leafeon's Leaf Stone, Magnezone's Thunder Stone).
 * Players can use an Everstone to opt out.
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

  if (condition.minHappiness != null && (context.happiness ?? 0) < condition.minHappiness) return false;
  if (condition.minAffection != null || condition.location) return false;
  if (context.timeOfDay && condition.timeOfDay && condition.timeOfDay !== context.timeOfDay) return false;

  if (condition.knownMove && !context.knownMoves().includes(condition.knownMove)) return false;
  if (condition.knownMoveType && !context.knownMoves().some((name) => moveType(name) === condition.knownMoveType)) {
    return false;
  }

  // Gender requirements (Combee and Salandit female only, Kirlia to Gallade
  // for males, Burmy to Wormadam or Mothim).
  if (condition.gender != null && GENDERS[condition.gender] !== context.gender) return false;

  if (trigger === 'use-item' && condition.item !== context.item) return false;

  // "Trade (or level up) while holding X" needs X actually held.
  if (condition.heldItem && condition.heldItem !== context.heldItem) return false;

  // Karrablast and Shelmet only evolve when traded for each other.
  if (condition.tradeSpecies && condition.tradeSpecies !== context.tradedFor) return false;

  return true;
}

/** A move's type, for Sylveon's "knows a Fairy move". */
const moveType = (name) => {
  const move = require('./content').move(name);
  return move ? move.type : null;
};

/** The moves a stored Pokemon knows, read only when a condition needs them. */
function knownMovesOf(row) {
  let known = null;
  return () => {
    if (!known) {
      known = row.id > 0
        ? require('./db').open().prepare('SELECT move FROM pokemon_moves WHERE pokemon_id = ?').all(row.id).map((m) => m.move)
        : [];
    }
    return known;
  };
}

/** The region of the form a stored Pokemon is in ("Hisui" for Hisuian Sneasel). */
function regionOf(row) {
  const form = index().forms.find((f) => f.speciesId === row.species_id && f.folder === row.form_folder);
  return form ? form.region : null;
}

/**
 * Which species this one could evolve into right now.
 *
 * Each match lists every condition that fired (Rockruff's three times of
 * day are three conditions on one link). Evolutions that belong to a regional
 * form go only to that form: Hisuian Sneasel becomes Sneasler, any other
 * Sneasel Weavile.
 */
function candidates(row, trigger, context = {}) {
  if (row.equipped_item === EVERSTONE) return [];

  const full = {
    ...context,
    level: context.level ?? row.level,
    heldItem: context.heldItem ?? row.equipped_item,
    gender: context.gender ?? row.gender,
    happiness: context.happiness ?? row.happiness,
    knownMoves: knownMovesOf(row),
  };

  let matches = [];

  for (const link of optionsFrom(row.species_id)) {
    const conditions = (link.conditions || []).filter((c) => conditionMatches(c, trigger, full));
    if (conditions.length) matches.push({ link, condition: conditions[0], conditions });
  }

  const regional = (match) => needsRegionalForm(row.species_id, match.link.id);
  if (matches.some(regional)) {
    const mine = regionOf(row);
    const theirs = matches.filter((m) => regional(m) && (loadSpecies(m.link.id) || {}).region === mine);
    matches = theirs.length ? theirs : matches.filter((m) => !regional(m));
  }

  return matches;
}

/**
 * The forms a time of day picks (Rockruff's Lycanroc). Dusk needs Own Tempo,
 * as in the games.
 */
const TIME_FORMS = {
  lycanroc: { day: 'Midday', night: 'Midnight', dusk: 'Dusk' },
};

const TIME_NAMES = { day: 'Day', night: 'Night', dusk: 'Dusk' };

/**
 * When several evolutions differ only by time of day, the ones to offer.
 *
 * @returns {Array<{timeOfDay, target}>|null} null when there is no choice
 */
function timeChoices(row, matches) {
  const options = [];

  for (const match of matches) {
    for (const condition of match.conditions) {
      const time = condition.timeOfDay;
      if (!time || options.some((o) => o.timeOfDay === time)) continue;
      if (time === 'dusk' && row.ability !== 'own-tempo') continue;

      const target = describe(row, match.link, { timeOfDay: time });
      if (target) options.push({ timeOfDay: time, label: TIME_NAMES[time] || time, target });
    }
  }

  // Every match has to be timed: Eevee may also be able to become Sylveon.
  const untimed = matches.some((m) => !m.conditions.some((c) => c.timeOfDay));
  return options.length >= 2 && !untimed ? options : null;
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

  const timed = context.timeOfDay && TIME_FORMS[link.name];
  const wantedForm = context.item ? ITEM_FORMS[context.item] : timed ? timed[context.timeOfDay] : null;

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
 * @returns {null | { choice } | { target, condition, changes, consumesHeldItem, alsoCreates }}
 *   `choice` lists the times of day to pick from instead of evolving
 */
function resolve(row, trigger, context = {}) {
  let matches = candidates(row, trigger, context);
  if (!matches.length) return null;

  // Knowing the move wins: an Eevee that knows a Fairy move becomes Sylveon.
  const byMove = matches.filter((m) => m.condition.knownMove || m.condition.knownMoveType);
  if (byMove.length) matches = byMove;

  // Espeon or Umbreon, Midday or Midnight Lycanroc: the player picks, then
  // calls again with `context.timeOfDay` (Utils/evolveprompt.js).
  if (!context.timeOfDay) {
    const choice = timeChoices(row, matches);
    if (choice) return { choice };
  }

  // Any other tie is broken at random (Wurmple, Tyrogue).
  const chosen = pickRandom(matches);
  const target = describe(row, chosen.link, context);
  if (!target) return null;

  // A held item a level-up evolution needed is used up (Razor Claw, Oval Stone).
  const usesUpItem = trigger === 'level-up' && Boolean(chosen.condition.heldItem);

  return {
    target,
    condition: chosen.condition,
    changes: { ...changesFor(row, target), ...(usesUpItem ? { equipped_item: null } : {}) },
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
// What an opponent has evolved into
// ---------------------------------------------------------------------------

/** Is this link a level-up evolution? Those happen exactly at their level. */
const levelOf = (link) => {
  const levels = (link.conditions || []).map((c) => c.minLevel).filter(Boolean);
  return levels.length ? Math.min(...levels) : null;
};

/** The gender a link needs (Combee to Vespiquen: female), or null. */
const genderFor = (link) => {
  const condition = (link.conditions || []).find((c) => c.gender != null);
  return condition ? GENDERS[condition.gender] : null;
};

/**
 * The lowest level this species can naturally be.
 *
 * A level evolution sets it outright (Combusken: 16, Blaziken: 36). Trades,
 * stones and friendship have no level, so they count from when the stage
 * before could first appear plus `afterLevels` (Kadabra 16, Alakazam 26).
 *
 * @returns {number} 1 for anything with nothing to climb
 */
const earliestLevelCache = new Map();

function earliestLevel(speciesId) {
  if (earliestLevelCache.has(speciesId)) return earliestLevelCache.get(speciesId);

  const species = loadSpecies(speciesId);
  const chain = (species && species.evolution && species.evolution.chain) || [];
  const link = chain.find((l) => l.id === speciesId);
  const from = link && link.evolvesFrom ? chain.find((l) => l.name === link.evolvesFrom) : null;

  let level = 1;
  if (from && from.id) {
    const before = earliestLevel(from.id);
    const atLevel = levelOf(link);
    level = atLevel ? Math.max(before, atLevel) : before + rates.battle.opponentEvolution.afterLevels;
  }

  earliestLevelCache.set(speciesId, level);
  return level;
}

/**
 * How likely an opponent of this level has taken this evolution: all or
 * nothing for level evolutions, a ramp up to `maxChance` for the rest.
 */
function evolvedChance(link, level) {
  const from = earliestLevel(link.id);
  if (level < from) return 0;
  if (levelOf(link)) return 1;

  const { rampLevels, maxChance } = rates.battle.opponentEvolution;
  return Math.min(maxChance, (maxChance * (level - from + 1)) / rampLevels);
}

/**
 * Does this evolution belong to a regional form the species' default form
 * isn't? Paldean Wooper becomes Clodsire and Galarian Meowth Perrserker;
 * opponents are always the default form, so they skip these.
 */
function needsRegionalForm(fromId, toId) {
  const target = loadSpecies(toId);
  if (!target || !target.region) return false;

  const forms = index().forms.filter((f) => f.speciesId === fromId);
  const usual = forms.find((f) => f.isDefault) || forms[0];
  return forms.some(
    (f) => !f.isDefault && f.region === target.region && (!usual || usual.region !== target.region)
  );
}

/**
 * The line from the bottom of the chain up to this species, for opponents.
 *
 * Babies are left off unless the baby itself was picked, so a Pikachu never
 * turns into a Pichu.
 */
function lineTo(speciesId) {
  const species = loadSpecies(speciesId);
  const chain = (species && species.evolution && species.evolution.chain) || [];

  const line = [speciesId];
  let link = chain.find((l) => l.id === speciesId);

  for (let guard = 0; link && link.evolvesFrom && guard < 10; guard += 1) {
    const from = chain.find((l) => l.name === link.evolvesFrom);
    if (!from || !from.id) break;

    const before = loadSpecies(from.id);
    if (before && before.rarity && before.rarity.isBaby) break;

    line.unshift(from.id);
    link = from;
  }

  return line;
}

const rollGenderOf = (speciesId, rng) => rollSpeciesGender(loadSpecies(speciesId), rng);

/**
 * The species an ordinary opponent of this level turns up as.
 *
 * Climbs the picked species' line from the bottom, so the stage depends on
 * the level and not on which stage was picked: a level 26 Torchic or
 * Blaziken is a Combusken, and a level 40 Abra or Alakazam is usually a
 * Kadabra, sometimes an Alakazam. Past the picked species any branch can be
 * taken (a level 50 Eevee is usually one of its evolutions).
 *
 * Milestone rosters skip this, since their species are fixed.
 *
 * @returns {{ speciesId: number, gender: string|null }} gender is set when an
 *   evolution depended on it (a male Combee stays a Combee)
 */
function opponentSpecies(speciesId, level, rng = Math.random) {
  const line = lineTo(speciesId);
  let current = line[0];
  let gender = null;

  for (let step = 1; step < 10; step += 1) {
    // Follow the picked line first, then any branch.
    const next = line[step];
    const options = optionsFrom(current).filter((link) =>
      next ? link.id === next : link.id && !needsRegionalForm(current, link.id)
    );
    if (!options.length) break;

    if (!gender && options.some(genderFor)) {
      gender = next ? genderFor(options[0]) || rollGenderOf(current, rng) : rollGenderOf(current, rng);
    }

    const open = options
      .filter((link) => !genderFor(link) || genderFor(link) === gender)
      .map((link) => ({ link, chance: evolvedChance(link, level) }))
      .filter((option) => option.chance > 0);
    if (!open.length) break;

    // Evolve as often as the likeliest branch allows, then pick a branch by
    // how likely each is.
    if (rng() >= Math.max(...open.map((option) => option.chance))) break;

    let roll = rng() * open.reduce((sum, option) => sum + option.chance, 0);
    const picked = open.find((option) => (roll -= option.chance) < 0) || open[open.length - 1];
    current = picked.link.id;
  }

  return { speciesId: current, gender };
}

module.exports = {
  earliestLevel,
  opponentSpecies,
  UNSUPPORTED,
  HANDLED_ELSEWHERE,
  EVERSTONE,
  SHEDINJA,
  tradeHeldItems,
  levelHeldItems,
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
