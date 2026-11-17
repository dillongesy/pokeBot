'use strict';

/**
 * The hand-made places: the way from home to the Main City.
 *
 *   Town 1 (your house, Professor A's lab) -> Path a -> Town 2 -> Path b
 *   -> the Main City
 *
 * The Main City is where everyone ends up: the Battle Tower in the middle
 * (milestones), the Drop Station, a POKéMON CENTER, a MART, and eight gates
 * out, one per region of the milestone ladder, clockwise from the north as on
 * the world map. Each gate leads to the first route of its region
 * (routegen.js).
 *
 * Names are placeholders until the real ones are chosen.
 */

const { MapBuilder } = require('./builder');
const { TILES, BUILDINGS } = require('./tiles');
const worldplan = require('../worldplan');

const CITY_W = 52;
const CITY_H = 46;

/**
 * The eight gates: the two exit tiles on the city's edge, and where you stand
 * coming back in. Clockwise from the north.
 */
const GATES = {
  1: { tiles: [[36, 0], [37, 0]], inside: [{ x: 36, y: 2, facing: 'down' }, { x: 37, y: 2, facing: 'down' }] },
  2: { tiles: [[51, 12], [51, 13]], inside: [{ x: 49, y: 12, facing: 'left' }, { x: 49, y: 13, facing: 'left' }] },
  3: { tiles: [[51, 32], [51, 33]], inside: [{ x: 49, y: 32, facing: 'left' }, { x: 49, y: 33, facing: 'left' }] },
  4: { tiles: [[36, 45], [37, 45]], inside: [{ x: 36, y: 43, facing: 'up' }, { x: 37, y: 43, facing: 'up' }] },
  5: { tiles: [[14, 45], [15, 45]], inside: [{ x: 14, y: 43, facing: 'up' }, { x: 15, y: 43, facing: 'up' }] },
  6: { tiles: [[0, 32], [0, 33]], inside: [{ x: 2, y: 32, facing: 'right' }, { x: 2, y: 33, facing: 'right' }] },
  7: { tiles: [[0, 12], [0, 13]], inside: [{ x: 2, y: 12, facing: 'right' }, { x: 2, y: 13, facing: 'right' }] },
  8: { tiles: [[14, 0], [15, 0]], inside: [{ x: 14, y: 2, facing: 'down' }, { x: 15, y: 2, facing: 'down' }] },
};

/** The gaps in the city's border pines (2x2 cells), for the gates and the road in. */
const CITY_GAPS = [[18, 0], [25, 6], [25, 16], [18, 22], [7, 22], [0, 16], [0, 6], [7, 0], [13, 22]];

/** What the people in a POKéMON CENTER and a MART say. */
const NURSE = [
  'Welcome to our POKéMON CENTER!',
  'Your POKéMON are fighting fit! If you are ever out of usable POKéMON, you will wake up here.',
  'We hope to see you again!',
];
const CLERK = [
  'Welcome! How may I serve you?',
  'Our stock is the same as the .shop on Discord. Buy with .buy there for now. A counter here is on its way!',
];

/** Doors that only lead to a chat: keep them, with what's said. Doors to nothing are walls. */
const finish = (map) => {
  const built = map.build();
  built.doors = built.doors.filter((d) => d.station || d.lines);
  return built;
};

function flowers(map, spots) {
  const kinds = map.ground.flowers.length ? map.ground.flowers : TILES.flowers;
  spots.forEach(([x, y], i) => map.set('objects', x, y, kinds[i % kinds.length]));
}

/** A little pond: a shallow rim you can wade, deep water in the middle when it's big enough. */
function pond(map, x0, y0, w, h) {
  map.rect('ground', TILES.shore, x0, y0, w, h, TILES.shallow);
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) map.terrain[y][x] = 'shallow';
  if (w >= 5 && h >= 4) {
    for (let y = y0 + 1; y < y0 + h - 1; y++) {
      for (let x = x0 + 1; x < x0 + w - 1; x++) {
        map.set('ground', x, y, TILES.deep).block(x, y);
        map.terrain[y][x] = 'deep';
      }
    }
  }
}

