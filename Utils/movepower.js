'use strict';

/**
 * What a move's power actually is, when the data does not say.
 *
 * PokeAPI records `power: null` for 78 damaging moves whose power depends on
 * the situation (weight, speed, HP, friendship, held item, the target's HP).
 * This module works out their power, or their damage directly.
 *
 * Pure: takes the two combatants and a random function and returns a verdict.
 * Utils/battle.js applies it.
 *
 * The verdict is one of:
 *
 *   { kind: 'normal' }                   use move.power, nothing special
 *   { kind: 'power',  power, type? }     variable power, then the usual formula
 *   { kind: 'fixed',  damage, selfFaint? } skip the formula, deal exactly this
 *   { kind: 'ohko' }                      one-hit knockout rules
 *   { kind: 'heal',   amount }            Present's kinder half
 *   { kind: 'fail',   reason }            the move had nothing to work with
 *
 * Fixed damage skips the formula entirely: no STAB, crits, damage roll or
 * type effectiveness (Seismic Toss at level 50 always does 50). Type
 * immunity still applies and is checked by the caller.
 */

const content = require('./content');

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** The games' friendship default, for anything that has no stored value. */
const DEFAULT_HAPPINESS = 70;

/** Every table below floors at 1. */
const atLeastOne = (value) => Math.max(1, Math.floor(value));

/** Walk a list of [threshold, value] pairs and take the first that fits. */
function banded(value, bands, fallback) {
  for (const [limit, power] of bands) {
    if (value < limit) return power;
  }
  return fallback;
}

/** How heavy something is, in kilograms. Zero is not a legal weight. */
const weightOf = (mon) => Math.max(0.1, (mon && mon.weight) || 1);

/** Current Speed including stages, which is what the two ball moves compare. */
function speedOf(mon, context) {
  if (context && typeof context.speedOf === 'function') return Math.max(1, context.speedOf(mon));
  return Math.max(1, (mon.stats && mon.stats.speed) || 1);
}

/** Friendship, 0-255. */
const happinessOf = (mon) =>
  Math.max(0, Math.min(255, mon && mon.happiness != null ? mon.happiness : DEFAULT_HAPPINESS));

/** How many stat stages a Pokemon has raised (for Punishment). */
const raisedStages = (mon) =>
  Object.values((mon && mon.stages) || {}).filter((stage) => stage > 0).reduce((t, s) => t + s, 0);

// ---------------------------------------------------------------------------
// The tables
// ---------------------------------------------------------------------------

/**
 * Weight in kilograms to power. Low Kick and Grass Knot share it exactly.
 *
 * As in the games: under 10kg is 20 power, 200kg or more is 120.
 */
const byTargetWeight = (_attacker, defender) =>
  banded(weightOf(defender), [[10, 20], [25, 40], [50, 60], [100, 80], [200, 100]], 120);

/**
 * Heavy Slam and Heat Crash: based on how many times heavier the user is.
 * Five times or more is 120.
 */
function byWeightRatio(attacker, defender) {
  const ratio = weightOf(attacker) / weightOf(defender);
  if (ratio >= 5) return 120;
  if (ratio >= 4) return 100;
  if (ratio >= 3) return 80;
  if (ratio >= 2) return 60;
  return 40;
}

/** Gyro Ball: 25 x target speed / user speed, capped at 150. */
function gyroBall(attacker, defender, context) {
  const mine = speedOf(attacker, context);
  const theirs = speedOf(defender, context);
  return Math.max(1, Math.min(150, Math.floor((25 * theirs) / mine) + 1));
}

/** Electro Ball: five steps based on user speed / target speed. */
function electroBall(attacker, defender, context) {
  const ratio = speedOf(attacker, context) / speedOf(defender, context);
  if (ratio >= 4) return 150;
  if (ratio >= 3) return 120;
  if (ratio >= 2) return 80;
  if (ratio > 1) return 60;
  return 40;
}

