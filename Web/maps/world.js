'use strict';

/**
 * The hand-made places: the way from home to the Main City.
 *
 *   Town 1 (your house, Professor A's lab) -> Path a -> Town 2 -> Path b
 *   -> the Main City, from south to north as on the Town Map
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
const { TILES, BUILDINGS, PROPS, PAVING } = require('./tiles');
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
  // Home is the south end of the world: the only way out is north.
  map.border([[6, 0]]);

  // The street north out of town, and the two streets across it.
  map.path(11, 0, 4, 26);
  map.path(3, 14, 20, 3);
  map.path(3, 23, 20, 3);
  map.sign(10, 3, ['TOWN 1', 'North: PATH A to TOWN 2 and the MAIN CITY']);

  // PROF. A's lab, up by the road north, with its front steps.
  map.building(BUILDINGS.lab, 16, 4, { station: 'lab' });
  labSteps(map, 18, 14);
  map.sign(15, 12, ["PROF. A'S POKéMON LAB"]);

  // Your house and the rival's (PROF. A's family home), on the south street.
  map.building(BUILDINGS.cottageRed, 4, 17, { station: 'home' });
  // {PLAYER_POSSESSIVE} becomes the player's name in the browser.
  map.sign(9, 22, ['{PLAYER_POSSESSIVE} HOUSE']);
  map.building(BUILDINGS.cottageBrown, 15, 17, { station: 'rival', lines: ["It's PROF. A's house. AIDE lives here too."] });
  map.sign(20, 22, ["PROF. A and AIDE'S HOUSE"]);

  pond(map, 3, 4, 5, 5);
  map.tree(21, 18);
  flowers(map, [[8, 6], [9, 8], [3, 11], [5, 12], [8, 10], [10, 19], [3, 20], [20, 20], [22, 21], [16, 2], [21, 2]]);
  map.npc({
    id: 'neighbor', name: 'Neighbor', sprite: 'granny', x: 6, y: 12, facing: 'down',
    lines: ["Oh, you're off on a journey? How exciting!", 'The MAIN CITY is north, past TOWN 2. Everyone ends up there sooner or later.'],
  });
  map.warp(12, 0, { map: 'path-a', x: 12, y: 38, facing: 'up' });
  map.warp(13, 0, { map: 'path-a', x: 13, y: 38, facing: 'up' });
  // At the foot of the lab's steps, where the professor leaves you.
  map.spawn = { x: 19, y: 16, facing: 'down' };
  return finish(map);
}

/** A trainer on the way to the MAIN CITY: easy, with Pokemon about the starter's level. */
const introTrainer = (t) => ({ sight: 4, ...t });

/**
 * PATH A, walked south to north. Ledges only hop south, so they're short
 * cuts home, never a way round the grass.
 */
