'use strict';

/**
 * Reads the generated game content out of Data/.
 *
 * Quests, both shops and the item catalogue are written by the importer.
 * Everything is parsed once and cached, and a missing import produces a clear
 * error.
 */

const fs = require('fs');
const path = require('path');
const movepatches = require('./movepatches');

const DATA = path.join(__dirname, '..', 'Data');

let cache = {};

function readJson(file, what, how) {
  if (!fs.existsSync(file)) {
    throw new Error(`${what} has not been imported yet. Run "${how}".`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Drop every cached file. Call after re-importing. */
function reload() {
  cache = {};
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/**
 * Every imported item, keyed by slug.
 *
 * Built from Data/Items/index.json plus each item's data.json.
 */
function items() {
  if (cache.items) return cache.items;

  const index = readJson(
    path.join(DATA, 'Items', 'index.json'),
    'Items',
    'node Utils/importdata.js items'
  );

  const map = new Map();
  for (const entry of index.entries) {
    map.set(entry.name, { ...entry, dir: path.join(DATA, 'Items', entry.folder) });
  }

  cache.items = map;
  return map;
}

/**
 * Items the shop defines itself, because PokeAPI has none.
 *
 * Keyed by slug, in the same shape as an imported item.
 */
function customItems() {
  if (cache.customItems) return cache.customItems;

  const map = new Map();

  // The shop may not be imported yet (importing it looks items up), so a
  // missing Data/Shop must not break item lookups.
  let sections;
  try {
    sections = shop().sections || [];
  } catch {
    return map;
  }

  for (const section of sections) {
    for (const entry of section.items || []) {
      if (entry.define) map.set(entry.item, { name: entry.item, ...entry.define, custom: true });
    }
  }

  cache.customItems = map;
  return map;
}

/**
 * One item's full record, or null.
 *
 * A shop `define` block overrides the imported item with the same slug, so
 * items that work differently here (e.g. Max Repel) are described correctly.
 *
 * Anything else is read from its data.json on first use.
 */
function item(slug) {
  const defined = customItems().get(slug);
  if (defined) return defined;

  const entry = items().get(slug);
  if (!entry) return null;

  if (!entry.full) {
    const file = path.join(entry.dir, 'data.json');
    entry.full = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  }

  return { ...entry.full, name: entry.name, displayName: entry.displayName, dir: entry.dir };
}

/**
 * The imported PokeAPI record for an item, ignoring any shop `define` block.
 *
 * A `define` block only carries a name, description and effect, so code that
 * needs real PokeAPI fields must use this. For example, the plates are
 * defined by the shop (they change Arceus's form), but Utils/battleeffects.js
 * needs their PokeAPI category and effect to apply the type boost.
 *
 * Use this for item facts; use item() for how the bot describes an item.
 */
function importedItem(slug) {
  const entry = items().get(slug);
  if (!entry) return null;

  if (!entry.full) {
    const file = path.join(entry.dir, 'data.json');
    entry.full = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  }

  return { ...entry.full, name: entry.name, displayName: entry.displayName, dir: entry.dir };
}

/** An item's sprite path, or null if it has none. */
function itemSprite(slug) {
  const entry = items().get(slug);
  if (!entry) return null;
  const file = path.join(entry.dir, 'sprite.png');
  return fs.existsSync(file) ? file : null;
}

// ---------------------------------------------------------------------------
// Moves and types
// ---------------------------------------------------------------------------

/**
 * Read one of the indexed Data/ folders that hold a record per id.
 *
 * Moves and Types use the same layout as Items: an index.json of stubs and a
 * data.json per folder. Full records are loaded lazily and cached.
 */
function indexed(folder, key) {
  if (cache[key]) return cache[key];

  const index = readJson(
    path.join(DATA, folder, 'index.json'),
    folder,
    `node Utils/importdata.js ${key}`
  );

  const map = new Map();
  for (const entry of index.entries) {
    map.set(entry.name, { ...entry, dir: path.join(DATA, folder, entry.folder) });
  }

  cache[key] = map;
  return map;
}

function readIndexed(map, name) {
  const entry = map.get(name);
  if (!entry) return null;

  if (!entry.full) {
    const file = path.join(entry.dir, 'data.json');
    entry.full = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  }

  return { ...entry.full, name: entry.name, displayName: entry.displayName, dir: entry.dir };
}

/** Every move, as stubs. `move(name)` reads the full record. */
const moves = () => indexed('Moves', 'moves');

/** One move's full record - power, accuracy, PP, type, damage class - or null. */
const move = (name) => movepatches.apply(readIndexed(moves(), name));

/** Every type, as stubs. `type(name)` reads the full record. */
const types = () => indexed('Types', 'types');

/**
 * One type's full record, including `damageRelations`.
 */
const type = (name) => readIndexed(types(), name);

/** Every berry, as stubs. `berry(name)` reads the full record. */
const berries = () => indexed('Berries', 'berries');

/**
 * One berry's record - flavours, growth, and the two fields Natural Gift needs.
 *
 * Indexed by bare name ("cheri"), not the item slug ("cheri-berry"), so
 * callers with an item slug must strip the suffix first.
 */
const berry = (name) => readIndexed(berries(), name);

// ---------------------------------------------------------------------------
// Shops
// ---------------------------------------------------------------------------

/**
 * Every shop price, multiplied by rates.priceScale.
 *
 * Scaled here rather than in the generated data. Both the shop display and
 * purchases read through this, so they always agree on prices.
 */
function scalePrices(raw) {
  const { priceScale } = require('./rates');
  if (!priceScale || priceScale === 1) return raw;

  return {
    ...raw,
    sections: (raw.sections || []).map((section) => ({
      ...section,
      items: (section.items || []).map((item) =>
        item.price ? { ...item, price: Math.max(1, Math.round(item.price * priceScale)) } : item
      ),
    })),
  };
}

function shop() {
  if (!cache.shop) {
    cache.shop = scalePrices(
      readJson(path.join(DATA, 'Shop', 'data.json'), 'The shop', 'npm run import:content')
    );
  }
  return cache.shop;
}

function goldShop() {
  if (!cache.goldShop) {
    cache.goldShop = readJson(
      path.join(DATA, 'GoldShop', 'data.json'),
      'The gold shop',
      'npm run import:content'
    );
  }
  return cache.goldShop;
}

/**
 * Look up something for sale by id, in either shop.
 *
 * Returns the entry along with which shop it came from and its price.
 */
function findForSale(id) {
  const wanted = String(id || '').toLowerCase().trim();
  if (!wanted) return null;

  for (const section of shop().sections || []) {
    for (const entry of section.items || []) {
      if (entry.item === wanted) {
        return {
          shop: 'coins',
          currency: 'coins',
          id: entry.item,
          price: entry.price,
          section: section.name,
          entry,
        };
      }
    }
  }

  for (const entry of goldShop().items || []) {
    if (entry.id === wanted) {
      return {
        shop: 'gold',
        currency: 'gold',
        id: entry.id,
        price: entry.price,
        section: 'Gold Shop',
        entry,
      };
    }
  }

  // "critical-drop" alone means the next unowned tier; the caller resolves it.
  const ladder = goldTiers(wanted);
  if (ladder.length) return { shop: 'gold', currency: 'gold', ladder: wanted, tiers: ladder };

  return null;
}

/**
 * Every tier of a stacking gold-shop buff, lowest first.
 *
 * Matched on the id prefix ("critical-drop" finds critical-drop-1..4) or the
 * buff name ("crit_drop"). Returns an empty list for non-tiered buffs.
 */
function goldTiers(name) {
  const wanted = String(name || '').toLowerCase().trim();
  if (!wanted) return [];

  return (goldShop().items || [])
    .filter(
      (entry) =>
        entry.tier != null &&
        (entry.buff === wanted || entry.id.startsWith(`${wanted}-`))
    )
    .sort((a, b) => a.tier - b.tier);
}

// ---------------------------------------------------------------------------
// Quests
// ---------------------------------------------------------------------------

function quests() {
  if (cache.quests) return cache.quests;

  const index = readJson(
    path.join(DATA, 'Quests', 'index.json'),
    'Quests',
    'npm run import:content'
  );

  cache.quests = index.quests.map((entry) =>
    JSON.parse(fs.readFileSync(path.join(DATA, 'Quests', entry.folder, 'data.json'), 'utf8'))
  );

  return cache.quests;
}

function quest(id) {
  return quests().find((q) => q.id === id) || null;
}

module.exports = {
  DATA,
  reload,
  items,
  item,
  importedItem,
  itemSprite,
  moves,
  move,
  types,
  type,
  berries,
  berry,
  shop,
  goldShop,
  goldTiers,
  findForSale,
  customItems,
  quests,
  quest,
};
