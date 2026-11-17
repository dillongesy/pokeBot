'use strict';

/**
 * The website's opening: Professor A, choosing how you look, and a starter
 * from any region.
 *
 * Everyone plays it once, existing Discord players included, and again after
 * each prestige (it's stored in web_progress, which is per prestige). Until
 * it's done the overworld won't let you walk (Web/overworld.js).
 *
 * The starter is the one thing here worth cheating for, so it is given at
 * most once per prestige: the "done" row is written first, inside the same
 * synchronous call, and only the call that actually wrote it hands the
 * Pokemon over. A second request, or a repeated one, gets nothing.
 *
 * Outfits are any of Tuxemon's characters (Web/sprites/tuxemon/characters).
 * They only change how you look, so they can be changed any time.
 */

const fs = require('fs');
const path = require('path');

const db = require('../Utils/db');
const store = require('../Utils/store');
const rates = require('../Utils/rates');
const { loadSpecies, loadForm, createPokemon, baseForm, rollSpeciesGender } = require('../Utils/pokemon');

const CHARACTERS_DIR = path.join(__dirname, 'sprites', 'tuxemon', 'characters');

/** The level every starter is given at. */
const STARTER_LEVEL = 5;

/** The grass, fire and water starters of every region. */
const STARTERS = [
  { region: 'Kanto', species: [1, 4, 7] },
  { region: 'Johto', species: [152, 155, 158] },
  { region: 'Hoenn', species: [252, 255, 258] },
  { region: 'Sinnoh', species: [387, 390, 393] },
  { region: 'Unova', species: [495, 498, 501] },
  { region: 'Kalos', species: [650, 653, 656] },
  { region: 'Alola', species: [722, 725, 728] },
  { region: 'Galar', species: [810, 813, 816] },
  { region: 'Paldea', species: [906, 909, 912] },
];

/** Not outfits: helper images, and sprites that aren't a person to walk around as. */
const NOT_OUTFITS = new Set(['drop_shadow', 'invisible', 'naked', 'light', '37707_female_missing', '37707_male_missing']);

/** Every outfit on offer, by file name without .png. Read once. */
let outfitCache = null;
function outfits() {
  if (!outfitCache) {
    outfitCache = fs.existsSync(CHARACTERS_DIR)
      ? fs.readdirSync(CHARACTERS_DIR)
        .filter((f) => f.endsWith('.png'))
        .map((f) => f.slice(0, -4))
        .filter((name) => !NOT_OUTFITS.has(name))
        .sort((a, b) => (a === 'adventurer' ? -1 : b === 'adventurer' ? 1 : a.localeCompare(b)))
      : ['adventurer'];
  }
  return outfitCache;
}

const DONE = 'intro:done';

function prestigeOf(userId) {
  const row = store.getUser(userId);
  return (row && row.prestige) || 0;
}

function done(userId) {
  return Boolean(
    db.open()
      .prepare('SELECT 1 FROM web_progress WHERE discord_user_id = ? AND prestige = ? AND key = ?')
      .get(userId, prestigeOf(userId), DONE)
  );
}

/** One starter, as the lab shows it. */
function starterInfo(speciesId) {
  const species = loadSpecies(speciesId);
  if (!species) return null;
  const form = baseForm(species.forms);
  const data = form && loadForm(speciesId, form.folder);
  const urls = (data && data.spriteUrls) || {};
  return {
    species: speciesId,
    name: species.displayName || species.name,
    types: (data && data.types) || [],
    sprite: urls.front || null,
  };
}

let startersCache = null;
const starters = () =>
  startersCache ||
  (startersCache = STARTERS.map((r) => ({ region: r.region, starters: r.species.map(starterInfo).filter(Boolean) })));

/** What the page needs for the intro. */
function view(userId) {
  store.ensureUser(userId);
  return {
    needed: !done(userId),
    level: STARTER_LEVEL,
    regions: starters(),
    outfits: outfits(),
  };
}

/**
 * Pick the starter. Only once per prestige.
 *
 * @returns {{ok: true, pokemon: {name, species, shiny}} | {ok: false, reason: string}}
 */
function chooseStarter(userId, speciesId) {
  const id = Number(speciesId);
  if (!STARTERS.some((r) => r.species.includes(id))) return { ok: false, reason: 'not a starter' };

  const species = loadSpecies(id);
  const form = species && baseForm(species.forms);
  const data = form && loadForm(id, form.folder);
  if (!data) return { ok: false, reason: 'missing data' };

  store.ensureUser(userId);

  // The claim comes first: whoever writes this row gets the Pokemon.
  const claimed = db.open()
    .prepare('INSERT OR IGNORE INTO web_progress (discord_user_id, prestige, key, done_at) VALUES (?, ?, ?, ?)')
    .run(userId, prestigeOf(userId), DONE, Date.now());
  if (Number(claimed.changes) !== 1) return { ok: false, reason: 'already' };

  const mon = createPokemon(species, data, { level: STARTER_LEVEL });
  const gender = (species.gender || {}).genderless ? 'genderless' : rollSpeciesGender(species);
  const shiny = Math.random() < 1 / rates.shinyRate;
  const row = store.grantPokemon(userId, mon, { shiny, gender, method: 'starter' });

  // Out of the lab and into Town 1, where the journey starts.
  require('./overworld').moveTo(userId, 'town-1');

  return { ok: true, pokemon: { name: row.display_name, species: id, shiny: Boolean(row.shiny) } };
}

const isOutfit = (name) => outfits().includes(String(name));

module.exports = { view, done, chooseStarter, outfits, isOutfit, STARTERS, STARTER_LEVEL };

// `node Web/intro.js` - the lab's table and the outfit count.
if (require.main === module) {
  for (const r of starters()) console.log(`${r.region.padEnd(7)} ${r.starters.map((s) => `${s.name} (${s.types.join('/')})`).join(', ')}`);
  console.log(`${outfits().length} outfits`);
}