/** The lab's front steps (the bottom of the stair tiles under its door). */
function labSteps(map, x, y) {
  for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) map.set('objects', x + c, y + r, `b${(38 + r) * 47 + 38 + c}`);
}

// ---------------------------------------------------------------------------

function town1() {
  const map = new MapBuilder({ id: 'town-1', name: 'Town 1', kind: 'town', width: 26, height: 28 });
  map.encounterRate = 0;
  map.border([[6, 13]]);

  // Your house (top left) and the rival's (top right): PROF. A's family home.
  map.building(BUILDINGS.cottageRed, 4, 3, { station: 'home' });
  // {PLAYER} becomes the player's name in the browser.
  map.sign(9, 9, ["{PLAYER_POSSESSIVE} HOUSE"]);
  map.building(BUILDINGS.cottageBrown, 16, 3, { station: 'rival', lines: ["It's PROF. A's house. AIDE lives here too."] });
  map.sign(15, 9, ["PROF. A and AIDE'S HOUSE"]);

  // The lab, in the middle, with its front steps.
  map.building(BUILDINGS.lab, 9, 12, { station: 'lab' });
  labSteps(map, 11, 22);
  map.sign(17, 20, ["PROF. A'S POKéMON LAB"]);

  // Paths: out of each front door, across the top, round the lab, out south.
  map.path(6, 9, 3, 3);
  map.path(18, 9, 3, 3);
  map.path(3, 11, 21, 3);
  map.path(3, 13, 3, 12);
  map.path(3, 23, 12, 3);
  map.path(11, 23, 4, 5);

  pond(map, 19, 14, 5, 5);
  flowers(map, [[2, 9], [3, 9], [10, 10], [14, 10], [21, 10], [7, 17], [7, 19], [17, 24], [19, 22], [3, 21], [16, 25]]);
  map.npc({
    id: 'neighbor', name: 'Neighbor', sprite: 'granny', x: 8, y: 24, facing: 'down',
    lines: ["Oh, you're off on a journey? How exciting!", 'The MAIN CITY is south, past TOWN 2. Everyone ends up there sooner or later.'],
  });
  map.warp(12, 27, { map: 'path-a', x: 12, y: 1, facing: 'down' });
  map.warp(13, 27, { map: 'path-a', x: 13, y: 1, facing: 'down' });
  // At the foot of the lab's steps, where the professor leaves you.
  map.spawn = { x: 12, y: 23, facing: 'down' };
  return finish(map);
}

/** A trainer on the way to the MAIN CITY: easy, with Pokemon about the starter's level. */
const introTrainer = (t) => ({ sight: 4, ...t });

function pathA() {
  const map = new MapBuilder({ id: 'path-a', name: 'Path a', kind: 'route', width: 26, height: 40, levels: { lo: 2, hi: 4 }, background: 'grass' });
  map.border([[6, 0], [6, 19]]);
  map.sign(10, 3, ['PATH A', 'North: TOWN 1   South: TOWN 2']);

  // Down from TOWN 1, then west along a wall of trees.
  map.path(11, 0, 4, 7);
  map.path(4, 5, 11, 3);
  map.path(4, 5, 3, 14);
  map.tree(8, 7);
  map.tree(8, 9);
  map.tree(8, 11);
  // A field of grass to the east, behind the trees: wild POKéMON forever.
  map.grass(14, 7, 8, 5);
  flowers(map, [[11, 8], [11, 10], [12, 12], [22, 13], [3, 8]]);

  // A ledge: hop down anywhere, but the way back up is the path.
  map.ledge(2, 14, 2);
  map.ledge(7, 14, 17);

  // Grass right across the way: one battle, low-level.
  map.patch('a1', 2, 16, 22, 2, 2, 3);

  // East, past a YOUNGSTER who's watching the path.
  map.path(4, 19, 18, 3);
  map.trainer(introTrainer({
    id: 'youngster', name: 'Youngster 1', sprite: 'cooldude', x: 22, y: 20, facing: 'left', sight: 6,
    team: [{ species: 19, level: 3 }, { species: 16, level: 2 }],
    before: ["Hey! I just got my first POKéMON too! Let's battle!"],
  }));

  // South past a meadow, with something lying in the grass.
  map.path(19, 19, 3, 13);
  map.grass(4, 23, 10, 6);
  map.item(4, 25, 'path-a-berry', { item: 'oran-berry' });
  map.ledge(14, 27, 4);
  pond(map, 3, 31, 5, 4);

  // Back west to the way out.
  map.path(11, 30, 11, 3);
  map.path(11, 30, 4, 10);
  flowers(map, [[16, 34], [17, 36], [9, 35], [10, 37], [22, 33]]);

  map.warp(12, 0, { map: 'town-1', x: 12, y: 26, facing: 'up' });
  map.warp(13, 0, { map: 'town-1', x: 13, y: 26, facing: 'up' });
  map.warp(12, 39, { map: 'town-2', x: 12, y: 1, facing: 'down' });
  map.warp(13, 39, { map: 'town-2', x: 13, y: 1, facing: 'down' });
  map.spawn = { x: 12, y: 1, facing: 'down' };
  return finish(map);
}

