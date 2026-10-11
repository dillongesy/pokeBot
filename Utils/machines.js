'use strict';

/**
 * TMs.
 *
 * TMs let players choose moves beyond the level-up moves from
 * Utils/learnset.js.
 *
 * A TM is identified by its move, not its number, because numbers differ
 * between games (TM01 is Take Down in Scarlet/Violet and Mega Punch in
 * Red/Blue). Across all 28 version groups there are 2,372 machine records but
 * only 358 distinct moves. The slug is `tm-flamethrower`; the displayed number
 * comes from the newest game that has it.
 *
 * HMs are treated as TMs, since the bot has no field moves. TMs are reusable
 * and stay in the bag.
 *
 * Which Pokemon can learn a TM comes from each form's move data (learn method
 * `machine`). A Pokemon can learn a TM if any game allowed it. A form without
 * its own machine list falls back to its species' default form, as in
 * Utils/learnset.js.
 */

const fs = require('fs');
const path = require('path');

const content = require('./content');
const versiongroups = require('./versiongroups');
const movepower = require('./movepower');
const { loadSpecies, loadForm } = require('./pokemon');

const DATA = path.join(__dirname, '..', 'Data', 'Machines');

/** Every TM slug starts with this, which is how classify() spots one. */
const PREFIX = 'tm-';

/**
 * What a TM costs, by how hard the move hits.
 *
 * Five bands rather than a formula. Priced to be affordable; after
 * rates.priceScale these are between 120 and 600 coins.
 */
const PRICES = [
  { upTo: 0, price: 1200 },     // status moves
  { upTo: 59, price: 1500 },
  { upTo: 79, price: 2500 },
  { upTo: 99, price: 4000 },
  { upTo: Infinity, price: 6000 },
];

function priceFor(move) {
  // Use the nominal power for variable-power moves, which have no power in
  // the data.
  const power = movepower.nominalPower(move) || 0;
  return (PRICES.find((band) => power <= band.upTo) || PRICES[PRICES.length - 1]).price;
}

let catalogueCache = null;

/**
 * Every TM there has ever been, keyed by move name.
 *
 * Built once from all Data/Machines folders. Each record uses the number from
 * the newest game that has the TM.
 *
 * @returns {Map<string, {move, displayName, slug, number, machine, versionGroup, isHm}>}
 */
function catalogue() {
  if (catalogueCache) return catalogueCache;

  const index = readIndex();
  const seen = new Map();

  for (const group of index.versionGroups || []) {
    const file = path.join(DATA, group.folder, 'data.json');
    if (!fs.existsSync(file)) continue;

    const data = JSON.parse(fs.readFileSync(file, 'utf8'));

    for (const machine of data.machines || []) {
      const existing = seen.get(machine.move);

      // The newest game's number wins.
      if (existing && !versiongroups.isNewer(group.name, existing.versionGroup)) {
        if (/^hm/.test(machine.machine)) existing.isHm = true;
        continue;
      }

      seen.set(machine.move, {
        move: machine.move,
        moveDisplayName: machine.moveDisplayName,
        slug: PREFIX + machine.move,
        machine: machine.machine,
        number: (machine.displayName || machine.machine || '').toUpperCase(),
        versionGroup: group.name,
        isHm: /^hm/.test(machine.machine) || (existing ? existing.isHm : false),
      });
    }
  }

  // Include the move's details so callers don't need a separate lookup.
  for (const record of seen.values()) {
    const move = content.move(record.move);

    record.data = move;
    record.type = move ? move.type : null;
    record.power = move ? move.power : null;

    // Used for sorting and pricing. Equal to power for most moves; an estimate
    // for variable-power moves, kept separate so it isn't shown as real power.
    record.nominalPower = movepower.nominalPower(move);
    record.damageClass = move ? move.damageClass : null;
    record.price = priceFor(move);

    // "TM125 Flamethrower"
    record.displayName = `${record.number} ${record.moveDisplayName}`;
  }

  catalogueCache = seen;
  return seen;
}