/**
 * Flail and Reversal: stronger at lower HP, up to 200. Bands are in 48ths of
 * max HP, as in the games.
 */
function byLowHealth(attacker) {
  const fraction = Math.floor((48 * attacker.hp) / Math.max(1, attacker.maxHp));
  return banded(fraction, [[2, 200], [5, 150], [10, 100], [17, 80], [33, 40]], 20);
}

/** Wring Out and Crush Grip: stronger against a healthy target. */
const byTargetHealth = (max) => (_attacker, defender) =>
  atLeastOne((max * defender.hp) / Math.max(1, defender.maxHp));

/** Return climbs with friendship; Frustration climbs as it falls. Both cap 102. */
const byFriendship = (invert) => (attacker) => {
  const happiness = invert ? 255 - happinessOf(attacker) : happinessOf(attacker);
  return Math.max(1, Math.min(102, Math.floor((happiness * 2) / 5)));
};

/**
 * Magnitude rolls its strength, using the games' distribution. The magnitude
 * number is returned for the battle log.
 */
const MAGNITUDES = [
  [4, 10, 5],
  [5, 30, 10],
  [6, 50, 20],
  [7, 70, 30],
  [8, 90, 20],
  [9, 110, 10],
  [10, 150, 5],
];

function magnitude(rng) {
  let roll = rng() * 100;
  for (const [number, power, weight] of MAGNITUDES) {
    roll -= weight;
    if (roll < 0) return { power, magnitude: number };
  }
  return { power: 70, magnitude: 7 };
}

/**
 * Trump Card gets stronger as its PP runs out. PP has already been deducted,
 * so `entry.pp` is what remains after this use.
 */
function trumpCard(entry) {
  const left = entry ? entry.pp : 4;
  return banded(left, [[1, 200], [2, 80], [3, 60], [4, 50]], 40);
}

/**
 * Present usually deals damage but sometimes heals the target.
 */
function present(rng) {
  const roll = rng() * 100;
  if (roll < 40) return { kind: 'power', power: 40 };
  if (roll < 70) return { kind: 'power', power: 80 };
  if (roll < 80) return { kind: 'power', power: 120 };
  return { kind: 'heal', amount: 'quarter' };
}

/**
 * Natural Gift reads the held berry and becomes that berry's type and power.
 *
 * Uses the berry's naturalGiftType and naturalGiftPower from PokeAPI. Berries
 * are indexed by bare name ("cheri"), so the "-berry" suffix is trimmed.
 */
function naturalGift(attacker) {
  if (!attacker.item) return { kind: 'fail', reason: 'no-berry' };

  const berry = content.berry(String(attacker.item).replace(/-berry$/, ''));
  if (!berry || !berry.naturalGiftPower) return { kind: 'fail', reason: 'no-berry' };

  return {
    kind: 'power',
    power: berry.naturalGiftPower,
    type: berry.naturalGiftType || null,
    consumesItem: true,
  };
}

/**
 * Fling throws the held item, and how much it hurts is a property of the item.
 *
 * Uses importedItem rather than item, since shop definitions don't include
 * fling power.
 */
function fling(attacker) {
  if (!attacker.item) return { kind: 'fail', reason: 'no-item' };

  const item = content.importedItem(String(attacker.item));
  if (!item || !item.flingPower) return { kind: 'fail', reason: 'no-item' };

  return { kind: 'power', power: item.flingPower, consumesItem: true };
}

/**
 * Beat Up hits once for every conscious Pokemon on the user's side, and each
 * strike uses that Pokemon's base Attack rather than the user's.
 *
 * Returns one power per hit, which the caller applies in turn.
 */
function beatUp(attacker, context) {
  const team = (context && context.allies) || [attacker];
  const conscious = team.filter((mon) => mon && !mon.fainted);

  if (!conscious.length) return { kind: 'fail', reason: 'nobody' };

  return {
    kind: 'power',
    power: Math.floor(((conscious[0].baseAttack || 50) / 10)) + 5,
    powers: conscious.map((mon) => Math.floor((mon.baseAttack || 50) / 10) + 5),
  };
}