function town2() {
  const map = new MapBuilder({ id: 'town-2', name: 'Town 2', kind: 'town', width: 26, height: 24 });
  map.encounterRate = 0;
  map.border([[6, 0], [6, 11]]);
  map.path(11, 0, 4, 24);

  map.building(BUILDINGS.center, 3, 3, { station: 'center' });
  map.path(5, 11, 7, 3);
  map.building(BUILDINGS.martBlue, 17, 4, { station: 'mart' });
  map.path(14, 8, 8, 3);
  map.building(BUILDINGS.cottageGrey, 17, 13, { lines: ['Hello! We moved here from the MAIN CITY. It was too busy for us!'] });
  map.path(14, 19, 9, 3);
  map.building(BUILDINGS.brick, 3, 15, { lines: ['My son went to the BATTLE TOWER. He says the routes outside the gates are tough!'] });
  map.path(5, 19, 7, 3);

  map.sign(10, 3, ['TOWN 2', 'The last stop before the MAIN CITY.']);
  map.sign(9, 14, ['POKéMON CENTER', 'If you white out, you wake up at the last one you visited.']);
  flowers(map, [[10, 7], [2, 13], [23, 11], [16, 22], [22, 22], [9, 22], [3, 21]]);
  map.npc({
    id: 'youngster', name: 'Youngster', sprite: 'cooldude_blue', x: 9, y: 16, facing: 'right',
    lines: ['The MAIN CITY has eight gates. Each one leads to a different kind of land!', 'You can only take on the next gate once the one before it is done, though.'],
  });
  map.npc({
    id: 'gardener', name: 'Gardener', sprite: 'florist', x: 22, y: 10, facing: 'left',
    lines: ['Tall grass right across a path always has a POKéMON in it. Exactly one!'],
  });
  map.warp(12, 0, { map: 'path-a', x: 12, y: 38, facing: 'up' });
  map.warp(13, 0, { map: 'path-a', x: 13, y: 38, facing: 'up' });
  map.warp(12, 23, { map: 'path-b', x: 12, y: 1, facing: 'down' });
  map.warp(13, 23, { map: 'path-b', x: 13, y: 1, facing: 'down' });
  map.spawn = { x: 7, y: 12, facing: 'down' };
  return finish(map);
}

