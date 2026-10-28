'use strict';

/**
 * Whether a Pokemon will do what it is told.
 *
 * Trainer level never makes a Pokemon stronger. Instead it sets a level cap
 * that decides which Pokemon obey.
 *
 * The rules:
 *
 *   1. At or below the cap, everything obeys.
 *   2. A Pokemon met above the cap never obeys until the cap rises to its
 *      met level.
 *   3. Nothing obeys more than MAX_OVER_CAP levels over the cap.
 *
 * Examples with a cap of 10:
 *
 *   met at 6, now level 5    obeys      under the cap
 *   met at 6, now level 10   obeys      at the cap
 *   met at 6, now level 15   obeys      5 over, within the limit
 *   met at 6, now level 16   refuses    6 over
 *   met at 75, now level 75  refuses    met above the cap
 *
 * Rule 2 matters because high-level legendaries can drop for new players;
 * they can be caught but not used until the trainer catches up. Rule 3 keeps
 * milestone battles from being trivialised by a single over-levelled Pokemon.
 *
 * Note: there is intentionally no "must have grown N levels before exceeding
 * the cap" rule. That would create levels a Pokemon can never pass, since it
 * can't battle (and so can't gain levels) while disobeying. Because rule 2
 * guarantees met <= cap, growth is always at least the overshoot, so rule 3
 * alone is sufficient.
 *
 * Pure: takes a row and a cap and returns a verdict, with no database access.
 */

/**
 * The most levels any Pokemon may be over the cap and still obey.
 *
 * Utils/trainer.js tapers experience as a Pokemon nears this limit, and
 * store.awardKnockout stops it there, so battling never levels a Pokemon past
 * the point where it would stop obeying. Only a Rare Candy can.
 */
const MAX_OVER_CAP = 5;

/** The rule, as one sentence, for anywhere that has to explain itself. */
const RULE_SUMMARY =
  'A Pokemon caught above your cap never obeys, and nothing obeys more than ' +
  `${MAX_OVER_CAP} levels over it.`;

/** Verdict constants. */
const OBEYS = 'obeys';
const TOO_WILD = 'too-wild'; // met above the cap - rule 2
const UNEARNED = 'unearned'; // never returned; see the note at the top of this file
const TOO_STRONG = 'too-strong'; // more than MAX_OVER_CAP over the cap - rule 3

/**
 * What level was this Pokemon when its trainer met it?
 *
 * Older records have no met level. For those the current level is used: it
 * is an upper bound on the met level and never favours the player.
 */
const metLevelOf = (row) =>
  row.met_level === null || row.met_level === undefined ? row.level : row.met_level;

/**
 * Will this Pokemon obey a trainer with this level cap?
 *
 * @param {object} row     a pokemon row - needs `level` and `met_level`
 * @param {number} cap     the trainer's level cap, from their badges
 * @returns {{ obeys: boolean, reason: string, shortfall: number, grown: number }}
 *          `shortfall` is how many more levels of growth it needs, 0 when it
 *          already obeys or when no amount of growth would help
 */
function check(row, cap) {
  const level = row.level;
  const met = metLevelOf(row);
  const grown = Math.max(0, level - met);

  // Rule 1. Everything at or under the cap obeys.
  if (level <= cap) return { obeys: true, reason: OBEYS, shortfall: 0, grown, ceiling: cap };

  // Rule 2. Met above the cap; only a higher cap fixes this.
  if (met > cap) return { obeys: false, reason: TOO_WILD, shortfall: 0, grown, ceiling: cap };

  // Rule 3. Never further over the cap than MAX_OVER_CAP.
  const ceiling = cap + MAX_OVER_CAP;

  if (level > ceiling) {
    return { obeys: false, reason: TOO_STRONG, shortfall: 0, grown, ceiling };
  }

  return { obeys: true, reason: OBEYS, shortfall: 0, grown, ceiling };
}

/** The short form, for anywhere that only needs a yes or no. */
const obeys = (row, cap) => check(row, cap).obeys;

/**
 * Why it will not listen, in words a player can act on.
 *
 * Each message says what would change the answer.
 */
function explain(row, cap, name = 'It') {
  const verdict = check(row, cap);
  if (verdict.obeys) return null;

  if (verdict.reason === TOO_WILD) {
    return (
      `${name} was met at level ${metLevelOf(row)}, above your trainer cap of ${cap}. ` +
      `It will not listen to you until your cap reaches ${metLevelOf(row)}.`
    );
  }

  // Only raising the cap can fix this one.
  if (verdict.reason === TOO_STRONG) {
    return (
      `${name} is level ${row.level}, and nothing obeys more than ${MAX_OVER_CAP} levels ` +
      `above your cap of ${cap}. The most you can field right now is level ` +
      `${verdict.ceiling}. Raise your trainer level to bring it back in line.`
    );
  }

  // check() only returns the two verdicts above; this is a safe fallback.
  return `${name} will not listen to you at trainer level ${cap}.`;
}

/**
 * Split a team into who will fight and who will not.
 *
 * The battle system uses the obedient half as the team and the rest to explain
 * why the team is smaller.
 */