function pathA() {
  const map = new MapBuilder({ id: 'path-a', name: 'Path a', kind: 'route', width: 26, height: 40, levels: { lo: 2, hi: 4 }, background: 'grass' });
  map.border([[6, 0], [6, 19]]);
  map.sign(10, 37, ['PATH A', 'North: TOWN 2   South: TOWN 1']);

  // Up from TOWN 1, then west.
  map.path(11, 31, 4, 9);
  map.path(4, 31, 11, 3);
  pond(map, 16, 33, 5, 4);
  flowers(map, [[8, 35], [9, 37], [16, 30], [22, 31], [3, 36]]);
  map.tree(7, 27);
  map.tree(9, 27);

  // North up the west side, through grass that covers the way: one battle.
  map.path(4, 19, 3, 14);
  map.ledge(15, 29, 9);
  map.patch('a1', 2, 24, 22, 2, 2, 3);

  // East along a row of trees, past a YOUNGSTER watching the path.
  map.path(4, 19, 18, 3);
  map.tree(8, 16);
  map.tree(12, 16);
  map.trainer(introTrainer({
    id: 'youngster', name: 'Youngster 1', sprite: 'cooldude', x: 22, y: 20, facing: 'left', sight: 6,
    team: [{ species: 19, level: 3 }, { species: 16, level: 2 }],
    before: ["Hey! I just got my first POKéMON too! Let's battle!"],
  }));

  // North again past a meadow, with something lying in the grass.
  map.path(19, 5, 3, 16);
  map.grass(4, 7, 10, 7);
  map.item(5, 9, 'path-a-berry', { item: 'oran-berry' });
  map.ledge(14, 14, 5);
  flowers(map, [[15, 9], [16, 11], [22, 8], [22, 12], [3, 15]]);

  // Back west to the way out.
  map.path(11, 4, 11, 3);
  map.path(11, 0, 4, 7);

  map.warp(12, 39, { map: 'town-1', x: 12, y: 1, facing: 'down' });
  map.warp(13, 39, { map: 'town-1', x: 13, y: 1, facing: 'down' });
  map.warp(12, 0, { map: 'town-2', x: 12, y: 22, facing: 'up' });
  map.warp(13, 0, { map: 'town-2', x: 13, y: 22, facing: 'up' });
  map.spawn = { x: 12, y: 38, facing: 'up' };
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

  map.sign(10, 22, ['TOWN 2', 'The last stop before the MAIN CITY, to the north.']);
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
  map.warp(12, 23, { map: 'path-a', x: 12, y: 1, facing: 'down' });
  map.warp(13, 23, { map: 'path-a', x: 13, y: 1, facing: 'down' });
  map.warp(12, 0, { map: 'path-b', x: 12, y: 38, facing: 'up' });
  map.warp(13, 0, { map: 'path-b', x: 13, y: 38, facing: 'up' });
  map.spawn = { x: 7, y: 12, facing: 'down' };
  return finish(map);
}

/** PATH B, south to north: over a stream at the ford, then up to the MAIN CITY. */
function pathB() {
  const map = new MapBuilder({ id: 'path-b', name: 'Path b', kind: 'route', width: 26, height: 40, levels: { lo: 3, hi: 5 }, background: 'grass' });
  map.border([[6, 0], [6, 19]]);
  map.sign(10, 37, ['PATH B', 'North: MAIN CITY   South: TOWN 2']);

  // Up from TOWN 2 and east.
  map.path(11, 32, 4, 8);
  map.path(11, 32, 11, 3);
  flowers(map, [[15, 36], [16, 37], [17, 36], [18, 37], [9, 34], [22, 36]]);
  map.grass(3, 30, 7, 5);
  map.ledge(2, 29, 9);

  // North up the east side: grass right across the way (one battle), then a
  // LASS in the flowers.
  // (The path stops either side of the ford, so the water shows.)
  map.path(19, 22, 3, 13);
  map.path(19, 15, 3, 5);
  map.patch('b1', 2, 26, 22, 2, 2, 4);
  map.trainer(introTrainer({
    id: 'lass', name: 'Lass 1', sprite: 'heroine', x: 22, y: 24, facing: 'left', sight: 3,
    team: [{ species: 43, level: 4 }, { species: 29, level: 4 }],
    before: ['Ooh, a new trainer! Show me your POKéMON!'],
  }));

  // A stream across the way, waded at the ford.
  for (let x = 2; x < 24; x++) {
    for (let y = 20; y < 22; y++) {
      const ford = x >= 18 && x <= 21;
      map.set('ground', x, y, ford ? TILES.shallow : TILES.deep);
      map.terrain[y][x] = ford ? 'shallow' : 'deep';
      if (!ford) map.block(x, y);
    }
  }

  // West along the far bank, then north to the city.
  map.path(11, 15, 11, 3);
  map.grass(3, 7, 7, 7);
  map.tree(4, 16);
  map.tree(6, 16);
  map.ledge(15, 12, 9);
  map.grass(15, 6, 8, 5);
  map.path(11, 0, 4, 18);
  map.sign(10, 4, ['MAIN CITY AHEAD', 'Home of the BATTLE TOWER.']);
  flowers(map, [[3, 18], [8, 18], [16, 3], [22, 4], [9, 5]]);

  map.warp(12, 39, { map: 'town-2', x: 12, y: 1, facing: 'down' });
  map.warp(13, 39, { map: 'town-2', x: 13, y: 1, facing: 'down' });
  map.warp(12, 0, { map: 'main-city', x: 26, y: 42, facing: 'up' });
  map.warp(13, 0, { map: 'main-city', x: 27, y: 42, facing: 'up' });
  map.spawn = { x: 12, y: 38, facing: 'up' };
  return finish(map);
}

