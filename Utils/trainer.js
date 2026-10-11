'use strict';

/**
 * Trainer level, the obedience cap, and prestige.
 *
 * Utils/obedience.js decides which Pokemon obey; this module computes the cap
 * it uses.
 *
 * Progression:
 *
 *   win ordinary .battle fights   -> trainer exp
 *   fill the bar                  -> the next milestone battle unlocks
 *   beat the milestone            -> trainer level +1, cap +1
 *   beat every milestone          -> prestige, and climb again
 *
 * Trainer level never makes a Pokemon stronger; it only raises the cap.
 *
 * Exp keeps accumulating, but the level won't go up until the milestone in
 * front of it is beaten. `pending` flags a full bar waiting on a milestone.
 *
 * Losing costs nothing: no exp, levels or cooldown.
 *
 * Pure: plain numbers in, plain numbers out.
 */

const rates = require('./rates');

const {
  startingCap,
  expPerOpponentLevel,
  levelExpBase,
  benchShare,
  shareRate,
  expUnderFloor,
  expOverFloor,
  expFightUpPower,
} = rates.trainer;

/** Where everybody starts. */
const STARTING_LEVEL = 1;

/**
 * The obedience cap for a trainer level.
 *
 * One level of cap per trainer level, starting from `startingCap` at level 1,
 * so new players can use most early wild Pokemon straight away.
 */
const capFor = (trainerLevel) => startingCap + Math.max(0, (trainerLevel || STARTING_LEVEL) - 1);

/** Exp needed to fill the bar at this level. Linear - see rates.js. */
const expForLevel = (trainerLevel) => levelExpBase * Math.max(1, trainerLevel || STARTING_LEVEL);

/**
 * Trainer exp for beating an opponent of this level.
 *
 * Scales with the opponent's level. Players can't pick weak opponents to farm,
 * since `.battle` chooses the opponent.
 */
const expForWin = (opponentLevel) => Math.max(1, Math.round(expPerOpponentLevel * (opponentLevel || 1)));

/**
 * A trainer's full progress state, from their stored row. Shared by .me,
 * .battle and the milestone gate so they always agree.
 *
 * @param {{trainer_level, trainer_exp, prestige, milestones_cleared}} row
 */
function progress(row = {}) {
  const level = Math.max(STARTING_LEVEL, row.trainer_level || STARTING_LEVEL);
  const exp = Math.max(0, row.trainer_exp || 0);
  const cleared = Math.max(0, row.milestones_cleared || 0);
  const prestige = Math.max(0, row.prestige || 0);

  const needed = expForLevel(level);

  // Each level after 1 requires one milestone, so the maximum reachable level
  // is milestones cleared + 1.
  const allowedLevel = cleared + STARTING_LEVEL;

  const full = exp >= needed;

  return {
    level,
    exp,
    needed,
    remaining: Math.max(0, needed - exp),
    fraction: needed > 0 ? Math.min(1, exp / needed) : 1,

    cap: capFor(level),
    prestige,
    milestonesCleared: cleared,

    /** The bar is full and a milestone is blocking the next level. */
    pending: full && level >= allowedLevel,

    /** The bar is full and nothing is blocking, so a level is due. */
    readyToLevel: full && level < allowedLevel,
  };
}

/**
 * Apply exp and work out whether that produced a level.
 *
 * Pure; Utils/store.js saves the result. Loops because one large award can
 * produce more than one level.
 *
 * @returns {{ level, exp, gained, levelsGained, pending, cap }}
 */
function addExp(row, amount) {
  let level = Math.max(STARTING_LEVEL, row.trainer_level || STARTING_LEVEL);
  let exp = Math.max(0, row.trainer_exp || 0) + Math.max(0, Math.round(amount || 0));

  const cleared = Math.max(0, row.milestones_cleared || 0);
  const allowedLevel = cleared + STARTING_LEVEL;

  let levelsGained = 0;

  // Level up while exp allows, stopping at the next milestone gate.
  while (level < allowedLevel && exp >= expForLevel(level)) {
    exp -= expForLevel(level);
    level += 1;
    levelsGained += 1;
  }

  // At a gate, exp keeps accumulating; progress().fraction clamps the display.
  return {
    level,
    exp,
    gained: Math.max(0, Math.round(amount || 0)),
    levelsGained,
    cap: capFor(level),
    pending: exp >= expForLevel(level) && level >= allowedLevel,
  };
}

// ---------------------------------------------------------------------------
// Pokemon experience
// ---------------------------------------------------------------------------

/**
 * Experience a Pokemon earns for a knockout.
 *
 * Uses the Gen 1-4 formula: base experience times the fainted Pokemon's
 * level, divided by seven (`physical.baseExperience` in Data/Pokemon).
 *
 * Every Pokemon brought is paid, at one of three rates:
 *
 *   'landed'   full - it scored the knockout
 *   'watched'  `benchShare` - it was on the field at some point
 *   'shared'   `shareRate` - it stayed on the bench (Exp. Share)
 *
 * The result is then scaled by the learner's level (see expScale below and
 * the notes in Utils/rates.js).
 *
 * @param {number} baseExperience  the fainted Pokemon's, from its form data
 * @param {number} faintedLevel
 * @param {string|boolean} role  'landed' | 'watched' | 'shared'
 * @param {number|null} learnerLevel  null skips the curve, for callers that
 *                                    want the raw award (the self-check does)
 * @param {number|null} cap  the trainer's obedience cap - what the over-cap
 *                           taper is anchored to. See expScale.
 * @returns {number}
 */