function pathB() {
  const map = new MapBuilder({ id: 'path-b', name: 'Path b', kind: 'route', width: 26, height: 40, levels: { lo: 3, hi: 5 }, background: 'grass' });
  map.border([[6, 0], [6, 19]]);
  map.sign(10, 3, ['PATH B', 'North: TOWN 2   South: MAIN CITY']);

  // Down and east, past a LASS in the flowers.
  map.path(11, 0, 4, 9);
  map.path(11, 7, 11, 3);
  map.path(19, 7, 3, 9);
  flowers(map, [[15, 4], [16, 5], [17, 4], [18, 5], [9, 6], [22, 10]]);
  map.trainer(introTrainer({
    id: 'lass', name: 'Lass 1', sprite: 'heroine', x: 22, y: 12, facing: 'left', sight: 3,
    team: [{ species: 43, level: 4 }, { species: 29, level: 4 }],
    before: ['Ooh, a new trainer! Show me your POKéMON!'],
  }));
  map.grass(3, 8, 7, 5);

  // A stream across the way, waded at the ford.
  for (let x = 2; x < 24; x++) {
    for (let y = 17; y < 19; y++) {
      const ford = x >= 18 && x <= 21;
      map.set('ground', x, y, ford ? TILES.shallow : TILES.deep);
      map.terrain[y][x] = ford ? 'shallow' : 'deep';
      if (!ford) map.block(x, y);
    }
  }
  map.path(19, 15, 3, 2);
  map.path(19, 19, 3, 3);

  // One patch of grass right across, then west to the city.
  map.patch('b1', 2, 22, 22, 2, 2, 4);
  map.path(11, 24, 11, 3);
  map.path(11, 24, 4, 16);
  map.ledge(2, 29, 9);
  map.ledge(15, 29, 9);
  map.grass(15, 31, 8, 5);
  map.tree(4, 32);
  map.tree(6, 32);
  map.sign(10, 35, ['MAIN CITY AHEAD', 'Home of the BATTLE TOWER.']);
  flowers(map, [[3, 26], [4, 27], [8, 37], [17, 38], [22, 27]]);

  map.warp(12, 0, { map: 'town-2', x: 12, y: 22, facing: 'up' });
  map.warp(13, 0, { map: 'town-2', x: 13, y: 22, facing: 'up' });
  map.warp(12, 39, { map: 'main-city', x: 26, y: 42, facing: 'up' });
  map.warp(13, 39, { map: 'main-city', x: 27, y: 42, facing: 'up' });
  map.spawn = { x: 12, y: 1, facing: 'down' };
  return finish(map);
}