function readIndex() {
  const file = path.join(DATA, 'index.json');

  if (!fs.existsSync(file)) {
    throw new Error('Machines have not been imported yet. Run "node Utils/importdata.js".');
  }

  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Every TM, sorted by type then by how hard it hits. For a shop page.
 *
 * `teachableOnly` drops the ones nobody can learn - see teachableAnywhere().
 */
function all({ teachableOnly = false } = {}) {
  const list = [...catalogue().values()];
  const usable = teachableOnly ? teachableAnywhere() : null;

  return list
    .filter((record) => !usable || usable.has(record.move))
    .sort(
      (a, b) =>
        String(a.type).localeCompare(String(b.type)) ||
        (b.power || 0) - (a.power || 0) ||
        a.move.localeCompare(b.move)
    );
}

let teachableCache = null;

/**
 * Every TM move that at least one Pokemon in the data can actually be taught.
 *
 * Some Legends Z-A TMs currently fail this because PokeAPI has the machine
 * list but no learnsets for that game yet. They stay in the catalogue and will
 * appear in the shop automatically once PokeAPI fills them in.
 *
 * Cached, and only used by the shop generator at import time.
 */
function teachableAnywhere() {
  if (teachableCache) return teachableCache;

  const file = path.join(__dirname, '..', 'Data', 'Pokemon', 'index.json');
  const index = JSON.parse(fs.readFileSync(file, 'utf8'));

  teachableCache = new Set();

  for (const form of index.forms) {
    for (const move of machineMoves(form.speciesId, form.folder)) {
      if (catalogue().has(move)) teachableCache.add(move);
    }
  }

  return teachableCache;
}

/** Is this slug a TM? */
const isTm = (slug) => typeof slug === 'string' && catalogue().has(moveOf(slug));

/** The move a TM slug teaches. `tm-flamethrower` -> `flamethrower`. */
const moveOf = (slug) =>
  typeof slug === 'string' && slug.startsWith(PREFIX) ? slug.slice(PREFIX.length) : '';

/** One TM by its slug, or null. */
const bySlug = (slug) => catalogue().get(moveOf(slug)) || null;

/** One TM by the move it teaches, or null. */
const forMove = (move) => catalogue().get(move) || null;

// ---------------------------------------------------------------------------
// Who can learn what
// ---------------------------------------------------------------------------

const learnableCache = new Map();

/**
 * Every move this form could ever be taught by a machine.
 *
 * Any version group counts, so a move learnable by TM in any game is allowed.
 *
 * @returns {Set<string>} move names
 */
function machineMoves(speciesId, formFolder) {
  const key = `${speciesId}/${formFolder}`;
  if (learnableCache.has(key)) return learnableCache.get(key);

  let moves = readMachines(loadForm(speciesId, formFolder));

  // No machine list of its own: fall back to the species' default form.
  if (!moves.size) {
    const species = loadSpecies(speciesId);
    const forms = (species && species.forms) || [];
    const base = forms.find((entry) => entry.percentage > 0) || forms[0];

    if (base && base.folder !== formFolder) {
      moves = readMachines(loadForm(speciesId, base.folder));
    }
  }

  learnableCache.set(key, moves);
  return moves;
}

function readMachines(form) {
  const out = new Set();

  for (const move of (form && form.moves) || []) {
    if ((move.learn || []).some((learn) => learn.method === 'machine')) out.add(move.name);
  }

  return out;
}

/** Can this Pokemon be taught this move by a TM? */
function canLearn(speciesId, formFolder, move) {
  if (!catalogue().has(move)) return false;
  return machineMoves(speciesId, formFolder).has(move);
}

/**
 * Every TM this Pokemon could be taught, as records.
 *
 * The intersection of the Pokemon's machine-learnable moves and the TM
 * catalogue (a few machine-learnable moves are not sold as TMs).
 */
function learnableFor(speciesId, formFolder) {
  const learnable = machineMoves(speciesId, formFolder);
  return all().filter((record) => learnable.has(record.move));
}

/**
 * The reason a Pokemon cannot be taught something, in words, or null if it can.
 *
 * Shared by `.tm` and `.useitem` so they give the same message.
 */
function refusalFor(row, slug) {
  const tm = bySlug(slug);
  if (!tm) return `There is no TM called "${slug}".`;

  if (!canLearn(row.species_id, row.form_folder, tm.move)) {
    return `${row.display_name} cannot learn ${tm.moveDisplayName}.`;
  }

  return null;
}

module.exports = {
  PREFIX,
  PRICES,
  priceFor,
  catalogue,
  all,
  teachableAnywhere,
  isTm,
  moveOf,
  bySlug,
  forMove,
  machineMoves,
  canLearn,
  learnableFor,
  refusalFor,
};

// ---------------------------------------------------------------------------
// `node Utils/machines.js [pokemon]` - the catalogue, or one Pokemon's options.
// ---------------------------------------------------------------------------

if (require.main === module) {
  const [, , query] = process.argv;

  if (query) {
    const names = require('./names');
    const found = (names.resolveSpecies(query) || [])[0];

    if (!found) {
      console.error(`No species called "${query}".`);
      process.exit(1);
    }

    const species = loadSpecies(found.id);
    const forms = species.forms || [];
    const base = forms.find((f) => f.percentage > 0) || forms[0];
    const options = learnableFor(species.id, base.folder);

    console.log(`${species.displayName} can be taught ${options.length} of ${catalogue().size} TMs\n`);

    const byType = new Map();
    for (const tm of options) {
      if (!byType.has(tm.type)) byType.set(tm.type, []);
      byType.get(tm.type).push(tm);
    }

    for (const [type, list] of [...byType].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${String(type).padEnd(10)} ${list.map((t) => t.moveDisplayName).join(', ')}`);
    }

    process.exit(0);
  }

  const list = all();
  console.log(`${list.length} distinct TMs across every game\n`);

  const byGame = new Map();
  for (const tm of list) byGame.set(tm.versionGroup, (byGame.get(tm.versionGroup) || 0) + 1);

  console.log('which game each one takes its number from:');
  for (const [group, count] of [...byGame].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}  ${versiongroups.displayNameOf(group)}`);
  }

  const hms = list.filter((tm) => tm.isHm);
  console.log(`\n${hms.length} have been an HM at some point: ${hms.map((t) => t.moveDisplayName).join(', ')}`);

  console.log('\nprices:');
  const byPrice = new Map();
  for (const tm of list) byPrice.set(tm.price, (byPrice.get(tm.price) || 0) + 1);
  for (const [price, count] of [...byPrice].sort((a, b) => a[0] - b[0])) {
    console.log(`  ${String(count).padStart(4)}  at ${price.toLocaleString()} coins`);
  }

  // Report TMs that no Pokemon can learn.
  const index = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'Data', 'Pokemon', 'index.json'), 'utf8'));
  const teachable = teachableAnywhere();
  const orphans = list.filter((tm) => !teachable.has(tm.move));

  console.log(`\n${orphans.length} TMs that NO Pokemon in the data can learn:`);
  for (const tm of orphans) {
    console.log(`  ${tm.displayName.padEnd(28)} only in ${versiongroups.displayNameOf(tm.versionGroup)}`);
  }

  let totalOptions = 0;
  let noneAtAll = 0;

  for (const form of index.forms) {
    const count = machineMoves(form.speciesId, form.folder).size;
    totalOptions += count;
    if (!count) noneAtAll += 1;
  }

  console.log(
    `\n${index.forms.length} forms, ${(totalOptions / index.forms.length).toFixed(1)} TMs each on average`
  );
  console.log(`${noneAtAll} forms can be taught nothing at all`);
}
