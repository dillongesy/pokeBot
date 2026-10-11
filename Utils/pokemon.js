'use strict';

/**
 * Turning a species into an actual Pokemon.
 *
 * Rolls IVs, nature, ability, gender and level, and calculates stats with the
 * Gen 3+ formulas.
 *
 * Run `node Utils/pokemon.js pikachu` to generate one and see the numbers.
 */

const fs = require('fs');
const path = require('path');

const rates = require('./rates');

const DATA_DIR = path.join(__dirname, '..', 'Data');
const NATURES_DIR = path.join(DATA_DIR, 'Natures');

/** The six stats, in the order the games list them. */
const STATS = ['hp', 'attack', 'defense', 'specialAttack', 'specialDefense', 'speed'];

/** PokeAPI names stats with dashes; we use camelCase everywhere else. */
const STAT_FROM_API = {
  hp: 'hp',
  attack: 'attack',
  defense: 'defense',
  'special-attack': 'specialAttack',
  'special-defense': 'specialDefense',
  speed: 'speed',
};

const MAX_IV = 31;
const MAX_LEVEL = 100;

/** Shedinja's HP is hard-wired to 1 no matter what its IVs or level say. */
const SHEDINJA_ID = 292;

// ---------------------------------------------------------------------------
// Natures
// ---------------------------------------------------------------------------

let naturesCache = null;

/** Load the 25 natures (five of which are neutral). */
function loadNatures() {
  if (naturesCache) return naturesCache;

  const natures = [];

  for (const entry of fs.readdirSync(NATURES_DIR)) {
    const file = path.join(NATURES_DIR, entry, 'data.json');
    if (!fs.existsSync(file)) continue;

    const nature = JSON.parse(fs.readFileSync(file, 'utf8'));
    natures.push({
      name: nature.name,
      displayName: nature.displayName,
      increased: STAT_FROM_API[nature.increasedStat] || null,
      decreased: STAT_FROM_API[nature.decreasedStat] || null,
    });
  }

  if (!natures.length) {
    throw new Error('No natures found. Run "node Utils/importdata.js natures".');
  }

  naturesCache = natures.sort((a, b) => a.name.localeCompare(b.name));
  return naturesCache;
}

/** How a nature scales one stat: 1.1 if it favours it, 0.9 if it hinders it. */
function natureMultiplier(nature, stat) {
  if (!nature || stat === 'hp') return 1;
  if (nature.increased === stat) return 1.1;
  if (nature.decreased === stat) return 0.9;
  return 1;
}

// ---------------------------------------------------------------------------
// Experience
// ---------------------------------------------------------------------------

/**
 * Total experience needed to reach a level, per growth rate.
 *
 * "Erratic" and "fluctuating" are piecewise curves.
 */
const GROWTH_RATES = {
  fast: (n) => (4 * n ** 3) / 5,
  medium: (n) => n ** 3,
  'medium-slow': (n) => (6 / 5) * n ** 3 - 15 * n ** 2 + 100 * n - 140,
  slow: (n) => (5 * n ** 3) / 4,

  'fast-then-very-slow': (n) => {
    if (n < 50) return (n ** 3 * (100 - n)) / 50;
    if (n < 68) return (n ** 3 * (150 - n)) / 100;
    if (n < 98) return (n ** 3 * Math.floor((1911 - 10 * n) / 3)) / 500;
    return (n ** 3 * (160 - n)) / 100;
  },

  'slow-then-very-fast': (n) => {
    if (n < 15) return (n ** 3 * (Math.floor((n + 1) / 3) + 24)) / 50;
    if (n < 36) return (n ** 3 * (n + 14)) / 50;
    return (n ** 3 * (Math.floor(n / 2) + 32)) / 50;
  },
};

/** Total experience a Pokemon on this growth rate has at the given level. */
function experienceForLevel(growthRate, level) {
  const curve = GROWTH_RATES[growthRate] || GROWTH_RATES.medium;
  return Math.max(0, Math.floor(curve(Math.max(1, Math.min(level, MAX_LEVEL)))));
}

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

/**
 * How far along its evolution line a species is.
 *
 * A species whose chain has only one member (Tauros, most legendaries) has
 * nowhere to evolve to, so it counts as final rather than as a baby.
 */
function evolutionTier(species) {
  const evolution = species.evolution || {};
  const chain = evolution.chain || [];
  const length = chain.reduce((longest, link) => Math.max(longest, link.stage || 1), 1);
  const stage = evolution.stage || 1;

  if (stage >= length) return 'final';
  if (stage === 1) return 'unevolved';
  return 'middle';
}

