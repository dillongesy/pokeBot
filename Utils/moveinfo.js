'use strict';

/**
 * How a move is described on a card: type, category, power, accuracy, PP and
 * what it does.
 *
 * Shared by `.moves` and the learn-a-move prompt (Utils/moveprompt.js) so a
 * move reads the same everywhere.
 */

const movepower = require('./movepower');
const { titleCase } = require('./display');

/** Damage class labels. */
const CLASS_LABEL = { physical: 'Physical', special: 'Special', status: 'Status' };

/**
 * "Fire, Special" then "Power 90, accuracy 100%, 15 PP".
 *
 * A tilde marks variable power, calculated at the time of the hit (see
 * Utils/movepower.js). `ppUp` is how many PP Ups have been used on it.
 */
function stats(data, ppUp = 0) {
  const nominal = movepower.nominalPower(data);
  const power = data.power ? String(data.power) : nominal ? `~${nominal}` : '-';
  // No accuracy means it can't miss (Aerial Ace), unless it is a status move
  // that never rolls to hit at all (Swords Dance).
  const accuracy = data.accuracy
    ? `${data.accuracy}%`
    : data.damageClass === 'status' ? '-' : 'never misses';
  const pp = data.pp ? data.pp + ppUp * Math.floor(data.pp / 5) : '-';
  const kind = CLASS_LABEL[data.damageClass] || titleCase(data.damageClass || '?');

  return (
    `${titleCase(data.type || '?')}, ${kind}\n` +
    `Power ${power}, accuracy ${accuracy}, ${pp} PP`
  );
}

/** What it does, from PokeAPI's short effect, plus its priority if any. */
function effect(data) {
  const text = String(data.shortEffect || data.effect || '').trim();
  const priority = data.priority ? `Priority ${data.priority > 0 ? '+' : ''}${data.priority}.` : '';

  return [text, priority].filter(Boolean).join(' ');
}

/** Stats and effect together, for a field value. */
function details(data, ppUp = 0) {
  if (!data) return 'Unknown move';

  const said = effect(data);
  return said ? `${stats(data, ppUp)}\n*${said}*` : stats(data, ppUp);
}

/** "Lv 18", or "On evolution" for an evolution move. */
const learnedAt = (move) => (move.evolution ? 'On evolution' : `Lv ${move.level}`);

module.exports = { CLASS_LABEL, stats, effect, details, learnedAt };
