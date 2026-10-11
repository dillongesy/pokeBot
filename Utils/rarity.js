'use strict';

/**
 * Which rarity bucket a species belongs to.
 *
 * Reads the flags on each species record in Data/ once and maps them to four
 * named buckets.
 *
 * Order matters: a species flagged both mythical and legendary counts as
 * mythical. Babies, pseudo-legendaries and Paradox Pokemon are all normal.
 */

const fs = require('fs');
const path = require('path');

const INDEX_FILE = path.join(__dirname, '..', 'Data', 'Pokemon', 'index.json');

/** The four buckets, rarest first. Used for ordering as well as lookup. */
const BUCKETS = ['mythical', 'ultraBeast', 'legendary', 'normal'];

/** How they are written when shown to a player. */
const LABELS = {
  mythical: 'Mythical',
  ultraBeast: 'Ultra Beast',
  legendary: 'Legendary',
  normal: 'Common',
};

/** Drop card embed colours. */
const COLORS = {
  normal: 0x0099ff,
  legendary: 0x66ff00,
  mythical: 0xff96c5,
  ultraBeast: 0xcf9fff,
};

/** Every name a player might type for a bucket, mapped to the bucket. */
const ALIASES = {
  legendary: 'legendary',
  legendaries: 'legendary',
  legend: 'legendary',
  l: 'legendary',
  mythical: 'mythical',
  mythicals: 'mythical',
  mythic: 'mythical',
  myth: 'mythical',
  m: 'mythical',
  ultrabeast: 'ultraBeast',
  ultrabeasts: 'ultraBeast',
  ultra: 'ultraBeast',
  ub: 'ultraBeast',
  normal: 'normal',
  common: 'normal',
};

let bySpecies = null;

/** Read the flags off one species index entry. */
function bucketFor(rarity) {
  if (!rarity) return 'normal';
  if (rarity.isMythical) return 'mythical';
  if (rarity.isUltraBeast) return 'ultraBeast';
  if (rarity.isLegendary) return 'legendary';
  return 'normal';
}

/** speciesId -> bucket, built once from the imported index. */
function load() {
  if (bySpecies) return bySpecies;

  if (!fs.existsSync(INDEX_FILE)) {
    throw new Error('Data/Pokemon/index.json is missing. Run "node Utils/importdata.js pokemon".');
  }

  const index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));

  bySpecies = new Map();
  for (const species of index.species) bySpecies.set(species.id, bucketFor(species.rarity));

  return bySpecies;
}

/** The bucket for a species id. Anything unknown is normal. */
function of(speciesId) {
  return load().get(Number(speciesId)) || 'normal';
}

/** Every species id in one bucket. */
function speciesIn(bucket) {
  const ids = [];
  for (const [id, value] of load()) if (value === bucket) ids.push(id);
  return ids;
}

/** Resolve what a player typed to a bucket name, or null. */
function parse(word) {
  return ALIASES[String(word || '').toLowerCase().replace(/[^a-z]/g, '')] || null;
}

/** Drop the cache. Call after re-importing. */
function reload() {
  bySpecies = null;
  return load();
}

module.exports = { BUCKETS, LABELS, COLORS, ALIASES, of, speciesIn, parse, bucketFor, reload };

// `node Utils/rarity.js` - how many species sit in each bucket.
if (require.main === module) {
  load();
  for (const bucket of BUCKETS) {
    console.log(`${LABELS[bucket].padEnd(12)} ${String(speciesIn(bucket).length).padStart(5)}`);
  }
}
