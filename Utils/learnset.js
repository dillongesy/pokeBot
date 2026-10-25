'use strict';

/**
 * What moves a Pokemon knows.
 *
 * As in the games, a Pokemon knows the last four level-up moves it would have
 * learned at or below its level. TMs can change them afterwards.
 *
 * PokeAPI has one learnset per version group, and they differ. This uses the
 * newest game the Pokemon appears in (see Utils/versiongroups.js).
 *
 * A form with no learnset of its own (all Gigantamax forms, and Legends Z-A
 * Megas so far) uses its species' default form.
 *
 * PokeAPI lists evolution moves (Decidueye's Spirit Shackle) as level-up moves
 * at level 0. They are kept at level 1 for ordering and marked `evolution`, so
 * they can be offered when the Pokemon evolves into this form.
 */

const content = require('./content');
const versiongroups = require('./versiongroups');
const movepower = require('./movepower');
const { loadSpecies, loadForm } = require('./pokemon');

/** How many moves a Pokemon can know. */
const MAX_MOVES = 4;

const cache = new Map();

/**
 * How much a move is worth having, for breaking a tie at the same level.
 *
 * Evolved Pokemon often have many level-1 moves (Charizard has seven in
 * Scarlet/Violet) and PokeAPI gives no order within a level. Ties are broken
 * by power, with status moves ranked lowest.
 */
function strengthOf(name) {
  const data = content.move(name);
  if (!data) return 0;
  if (data.damageClass === 'status') return 0;

  // Variable-power moves (Seismic Toss, Low Kick, Flail) use the nominal
  // power from Utils/movepower.js.
  return movepower.nominalPower(data) || 1;
}

/**
 * Every level-up move on a form's list, from the newest game that has one.
 *
 * Sorted by level, then weakest first within a level (movesAtLevel takes the
 * last four, so the strongest survive), then by name for a stable order.
 *
 * @returns {{ versionGroup: string|null, moves: Array<{name, displayName, level, evolution}> }}
 */
function levelUpMoves(speciesId, formFolder) {
  const key = `${speciesId}/${formFolder}`;
  if (cache.has(key)) return cache.get(key);

  const answer = build(speciesId, formFolder);
  cache.set(key, answer);
  return answer;
}

function build(speciesId, formFolder) {
  const empty = { versionGroup: null, moves: [] };

  let form = loadForm(speciesId, formFolder);
  let list = readLevelUp(form);

  // No learnset of its own: fall back to the species' default form.
  if (!list.length) {
    const species = loadSpecies(speciesId);
    const forms = (species && species.forms) || [];
    const base = forms.find((entry) => entry.percentage > 0) || forms[0];

    if (!base || base.folder === formFolder) return empty;

    form = loadForm(speciesId, base.folder);
    list = readLevelUp(form);
  }

  if (!list.length) return empty;

  // Use a single game's list; mixing games would duplicate moves.
  const versionGroup = versiongroups.newest(list.map((entry) => entry.versionGroup));

  const moves = list
    .filter((entry) => entry.versionGroup === versionGroup)
    .sort(
      (a, b) =>
        a.level - b.level ||
        strengthOf(a.name) - strengthOf(b.name) ||
        a.name.localeCompare(b.name)
    )
    .map(({ name, displayName, level, evolution }) => ({ name, displayName, level, evolution }));

  return { versionGroup, moves };
}

/** Flatten a form's move data down to its level-up entries. */
function readLevelUp(form) {
  const out = [];

  for (const move of (form && form.moves) || []) {
    for (const learn of move.learn || []) {
      if (learn.method !== 'level-up') continue;

      out.push({
        name: move.name,
        displayName: move.displayName,
        level: learn.level || 1,
        evolution: !learn.level,
        versionGroup: learn.versionGroup,
      });
    }
  }

  return out;
}

/**
 * The moves a Pokemon becomes able to learn when levelling from one level to
 * another, in the order they would be learned.
 *
 * The range is `(from, to]`: moves at the new level count, moves at the old
 * level do not.
 */
function movesLearnedBetween(speciesId, formFolder, fromLevel, toLevel) {
  const { moves } = levelUpMoves(speciesId, formFolder);

  return moves
    .filter((move) => move.level > fromLevel && move.level <= toLevel)
    .sort((a, b) => a.level - b.level);
}

/** The moves this form learns the moment something evolves into it. */
function evolutionMoves(speciesId, formFolder) {
  return levelUpMoves(speciesId, formFolder).moves.filter((move) => move.evolution);
}

/**
 * Every new move a Pokemon has earned by growing from `before` to `after`.
 *
 * Level-up moves in `(before.level, after.level]` from its current list, plus
 * the evolution moves of each form it evolved into along the way. `steps`
 * lists those forms ({species_id, form_folder}); when omitted, a change of
 * species counts as one step into `after`.
 *
 * An Everstone stops the evolution, so the species stays the same and only
 * that species' own moves are earned.
 *
 * @returns {Array<{name, displayName, level, evolution}>} in learning order
 */
function movesOnGrowth(before, after, steps = null) {
  const evolvedInto = steps || (before.species_id !== after.species_id ? [after] : []);

  const earned = [
    ...movesLearnedBetween(after.species_id, after.form_folder, before.level, after.level),
    ...evolvedInto.flatMap((step) => evolutionMoves(step.species_id, step.form_folder)),
  ];

  const seen = new Set();
  return earned.filter((move) => !seen.has(move.name) && seen.add(move.name));
}

/**
 * Everything this Pokemon could know at its current level.
 *
 * Derived from the level rather than stored, so a move that wasn't learned
 * when offered can still be learned later with `.moves <id> learn`.
 */
