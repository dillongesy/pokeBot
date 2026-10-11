'use strict';

/**
 * Working out which species somebody meant.
 *
 * Utils/pokemon.js already normalises punctuation and accents, so names like
 * "Farfetch'd", "Mr. Mime", "Ho-Oh" and "Flabébé" match on their own. This
 * module adds:
 *
 *   1. custom aliases, which can't be derived
 *   2. every localised name, which the importer writes to each species'
 *      info.json
 *
 * Localised names need a wider fold than normaliseName, which strips
 * everything outside [a-z0-9]. foldName keeps letters and digits in any
 * script.
 */

const fs = require('fs');
const path = require('path');

const { normaliseName, nameCandidates } = require('./pokemon');

const POKEMON_DIR = path.join(__dirname, '..', 'Data', 'Pokemon');
const INDEX_FILE = path.join(POKEMON_DIR, 'index.json');

/**
 * Custom aliases (server in-jokes) that also catch the Pokemon. Keyed by
 * alias so several aliases can point at the same species.
 */
const JOKE_ALIASES = {
  soju: 'vaporeon',
  kabocha: 'flareon',
  yuzu: 'jolteon',
  ume: 'espeon',
  yume: 'umbreon',
  rukia: 'leafeon',
  etude: 'sylveon',
  suzume: 'glaceon',
  boingo: 'spoink',
  dooh: 'clodsire',
  ivy: 'ivysaur',
};

/**
 * Fold text for comparison, keeping every script.
 *
 * Decompose, strip accents from Latin letters ("Flabébé" -> "flabebe"),
 * lowercase, translate gender symbols as normaliseName does (Nidoran♀ ->
 * "nidoranf"), then drop anything that isn't a letter or digit in any script.
 *
 * Accents are stripped only from Latin letters. Japanese dakuten use the same
 * combining-mark category but are part of the letter (stripping them would
 * make Marowak's ガラガラ equal Cubone's カラカラ). NFC recomposes the rest.
 */
function foldName(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/(\p{Script=Latin})\p{M}+/gu, '$1')
    .normalize('NFC')
    .toLowerCase()
    .replace(/♀/g, 'f')
    .replace(/♂/g, 'm')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

let index = null;

/**
 * Build the lookup once.
 *
 * `byName` maps a folded name in any language to the set of species it could
 * mean. A set because names can collide across languages, and "nidoran"
 * means two species.
 */
function load() {
  if (index) return index;

  if (!fs.existsSync(INDEX_FILE)) {
    throw new Error('Data/Pokemon/index.json is missing. Run "node Utils/importdata.js pokemon".');
  }

  const data = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));

  const byName = new Map();
  const byId = new Map();
  const keyById = new Map();

  const add = (name, speciesId) => {
    const folded = foldName(name);
    if (!folded) return;
    if (!byName.has(folded)) byName.set(folded, new Set());
    byName.get(folded).add(speciesId);
  };

  for (const species of data.species) {
    byId.set(species.id, species);

    // The key stored in the database, derived the same way as store.createDrop.
    keyById.set(species.id, normaliseName(species.name));

    add(species.name, species.id);
    add(species.displayName, species.id);

    // "nidoran-f" and "nidoran-m": index the bare name against both so
    // "nidoran" matches whichever one dropped.
    const bare = /^(.+)-(f|m)$/.exec(species.name);
    if (bare) add(bare[1], species.id);

    // Every localised name, straight out of the species record.
    const info = path.join(POKEMON_DIR, species.folder, 'info.json');
    if (!fs.existsSync(info)) continue;

    const names = JSON.parse(fs.readFileSync(info, 'utf8')).names || {};
    for (const value of Object.values(names)) add(value, species.id);
  }

  // Custom aliases resolve through the English name.
  for (const [alias, target] of Object.entries(JOKE_ALIASES)) {
    const folded = foldName(target);
    const ids = byName.get(folded);
    if (ids) for (const id of ids) add(alias, id);
  }

  index = { byName, byId, keyById };
  return index;
}

/**
 * Every species a guess could mean, as index entries.
 *
 * Returns all matches. The drop lookup also requires the species to be the
 * current drop in that channel, which resolves any ambiguity.
 */
function resolveSpecies(guess) {
  const { byName, byId } = load();
  const ids = byName.get(foldName(guess));
  if (!ids) return [];
  return [...ids].map((id) => byId.get(id)).filter(Boolean);
}

/**
 * The species keys a guess could match in the database.
 *
 * Falls back to Utils/pokemon.js's own candidates when the name is not in the
 * index.
 */
function resolveKeys(guess) {
  const { keyById } = load();
  const keys = new Set();

  for (const species of resolveSpecies(guess)) {
    const key = keyById.get(species.id);
    if (key) keys.add(key);
  }

  // Nothing in the index matched: fall back to the plain candidates.
  if (!keys.size) for (const key of nameCandidates(guess)) keys.add(key);

  return [...keys];
}

/** One species, when the caller wants a single answer. Lowest dex number wins. */
function resolveOne(guess) {
  const matches = resolveSpecies(guess);
  if (!matches.length) return null;
  return matches.reduce((best, species) => (species.id < best.id ? species : best));
}

/** Species by id, from the same cached index. */
function speciesById(speciesId) {
  return load().byId.get(Number(speciesId)) || null;
}

/** Every species, in dex order. */
function allSpecies() {
  return [...load().byId.values()].sort((a, b) => a.id - b.id);
}

function reload() {
  index = null;
  return load();
}

module.exports = {
  JOKE_ALIASES,
  foldName,
  resolveSpecies,
  resolveKeys,
  resolveOne,
  speciesById,
  allSpecies,
  reload,
};

// `node Utils/names.js [guess ...]` - what a guess resolves to.
if (require.main === module) {
  const args = process.argv.slice(2);

  if (!args.length) {
    const { byName } = load();
    let collisions = 0;
    for (const [name, ids] of byName) {
      if (ids.size > 1) {
        collisions += 1;
        console.log(`${name}  ->  ${[...ids].join(', ')}`);
      }
    }
    console.log(`\n${byName.size} names indexed, ${collisions} ambiguous`);
  } else {
    for (const guess of args) {
      const found = resolveSpecies(guess);
      console.log(
        `${guess.padEnd(16)} -> ` +
          (found.length ? found.map((s) => `${s.displayName} (#${s.id})`).join(', ') : 'no match')
      );
    }
  }
}
