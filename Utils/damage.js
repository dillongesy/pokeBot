'use strict';

/**
 * How much a move takes off.
 *
 * The games' damage formula (Generation 5 onward). Pure: randomness is passed
 * in, so the same inputs always give the same result and battles can be
 * replayed from a seed.
 *
 * The formula:
 *
 *   base   = floor(floor(floor(2 x level / 5 + 2) x power x A / D) / 50) + 2
 *   damage = base x crit x random x STAB x type x burn
 *
 * The games truncate at each of the three floors, so this does too.
 *
 * Abilities and held items apply at four different points, matching the
 * games (because of the floors, the position changes the result):
 *
 *   attackModifiers   multiply the attack stat, before the division.
 *                     Huge Power, Choice Band, Guts, Light Ball, Thick Club.
 *   defenceModifiers  multiply the defence stat, before the division.
 *                     Eviolite, Assault Vest, Fur Coat, Marvel Scale.
 *   stabMultiplier    replaces the 1.5x same-type bonus (Adaptability).
 *   extraModifiers    everything else, multiplied at the end. Life Orb,
 *                     Blaze, Thick Fat, Filter, Expert Belt, type-boosting
 *                     items.
 *
 * Utils/battleeffects.js sorts each effect into the right bucket, and weather
 * from Utils/field.js is added to the same arrays. Terrain, screens and
 * spread-move reduction are not modelled.
 */

const typechart = require('./typechart');

/** The damage roll, as the games do it: 85% to 100%, in whole percent. */
const MIN_ROLL = 0.85;
const MAX_ROLL = 1.0;

/** What a critical hit multiplies by. 2x before Gen 6, 1.5x since. */
const CRIT_MULTIPLIER = 1.5;

/**
 * Chance of a critical hit, by crit stage.
 *
 * Generation 7 onward. A move's own stage comes from `meta.critRate` - Slash
 * and Razor Leaf are stage 1, Frost Breath and Storm Throw always crit.
 */
const CRIT_CHANCE = [1 / 24, 1 / 8, 1 / 2, 1];

/** Burn halves physical damage. */
const BURN_MULTIPLIER = 0.5;

/**
 * What a stat stage is worth.
 *
 * As in the games: +1 is 3/2, +2 is 4/2, -1 is 2/3. Clamped to -6..+6.
 */
function stageMultiplier(stage) {
  const clamped = Math.max(-6, Math.min(6, Math.round(stage || 0)));
  return clamped >= 0 ? (2 + clamped) / 2 : 2 / (2 - clamped);
}

/**
 * Does the move land?
 *
 * `accuracy: null` (Swift, Aerial Ace) means the move never misses.
 *
 * @param {object} move   from Data/Moves
 * @param {number} roll   0 to 1
 * @param {number} accuracyStage / evasionStage  the games' -6..+6
 * @param {number} extra  Compound Eyes and Hustle, multiplied in
 */
function hits(move, roll, accuracyStage = 0, evasionStage = 0, extra = 1) {
  if (!move || move.accuracy === null || move.accuracy === undefined) return true;

  // Accuracy and evasion combine into a single stage.
  const net = Math.max(-6, Math.min(6, (accuracyStage || 0) - (evasionStage || 0)));
  const modifier = net >= 0 ? (3 + net) / 3 : 3 / (3 - net);

  return roll < Math.min(1, (move.accuracy / 100) * modifier * (extra || 1));
}

/** Did it crit? `roll` is 0 to 1. */
function crits(move, roll, extraStage = 0) {
  const stage = Math.max(0, Math.min(3, (move && move.meta && move.meta.critRate) || 0) + extraStage);
  return roll < CRIT_CHANCE[Math.min(3, stage)];
}

/**
 * The 0.85-1.00 spread, quantised to the 16 values the games actually roll.
 *
 * The games pick one of sixteen discrete values rather than a continuous one.
 */
const damageRoll = (roll) => (85 + Math.floor(Math.max(0, Math.min(0.9999, roll)) * 16)) / 100;

/** Multiply a list of modifiers together. An empty list is 1, not 0. */
const multiplyAll = (values) => (values || []).reduce((total, value) => total * value, 1);

