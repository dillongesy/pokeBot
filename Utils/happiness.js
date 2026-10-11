'use strict';

/**
 * Friendship, and what raises it.
 *
 *   Berries    the six EV-lowering berries, as in the games (implemented)
 *   Battling   a Pokemon that fights without fainting (not yet implemented)
 *   Petting    spending time with a Pokemon, on a cooldown (not yet
 *              implemented)
 *
 * Friendship evolutions: about twenty evolutions in the data require
 * minHappiness (Azurill, Chansey, Golbat, the Eevee friendship lines and so
 * on), but Utils/evolution.js does not check it yet. Enabling the check now
 * would make berries the only way to reach those evolutions, so it stays off
 * until friendship can be earned through play. Enabling it is a one-line
 * change in Utils/evolution.js.
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

/**
 * Friendship required by friendship evolutions (per PokeAPI). Not enforced
 * yet; see the note above.
 */
const EVOLVE_AT = 160;

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

const clamp = (value) => Math.max(MIN, Math.min(MAX, Math.round(Number(value) || 0)));

/** One Pokemon's friendship, or the starting value if the row is gone. */
function of(pokemonId) {
  const row = db
    .open()
    .prepare('SELECT happiness FROM pokemon WHERE id = ?')
    .get(pokemonId);

  return row ? row.happiness : START;
}

/**
 * Move a Pokemon's friendship, clamped to 0-255.
 *
 * The clamp happens inside the UPDATE, so concurrent changes are not lost.
 * Accepts negative amounts.
 *
 * @returns {number} what it is now
 */
function gain(pokemonId, amount) {
  const handle = db.open();

  handle
    .prepare(
      `UPDATE pokemon
       SET happiness = MAX(?, MIN(?, happiness + ?))
       WHERE id = ?`
    )
    .run(MIN, MAX, Math.round(Number(amount) || 0), pokemonId);

  return of(pokemonId);
}

// ---------------------------------------------------------------------------
// The sources
// ---------------------------------------------------------------------------

/** How much each source is worth. Provisional values. */
const REWARDS = {
  /** Per battle survived. */
  battle: 3,

  /** Per petting session. */
  pet: 5,
};

/**
 * Friendship gained from one of the six EV-lowering berries. As in the games,
 * the gain shrinks as friendship rises.
 *
 * Pure: takes the current value and returns the gain, so Utils/items.js can
 * write it in the same UPDATE as the EV change.
 */
function fromBerry(current) {
  const now = clamp(current);
  if (now >= 200) return 2;
  if (now >= 100) return 5;
  return 10;
}

/** How long between two pettings of the same Pokemon. */
const PET_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * Not implemented yet. Friendship for a Pokemon that finished a battle
 * without fainting.
 */
function fromBattle(/* pokemonId */) {
  throw new Error('Happiness from battling is not implemented yet.');
}

/**
 * Not implemented yet. Friendship from petting, which will need a
 * per-Pokemon cooldown.
 */
function fromPetting(/* pokemonId */) {
  throw new Error('Petting is not implemented yet.');
}

module.exports = {
  MIN,
  MAX,
  START,
  EVOLVE_AT,
  REWARDS,
  PET_COOLDOWN_MS,
  clamp,
  describe,
  of,
  gain,
  fromBerry,
  fromBattle,
  fromPetting,
};

// `node Utils/happiness.js` - check the schema default and list the sources.
if (require.main === module) {
  const { SCHEMA } = require('./db');

  const declared = /happiness\s+INTEGER NOT NULL DEFAULT (\d+)/.exec(SCHEMA);
  const schemaDefault = declared ? Number(declared[1]) : null;

  console.log(`start ${START}, evolves at ${EVOLVE_AT}, range ${MIN}-${MAX}`);
  console.log(
    schemaDefault === START
      ? `schema default matches (${schemaDefault})`
      : `MISMATCH: the schema defaults to ${schemaDefault}, this file says ${START}`
  );

  for (const value of [0, 40, 70, 120, 160, 220, 255]) {
    console.log(`  ${String(value).padStart(3)}  ${describe(value)}`);
  }

  console.log('\nberry gain by current friendship:');
  for (const value of [0, 70, 99, 100, 199, 200, 255]) {
    console.log(`  ${String(value).padStart(3)}  +${fromBerry(value)}`);
  }

  console.log('\nsources:');
  for (const name of ['fromBattle', 'fromPetting']) {
    try {
      module.exports[name](0);
      console.log(`  ${name}  built`);
    } catch (err) {
      console.log(`  ${name}  ${err.message}`);
    }
  }

  if (schemaDefault !== START) process.exit(1);
}