function mainCity() {
  const map = new MapBuilder({ id: 'main-city', name: 'Main City', kind: 'town', width: CITY_W, height: CITY_H, background: 'stadium' });
  map.encounterRate = 0;
  map.border(CITY_GAPS);

  // A paved plaza, and roads out to every gate.
  map.path(4, 4, CITY_W - 8, CITY_H - 8);
  for (const g of Object.values(GATES)) {
    const [[x, y]] = g.tiles;
    if (y === 0) map.path(x - 1, 0, 4, 5);
    else if (y === CITY_H - 1) map.path(x - 1, CITY_H - 5, 4, 5);
    else if (x === 0) map.path(0, y - 1, 5, 4);
    else map.path(CITY_W - 5, y - 1, 5, 4);
  }
  map.path(25, CITY_H - 5, 4, 5);

  // The Battle Tower in the middle.
  map.building(BUILDINGS.tower, 22, 14, { station: 'battle' });
  map.sign(21, 25, ['BATTLE TOWER', 'Every milestone is fought here.']);

  map.building(BUILDINGS.shopYellow, 6, 5, { station: 'drop' });
  map.sign(11, 8, ['DROP STATION', 'Drop a wild Pokemon, then catch it by name.']);
  map.building(BUILDINGS.martBlue, 17, 5, { station: 'mart' });
  map.building(BUILDINGS.center, 40, 3, { station: 'center' });
  map.sign(39, 10, ['POKéMON CENTER']);

  map.building(BUILDINGS.officeWhite, 40, 16, { lines: ['This is the office of the BATTLE TOWER. Every challenger is recorded here.'] });
  map.building(BUILDINGS.officeGrey, 40, 24, { lines: ['We plan the routes past the gates. Every trainer out there is placed just so.'] });
  map.building(BUILDINGS.officeGold, 5, 16, {});
  map.building(BUILDINGS.officeCyan, 5, 24, {});
  map.building(BUILDINGS.cafe, 17, 34, { room: 'cotton_cafe', lines: ['Welcome to the cafe! Trainers come here after a long day on the routes.'] });
  map.building(BUILDINGS.cottageBrown, 30, 35, { lines: ['I grew up in this city. It has grown so big since the BATTLE TOWER went up!'] });
  map.building(BUILDINGS.brick, 5, 37, {});

  map.tree(18, 28);
  map.tree(32, 28);
  map.tree(18, 11);
  map.tree(32, 11);
  flowers(map, [[6, 13], [7, 14], [45, 14], [46, 15], [6, 30], [46, 30], [21, 30], [30, 30], [12, 41], [40, 41]]);

  // The gates, each with a sign saying where it goes.
  for (const gate of worldplan.plan().gates) {
    const g = GATES[gate.number];
    const first = gate.routes[0].number;
    // Gate 1 is open from the start; the rest once the region before is done.
    const requires = first > 1 ? { route: first - 1 } : undefined;
    g.tiles.forEach(([x, y], i) => map.warp(x, y, { map: `route-${first}`, x: 8 + i, y: 1, facing: 'down', requires }));
    const [[tx, ty]] = g.tiles;
    const sx = ty === 0 ? tx - 2 : ty === CITY_H - 1 ? tx + 3 : tx === 0 ? 5 : CITY_W - 6;
    const sy = ty === 0 ? 5 : ty === CITY_H - 1 ? CITY_H - 6 : tx === 0 ? ty - 2 : ty + 3;
    map.sign(sx, sy, [`GATE ${gate.number}: ROUTES ${gate.milestones[0]}-${gate.milestones[1]}`, `${gate.region} ladder · ${gate.biomes.join(', ')}`]);
  }

  // In from Path b, at the bottom middle.
  map.warp(26, 45, { map: 'path-b', x: 12, y: 38, facing: 'up' });
  map.warp(27, 45, { map: 'path-b', x: 13, y: 38, facing: 'up' });

  map.npc({
    id: 'taxi', name: 'Taxi Driver', sprite: 'riverboatcaptain', x: 23, y: 39, facing: 'down',
    lines: ["My FARFETCH'D taxi flies anywhere you've been! Press M to FLY."],
  });
  map.npc({
    id: 'veteran', name: 'Veteran', sprite: 'knightlord', x: 20, y: 27, facing: 'down',
    lines: ['Fill your TRAINER EXP bar on the routes, then come back here for your milestone.', 'Each one beaten opens the next route.'],
  });
  map.npc({
    id: 'tourist', name: 'Tourist', sprite: 'fashionista', x: 33, y: 20, facing: 'left',
    lines: ['I came all this way to see the BATTLE TOWER. It is even taller than I imagined!'],
  });
  map.npc({
    id: 'worker', name: 'Office Worker', sprite: 'ceo', x: 47, y: 22, facing: 'left',
    lines: ['Some rocks and trees on the routes can only be cleared by POKéMON moves.', 'They open up as you beat more milestones. Worth going back for what is behind them!'],
  });
  map.npc({
    id: 'kid', name: 'Little Girl', sprite: 'childactor_blonde', x: 12, y: 21, facing: 'right',
    lines: ['The trainers on the routes never move. If you can see them, they can see you!'],
  });
  map.spawn = { x: 26, y: 42, facing: 'up' };
  return finish(map);
}

const town1Map = town1();
const town2Map = town2();
const pathAMap = pathA();
const pathBMap = pathB();
const city = mainCity();

/** The FLY scene, the first time you walk into the Main City. */
const FLY_SCENE = [
  "TAXI DRIVER: Oh no, oh no! My FARFETCH'D flew off again!",
  '...Huh? You found it hiding behind the BATTLE TOWER? Thank you!',
  "My FARFETCH'D is a taxi. It can FLY you to any place you've been before.",
  'Take it whenever you like. Just press M (or the FLY button) to choose where to go!',
];

module.exports = { maps: [town1Map, pathAMap, town2Map, pathBMap, city], GATES, FLY_SCENE, NURSE, CLERK, finish, flowers, pond };