/**
 * Work out the damage one move does.
 *
 * @param {object}   options
 * @param {object}   options.attacker  { level, types, stats:{attack,specialAttack}, stages, status }
 * @param {object}   options.defender  { types, stats:{defense,specialDefense}, stages }
 * @param {object}   options.move      a Data/Moves record
 * @param {number}   options.roll      0-1, for the 85-100% spread
 * @param {boolean}  options.critical
 * @param {number[]} options.attackModifiers   multiply the attack stat
 * @param {number[]} options.defenceModifiers  multiply the defence stat
 * @param {number}   options.stabMultiplier    replaces the same-type bonus
 * @param {boolean}  options.ignoreBurn        Guts, and Facade under a status
 * @param {number}   options.critMultiplier    Sniper makes a crit hit harder
 * @param {number[]} options.extraModifiers    anything else, multiplied in
 * @param {number}   options.power   overrides move.power - see Utils/movepower.js
 * @param {string}   options.type    overrides move.type, for Natural Gift
 *
 * @returns {{damage, effectiveness, stab, critical, immune}}
 */
function calculate({
  attacker,
  defender,
  move,
  roll = 0.5,
  critical = false,
  extraModifiers = [],
  attackModifiers = [],
  defenceModifiers = [],
  stabMultiplier = null,
  ignoreBurn = false,
  critMultiplier = 1,
  power = null,
  type = null,
  effectiveness: effectivenessOverride = null,
}) {
  // Some damaging moves have no power in the data (Seismic Toss, Low Kick,
  // Flail, Gyro Ball). Utils/movepower.js calculates it and passes it in.
  const usedPower = power || move.power;
  const usedType = type || move.type;

  // The caller can pass effectiveness worked out with battle conditions
  // (Foresight, Miracle Eye, Gravity; see Utils/conditions.js).
  const effectiveness = effectivenessOverride != null
    ? effectivenessOverride
    : typechart.effectiveness(usedType, defender.types);

  // Status moves and immunities do nothing. Return early so the formula's +2
  // can't turn an immunity into damage.
  if (!usedPower || move.damageClass === 'status' || effectiveness === 0) {
    return {
      damage: 0,
      effectiveness,
      stab: 1,
      critical: false,
      immune: effectiveness === 0 && Boolean(usedPower),
    };
  }

  const physical = move.damageClass === 'physical';

  const attackStat = physical ? attacker.stats.attack : attacker.stats.specialAttack;
  const defenceStat = physical ? defender.stats.defense : defender.stats.specialDefense;

  const attackStage = (attacker.stages || {})[physical ? 'attack' : 'specialAttack'] || 0;
  const defenceStage = (defender.stages || {})[physical ? 'defense' : 'specialDefense'] || 0;

  // A critical hit ignores stages that favour the defender: their defence
  // boosts and the attacker's attack drops.
  const usedAttackStage = critical ? Math.max(0, attackStage) : attackStage;
  const usedDefenceStage = critical ? Math.min(0, defenceStage) : defenceStage;

  // Stat modifiers apply to the stat itself, before the division.
  const attack = Math.floor(
    attackStat * stageMultiplier(usedAttackStage) * multiplyAll(attackModifiers)
  );
  const defence = Math.max(
    1,
    Math.floor(defenceStat * stageMultiplier(usedDefenceStage) * multiplyAll(defenceModifiers))
  );

  const base =
    Math.floor(
      Math.floor(Math.floor((2 * attacker.level) / 5 + 2) * usedPower * attack / defence) / 50
    ) + 2;

  // Adaptability replaces the bonus, and only for same-type moves.
  const natural = typechart.sameTypeBonus(usedType, attacker.types);
  const stab = stabMultiplier !== null && natural > 1 ? stabMultiplier : natural;

  const burn = !ignoreBurn && attacker.status === 'burn' && physical ? BURN_MULTIPLIER : 1;

  let total = base;
  total *= critical ? CRIT_MULTIPLIER * (critMultiplier || 1) : 1;
  total *= damageRoll(roll);
  total *= stab;
  total *= effectiveness;
  total *= burn;
  for (const modifier of extraModifiers) total *= modifier;

  return {
    // A hit always does at least 1 damage unless the target is immune.
    damage: Math.max(1, Math.floor(total)),
    effectiveness,
    stab,
    critical,
    immune: false,
  };
}