/** Spit Up uses all Stockpile charges; fails with none. */
function spitUp(attacker) {
  const stored = attacker.stockpile || 0;
  if (stored <= 0) return { kind: 'fail', reason: 'no-stockpile' };
  return { kind: 'power', power: 100 * stored, spendsStockpile: true };
}

// ---------------------------------------------------------------------------
// Fixed damage
// ---------------------------------------------------------------------------

/**
 * Counter, Mirror Coat and Metal Burst all answer the hit you just took.
 *
 * `damageTakenThisTurn` is cleared each turn, so these only work when the user
 * moves second, as in the games.
 */
const retaliate = (field, multiplier) => (attacker) => {
  const taken = (attacker.damageTakenThisTurn || {})[field] || 0;
  if (taken <= 0) return { kind: 'fail', reason: 'nothing-to-answer' };
  return { kind: 'fixed', damage: atLeastOne(taken * multiplier) };
};

/**
 * Bide's release: twice the damage it stored over its two turns of waiting
 * (Utils/moverules.js handles the waiting).
 */
function bide(attacker) {
  const stored = (attacker.volatiles || {}).bideRelease || 0;
  if (stored <= 0) return { kind: 'fail', reason: 'nothing-to-answer' };
  return { kind: 'fixed', damage: atLeastOne(stored * 2) };
}

/** Endeavor reduces the target's HP to the user's. Fails if the user has more. */
function endeavor(attacker, defender) {
  const gap = defender.hp - attacker.hp;
  if (gap <= 0) return { kind: 'fail', reason: 'higher-health' };
  return { kind: 'fixed', damage: gap };
}

/** Psywave is the user's level, give or take half of it. */
const psywave = (attacker, _defender, rng) =>
  atLeastOne((attacker.level * (Math.floor(rng() * 101) + 50)) / 100);

// ---------------------------------------------------------------------------
// Move table
// ---------------------------------------------------------------------------

/**
 * Every move whose power is not a number in the data.
 *
 * `power` entries return a number that goes through the normal damage
 * formula. `fixed` entries return a verdict directly. Unlisted moves with null
 * power are Z-moves or Shadow moves, which can't be obtained.
 */
