'use strict';

/**
 * Failure logs: one file per failure in Logs/, ready to send in for fixing.
 *
 *   Logs/2026-11-05_18-22-03_battle.log
 *
 * Each file has the error and its stack trace, what was going on (the
 * command, who ran it, where) and, for a battle, both teams, the field, the
 * last button pressed and the battle log - enough to rebuild the fight.
 *
 * install() also catches everything else the bot reports with console.error
 * (a quest sync that failed, a payout that couldn't be saved...), so nothing
 * has to remember to log twice. The folder keeps the newest MAX_FILES.
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'Logs');

/** The oldest files are removed past this many. */
const MAX_FILES = 300;

/** Errors already written, so the console.error hook doesn't write them again. */
const written = new WeakSet();

const pad = (n) => String(n).padStart(2, '0');

/** "2026-11-05_18-22-03", local time, sortable. */
function stamp(date = new Date()) {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

/** Keep the folder from growing forever. */
function prune() {
  try {
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.log')).sort();
    for (const file of files.slice(0, Math.max(0, files.length - MAX_FILES))) fs.unlinkSync(path.join(DIR, file));
  } catch {
    // Pruning is housekeeping; never let it fail a log.
  }
}

/** JSON that survives the battle's circular references (allies, arena). */
function safeJson(value) {
  const seen = new WeakSet();
  return JSON.stringify(
    value,
    (key, val) => {
      if (typeof val === 'function') return undefined;
      if (typeof val === 'bigint') return String(val);
      if (val && typeof val === 'object') {
        if (seen.has(val)) return '[seen above]';
        seen.add(val);
      }
      return val;
    },
    2
  );
}

/**
 * Write one failure log.
 *
 * @param {string} kind     a short word for the file name: battle, command...
 * @param {*}      error    the Error (or whatever was thrown)
 * @param {object} context  anything that helps reproduce it
 * @returns {string|null} the file written, or null if it couldn't be
 */
function record(kind, error, context = {}) {
  try {
    if (error && typeof error === 'object') written.add(error);
    fs.mkdirSync(DIR, { recursive: true });

    const now = new Date();
    let file = path.join(DIR, `${stamp(now)}_${String(kind).replace(/[^a-z0-9-]+/gi, '-')}.log`);
    for (let n = 2; fs.existsSync(file); n += 1) file = file.replace(/(_\d+)?\.log$/, `_${n}.log`);

    const text = [
      `PokeDropper failure log - ${kind}`,
      `When:  ${now.toISOString()} (${now.toString()})`,
      `Node:  ${process.version}`,
      '',
      '=== Error ===',
      error && error.stack ? error.stack : String(error),
      '',
      '=== Context ===',
      safeJson(context),
      '',
    ].join('\n');

    fs.writeFileSync(file, text, 'utf8');
    prune();
    return file;
  } catch (err) {
    // Logging must never be the thing that breaks the bot.
    process.stderr.write(`Could not write a failure log: ${err && err.message}\n`);
    return null;
  }
}

/**
 * One fighter, as the log shows it: everything that decides a turn.
 */
function fighter(mon) {
  if (!mon) return null;
  const nonZero = (stages) => Object.fromEntries(Object.entries(stages || {}).filter(([, v]) => v));
  return {
    id: mon.id,
    name: mon.name,
    species: mon.species,
    speciesId: mon.speciesId,
    form: mon.form,
    level: mon.level,
    hp: `${mon.hp}/${mon.maxHp}`,
    fainted: Boolean(mon.fainted),
    status: mon.status || null,
    types: mon.types,
    ability: mon.ability,
    item: mon.item,
    stats: mon.stats,
    stages: nonZero(mon.stages),
    moves: (mon.moves || []).map((m) => `${m.name} ${m.pp}/${m.maxPp}`),
    volatiles: Object.keys(mon.volatiles || {}),
    substitute: mon.substitute || 0,
    transformed: Boolean(mon.transformed),
    megaForm: mon.megaForm || null,
    megaEvolved: Boolean(mon.megaEvolved),
    lastMove: mon.lastMove || null,
  };
}

/** A battle state, as the log shows it. */
function battleSnapshot(state) {
  if (!state) return null;
  // A copy, so later turns can't change what was recorded.
  return JSON.parse(safeJson({
    seed: state.seed,
    kind: state.kind,
    turn: state.turn,
    finished: state.finished,
    winner: state.winner,
    awaitingSwitch: state.awaitingSwitch ?? null,
    field: state.field,
    sides: (state.sides || []).map((side) => ({
      name: side.name,
      active: side.active,
      megaUsed: Boolean(side.megaUsed),
      conditions: side.conditions,
      team: side.team.map(fighter),
    })),
  }));
}

/**
 * A battle that broke: the error plus everything about the fight.
 *
 * @param {object} options  error, userId, state, setup, log (the battle log lines)
 */
function battle({ error, userId, state, setup, log }) {
  return record('battle', error, {
    userId,
    battleKind: setup && setup.kind,
    opponent: setup && setup.opponent ? setup.opponent.name : null,
    // The last thing pressed, with the battle as it was just before.
    lastAction: setup ? setup.lastAction || null : null,
    battleNow: battleSnapshot(state),
    battleLog: (log || []).slice(-60),
  });
}

/**
 * Also write a log for every error the bot reports through console.error,
 * unless it was already written. Called once, from index.js.
 */
function install() {
  const original = console.error.bind(console);

  console.error = (...args) => {
    original(...args);
    const error = args.find((a) => a instanceof Error);
    if (!error || written.has(error)) return;

    const message = args.filter((a) => typeof a === 'string').join(' ').trim();
    record('error', error, { message });
  };
}

module.exports = { DIR, record, battle, battleSnapshot, install, MAX_FILES };