module.exports = {
  MIN_ROLL,
  MAX_ROLL,
  CRIT_MULTIPLIER,
  CRIT_CHANCE,
  BURN_MULTIPLIER,
  stageMultiplier,
  hits,
  crits,
  damageRoll,
  multiplyAll,
  calculate,
};

// `node Utils/damage.js` - the formula, against a few known matchups.
if (require.main === module) {
  const content = require('./content');

  const mon = (level, types, attack, defense) => ({
    level,
    types,
    stats: { attack, specialAttack: attack, defense, specialDefense: defense },
    stages: {},
    status: null,
  });

  console.log('stat stages:');
  for (const stage of [-6, -3, -1, 0, 1, 2, 6]) {
    console.log(`  ${String(stage).padStart(2)}  x${stageMultiplier(stage).toFixed(3)}`);
  }

  console.log('\nthe damage roll is one of sixteen:');
  const seen = new Set();
  for (let i = 0; i < 1000; i += 1) seen.add(damageRoll(i / 1000));
  console.log(`  ${seen.size} distinct values, ${Math.min(...seen)} to ${Math.max(...seen)}`);

  console.log('\ncrit chance by stage:');
  CRIT_CHANCE.forEach((chance, stage) =>
    console.log(`  stage ${stage}: ${(chance * 100).toFixed(1)}%`)
  );

  console.log('\nFlamethrower, level 50, 120 SpA vs 100 SpD:');
  const flamethrower = content.move('flamethrower');
  const user = mon(50, ['fire'], 120, 100);
  const target = mon(50, ['grass'], 120, 100);

  for (const [label, options] of [
    ['min roll', { roll: 0 }],
    ['max roll', { roll: 0.999 }],
    ['crit', { roll: 0.999, critical: true }],
  ]) {
    const result = calculate({ attacker: user, defender: target, move: flamethrower, ...options });
    console.log(
      `  ${label.padEnd(9)} ${String(result.damage).padStart(4)}  ` +
        `(x${result.effectiveness} type, x${result.stab} STAB)`
    );
  }

  console.log('\nthe same move into different defenders:');
  for (const types of [['grass'], ['water'], ['fire', 'water'], ['grass', 'bug'], ['rock']]) {
    const result = calculate({
      attacker: user,
      defender: mon(50, types, 120, 100),
      move: flamethrower,
      roll: 0.5,
    });
    console.log(
      `  ${types.join('/').padEnd(12)} ${String(result.damage).padStart(4)}  x${result.effectiveness}`
    );
  }

  console.log('\nimmunity and status:');
  const earthquake = content.move('earthquake');
  const immune = calculate({
    attacker: mon(50, ['ground'], 120, 100),
    defender: mon(50, ['flying'], 120, 100),
    move: earthquake,
    roll: 0.5,
  });
  console.log(`  Earthquake into Flying: ${immune.damage} damage, immune=${immune.immune}`);

  const burned = calculate({
    attacker: { ...mon(50, ['normal'], 120, 100), status: 'burn' },
    defender: mon(50, ['normal'], 120, 100),
    move: content.move('body-slam'),
    roll: 0.5,
  });
  const healthy = calculate({
    attacker: mon(50, ['normal'], 120, 100),
    defender: mon(50, ['normal'], 120, 100),
    move: content.move('body-slam'),
    roll: 0.5,
  });
  console.log(`  Body Slam burned: ${burned.damage} vs healthy ${healthy.damage}`);

  console.log('\naccuracy:');
  for (const name of ['swift', 'flamethrower', 'focus-blast', 'sheer-cold']) {
    const move = content.move(name);
    let landed = 0;
    for (let i = 0; i < 10000; i += 1) if (hits(move, i / 10000)) landed += 1;
    console.log(
      `  ${name.padEnd(14)} ${String(move.accuracy === null ? '-' : move.accuracy).padStart(4)}` +
        `   landed ${(landed / 100).toFixed(1)}%`
    );
  }
}