const VARIABLE = {
  'low-kick': { nominal: 60, power: byTargetWeight },
  'grass-knot': { nominal: 60, power: byTargetWeight },

  'heavy-slam': { nominal: 60, power: byWeightRatio },
  'heat-crash': { nominal: 60, power: byWeightRatio },

  'gyro-ball': { nominal: 70, power: gyroBall },
  'electro-ball': { nominal: 70, power: electroBall },

  flail: { nominal: 70, power: byLowHealth },
  reversal: { nominal: 70, power: byLowHealth },

  'wring-out': { nominal: 90, power: byTargetHealth(120) },
  'crush-grip': { nominal: 90, power: byTargetHealth(120) },
  'hard-press': { nominal: 80, power: byTargetHealth(100) },

  return: { nominal: 90, power: byFriendship(false) },
  'pika-papow': { nominal: 90, power: byFriendship(false) },
  'veevee-volley': { nominal: 90, power: byFriendship(false) },
  frustration: { nominal: 90, power: byFriendship(true) },

  punishment: { nominal: 70, power: (_a, defender) => Math.min(200, 60 + 20 * raisedStages(defender)) },

  'trump-card': { nominal: 60, power: (_a, _d, _rng, context) => trumpCard(context.entry) },

  magnitude: { nominal: 70,
    random: true,
    verdict: (_a, _d, rng) => {
      const rolled = magnitude(rng);
      return { kind: 'power', power: rolled.power, magnitude: rolled.magnitude };
    },
  },

  present: { nominal: 60, random: true, verdict: (_a, _d, rng) => present(rng) },
  'natural-gift': { nominal: 60, verdict: (attacker) => naturalGift(attacker) },
  fling: { nominal: 60, verdict: (attacker) => fling(attacker) },
  'beat-up': { nominal: 60, verdict: (attacker, _d, _rng, context) => beatUp(attacker, context) },
  'spit-up': { nominal: 100, verdict: (attacker) => spitUp(attacker) },

  // ---- fixed damage: the formula never runs ----

  'seismic-toss': { nominal: 70, fixed: (attacker) => attacker.level },
  'night-shade': { nominal: 70, fixed: (attacker) => attacker.level },
  'sonic-boom': { nominal: 25, fixed: () => 20 },
  'dragon-rage': { nominal: 45, fixed: () => 40 },
  psywave: { nominal: 70, random: true, fixed: psywave },

  'super-fang': { nominal: 80, fixed: (_a, defender) => atLeastOne(defender.hp / 2) },
  'natures-madness': { nominal: 80, fixed: (_a, defender) => atLeastOne(defender.hp / 2) },
  'ruination': { nominal: 80, fixed: (_a, defender) => atLeastOne(defender.hp / 2) },
  'guardian-of-alola': { nominal: 100, fixed: (_a, defender) => atLeastOne((defender.hp * 3) / 4) },

  // Final Gambit deals the user's remaining HP as damage, then the user faints.
  'final-gambit': { nominal: 100,
    verdict: (attacker) => ({
      kind: 'fixed',
      damage: Math.max(1, attacker.hp),
      selfFaint: true,
    }),
  },

  endeavor: { nominal: 80, verdict: endeavor },
  counter: { nominal: 70, verdict: retaliate('physical', 2) },
  'mirror-coat': { nominal: 70, verdict: retaliate('special', 2) },
  'metal-burst': { nominal: 70, verdict: retaliate('total', 1.5) },
  comeuppance: { nominal: 70, verdict: retaliate('total', 1.5) },
  bide: { nominal: 70, verdict: bide },
};

/**
 * Two Gen 9 moves are recorded with a power of 1 rather than null.
 *
 * Ruination halves the target's HP and Comeuppance returns 1.5x the damage
 * taken; neither really has a power. They are in the table above, and the
 * lookup runs before move.power so the placeholder 1 is ignored.
 */
const OVERRIDES_DATA_POWER = new Set(['ruination', 'comeuppance']);

/** The four moves that skip damage entirely and just end it. */
const OHKO = new Set(['guillotine', 'horn-drill', 'fissure', 'sheer-cold']);

/**
 * Moves that only work on the turn their user arrives.
 *
 * Fake Out, First Impression and Mat Block. Without this rule Fake Out (+3
 * priority, guaranteed flinch) could lock an opponent forever.
 *
 * "The first turn" means the first turn the Pokemon gets to act after being
 * sent out, tracked by Utils/battle.js as `turnsActive`.
 */
const FIRST_TURN_ONLY = new Set(['fake-out', 'first-impression', 'mat-block']);

/**
 * Moves that fail unless the target is about to attack: it chose a damaging
 * move this turn and has not moved yet (so a faster target, a status move or
 * a switch all make them fail).
 */
const NEEDS_INCOMING_ATTACK = new Set(['sucker-punch', 'thunderclap']);

/** Stockpile and its related moves. */
const STOCKPILE_MAX = 3;

// ---------------------------------------------------------------------------
// What the battle engine calls
// ---------------------------------------------------------------------------

/** Is this a move whose power the data does not know? */
const isVariable = (move) => Boolean(move && VARIABLE[move.name]);

/** Is this a one-hit knockout move? */
const isOhko = (move) => Boolean(move && OHKO.has(move.name));

