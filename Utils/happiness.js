'use strict';

/**
 * Friendship, and what changes it - Emerald's rules.
 *
 *   levelUp       each level gained, in battle or from a Rare Candy
 *   vitamin       HP Up, Protein and the rest
 *   berry         the six EV-lowering berries
 *   leagueBattle  every Pokemon on the team, after beating a Gym Leader,
 *                 Elite Four member or Champion (any milestone)
 *   learnTm       being taught a TM
 *   faint         fainting in battle
 *   faintBadly    fainting to something 30 or more levels higher
 *
 * Each gain is smaller once friendship passes 100 and again at 200, and a
 * held Soothe Bell makes gains half again as big (losses are unchanged).
 *
 * Friendship evolutions (Pichu, Golbat, Eevee to Espeon or Umbreon...) check
 * it on level-up; see Utils/evolution.js. Return and Frustration read it for
 * their power; see Utils/movepower.js.
 */

const db = require('./db');

/** The same range as the games. */
const MIN = 0;
const MAX = 255;

/**
 * Starting friendship when caught (the games' default).
 *
 * The `happiness` column default in Utils/db.js must match. Running
 * `node Utils/happiness.js` checks this.
 */
const START = 70;

/** Where most friendship evolutions start (some, like Pichu, need 220). */
const EVOLVE_AT = 160;

/** Emerald's table: the change below 100, at 100-199, and at 200 or more. */
const EVENTS = {
  levelUp: [5, 3, 2],
  vitamin: [5, 3, 2],
  berry: [10, 5, 2],
  leagueBattle: [3, 2, 1],
  learnTm: [1, 1, 0],
  faint: [-1, -1, -1],
  faintBadly: [-5, -5, -10],
};

/** Fainting to a foe at least this many levels higher counts as faintBadly. */
const BAD_FAINT_GAP = 30;

/** Held, it makes every gain 1.5 times as big (rounded down), as in Emerald. */
const SOOTHE_BELL = 'soothe-bell';

const clamp = (value) => Math.max(MIN, Math.min(MAX, Math.round(Number(value) || 0)));

/**
 * How much one event changes friendship, from where it is now.
 *
 * @param {string} event      a key of EVENTS
 * @param {number} current
 * @param {string} [heldItem]
 */
function amountFor(event, current, heldItem = null) {
  const now = clamp(current);
  const tier = now >= 200 ? 2 : now >= 100 ? 1 : 0;

  let amount = EVENTS[event][tier];
  if (amount > 0 && heldItem === SOOTHE_BELL) amount = Math.floor((amount * 150) / 100);
  return amount;
}

/**
 * A Pokemon's friendship after an event happens `times` times in a row.
 *
 * Pure, so callers can write it in the same UPDATE as everything else. Each
 * repeat uses the new value, so gaining ten levels slows down past 100.
 *
 * @param {object} row  a pokemon row (reads happiness and equipped_item)
 */
function after(row, event, times = 1) {
  let value = clamp(row.happiness ?? START);
  for (let i = 0; i < times; i += 1) value = clamp(value + amountFor(event, value, row.equipped_item));
  return value;
}

/** How it reads on a card. */
function describe(value) {
  const happiness = clamp(value);

  if (happiness >= 220) return 'Inseparable';
  if (happiness >= EVOLVE_AT) return 'Very friendly';
  if (happiness >= 100) return 'Friendly';
  if (happiness >= START) return 'Getting used to you';
  if (happiness > 0) return 'Wary';
  return 'Wild';
}

/** Hearts in the meter. Each is a tenth of the way to 255. */
const HEARTS = 10;

/** "❤️❤️❤️🤍🤍🤍🤍🤍🤍🤍" - filled in proportion to friendship. */
function meter(value) {
  const filled = Math.round((clamp(value) / MAX) * HEARTS);
  return '❤️'.repeat(filled) + '🤍'.repeat(HEARTS - filled);
}

/** One Pokemon's friendship, or the starting value if the row is gone. */
function of(pokemonId) {
  const row = db
    .open()
    .prepare('SELECT happiness FROM pokemon WHERE id = ?')
    .get(pokemonId);

  return row ? row.happiness : START;
}

module.exports = {
  MIN,
  MAX,
  START,
  EVOLVE_AT,
  EVENTS,
  BAD_FAINT_GAP,
  SOOTHE_BELL,
  clamp,
  amountFor,
  after,
  describe,
  meter,
  of,
};

// `node Utils/happiness.js` - check the schema default and print the table.
if (require.main === module) {
  const { SCHEMA } = require('./db');

  const declared = /happiness\s+INTEGER NOT NULL DEFAULT (\d+)/.exec(SCHEMA);
  const schemaDefault = declared ? Number(declared[1]) : null;

  console.log(`start ${START}, most evolve at ${EVOLVE_AT}, range ${MIN}-${MAX}`);
  console.log(
    schemaDefault === START
      ? `schema default matches (${schemaDefault})`
      : `MISMATCH: the schema defaults to ${schemaDefault}, this file says ${START}`
  );

  for (const value of [0, 40, 70, 120, 160, 220, 255]) {
    console.log(`  ${String(value).padStart(3)}  ${meter(value)}  ${describe(value)}`);
  }

  console.log('\nchange at 70 / 150 / 230, and with a Soothe Bell:');
  for (const event of Object.keys(EVENTS)) {
    const plain = [70, 150, 230].map((v) => amountFor(event, v)).join(' / ');
    const bell = [70, 150, 230].map((v) => amountFor(event, v, SOOTHE_BELL)).join(' / ');
    console.log(`  ${event.padEnd(13)} ${plain.padEnd(14)} ${bell}`);
  }

  if (schemaDefault !== START) process.exit(1);
}