function learnableAt(speciesId, formFolder, level) {
  const { moves } = levelUpMoves(speciesId, formFolder);
  return moves.filter((move) => move.level <= level).sort((a, b) => a.level - b.level);
}

/**
 * The four moves a Pokemon of this species, form and level would know.
 *
 * The last four it has learned, newest last. May be fewer than four, but
 * never zero: a Pokemon below its first level-up move still gets that move.
 *
 * @returns {Array<{name: string, displayName: string, level: number}>}
 */
function movesAtLevel(speciesId, formFolder, level) {
  const { moves } = levelUpMoves(speciesId, formFolder);
  if (!moves.length) return [];

  const due = moves.filter((move) => move.level <= level);

  // Nothing learned yet: use the earliest move so it has something to use.
  const pool = due.length ? due : [moves[0]];

  // Deduplicate before slicing, since some lists teach a move at two levels.
  const seen = new Set();
  const unique = [];

  for (let i = pool.length - 1; i >= 0; i -= 1) {
    if (seen.has(pool[i].name)) continue;
    seen.add(pool[i].name);
    unique.push(pool[i]);
    if (unique.length === MAX_MOVES) break;
  }

  return keepSomethingToAttackWith(unique.reverse(), pool);
}

/** Can this move actually take HP off something? */
const isDamaging = (name) => {
  const data = content.move(name);
  return Boolean(data) && data.damageClass !== 'status';
};

/**
 * Avoid a moveset of four status moves when an attack is available.
 *
 * For example, a level 20 Mightyena would otherwise get Howl, Leer, Roar and
 * Swagger while Crunch and Bite are available at level 1. In that case the
 * weakest slot is replaced by the strongest available attack. Only applies
 * when none of the four moves does damage.
 */
function keepSomethingToAttackWith(dealt, pool) {
  if (!dealt.length || dealt.some((move) => isDamaging(move.name))) return dealt;

  const known = new Set(dealt.map((move) => move.name));

  // The pool is sorted weakest-first within each level, so the last damaging
  // move is the strongest.
  let best = null;
  for (const move of pool) {
    if (known.has(move.name) || !isDamaging(move.name)) continue;
    if (!best || strengthOf(move.name) >= strengthOf(best.name)) best = move;
  }

  if (!best) return dealt;

  // Drop the weakest of what it was dealt, keeping the rest in learning order.
  const weakest = dealt.reduce((worst, move) =>
    strengthOf(move.name) < strengthOf(worst.name) ? move : worst
  );

  return dealt
    .filter((move) => move !== weakest)
    .concat(best)
    .sort((a, b) => a.level - b.level || strengthOf(a.name) - strengthOf(b.name));
}

/**
 * A move's data from Data/Moves, or null if missing.
 */
function move(name) {
  return content.move(name);
}

/** Every move this form can learn by any method (used for TM checks). */
function allMoves(speciesId, formFolder) {
  const form = loadForm(speciesId, formFolder);
  return new Set(((form && form.moves) || []).map((entry) => entry.name));
}

module.exports = {
  MAX_MOVES,
  levelUpMoves,
  movesAtLevel,
  movesLearnedBetween,
  evolutionMoves,
  movesOnGrowth,
  learnableAt,
  allMoves,
  move,
};

// `node Utils/learnset.js [species] [level]` - what would it know?
if (require.main === module) {
  const [, , rawSpecies, rawLevel] = process.argv;

  if (rawSpecies) {
    const names = require('./names');
    const found = /^\d+$/.test(rawSpecies)
      ? Number(rawSpecies)
      : ((names.resolveSpecies(rawSpecies) || [])[0] || {}).id;
    const species = found ? loadSpecies(found) : null;

    if (!species) {
      console.error(`No species called "${rawSpecies}".`);
      process.exit(1);
    }

    const forms = species.forms || [];
    const base = forms.find((f) => f.percentage > 0) || forms[0];
    const level = Number(rawLevel) || 50;

    const { versionGroup, moves } = levelUpMoves(species.id, base.folder);
    console.log(`${species.displayName} (${base.folder}) - reading ${versionGroup}`);
    console.log(`${moves.length} level-up moves\n`);

    console.log(`at level ${level} it would know:`);
    for (const known of movesAtLevel(species.id, base.folder, level)) {
      const data = move(known.name) || {};
      console.log(
        `  ${String(known.level).padStart(3)}  ${known.displayName.padEnd(20)}` +
          `${String(data.type || '?').padEnd(9)}${String(data.power || '-').padStart(4)} power`
      );
    }
    process.exit(0);
  }

  // No arguments: report coverage across everything.
  const fs = require('fs');
  const path = require('path');

  const index = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'Data', 'Pokemon', 'index.json'), 'utf8')
  );

  const byGroup = new Map();
  let none = 0;
  let borrowed = 0;

  for (const form of index.forms) {
    const own = readLevelUp(loadForm(form.speciesId, form.folder));
    const { versionGroup, moves } = levelUpMoves(form.speciesId, form.folder);

    if (!moves.length) {
      none += 1;
      continue;
    }

    if (!own.length) borrowed += 1;
    byGroup.set(versionGroup, (byGroup.get(versionGroup) || 0) + 1);
  }

  console.log(`${index.forms.length} forms\n`);
  console.log(`  ${borrowed} borrow their species' default list`);
  console.log(`  ${none} have no level-up moves anywhere\n`);

  console.log('which game each form reads:');
  for (const [group, count] of [...byGroup].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(5)}  ${group}`);
  }
}