/**
 * The lowest level named by a set of evolution conditions, or null.
 *
 * Only conditions with a minLevel count; friendship, stat checks, stones and
 * trades say nothing about level. If a species can be reached both by level
 * and another way (Sandslash), the level is used.
 */
function evolutionLevel(conditions) {
  const levels = (conditions || [])
    .map((condition) => condition.minLevel)
    .filter((level) => typeof level === 'number' && level > 0);

  return levels.length ? Math.min(...levels) : null;
}

/**
 * The wild level range for a species, derived from its evolution line.
 *
 *   min   the level it evolves into this species (Flygon: 45)
 *   max   one below the level it evolves out (Trapinch: 34)
 *
 * Bounds propagate along the whole chain. Azurill evolves by friendship, but
 * Marill caps at 17, so Azurill inherits that ceiling. Likewise Crobat
 * inherits Golbat's floor of 22. The result never lets a stage out-level the
 * stage it evolves into.
 *
 * If no level appears anywhere in the line, the range is 1 to the cap.
 *
 * Legendaries, mythicals and Ultra Beasts are marked `flat` and roll evenly
 * (see rates.js).
 *
 * @returns {{ min: number, max: number, flat: boolean }}
 */
function wildLevelRange(species) {
  const { cap, legendary } = rates.wildLevels;
  const rarity = species.rarity || {};

  if (rarity.isLegendary || rarity.isMythical || rarity.isUltraBeast) {
    return {
      min: Math.min(legendary[0], cap),
      max: Math.min(legendary[1], cap),
      flat: true,
    };
  }

  // Each species record includes its whole chain, and each link's conditions
  // describe how to evolve into it.
  const chain = (species.evolution || {}).chain || [];
  const byName = new Map(chain.map((link) => [link.name, link]));

  const childrenOf = (name) => chain.filter((link) => link.evolvesFrom === name);
  const gateInto = (link) => (link ? evolutionLevel(link.conditions) : null);

  /**
   * The highest a stage can be: one below whatever it turns into, or - when
   * that transition names no level - as high as that stage itself may go.
   */
  const ceilingOf = (name, seen = new Set()) => {
    if (seen.has(name)) return cap;
    seen.add(name);

    let ceiling = cap;
    for (const child of childrenOf(name)) {
      const gate = gateInto(child);
      const inherited = ceilingOf(child.name, seen);
      ceiling = Math.min(ceiling, gate === null ? inherited : Math.min(gate - 1, inherited));
    }

    return ceiling;
  };

  /** The lowest: its own arrival level, or its predecessor's floor. */
  const floorOf = (name, seen = new Set()) => {
    if (seen.has(name)) return 1;
    seen.add(name);

    const link = byName.get(name);
    const gate = gateInto(link);
    const parent = link && link.evolvesFrom ? floorOf(link.evolvesFrom, seen) : 1;

    return Math.max(gate === null ? 1 : gate, parent);
  };

  const min = Math.min(floorOf(species.name), cap);
  const max = Math.min(ceilingOf(species.name), cap);

  // Guard against an inverted range.
  return { min, max: Math.max(min, max), flat: false };
}

/**
 * Roll the level a wild Pokemon of this species shows up at.
 *
 * Weighted toward the bottom of the band (see rates.wildLevels.falloff).
 * Legendaries roll flat.
 */
function rollLevel(species) {
  const { min, max, flat } = wildLevelRange(species);
  const span = max - min;

  if (span <= 0) return min;

  const falloff = flat ? 0 : Number(rates.wildLevels.falloff) || 0;
  if (falloff <= 0) return min + Math.floor(Math.random() * (span + 1));

  const weightAt = (offset) => 2 ** ((-falloff * offset) / span);

  let total = 0;
  for (let offset = 0; offset <= span; offset += 1) total += weightAt(offset);

  let roll = Math.random() * total;
  for (let offset = 0; offset <= span; offset += 1) {
    roll -= weightAt(offset);
    if (roll < 0) return min + offset;
  }

  return max;
}

// ---------------------------------------------------------------------------
// Rolling a Pokemon
// ---------------------------------------------------------------------------

const randomInt = (max) => Math.floor(Math.random() * (max + 1));
const pickRandom = (list) => list[Math.floor(Math.random() * list.length)];

/** Roll six independent IVs, 0-31 each. */
function rollIvs() {
  const ivs = {};
  for (const stat of STATS) ivs[stat] = randomInt(MAX_IV);
  return ivs;
}

