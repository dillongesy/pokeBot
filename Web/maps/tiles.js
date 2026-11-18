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
  // The inner corners (grass off one corner, inside a turn): ise has grass
  // to the south-east, and so on.
  path: {
    tl: 'o116', t: 'o117', tr: 'o118', l: 'o153', c: 'o154', r: 'o155', bl: 'o190', b: 'o191', br: 'o192',
    ise: 'o228', isw: 'o229', ine: 'o265', inw: 'o266',
  },
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
  // The door sits one in from the drainpipe on the right.
  overlay: [{ dx: 3, dy: 1, tile: 'b181' }, { dx: 3, dy: 2, tile: 'b228' }],
  door: { dx: 3 },
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
  // Town houses, 5 x 4, side by side on the sheet: dark brick, two timber,
  // a Japanese-style one with paper screens, and grey stone.
  brickDark: cut(5, 9, 5, 4, 3),
  timber: cut(10, 9, 5, 4, 3),
  timberLight: cut(15, 9, 5, 4, 3),
  shoji: cut(20, 9, 5, 4, 3),
  stone: cut(25, 9, 5, 4, 4),
  // Big timber houses with pitched roofs, 5 x 7.
  lodge: cut(12, 27, 5, 7, 3, 3),
  lodgeRed: cut(17, 27, 5, 7, 3, 3),
  // A big green-roofed hall (the trainer school), 7 x 8.
  hall: cut(0, 18, 7, 8, 4, 2),
  // The BATTLE TOWER, 9 x 13 (spire included), and PROF. A's lab, 8 x 10.
  tower: cut(36, 14, 9, 13, 4, 7),
  lab: cut(36, 28, 8, 10, 3, 4),
};

/**
 * Props from the city sheet (core_city_and_country, "c"): each is rows of
 * tiles, all solid.
 */
const PROPS = {
  // A round fountain, 3 x 3 (animated in the browser).
  fountain: [['c382', 'c383', 'c384'], ['c422', 'c423', 'c424'], ['c462', 'c463', 'c464']],
  // A banner on a pole, 2 x 2 (waves in the browser).
  banner: [['c1163', 'c1164'], ['c1203', 'c1204']],
  // A stone statue on a plinth, 1 x 4.
  statue: [['c890'], ['c930'], ['c970'], ['c1010']],
};

/** City paving: plain concrete, and the stone of the plazas and avenues. */
const PAVING = { concrete: 'c28', stone: 'c63' };

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

/** A low hedge from the city sheet, edge pieces with see-through backs. */
const HEDGE = { tl: 'c521', t: 'c522', tr: 'c523', l: 'c561', r: 'c563', bl: 'c601', b: 'c602', br: 'c603', bush: 'c562' };

module.exports = { TILES, SHOP, HOUSE, OBSTACLES, BUILDINGS, PROPS, PAVING, HEDGE, GROUNDS, BIOME_GROUND, ROCKS };
