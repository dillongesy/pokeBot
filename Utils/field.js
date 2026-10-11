'use strict';

/**
 * The weather, and everything else a move can do that is not damage.
 *
 * Weather, Protect, trapping moves, Leech Seed and Substitute.
 *
 * Pure: this module defines the rules (duration, boosts, chip damage, whether
 * Protect holds); Utils/battle.js owns the state and emits the events.
 *
 * Two kinds of state:
 *
 *   field       weather, on `state.field`. One per battle, persists through
 *               switches and counts down on its own.
 *   volatiles   Protect, trapped, seeded, Substitute. Stored on the
 *               combatant and cleared when it leaves the field (which is why
 *               switching out escapes Wrap).
 */

// ---------------------------------------------------------------------------
// Weather
// ---------------------------------------------------------------------------

/**
 * The five weathers, and what each one actually does.
 *
 * `chip` is the fraction of max HP lost at the end of each turn by anything
 * not in `immune`.
 *
 * Snow replaced Hail in Gen 9 (no chip damage, boosts Ice-type Defence). Both
 * are here because both appear in the move data.
 */
const WEATHER = {
  rain: {
    name: 'Rain',
    started: 'It started to rain!',
    ongoing: 'Rain continues to fall.',
    ended: 'The rain stopped.',
    boosts: { water: 1.5, fire: 0.5 },
  },

  sun: {
    name: 'Harsh sunlight',
    started: 'The sunlight turned harsh!',
    ongoing: 'The sunlight is strong.',
    ended: 'The sunlight faded.',
    boosts: { fire: 1.5, water: 0.5 },
  },

  sandstorm: {
    name: 'Sandstorm',
    started: 'A sandstorm kicked up!',
    ongoing: 'The sandstorm rages.',
    ended: 'The sandstorm subsided.',
    chip: 1 / 16,
    immune: ['rock', 'ground', 'steel'],
    // Sandstorm raises Rock-types' Special Defence by half.
    specialDefenceFor: { rock: 1.5 },
  },

  hail: {
    name: 'Hail',
    started: 'It started to hail!',
    ongoing: 'The hail crashes down.',
    ended: 'The hail stopped.',
    chip: 1 / 16,
    immune: ['ice'],
  },

  snow: {
    name: 'Snow',
    started: 'It started to snow!',
    ongoing: 'The snow keeps falling.',
    ended: 'The snow stopped.',
    // Gen 9 snow: no chip damage, boosts Ice-type Defence.
    defenceFor: { ice: 1.5 },
  },
};

/** Which move starts which weather. */
const WEATHER_MOVES = {
  'rain-dance': 'rain',
  'sunny-day': 'sun',
  sandstorm: 'sandstorm',
  hail: 'hail',
  snowscape: 'snow',
  'chilly-reception': 'snow',
};

/** How long weather lasts when a move sets it. Eight with the matching rock. */
const WEATHER_TURNS = 5;
const EXTENDED_WEATHER_TURNS = 8;

/** The four rocks, each extending its own weather. */
const WEATHER_ROCKS = {
  'damp-rock': 'rain',
  'heat-rock': 'sun',
  'smooth-rock': 'sandstorm',
  'icy-rock': 'hail',
};

/** Does this move set the weather, and to what? */
const weatherFor = (move) => (move ? WEATHER_MOVES[move.name] || null : null);

/** How long it should last for this user, given what it is holding. */
function weatherDuration(kind, holder) {
  const rock = holder && holder.item ? WEATHER_ROCKS[holder.item] : null;
  return rock === kind ? EXTENDED_WEATHER_TURNS : WEATHER_TURNS;
}

/** The current weather's rules, or null when the sky is clear. */
const weatherRules = (field) => (field && field.weather ? WEATHER[field.weather] || null : null);

/**
 * What the weather does to a move's damage.
 *
 * Rain boosts Water and weakens Fire; sun does the reverse. Applied as an
 * entry in Utils/damage.js's extraModifiers.
 */
function weatherDamageMultiplier(field, move) {
  const rules = weatherRules(field);
  if (!rules || !rules.boosts || !move) return 1;

  return rules.boosts[String(move.type || '').toLowerCase()] || 1;
}

/** Sandstorm's Special Defence bonus for Rock types, and snow's for Ice. */
function weatherDefenceMultiplier(field, defender, move) {
  const rules = weatherRules(field);
  if (!rules || !defender) return 1;

  const types = (defender.types || []).map((type) => String(type).toLowerCase());
  const physical = move && move.damageClass === 'physical';

  const table = physical ? rules.defenceFor : rules.specialDefenceFor;
  if (!table) return 1;

  let multiplier = 1;
  for (const [type, value] of Object.entries(table)) {
    if (types.includes(type)) multiplier = Math.max(multiplier, value);
  }

  return multiplier;
}

/** Does the weather hurt this Pokemon at the end of a turn, and by how much? */
function weatherChip(field, mon) {
  const rules = weatherRules(field);
  if (!rules || !rules.chip || !mon) return 0;

  const types = (mon.types || []).map((type) => String(type).toLowerCase());
  if ((rules.immune || []).some((type) => types.includes(type))) return 0;

  return Math.max(1, Math.floor(mon.maxHp * rules.chip));
}

// ---------------------------------------------------------------------------
// Protect and Detect
// ---------------------------------------------------------------------------

/**
 * The moves that put up a shield for a turn.
 *
 * Each consecutive use is a third as likely to succeed. Using any other move
 * resets the chain.
 */
const PROTECT_MOVES = new Set([
  'protect', 'detect', 'spiky-shield', 'baneful-bunker', 'silk-trap',
  'obstruct', 'burning-bulwark', 'kings-shield', 'max-guard',
]);

const isProtect = (move) => Boolean(move && PROTECT_MOVES.has(move.name));

