'use strict';

/**
 * Tile names in the Tuxemon tilesets: "<sheet><id>", where the sheet letter is
 * o = core_outdoor, b = core_buildings, s = core_set_pieces (the browser's
 * world.js knows where each sheet is).
 *
 * Ids were read off Tuxemon's own .tmx maps rather than guessed from the
 * sheets.
 */

const TILES = {
  grass: 'o111',
  tallGrass: 'o1246',
  // A pine: two tiles of top over two of trunk.
  treeTop: ['o1319', 'o1320'],
  treeBottom: ['o1356', 'o1357'],
  // Sand path on grass, as a rectangle.
  path: { tl: 'o116', t: 'o117', tr: 'o118', l: 'o153', c: 'o154', r: 'o155', bl: 'o190', b: 'o191', br: 'o192' },
  // Water's edge on grass, around shallow water.
  shore: { tl: 'o571', t: 'o572', tr: 'o573', l: 'o608', r: 'o610', bl: 'o645', b: 'o646', br: 'o647' },
  shallow: 'o1268',
  deep: 'o941',
  flowers: ['o1482', 'o1556', 'o1704'],
  // A signpost: its post, and its board drawn over the player.
  signPost: 's199',
  signBoard: 's168',
};

/** The blue-roofed shop: a row of roof drawn over the player, then 3 rows. */
const SHOP = {
  above: [['b245', 'b246', 'b247', 'b248', 'b249']],
  body: [
    ['b292', 'b293', 'b294', 'b295', 'b296'],
    ['b339', 'b340', 'b341', 'b342', 'b343'],
    ['b386', 'b387', 'b388', 'b389', 'b390'],
  ],
  door: { dx: 2 },
};

/** The red-roofed house; its door is drawn on, in the last column. */
const HOUSE = {
  above: [['b423', 'b424', 'b425', 'b426', 'b427']],
  body: [
    ['b470', 'b471', 'b472', 'b473', 'b474'],
    ['b517', 'b518', 'b519', 'b520', 'b521'],
    ['b564', 'b565', 'b566', 'b567', 'b568'],
  ],
  overlay: [{ dx: 4, dy: 1, tile: 'b181' }, { dx: 4, dy: 2, tile: 'b228' }],
  door: { dx: 4 },
};

/**
 * What stands in the way of each field move, as tiles. `top` is drawn on the
 * tile above (over the player), for things two tiles tall.
 */
const OBSTACLES = {
  Cut: { tile: 'o1097', top: 'o1060', says: 'This tree looks like it can be CUT down!' },
  Flash: { tile: 'o2194', says: "It's too dark in there to see anything." },
  'Rock Smash': { tile: 'o1208', says: "It's a rugged rock, but a POKéMON may be able to smash it." },
  Surf: { tile: 'o941', says: 'The water is dyed a deep blue...' },
  Strength: { tile: 'o1139', says: "It's a big boulder, but a POKéMON may be able to push it aside." },
  'Rock Climb': { tile: 'o1140', says: 'A rocky wall. A POKéMON may be able to climb it.' },
  Waterfall: { tile: 'o941', says: "A wall of water is crashing down with a mighty roar." },
  Dive: { tile: 'o941', says: 'The sea is deep here. A POKéMON may be able to go underwater.' },
  Defog: { tile: 'o1284', says: 'A thick fog hangs here. You can barely see ahead.' },
  Whirlpool: { tile: 'o941', says: "It's a vicious whirlpool! A POKéMON may be able to cross it." },
};

/**
 * A building cut straight out of core_buildings (47 columns): `w` x `h` tiles
 * from column c0, row r0. The top `above` rows are drawn over the player;
 * the door is on the bottom row, `door` tiles in from the left.
 */
function cut(c0, r0, w, h, door, above = 1) {
  const rows = [];
  for (let r = 0; r < h; r++) {
    const row = [];
    for (let c = 0; c < w; c++) row.push(`b${(r0 + r) * 47 + c0 + c}`);
    rows.push(row);
  }
  return { above: rows.slice(0, above), body: rows.slice(above), door: { dx: door } };
}

/** Every building used, by what it is. */
const BUILDINGS = {
  // Small shops, 5 x 4, by roof colour.
  martBlue: SHOP,
  shopYellow: cut(15, 5, 5, 4, 2),
  shopGreen: cut(25, 5, 5, 4, 2),
  shopGrey: cut(5, 5, 5, 4, 2),
  shopWhite: cut(0, 5, 5, 4, 2),
  centerSmall: cut(20, 5, 5, 4, 2),
  // The big POKéMON CENTER, 7 x 8.
  center: cut(0, 26, 7, 8, 4, 2),
  // Office blocks, 7 x 5.
  officeWhite: cut(0, 0, 7, 5, 3),
  officeGrey: cut(7, 0, 7, 5, 3),
  officeGold: cut(14, 0, 7, 5, 3),
  officeCyan: cut(21, 0, 7, 5, 3),
  // Wooden cottages, 5 x 6.
  cottageBrown: cut(7, 19, 5, 6, 3, 2),
  cottageRed: cut(12, 19, 5, 6, 3, 2),
  cottageGrey: cut(17, 19, 5, 6, 3, 2),
  // Brick houses (the old HOUSE), 5 x 4.
  brick: HOUSE,
  // A cafe with a striped awning, 5 x 5.
  cafe: cut(7, 26, 5, 5, 3, 2),
  // The BATTLE TOWER, 9 x 12, and PROF. A's lab, 8 x 10.
  tower: cut(36, 15, 9, 12, 4, 6),
  lab: cut(36, 28, 8, 10, 3, 4),
};

/**
 * The ground of each kind of land: its plain tile, flowers that sit on it,
 * and what walls a route in (pines, rocks, or deep water).
 */
const GROUNDS = {
  grass: { tile: 'o111', flowers: TILES.flowers, border: 'trees' },
  sand: { tile: 'o666', flowers: ['o561', 'o562', 'o632'], border: 'trees' },
  desert: { tile: 'o666', flowers: ['o561', 'o632'], border: 'rocks' },
  dirt: { tile: 'o128', flowers: ['o22', 'o23', 'o93'], border: 'rocks' },
  stone: { tile: 'o136', flowers: ['o30', 'o31', 'o101'], border: 'rocks' },
  snow: { tile: 'o674', flowers: ['o569', 'o570', 'o640'], border: 'trees' },
  water: { tile: 'o1268', flowers: [], border: 'water', terrain: 'shallow' },
};

/** Which ground each biome has. */
const BIOME_GROUND = {
  meadow: 'grass',
  forest: 'grass',
  beach: 'sand',
  coast: 'sand',
  jungle: 'grass',
  'river valley': 'grass',
  mountain: 'dirt',
  cave: 'stone',
  desert: 'desert',
  canyon: 'dirt',
  'open sea': 'water',
  reef: 'water',
  snowfield: 'snow',
  'ice cave': 'stone',
  blizzard: 'snow',
  summit: 'snow',
};

/** Single-tile rocks for rocky borders. */
const ROCKS = ['o1139', 'o1140', 'o1208'];

module.exports = { TILES, SHOP, HOUSE, OBSTACLES, BUILDINGS, GROUNDS, BIOME_GROUND, ROCKS };