/**
 * Work out what a move does this time.
 *
 * @param {object} move     a Data/Moves record
 * @param {object} context  { attacker, defender, rng, entry, allies, speedOf }
 * @returns {{kind: string}} see the verdict list at the top of the file
 */
function resolve(move, context = {}) {
  if (!move) return { kind: 'fail', reason: 'no-move' };

  // Checked first, even for status moves. turnsActive is 0 only on the first
  // turn a Pokemon acts.
  if (FIRST_TURN_ONLY.has(move.name) && (context.attacker || {}).turnsActive) {
    return { kind: 'fail', reason: 'not-first-turn' };
  }

  // Sucker Punch and Thunderclap only work against an attack that is still
  // coming: the target must have chosen a damaging move and not used it yet.
  // Only checked when the engine says what the target chose (`foeMove`), so
  // previews and the opponent's move scoring are unaffected.
  if (NEEDS_INCOMING_ATTACK.has(move.name) && 'foeMove' in context) {
    const { foeMove, foeMoved } = context;
    if (foeMoved || !foeMove || foeMove.damageClass === 'status') {
      return { kind: 'fail', reason: 'no-attack-coming' };
    }
  }

  if (move.damageClass === 'status') return { kind: 'normal' };
  if (OHKO.has(move.name)) return { kind: 'ohko' };

  const rule = VARIABLE[move.name];
  if (move.power && !rule) return { kind: 'normal' };

  // A powerless damaging move not in the table (a Z-move or Shadow move).
  // These can't be obtained, but fail explicitly just in case.
  if (!rule) return { kind: 'fail', reason: 'unsupported' };

  const { attacker, defender, rng = Math.random } = context;

  if (rule.verdict) return rule.verdict(attacker, defender, rng, context);
  if (rule.fixed) return { kind: 'fixed', damage: atLeastOne(rule.fixed(attacker, defender, rng, context)) };

  return { kind: 'power', power: Math.max(1, Math.floor(rule.power(attacker, defender, rng, context))) };
}

/**
 * How a move's strength should read on its button.
 *
 * Formula moves show their power, fixed-damage moves the damage they will
 * deal, and one-hit KO moves say so. Calculated against the current opponent.
 *
 * @returns {string|null} null for a status move, which has nothing to say here
 */
function describe(move, context = {}) {
  if (!move) return null;

  // Show that a first-turn-only move can no longer be used.
  if (FIRST_TURN_ONLY.has(move.name) && (context.attacker || {}).turnsActive) return '-';

  if (move.damageClass === 'status') return null;

  const rule = VARIABLE[move.name];
  if (!rule && move.power) return String(move.power);

  // Without both combatants, fall back to the move's own power (or nothing).
  if (!context.attacker || !context.defender) {
    return move.power ? String(move.power) : '?';
  }

  // Use a fixed roll so the label doesn't change between redraws. Random
  // moves are marked instead.
  const verdict = resolve(move, { ...context, rng: () => 0.5 });
  const about = rule && rule.random ? '~' : '';

  switch (verdict.kind) {
    case 'ohko': return 'OHKO';
    case 'power': return about + String(verdict.power);
    case 'fixed': return `${about}${verdict.damage} dmg`;

    // Present heals only a fifth of the time, so show the damage.
    case 'heal': return '~80';

    // Would fail right now (e.g. Fling with no item, Spit Up with no
    // stockpile).
    case 'fail': return '-';

    default: return '?';
  }
}

/**
 * One representative power for a move, with no battle to measure it against.
 *
 * Used outside battle for ranking and display: learnset tie-breaks, TM shop
 * sorting and `.moves`. An estimate; `resolve` and `describe` give the real
 * value in battle.
 *
 * @returns {number|null} null for status moves and the unobtainable Z-moves
 */
function nominalPower(move) {
  if (!move || move.damageClass === 'status') return null;

  // One-hit KO moves have no power; use 120 as a stand-in.
  if (OHKO.has(move.name)) return 120;

  const rule = VARIABLE[move.name];
  if (rule && rule.nominal) return rule.nominal;

  return move.power || null;
}