function zeroEvs() {
  const evs = {};
  for (const stat of STATS) evs[stat] = 0;
  return evs;
}

/**
 * Pick an ability. Hidden abilities are rare, as in the games.
 */
function rollAbility(form) {
  const abilities = form.abilities || [];
  if (!abilities.length) return null;

  const hidden = abilities.filter((a) => a.isHidden);
  const ordinary = abilities.filter((a) => !a.isHidden);

  if (hidden.length && Math.random() * 100 < rates.hiddenAbilityPercent) {
    return pickRandom(hidden);
  }

  return pickRandom(ordinary.length ? ordinary : abilities);
}

/**
 * The Gen 3+ stat formulas.
 *
 * HP gets its own formula and its own +level+10; every other stat is the
 * shared formula with the nature multiplier applied last.
 */
function calculateStats({ base, ivs, evs, level, nature, speciesId }) {
  const stats = {};

  for (const stat of STATS) {
    const baseValue = base[stat] || 0;
    const core = Math.floor(((2 * baseValue + ivs[stat] + Math.floor(evs[stat] / 4)) * level) / 100);

    if (stat === 'hp') {
      stats.hp = speciesId === SHEDINJA_ID ? 1 : core + level + 10;
      continue;
    }

    stats[stat] = Math.floor((core + 5) * natureMultiplier(nature, stat));
  }

  return stats;
}

/**
 * Build a complete Pokemon from a species and one of its forms.
 *
 * `species` is a Data/Pokemon/<id>/info.json and `form` a .../<Form>/data.json.
 * Pass overrides to fix specific values.
 */
function createPokemon(species, form, overrides = {}) {
  const level = overrides.level ?? rollLevel(species);
  const ivs = overrides.ivs ?? rollIvs();
  const evs = overrides.evs ?? zeroEvs();
  const nature = overrides.nature ?? pickRandom(loadNatures());
  const ability = overrides.ability ?? rollAbility(form);

  const base = form.stats.base;
  const stats = calculateStats({ base, ivs, evs, level, nature, speciesId: species.id });

  return {
    speciesId: species.id,
    speciesName: species.name,
    displayName: form.displayName,
    formFolder: form.folder,
    formSlug: form.slug,

    level,
    experience: experienceForLevel((species.breeding || {}).growthRate, level),
    growthRate: (species.breeding || {}).growthRate || 'medium',

    nature,
    ability,
    ivs,
    evs,
    stats,
    ivTotal: STATS.reduce((sum, stat) => sum + ivs[stat], 0),

    bst: form.stats.total,
    types: form.types,
    region: form.region || species.region || null,
  };
}

/** IV total as a percentage of a perfect 186. */
function ivPercent(ivTotal) {
  return Math.round((ivTotal / (MAX_IV * STATS.length)) * 1000) / 10;
}

// ---------------------------------------------------------------------------
// Working from stored rows
// ---------------------------------------------------------------------------

/**
 * Parsed species and form files, kept in memory once read.
 *
 * Species files are small (under 4 MB total) and cached. Form files are much
 * larger (about 93 MB total, mostly move lists), so only the ones requested
 * are cached.
 */
const speciesCache = new Map();
const formCache = new Map();

/** Drop the caches. Call after re-importing. */
function reloadData() {
  speciesCache.clear();
  formCache.clear();
  naturesCache = null;
}

/** Load a form's data.json from Data/Pokemon. */
function loadForm(speciesId, formFolder) {
  const key = `${speciesId}/${formFolder}`;
  if (formCache.has(key)) return formCache.get(key);

  const file = path.join(DATA_DIR, 'Pokemon', String(speciesId), formFolder, 'data.json');
  const value = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;

  formCache.set(key, value);
  return value;
}

/** Load a species' info.json from Data/Pokemon. */
function loadSpecies(speciesId) {
  if (speciesCache.has(speciesId)) return speciesCache.get(speciesId);

  const file = path.join(DATA_DIR, 'Pokemon', String(speciesId), 'info.json');
  const value = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;

  speciesCache.set(speciesId, value);
  return value;
}

/**
 * Recompute a stored Pokemon's six stats.
 *
 * Must be called after any change to level, EVs or form, since stats are
 * stored (for sorting in SQL).
 *
 * Takes and returns the flat snake_case shape of a `pokemon` row.
 */