/**
 * Does a Protect go up?
 *
 * The games' 1/3-per-consecutive-use chain. A first use always works.
 *
 * @param {number} streak  how many turns in a row it has already succeeded
 * @param {number} roll    0-1
 */
function protectSucceeds(streak, roll) {
  const chance = 1 / 3 ** Math.max(0, streak);
  return roll < chance;
}

/**
 * Moves that go through Protect (e.g. Feint). Listed by hand because PokeAPI
 * has no "bypasses protect" flag (see Utils/battleeffects.js).
 */
const BYPASSES_PROTECT = new Set(['feint', 'shadow-force', 'phantom-force', 'hyperspace-hole', 'hyperspace-fury']);

const piercesProtect = (move) => Boolean(move && BYPASSES_PROTECT.has(move.name));

// ---------------------------------------------------------------------------
// Trapping
// ---------------------------------------------------------------------------

/**
 * Wrap, Fire Spin, Sand Tomb and the rest: damage now, then damage every turn
 * for four or five more, and no switching out until it ends.
 *
 * Derived from PokeAPI's `meta.ailment: 'trap'` and its min/max turns.
 */
const TRAP_FRACTION = 1 / 8;

/** The stronger binding a Binding Band turns them into. */
const BINDING_BAND_FRACTION = 1 / 6;

const isTrapping = (move) =>
  Boolean(move && move.meta && move.meta.ailment === 'trap');

/** How many turns a trap holds, from the move's own data. */
function trapTurns(move, roll) {
  const meta = (move && move.meta) || {};
  const min = meta.minTurns || 4;
  const max = meta.maxTurns || 5;
  return min + Math.floor(roll * (max - min + 1));
}

/** What a trap takes at the end of a turn. */
function trapChip(mon, holder) {
  const fraction = holder && holder.item === 'binding-band' ? BINDING_BAND_FRACTION : TRAP_FRACTION;
  return Math.max(1, Math.floor(mon.maxHp * fraction));
}

// ---------------------------------------------------------------------------
// Leech Seed
// ---------------------------------------------------------------------------

const LEECH_FRACTION = 1 / 8;

const isLeechSeed = (move) => Boolean(move && move.name === 'leech-seed');

/** Grass types cannot be seeded. */
const canBeSeeded = (mon) =>
  !(mon.types || []).some((type) => String(type).toLowerCase() === 'grass');

const leechAmount = (mon) => Math.max(1, Math.floor(mon.maxHp * LEECH_FRACTION));

// ---------------------------------------------------------------------------
// Substitute
// ---------------------------------------------------------------------------

const SUBSTITUTE_FRACTION = 1 / 4;

const isSubstitute = (move) => Boolean(move && move.name === 'substitute');

/**
 * What a Substitute costs and what it is worth.
 *
 * Costs a quarter of max HP and fails if the user doesn't have more than that.
 */
function substituteCost(mon) {
  const cost = Math.max(1, Math.floor(mon.maxHp * SUBSTITUTE_FRACTION));
  return mon.hp > cost ? cost : null;
}

/** A Substitute takes damage instead of its owner, and status never lands. */
const behindSubstitute = (mon) => Boolean(mon && mon.substitute > 0);

module.exports = {
  WEATHER,
  WEATHER_MOVES,
  WEATHER_ROCKS,
  WEATHER_TURNS,
  EXTENDED_WEATHER_TURNS,
  PROTECT_MOVES,
  BYPASSES_PROTECT,
  TRAP_FRACTION,
  LEECH_FRACTION,
  SUBSTITUTE_FRACTION,

  weatherFor,
  weatherDuration,
  weatherRules,
  weatherDamageMultiplier,
  weatherDefenceMultiplier,
  weatherChip,

  isProtect,
  protectSucceeds,
  piercesProtect,

  isTrapping,
  trapTurns,
  trapChip,

  isLeechSeed,
  canBeSeeded,
  leechAmount,

  isSubstitute,
  substituteCost,
  behindSubstitute,
};

// `node Utils/field.js` - the weather table, and what each one is worth.
if (require.main === module) {
  const content = require('./content');

  console.log('WEATHER\n');
  console.log('  weather      sets it          lasts  chips        boosts');

  for (const [kind, rules] of Object.entries(WEATHER)) {
    const move = Object.keys(WEATHER_MOVES).find((name) => WEATHER_MOVES[name] === kind) || '-';
    const rock = Object.keys(WEATHER_ROCKS).find((item) => WEATHER_ROCKS[item] === kind);

    const boosts = rules.boosts
      ? Object.entries(rules.boosts).map(([type, value]) => `${type} x${value}`).join(', ')
      : '-';

    console.log(
      `  ${kind.padEnd(12)} ${move.padEnd(16)} ${String(WEATHER_TURNS).padEnd(6)} ` +
      `${(rules.chip ? '1/16 a turn' : '-').padEnd(12)} ${boosts}` +
      (rock ? `\n               (${rock} makes it ${EXTENDED_WEATHER_TURNS})` : '')
    );
  }

  console.log('\n\nEVERY TRAPPING MOVE IN THE DATA (derived, not typed):\n');

  const traps = [];
  for (const entry of content.moves().values()) {
    const move = content.move(entry.name);
    if (isTrapping(move)) traps.push(`${move.displayName} (${move.meta.minTurns}-${move.meta.maxTurns} turns)`);
  }
  console.log('  ' + traps.join('\n  '));

  console.log('\n\nPROTECT, USED OVER AND OVER:\n');
  console.log('  consecutive use   chance it holds');
  for (let streak = 0; streak < 5; streak += 1) {
    console.log(`  ${String(streak + 1).padStart(15)}   ${(100 / 3 ** streak).toFixed(1)}%`);
  }
}