/** Why a move fizzled, in words a battle log can print. */
function reasonText(reason, name) {
  switch (reason) {
    case 'no-berry': return `${name} has no berry to use.`;
    case 'no-item': return `${name} has nothing to fling.`;
    case 'no-stockpile': return `${name} has not stockpiled anything.`;
    case 'nothing-to-answer': return 'But there was nothing to answer.';
    case 'not-first-turn': return `${name} can only do that the turn it comes in.`;
    case 'higher-health': return 'But it failed.';
    case 'nobody': return 'But there was nobody left to help.';
    default: return 'But it failed.';
  }
}

// ---------------------------------------------------------------------------
// Self-check
// ---------------------------------------------------------------------------

/**
 * `node Utils/movepower.js` - prints every move in the table, resolved
 * against a sample attacker and a Snorlax.
 */
if (require.main === module) {
  const attacker = {
    level: 50,
    hp: 60,
    maxHp: 200,
    weight: 130,
    happiness: 200,
    item: 'cheri-berry',
    baseAttack: 130,
    stockpile: 2,
    stats: { speed: 55 },
    stages: {},
    damageTakenThisTurn: { physical: 40, special: 20, total: 60 },
    damageTakenLastTurn: { physical: 10, special: 0, total: 10 },
  };

  const defender = {
    level: 50,
    hp: 180,
    maxHp: 240,
    weight: 460,
    stats: { speed: 30 },
    stages: { attack: 2 },
  };

  attacker.allies = [attacker, { ...attacker, fainted: false }];

  console.log('A Machamp-ish attacker at 60/200 health, holding a Cheri Berry,');
  console.log('against a Snorlax-ish target at 180/240 and 460kg.\n');

  const rows = [];

  for (const name of [...Object.keys(VARIABLE), ...OHKO].sort()) {
    const move = content.move(name);
    if (!move) {
      rows.push([name, 'NO DATA', '']);
      continue;
    }

    const verdict = resolve(move, {
      attacker,
      defender,
      rng: () => 0.5,
      entry: { pp: 2 },
      allies: attacker.allies,
    });

    const said =
      verdict.kind === 'power' ? `${verdict.power} power`
        : verdict.kind === 'fixed' ? `${verdict.damage} damage${verdict.selfFaint ? ', user faints' : ''}`
        : verdict.kind === 'ohko' ? 'one-hit knockout'
        : verdict.kind === 'heal' ? 'heals the target'
        : `fails - ${verdict.reason}`;

    rows.push([move.displayName, said, describe(move, { attacker, defender, entry: { pp: 2 }, allies: attacker.allies })]);
  }

  for (const [name, said, label] of rows) {
    console.log(`${name.padEnd(20)}${said.padEnd(26)}button: ${label}`);
  }

  const unlisted = [];
  for (const entry of content.moves().values()) {
    const move = content.move(entry.name);
    if (!move || move.damageClass === 'status' || move.power) continue;
    if (VARIABLE[move.name] || OHKO.has(move.name)) continue;
    unlisted.push(move.name);
  }

  console.log(`\n${rows.length} moves handled.`);
  console.log(
    `${unlisted.length} powerless damaging moves are NOT handled - all Z-moves and ` +
    'Shadow moves, which nothing can legally hold.'
  );
}

module.exports = {
  DEFAULT_HAPPINESS,
  STOCKPILE_MAX,
  VARIABLE,
  OHKO,
  FIRST_TURN_ONLY,
  NEEDS_INCOMING_ATTACK,
  MAGNITUDES,
  isVariable,
  isOhko,
  resolve,
  describe,
  nominalPower,
  reasonText,

  // Exported for testing.
  byTargetWeight,
  byWeightRatio,
  gyroBall,
  electroBall,
  byLowHealth,
  byFriendship,
  trumpCard,
  magnitude,
};