function sortTeam(rows, cap) {
  const willing = [];
  const refusing = [];

  for (const row of rows) {
    (check(row, cap).obeys ? willing : refusing).push(row);
  }

  return { willing, refusing };
}

/**
 * The same rules as a SQL fragment, for `.party suggested` on large parties.
 *
 * Kept next to check() so the two stay in sync; any change to one must be
 * made to the other.
 *
 * `alias` is the table alias the party queries use.
 *
 * @returns {{ sql: string, params: number[] }}
 */
function sqlFilter(cap, alias = 'p') {
  return {
    sql:
      `(${alias}.level <= ? OR ` +
      `(COALESCE(${alias}.met_level, ${alias}.level) <= ? AND ${alias}.level <= ?))`,
    params: [cap, cap, cap + MAX_OVER_CAP],
  };
}

/**
 * The highest level this Pokemon could be at and still obey.
 *
 * Used to warn when levelling further would make a Pokemon disobey.
 */
function ceilingFor(row, cap) {
  const met = metLevelOf(row);
  if (met > cap) return cap;

  // Same arithmetic as check().
  return cap + MAX_OVER_CAP;
}

/**
 * Did growing from `fromLevel` to the row's level just bring this Pokemon to
 * the edge of obeying, or past it?
 *
 *   'over'  it obeyed before and no longer does (only a Rare Candy can do
 *           this; battle experience stops at the limit, see store.awardKnockout)
 *   'at'    it has reached the limit, so battles won't level it any further
 *
 * @returns {{ kind: 'over'|'at', level: number, ceiling: number } | null}
 */
function levelWarning(row, fromLevel, cap) {
  const ceiling = ceilingFor(row, cap);
  const level = row.level;

  if (fromLevel <= ceiling && level > ceiling) return { kind: 'over', level, ceiling };
  if (fromLevel < ceiling && level === ceiling) return { kind: 'at', level, ceiling };
  return null;
}

/**
 * A level warning in words. `nextFight` names the milestone that would raise
 * the cap, when there is one.
 */
function describeWarning(warning, name, cap, nextFight = null) {
  const raise = nextFight ? `beat ${nextFight} to raise your cap` : 'raise your trainer level';

  if (warning.kind === 'over') {
    const needed = warning.level - MAX_OVER_CAP;
    return (
      `${name} is now level ${warning.level}, more than ${MAX_OVER_CAP} levels over your ` +
      `trainer cap of ${cap}, so it will stop obeying you and stay behind in battles. ` +
      `It obeys again once your cap reaches ${needed}; ${raise}.`
    );
  }

  return (
    `${name} is level ${warning.level}, the most it can reach at a cap of ${cap}, so it won't ` +
    `gain any more levels from battles until you ${raise}.`
  );
}

module.exports = {
  levelWarning,
  describeWarning,
  RULE_SUMMARY,
  MAX_OVER_CAP,
  OBEYS,
  TOO_WILD,
  UNEARNED,
  TOO_STRONG,
  metLevelOf,
  check,
  obeys,
  explain,
  sortTeam,
  ceilingFor,
  sqlFilter,
};

// `node Utils/obedience.js [cap]` - the rule, as a table.
if (require.main === module) {
  const cap = Number(process.argv[2]) || 10;

  console.log(`trainer cap ${cap}. ${RULE_SUMMARY}\n`);
  console.log('  met  level  grown  allowed  verdict');

  for (const [met, level] of [
    [6, 5], [6, 10], [6, 11], [6, 15], [6, 25], [6, 26], [6, 40],
    [8, 11], [8, 12], [9, 11], [9, 14], [9, 25], [9, 26],
    [10, 15], [10, 25], [10, 26], [11, 11], [75, 75],
  ]) {
    const verdict = check({ level, met_level: met }, cap);
    console.log(
      `  ${String(met).padStart(3)}  ${String(level).padStart(5)}  ` +
        `${String(verdict.grown).padStart(5)}  ${String(verdict.ceiling).padStart(7)}  ` +
        `${verdict.obeys ? 'obeys  ' : 'REFUSES'}  ${verdict.reason}` +
        (verdict.shortfall ? `  (${verdict.shortfall} over its allowance)` : '')
    );
  }

  // Levelling up one level at a time from the met level must never hit a
  // level the Pokemon can't reach (see the note at the top of this file).
  console.log('\nno level is unreachable by training, at any cap:');
  let stranded = 0;

  for (let testCap = 5; testCap <= 100; testCap += 1) {
    for (let met = 1; met <= testCap; met += 1) {
      let obeyedAt = met;

      for (let level = met; level <= testCap + MAX_OVER_CAP; level += 1) {
        if (check({ level, met_level: met }, testCap).obeys) obeyedAt = level;
        else if (level <= obeyedAt + 1) stranded += 1;
      }
    }
  }

  console.log(
    stranded === 0
      ? '  ok    every level from met upward is reachable'
      : `  FAIL  ${stranded} stranded levels`
  );

  if (stranded) process.exitCode = 1;

  console.log('\nno met data falls back to its current level:');
  for (const level of [5, 10, 11, 50]) {
    const verdict = check({ level, met_level: null }, cap);
    console.log(`  level ${String(level).padStart(3)}  ${verdict.obeys ? 'obeys' : 'REFUSES'}`);
  }
}