function expForKnockout(baseExperience, faintedLevel, role = 'landed', learnerLevel = null, cap = null) {
  const full = ((baseExperience || 0) * Math.max(1, faintedLevel || 1)) / 7;
  const scale = learnerLevel == null ? 1 : expScale(learnerLevel, faintedLevel, cap);

  // Booleans are also accepted (true = landed, false = watched).
  const share = role === true || role === 'landed' ? 1
    : role === 'shared' ? shareRate
    : benchShare;

  return Math.max(1, Math.floor(full * scale * share));
}

/**
 * How much of a knockout's experience a Pokemon of this level actually gets.
 *
 * Two factors, multiplied:
 *
 *   Below the opponent's level, the learner earns proportionally less, so a
 *   very low-level Pokemon can't jump many levels from one high-level win.
 *
 *   Above the obedience cap, experience tapers to a floor at MAX_OVER_CAP,
 *   so Pokemon stop gaining levels where they would stop obeying.
 *
 * @param {number} learnerLevel
 * @param {number} faintedLevel
 * @returns {number} between the two floors and 1
 */
function expScale(learnerLevel, faintedLevel, cap = null) {
  const { MAX_OVER_CAP } = require('./obedience');

  const learner = Math.max(1, learnerLevel || 1);
  const fainted = Math.max(1, faintedLevel || 1);

  // Factor 1: learner level vs. opponent level.
  //
  // The exponent is below 1 on purpose. At exactly 1 the opponent's level
  // would cancel out (the base award is proportional to it), so beating a
  // stronger opponent would pay no more. With the root, beating something ten
  // levels higher pays about a fifth more.
  const parity = learner <= fainted
    ? Math.max(expUnderFloor, (learner / fainted) ** expFightUpPower)
    : 1;

  // Factor 2: how far the learner is over the obedience cap.
  //
  // Anchored to the cap rather than the opponent, since opponents can be
  // above the cap too. Without a cap (the self-checks), the opponent's level
  // is used.
  const anchor = cap == null ? fainted : Math.max(1, cap);
  const over = Math.max(0, learner - anchor);

  const through = Math.min(1, over / MAX_OVER_CAP);
  const ceiling = Math.max(expOverFloor, 1 - through * (1 - expOverFloor));

  return parity * ceiling;
}

/**
 * Effort values a Pokemon earns for a knockout.
 *
 * The fainted Pokemon's EV yield, awarded in full to every participant.
 * Clamping to 252/510 is done by Utils/items.js.
 *
 * @param {object} effortYield  from form.stats.effortYield
 */
function evsForKnockout(effortYield) {
  return { ...(effortYield || {}) };
}

// ---------------------------------------------------------------------------
// Prestige
// ---------------------------------------------------------------------------

/**
 * Can this trainer prestige?
 *
 * Only after every milestone is cleared. `total` comes from
 * Utils/milestones.js and is passed in to keep this module pure.
 */
const canPrestige = (row, total) => (row.milestones_cleared || 0) >= total && total > 0;

/**
 * What prestiging does to a row.
 *
 * Resets level, exp and cleared milestones, so the cap drops back to
 * `startingCap`. Pokemon, items, coins and quests are kept, but high-level
 * Pokemon will no longer obey, so the climb starts again with new ones.
 */
function prestige(row) {
  return {
    prestige: (row.prestige || 0) + 1,
    trainer_level: STARTING_LEVEL,
    trainer_exp: 0,
    milestones_cleared: 0,
  };
}

module.exports = {
  STARTING_LEVEL,
  capFor,
  expForLevel,
  expForWin,
  progress,
  addExp,
  expForKnockout,
  expScale,
  evsForKnockout,
  canPrestige,
  prestige,
};

// `node Utils/trainer.js` - the whole climb, as a table.
if (require.main === module) {
  console.log(
    `cap at level 1: ${startingCap}   exp per opponent level: ${expPerOpponentLevel}   ` +
      `exp for level n: ${levelExpBase} x n\n`
  );

  console.log('  level   cap   exp to next   exp per win   wins needed');

  let totalExp = 0;
  let totalWins = 0;

  for (let level = 1; level <= 100; level += 1) {
    const needed = expForLevel(level);
    const cap = capFor(level);

    // Opponents are picked near the cap, so use the cap as the opponent level.
    const perWin = expForWin(cap);
    const wins = Math.ceil(needed / perWin);

    totalExp += needed;
    totalWins += wins;

    if (level <= 5 || level % 10 === 0 || level === 100) {
      console.log(
        `  ${String(level).padStart(5)}   ${String(cap).padStart(3)}   ` +
          `${String(needed).padStart(11)}   ${String(perWin).padStart(11)}   ` +
          `${String(wins).padStart(11)}`
      );
    }
  }

  console.log(
    `\nthe whole climb: ${totalExp.toLocaleString()} exp, ` +
      `about ${totalWins.toLocaleString()} wins, and 99 milestones`
  );

  console.log('\nknockout experience, against base 64 (a Rattata is 51, a Blissey 608):');
  for (const level of [5, 20, 50, 100]) {
    console.log(
      `  fainted level ${String(level).padStart(3)}   ` +
        `knockout ${String(expForKnockout(64, level, true)).padStart(5)}   ` +
        `bench ${String(expForKnockout(64, level, false)).padStart(5)}`
    );
  }
}