/** Lay a tile over a rectangle of the ground. */
function pave(map, tile, x0, y0, w, h) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) map.set('ground', x, y, tile);
}

/** A prop from the city sheet, solid. */
function prop(map, rows, x0, y0) {
  rows.forEach((row, dy) => row.forEach((tile, dx) => map.set('objects', x0 + dx, y0 + dy, tile).block(x0 + dx, y0 + dy)));
}

/** A little park: a lawn with a pine or two and flowers. */
function park(map, x0, y0, w, h, trees = [], flowerSpots = []) {
  pave(map, TILES.grass, x0, y0, w, h);
  trees.forEach(([x, y]) => map.tree(x, y));
  flowers(map, flowerSpots);
}

/**
 * The MAIN CITY: a grid of stone avenues round the BATTLE TOWER, each one
 * running out to a gate; concrete pavements; blocks of shops, offices and
 * homes; parks; and plenty of people about.
 */
function mainCity() {
  const map = new MapBuilder({
    id: 'main-city', name: 'Main City', kind: 'town', width: CITY_W, height: CITY_H, background: 'stadium',
    ground: { tile: PAVING.concrete, flowers: [], border: 'trees' },
  });
  map.encounterRate = 0;
  // Grass under the pines round the edge.
  pave(map, TILES.grass, 0, 0, CITY_W, 2);
  pave(map, TILES.grass, 0, CITY_H - 2, CITY_W, 2);
  pave(map, TILES.grass, 0, 0, 2, CITY_H);
  pave(map, TILES.grass, CITY_W - 2, 0, 2, CITY_H);
  map.border(CITY_GAPS);

  // The avenues: two across, two down, and the road in from PATH B.
  const S = PAVING.stone;
  pave(map, S, 0, 11, CITY_W, 4);
  pave(map, S, 0, 31, CITY_W, 4);
  pave(map, S, 13, 0, 4, CITY_H);
  pave(map, S, 35, 0, 4, CITY_H);
  pave(map, S, 24, 28, 5, CITY_H - 28);
  // The plaza round the tower.
  pave(map, S, 17, 15, 18, 16);

  // The BATTLE TOWER in the middle, with a fountain either side.
  map.building(BUILDINGS.tower, 21, 15, { station: 'battle' });
  map.sign(20, 28, ['BATTLE TOWER', 'Every milestone is fought here.']);
  prop(map, PROPS.fountain, 17, 21);
  prop(map, PROPS.fountain, 32, 21);
  park(map, 17, 15, 3, 3, [], [[17, 17], [19, 17]]);
  park(map, 32, 15, 3, 3, [], [[32, 17], [34, 17]]);
  prop(map, PROPS.statue, 18, 15);
  prop(map, PROPS.statue, 33, 15);
  // Banners either side of the way in.
  prop(map, PROPS.banner, 19, 26);
  prop(map, PROPS.banner, 31, 26);

  // North-west: the POKéMON CENTER.
  map.building(BUILDINGS.center, 3, 3, { station: 'center' });
  park(map, 10, 3, 3, 8, [[10, 4]], [[11, 7], [10, 9], [12, 9]]);
  map.sign(12, 3, ['GATE 8 is north.']);

  // North: the MART, a florist's, a lawn, the DROP STATION.
  map.building(BUILDINGS.martBlue, 17, 7, { station: 'mart' });
  map.building(BUILDINGS.shopWhite, 22, 7, { lines: ['FLORIST: Every flower in the city is grown right here!'] });
  park(map, 17, 2, 18, 5, [[19, 2], [27, 2], [31, 2]], [[17, 4], [18, 5], [22, 4], [23, 5], [24, 3], [25, 5], [29, 4], [33, 5], [34, 3]]);
  park(map, 27, 7, 3, 4, [[27, 8]], [[29, 7], [29, 10]]);
  map.building(BUILDINGS.shopYellow, 30, 7, { station: 'drop' });
  map.sign(34, 6, ['DROP STATION', 'Drop a wild POKéMON, then catch it by name.']);

  // North-east: the TRAINER SCHOOL.
  map.building(BUILDINGS.hall, 40, 3, { lines: ['TEACHER: Welcome to the TRAINER SCHOOL!', 'Lesson one: a POKéMON above your obedience cap will not listen to you in battle.'] });
  park(map, 47, 2, 3, 9, [], [[47, 4], [48, 6], [47, 8]]);
  map.sign(39, 3, ['GATE 1 is north.']);
  map.sign(48, 10, ['GATE 2 is east.']);

  // West: offices and homes.
  map.building(BUILDINGS.officeGold, 4, 15, { lines: ['This is the office of the BATTLE TOWER. Every challenger is recorded here.'] });
  map.building(BUILDINGS.brick, 3, 21, { lines: ['I sell tickets to the BATTLE TOWER... well, I would, if it cost anything!'] });
  map.building(BUILDINGS.brickDark, 8, 21, { lines: ['My grandfather built this house before the TOWER went up.'] });
  map.building(BUILDINGS.officeCyan, 4, 26, { lines: ['We plan the routes past the gates. Every trainer out there is placed just so.'] });
  map.sign(2, 10, ['GATE 7 is west.']);

  // East: more offices and homes.
  map.building(BUILDINGS.officeGrey, 40, 15, { lines: ['Some rocks and trees on the routes can only be cleared by POKéMON moves.', 'They open up as you beat more milestones.'] });
  map.building(BUILDINGS.timber, 39, 21, { lines: ['I just moved here from TOWN 2. The city never sleeps!'] });
  map.building(BUILDINGS.timberLight, 44, 21, { lines: ['My POKéMON loves the fountains in the plaza.'] });
  map.building(BUILDINGS.officeWhite, 40, 26, { lines: ['RECEPTIONIST: This floor is for staff only, sorry!'] });

  // South-west: the cafe and a stone house.
  map.building(BUILDINGS.cafe, 3, 36, { room: 'cotton_cafe', lines: ['Welcome to the cafe! Trainers come here after a long day on the routes.'] });
  map.building(BUILDINGS.stone, 8, 36, { lines: ['They say every gate leads to a land from a different region.'] });
  park(map, 3, 41, 10, 2, [], [[4, 41], [6, 42], [9, 41], [11, 42]]);
  map.sign(3, 35, ['GATE 6 is west.']);
  map.sign(12, 42, ['GATE 5 is south.']);

  // South: two lodges either side of the road in.
  map.building(BUILDINGS.lodge, 18, 35, { lines: ['I grew up in this city. It has grown so big since the BATTLE TOWER went up!'] });
  map.building(BUILDINGS.lodgeRed, 29, 35, { lines: ['Did you come up PATH B? That stream is cold this time of year!'] });
  park(map, 17, 42, 7, 2, [], [[17, 42], [20, 43], [23, 42]]);
  park(map, 29, 42, 6, 2, [], [[30, 43], [33, 42]]);

  // South-east: a quiet street.
  map.building(BUILDINGS.shoji, 39, 36, { lines: ['Please take your shoes off! ...Oh, you are just visiting?'] });
  map.building(BUILDINGS.cottageGrey, 44, 36, { lines: ['The routes past GATE 1 are full of bug POKéMON. Yuck!'] });
  park(map, 39, 41, 5, 2, [], [[40, 41], [42, 42]]);
  map.sign(48, 35, ['GATE 3 is east.']);
  map.sign(39, 42, ['GATE 4 is south.']);

  // The gates, each with a sign saying where it goes.
  for (const gate of worldplan.plan().gates) {
    const g = GATES[gate.number];
    const first = gate.routes[0].number;
    // Gate 1 is open from the start; the rest once the region before is done.
    const requires = first > 1 ? { route: first - 1 } : undefined;
    g.tiles.forEach(([x, y], i) => map.warp(x, y, { map: `route-${first}`, x: 8 + i, y: 1, facing: 'down', requires }));
    const sign = map.signs.find((s) => s.lines[0] === `GATE ${gate.number} is ${['', 'north', 'east', 'east', 'south', 'south', 'west', 'west', 'north'][gate.number]}.`);
    if (sign) sign.lines = [`GATE ${gate.number}: ROUTES ${gate.milestones[0]}-${gate.milestones[1]}`, `${gate.region} ladder · ${gate.biomes.join(', ')}`];
  }

  // In from PATH B, at the bottom middle.
  map.warp(26, 45, { map: 'path-b', x: 12, y: 1, facing: 'down' });
  map.warp(27, 45, { map: 'path-b', x: 13, y: 1, facing: 'down' });

  // People about town.
  map.npc({
    id: 'taxi', name: 'Taxi Driver', sprite: 'riverboatcaptain', x: 23, y: 39, facing: 'down',
    lines: ["My FARFETCH'D taxi flies anywhere you've been! Press M to FLY."],
  });
  const folk = [
    ['veteran', 'Veteran', 'knightlord', 20, 29, ['Fill your TRAINER EXP bar on the routes, then come back here for your milestone.', 'Each one beaten opens the next route.']],
    ['tourist', 'Tourist', 'fashionista', 30, 29, ['I came all this way to see the BATTLE TOWER. It is even taller than I imagined!']],
    ['worker', 'Office Worker', 'ceo', 46, 13, ['I take the long way round every morning. The avenues all lead to a gate!']],
    ['kid', 'Little Girl', 'childactor_blonde', 15, 20, ['The trainers on the routes never move. If you can see them, they can see you!']],
    ['jogger', 'Jogger', 'cooldude_blue', 30, 12, ['Round the city twice before breakfast! The avenues make a great running track.']],
    ['granny', 'Old Lady', 'granny', 26, 32, ['When I was young, all of this was grass. Now look at it!']],
    ['fan', 'Tower Fan', 'cooldude_blonde', 34, 29, ['One day I will see a champion fight up there. One day!']],
    ['artist', 'Artist', 'magician_blonde', 21, 4, ['The light on the BATTLE TOWER at sunset... I have painted it a hundred times.']],
    ['florist', 'Florist', 'florist', 25, 3, ['Do not step on the flowers, please!']],
    ['shopper', 'Shopper', 'homemaker_blonde', 19, 12, ['The MART here has the same stock as the shop on Discord. So handy!']],
    ['hiker', 'Hiker', 'miner', 37, 38, ['Off to GATE 4 again. The mountains past it are something else.']],
    ['student', 'Student', 'heroine', 43, 12, ['I am studying at the TRAINER SCHOOL. Type matchups are on the test tomorrow!']],
    ['fisher', 'Fisherman', 'fisher', 6, 33, ['The sea routes past GATE 6 have the biggest catches. Or so I hear.']],
    ['postman', 'Postman', 'postboy', 10, 13, ['Letters for the whole city, and not a single one for me.']],
  ];
  for (const [id, name, sprite, x, y, lines] of folk) map.npc({ id, name, sprite, x, y, facing: 'down', lines });
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