function recalculateStats(row, overrides = {}) {
  const speciesId = overrides.species_id ?? row.species_id;
  const formFolder = overrides.form_folder ?? row.form_folder;

  const form = loadForm(speciesId, formFolder);
  if (!form) throw new Error(`No data for species ${speciesId} form "${formFolder}".`);

  const level = overrides.level ?? row.level;
  const nature = loadNatures().find((n) => n.name === (overrides.nature ?? row.nature)) || null;

  const ivs = {};
  const evs = {};
  for (const stat of STATS) {
    const column = stat.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
    ivs[stat] = overrides[`iv_${column}`] ?? row[`iv_${column}`];
    evs[stat] = overrides[`ev_${column}`] ?? row[`ev_${column}`];
  }

  const stats = calculateStats({ base: form.stats.base, ivs, evs, level, nature, speciesId });

  return {
    stat_hp: stats.hp,
    stat_attack: stats.attack,
    stat_defense: stats.defense,
    stat_special_attack: stats.specialAttack,
    stat_special_defense: stats.specialDefense,
    stat_speed: stats.speed,
    bst: form.stats.total,

    // These belong to the form, so they are rewritten whenever the form
    // changes (evolving, Mega Evolving or reverting).
    types: form.types.join(','),
    region: form.region || null,
    form_slug: form.slug,

    // The display name depends on the form too. Nicknames are a separate
    // column and are not affected.
    display_name: form.displayName,
  };
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * Reduce a name to bare letters and digits so guessing is forgiving.
 *
 * Accents are stripped (Flabebe), then the gender symbols become the letters
 * the data uses, then everything else goes. That collapses "Ho-Oh", "ho oh",
 * "Mr. Mime", "Farfetch'd" and "Nidoran (female)" onto the stored slugs.
 */
function normaliseName(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/♀/g, 'f')
    .replace(/♂/g, 'm')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * The species keys a typed guess could mean.
 *
 * Usually one. Bare "nidoran" matches both Nidoran species; only one can be
 * the current drop, so this is never ambiguous.
 */
function nameCandidates(text) {
  const key = normaliseName(text);
  if (!key) return [];
  if (key === 'nidoran') return ['nidoran', 'nidoranf', 'nidoranm'];
  return [key];
}

module.exports = {
  STATS,
  MAX_IV,
  MAX_LEVEL,
  loadNatures,
  natureMultiplier,
  experienceForLevel,
  evolutionTier,
  evolutionLevel,
  wildLevelRange,
  rollLevel,
  rollIvs,
  zeroEvs,
  rollAbility,
  calculateStats,
  reloadData,
  loadForm,
  loadSpecies,
  recalculateStats,
  normaliseName,
  nameCandidates,
  createPokemon,
  ivPercent,
};

// `node Utils/pokemon.js [name-or-dex]` - generate one and print the numbers.
if (require.main === module) {
  const query = (process.argv[2] || 'pikachu').toLowerCase();
  const index = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'Pokemon', 'index.json'), 'utf8'));

  const entry =
    index.species.find((s) => s.name === query) ||
    index.species.find((s) => String(s.id) === query);

  if (!entry) {
    console.error(`No species called "${query}".`);
    process.exit(1);
  }

  const speciesDir = path.join(DATA_DIR, 'Pokemon', entry.folder);
  const species = JSON.parse(fs.readFileSync(path.join(speciesDir, 'info.json'), 'utf8'));
  const formFolder = species.forms.find((f) => f.percentage > 0) || species.forms[0];
  const form = JSON.parse(
    fs.readFileSync(path.join(speciesDir, formFolder.folder, 'data.json'), 'utf8')
  );

  const mon = createPokemon(species, form);

  console.log(`${mon.displayName}  Lv.${mon.level}  (${evolutionTier(species)})`);
  console.log(`nature   ${mon.nature.displayName}`);
  console.log(`ability  ${mon.ability ? mon.ability.displayName : 'none'}`);
  console.log(`exp      ${mon.experience} (${mon.growthRate})`);
  console.log(`IVs      ${mon.ivTotal}/186  (${ivPercent(mon.ivTotal)}%)`);
  console.log('');
  for (const stat of STATS) {
    const arrow =
      mon.nature.increased === stat ? '+' : mon.nature.decreased === stat ? '-' : ' ';
    console.log(
      `  ${arrow} ${stat.padEnd(15)} base ${String(form.stats.base[stat]).padStart(3)}` +
        `  iv ${String(mon.ivs[stat]).padStart(2)}  ->  ${mon.stats[stat]}`
    );
  }
}
