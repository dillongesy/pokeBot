'use strict';

/**
 * How well one type does against another.
 *
 * Built from Data/Types, where PokeAPI records each attacking type's damage
 * relations (e.g. fire has grass in `doubleDamageTo`).
 *
 * PokeAPI's `unknown`, `shadow` and `stellar` types have no damage relations,
 * so they are neutral against everything.
 *
 * The chart is built once on first use and cached.
 */

const content = require('./content');

/** The multipliers a single matchup can produce. */
const IMMUNE = 0;
const NOT_VERY = 0.5;
const NEUTRAL = 1;
const SUPER = 2;

let chart = null;

/**
 * attacking -> defending -> multiplier.
 *
 * Anything not in the map is 1x, so only non-neutral matchups are stored.
 */
function build() {
  const table = new Map();

  for (const [name] of content.types()) {
    const type = content.type(name);
    const relations = (type && type.damageRelations) || {};
    const row = new Map();

    for (const against of relations.doubleDamageTo || []) row.set(against, SUPER);
    for (const against of relations.halfDamageTo || []) row.set(against, NOT_VERY);
    for (const against of relations.noDamageTo || []) row.set(against, IMMUNE);

    table.set(name, row);
  }

  return table;
}

function table() {
  if (!chart) chart = build();
  return chart;
}

/** One type against one type. Unknown names are neutral rather than a throw. */
function against(attacking, defending) {
  const row = table().get(String(attacking || '').toLowerCase());
  if (!row) return NEUTRAL;

  const found = row.get(String(defending || '').toLowerCase());
  return found === undefined ? NEUTRAL : found;
}

/**
 * One attacking type against a whole Pokemon.
 *
 * Dual-type multipliers are multiplied together, giving 4x, 0.25x or 0x.
 *
 * @param {string} attacking
 * @param {string[]|string} defending  one type, or the array a row stores
 * @returns {number} 0, 0.25, 0.5, 1, 2 or 4
 */
function effectiveness(attacking, defending) {
  const types = Array.isArray(defending)
    ? defending
    : String(defending || '').split(',').map((part) => part.trim()).filter(Boolean);

  return types.reduce((total, type) => total * against(attacking, type), NEUTRAL);
}

/** How a multiplier reads in a battle log. Null when there is nothing to say. */
function describe(multiplier) {
  if (multiplier === 0) return "It doesn't affect the target...";
  if (multiplier >= 4) return "It's super effective!";
  if (multiplier > 1) return "It's super effective!";
  if (multiplier <= 0.25) return "It's not very effective...";
  if (multiplier < 1) return "It's not very effective...";
  return null;
}

/**
 * Same-type attack bonus (STAB): 1.5x if the attacker shares the move's type.
 *
 * @param {string} moveType
 * @param {string[]|string} attackerTypes
 */
function sameTypeBonus(moveType, attackerTypes) {
  const types = Array.isArray(attackerTypes)
    ? attackerTypes
    : String(attackerTypes || '').split(',').map((part) => part.trim()).filter(Boolean);

  return types.some((type) => type.toLowerCase() === String(moveType || '').toLowerCase())
    ? 1.5
    : 1;
}

module.exports = {
  IMMUNE,
  NOT_VERY,
  NEUTRAL,
  SUPER,
  against,
  effectiveness,
  describe,
  sameTypeBonus,
  table,
};

// `node Utils/typechart.js [attacking] [defending...]` - print the chart.
if (require.main === module) {
  const [, , attacking, ...defending] = process.argv;

  if (attacking) {
    if (defending.length) {
      const multiplier = effectiveness(attacking, defending);
      console.log(
        `${attacking} vs ${defending.join('/')}: ${multiplier}x` +
          (describe(multiplier) ? `  "${describe(multiplier)}"` : '')
      );
      process.exit(0);
    }

    console.log(`${attacking} attacking:\n`);
    for (const [name] of content.types()) {
      const multiplier = against(attacking, name);
      if (multiplier !== NEUTRAL) console.log(`  ${String(multiplier).padStart(4)}x  ${name}`);
    }
    process.exit(0);
  }

  // The whole chart as a grid, plus some sanity checks.
  const real = [...content.types().keys()].filter(
    (name) => !['unknown', 'shadow', 'stellar'].includes(name)
  );

  console.log(`${real.length} real types, ${content.types().size} in the data\n`);

  const short = (name) => name.slice(0, 3).padEnd(3);
  console.log('      ' + real.map(short).join(' '));

  for (const attack of real) {
    const cells = real.map((defend) => {
      const value = against(attack, defend);
      if (value === 0) return '  0';
      if (value === 0.5) return ' ½ ';
      if (value === 2) return ' 2 ';
      return '  ·';
    });
    console.log(`${short(attack)}   ${cells.join(' ')}`);
  }

  const immunities = [];
  for (const attack of real) {
    for (const defend of real) {
      if (against(attack, defend) === 0) immunities.push(`${attack} -> ${defend}`);
    }
  }

  console.log(`\n${immunities.length} immunities: ${immunities.join(', ')}`);

  console.log('\nspot checks:');
  for (const [attack, defend, want] of [
    ['fire', ['grass'], 2],
    ['fire', ['water'], 0.5],
    ['ground', ['flying'], 0],
    ['ground', ['steel', 'flying'], 0],
    ['rock', ['fire', 'flying'], 4],
    ['fighting', ['ghost'], 0],
    ['electric', ['ground'], 0],
    ['fire', ['fire', 'water'], 0.25],
    ['normal', ['ghost'], 0],
    ['stellar', ['dragon'], 1],
  ]) {
    const got = effectiveness(attack, defend);
    console.log(
      `  ${got === want ? 'ok  ' : 'FAIL'} ${attack} vs ${defend.join('/')}: ${got}x (want ${want}x)`
    );
    if (got !== want) process.exitCode = 1;
  }
}
