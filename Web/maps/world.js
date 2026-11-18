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
const { TILES, BUILDINGS, PROPS, PAVING, HEDGE } = require('./tiles');
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

/** Flowers here and there; a spot that's taken (a tree, a wall, a path) is skipped. */
function flowers(map, spots) {
  const kinds = map.ground.flowers.length ? map.ground.flowers : TILES.flowers;
  spots.forEach(([x, y], i) => map.decorate(x, y, kinds[i % kinds.length]));
}

/**
 * A little pond: a grassy rim with a sandy lip (dry land), and water inside
 * that you can wade through. Splashes only happen in the water.
 */
function pond(map, x0, y0, w, h) {
  map.rect('ground', TILES.shore, x0, y0, w, h, TILES.shallow);
  for (let y = y0 + 1; y < y0 + h - 1; y++) for (let x = x0 + 1; x < x0 + w - 1; x++) map.terrain[y][x] = 'shallow';
}

/** The lab's front steps (the bottom of the stair tiles under its door). */
function labSteps(map, x, y) {
  for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) map.set('objects', x + c, y + r, `b${(38 + r) * 47 + 38 + c}`);
}

// ---------------------------------------------------------------------------

/** AIDE's first battle: his starter, at the starter's level. */
const RIVAL_FIRST_LEVEL = 5;

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

  // Your house and the professor's family home, on the south street.
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

  // AIDE, waiting at the way out after the lab: nobody leaves town without
  // battling him first. Both exit tiles are in his sight; he goes once beaten.
  map.trainer({
    id: 'rival-gate',
    rival: true,
    leaves: true,
    name: 'AIDE',
    sprite: 'cooldude_red',
    x: 15,
    y: 2,
    facing: 'left',
    sight: 4,
    level: RIVAL_FIRST_LEVEL,
    team: [],
    before: ["AIDE: There you are! I've been waiting forever!", "AIDE: Let's see whose POKéMON is stronger. Mine, obviously!"],
    // Said right after you beat him, before he goes.
    won: [
      'AIDE: What?! I lost?',
      "AIDE: ...Hmph. My POKéMON just isn't used to battling yet. That's all.",
      "AIDE: You'd better keep getting stronger. Next time, I won't go easy on you!",
    ],
    after: ['AIDE: ...Hmph. Lucky. I\'m going to train until I can beat you!'],
    reward: { coins: 30 },
  });

  map.warp(12, 0, { map: 'path-a', x: 12, y: 38, facing: 'up' });
  map.warp(13, 0, { map: 'path-a', x: 13, y: 38, facing: 'up' });
  // At the foot of the lab's steps.
  map.spawn = { x: 19, y: 16, facing: 'down' };
  return finish(map);
}

/** A trainer on the way to the MAIN CITY: easy, with Pokemon about the starter's level. */
const introTrainer = (t) => ({ sight: 4, ...t });

/**
 * PATH A, walked south to north. The way forward squeezes between trees
 * through a patch of grass (one battle), then past a YOUNGSTER watching a
 * gap. Ledges only hop south: short cuts home, never round the grass.
 */
function pathA() {
  const map = new MapBuilder({ id: 'path-a', name: 'Path a', kind: 'route', width: 26, height: 40, levels: { lo: 2, hi: 4 }, background: 'grass' });
  map.border([[6, 0], [6, 19]]);
  map.sign(10, 37, ['PATH A', 'North: TOWN 2   South: TOWN 1']);

  // Up from TOWN 1 to the trees.
  map.path(11, 29, 4, 11);
  pond(map, 17, 33, 5, 4);
  map.grass(3, 32, 6, 4);
  flowers(map, [[9, 35], [16, 30], [22, 31], [3, 37], [15, 38]]);
  map.ledge(2, 30, 8);

  // The trees close in: a patch of grass across the gap (one battle).
  map.wall(25, 2, 23, 10, 15, 4);
  map.patch('a1', 10, 25, 6, 4, 4, 3);

  // A meadow, then a YOUNGSTER watching the gap in the next row of trees.
  map.path(11, 13, 4, 12);
  map.grass(3, 15, 6, 6);
  map.item(4, 17, 'path-a-berry', { item: 'oran-berry' });
  map.ledge(15, 21, 9);
  flowers(map, [[17, 16], [20, 18], [22, 14], [9, 22], [16, 23]]);
  map.wall(11, 2, 23, 10, 15, 2);
  map.trainer(introTrainer({
    id: 'youngster', name: 'Youngster 1', sprite: 'cooldude', x: 16, y: 13, facing: 'left', sight: 6,
    team: [{ species: 19, level: 3 }, { species: 16, level: 2 }],
    before: ["Hey! I just got my first POKéMON too! Let's battle!"],
    after: ['My RATTATA and I are going to train even harder!'],
  }));

  // On to TOWN 2.
  map.path(11, 0, 4, 11);
  map.grass(16, 3, 7, 5);
  flowers(map, [[4, 4], [6, 7], [8, 3], [3, 9], [17, 9]]);

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

  map.sign(10, 18, ['TOWN 2', 'The last stop before the MAIN CITY, to the north.']);
  map.sign(9, 14, ['POKéMON CENTER', 'If you white out, you wake up at the last one you visited.']);
  flowers(map, [[10, 7], [2, 13], [23, 11], [23, 18], [9, 17], [3, 21], [16, 17]]);
  map.npc({
    id: 'youngster', name: 'Youngster', sprite: 'cooldude_blue', x: 9, y: 16, facing: 'right',
    lines: ['The MAIN CITY has eight gates. Each one leads to a different kind of land!', 'You can only take on the next gate once the one before it is done, though.'],
  });
  map.npc({
    id: 'gardener', name: 'Gardener', sprite: 'florist', x: 22, y: 10, facing: 'left',
    lines: ['Grass right across the way always has a POKéMON in it. Exactly one!'],
  });
  map.warp(12, 23, { map: 'path-a', x: 12, y: 1, facing: 'down' });
  map.warp(13, 23, { map: 'path-a', x: 13, y: 1, facing: 'down' });
  map.warp(12, 0, { map: 'path-b', x: 12, y: 38, facing: 'up' });
  map.warp(13, 0, { map: 'path-b', x: 13, y: 38, facing: 'up' });
  map.spawn = { x: 7, y: 12, facing: 'down' };
  return finish(map);
}

/** PATH B, south to north: through the grass, over the river at the ford, up to the MAIN CITY. */
function pathB() {
  const map = new MapBuilder({ id: 'path-b', name: 'Path b', kind: 'route', width: 26, height: 40, levels: { lo: 3, hi: 5 }, background: 'grass' });
  // Gaps in the pines where the river runs off both edges.
  map.border([[6, 0], [6, 19], [0, 9], [0, 10], [12, 9], [12, 10]]);
  map.sign(10, 37, ['PATH B', 'North: MAIN CITY   South: TOWN 2']);

  // Up from TOWN 2 and east to the gap in the trees.
  map.path(11, 31, 4, 9);
  map.path(11, 31, 10, 3);
  map.grass(3, 34, 6, 4);
  map.ledge(2, 32, 8);
  flowers(map, [[15, 36], [17, 37], [19, 36], [21, 37], [9, 33], [22, 34]]);

  // Trees with a gap on the east side: grass across it (one battle).
  map.wall(26, 2, 23, 16, 21, 4);
  map.patch('b1', 16, 26, 6, 4, 4, 4);

  // Up to the river and its bridge: a LASS waits by it.
  map.path(17, 23, 4, 3);
  map.trainer(introTrainer({
    id: 'lass', name: 'Lass 1', sprite: 'heroine', x: 22, y: 23, facing: 'left', sight: 5,
    team: [{ species: 43, level: 4 }, { species: 29, level: 4 }],
    before: ['Ooh, a new trainer! Show me your POKéMON!'],
    after: ['The river is lovely, isn\'t it? Mind your step at the ford!'],
  }));
  map.grass(3, 23, 7, 2);
  map.river(18, 0, 25, 17, 20, 3);

  // West along the far bank, then north to the city.
  map.path(17, 13, 4, 5);
  map.path(11, 13, 10, 3);
  map.ledge(15, 11, 9);
  map.grass(15, 5, 8, 5);
  map.grass(3, 6, 7, 6);
  map.tree(5, 14);
  map.tree(7, 14);
  map.path(11, 0, 4, 16);
  map.sign(10, 4, ['MAIN CITY AHEAD', 'Home of the BATTLE TOWER.']);
  flowers(map, [[3, 15], [9, 16], [16, 3], [22, 3], [9, 4], [3, 3]]);

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

/** A lawn behind a low hedge, with a tree or flowers inside. */
function park(map, x0, y0, w, h, { trees = [], flowerSpots = [], gaps = [] } = {}) {
  map.lawn(x0, y0, w, h, { gaps });
  trees.forEach(([x, y]) => map.tree(x, y));
  flowers(map, flowerSpots);
}

/** A row of single round bushes on the pavement. */
function bushes(map, spots) {
  for (const [x, y] of spots) map.set('objects', x, y, HEDGE.bush).block(x, y);
}

/**
 * The MAIN CITY, built like the big cities in the games: stone avenues out
 * to the eight gates round the BATTLE TOWER's plaza, and between them blocks
 * packed with shops, offices and homes, back to back, cut through by narrow
 * alleys. Not every building can be entered. Each gate has its number
 * painted on the road in front of it.
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
  pave(map, S, 17, 15, 18, 16);

  const B = BUILDINGS;
  /** A building nobody can go into: just part of the city. */
  const block = (plan, x, y) => map.building(plan, x, y, {});
  const home = (plan, x, y, line) => map.building(plan, x, y, { lines: [line] });

  // ---- The plaza: the BATTLE TOWER, fountains, statues, banners.
  map.building(B.tower, 21, 15, { station: 'battle' });
  map.sign(20, 29, ['BATTLE TOWER', 'Every milestone is fought here.']);
  prop(map, PROPS.fountain, 17, 19);
  prop(map, PROPS.fountain, 32, 19);
  prop(map, PROPS.statue, 18, 15);
  prop(map, PROPS.statue, 33, 15);
  prop(map, PROPS.banner, 21, 28);
  prop(map, PROPS.banner, 29, 28);
  park(map, 17, 24, 4, 4, { flowerSpots: [[18, 25], [19, 26]] });
  park(map, 31, 24, 4, 4, { flowerSpots: [[32, 26], [33, 25]] });

  // ---- North-west: the POKéMON CENTER, with a hut squeezed in beside it.
  map.building(B.center, 2, 3, { station: 'center' });
  home(B.dome, 9, 3, 'This hut has been here longer than the whole city!');
  block(B.dome, 9, 7);

  // ---- North: two rows back to back, an alley between and one through the middle.
  home(B.tudor, 17, 2, 'I sell tickets to the BATTLE TOWER... well, I would, if it cost anything!');
  block(B.shopGreen, 22, 2);
  home(B.dome, 28, 2, 'I just moved here from TOWN 2. The city never sleeps!');
  block(B.dome, 32, 2);
  map.building(B.martBlue, 17, 7, { station: 'mart' });
  home(B.shopWhite, 22, 7, 'FLORIST: Every flower in the city is grown right here!');
  map.building(B.shopYellow, 28, 7, { station: 'drop' });
  map.sign(34, 9, ['DROP STATION', 'Drop a wild POKéMON, then catch it by name.']);

  // ---- North-east: the TRAINER SCHOOL and a terrace.
  home(B.hall, 39, 3, 'TEACHER: Welcome to the TRAINER SCHOOL! Lesson one: a POKéMON above your obedience cap will not listen to you in battle.');
  home(B.dome, 46, 2, 'Shh! The students next door are taking a test.');
  bushes(map, [[46, 7], [49, 7], [46, 9], [49, 9]]);

  // ---- West: offices, a row of town houses, a hut.
  home(B.officeGold, 2, 15, 'This is the office of the BATTLE TOWER. Every challenger is recorded here.');
  block(B.dome, 9, 16);
  home(B.tudor, 2, 21, 'My grandfather built this house before the TOWER went up.');
  block(B.shopGrey, 7, 21);
  home(B.officeCyan, 2, 26, 'We plan the routes past the gates. Every trainer out there is placed just so.');
  home(B.dome, 9, 27, 'My POKéMON loves the fountains in the plaza.');

  // ---- East: the same the other way round.
  home(B.officeGrey, 39, 15, 'Some rocks and trees on the routes can only be cleared by POKéMON moves. They open up as you beat more milestones.');
  block(B.dome, 46, 16);
  home(B.tudor, 39, 21, 'They say every gate leads to a land from a different region.');
  home(B.townhouseBrick, 44, 21, 'The routes past GATE 1 are full of bug POKéMON. Yuck!');
  block(B.officeWhite, 39, 26);
  block(B.dome, 46, 27);

  // ---- South-west: the cafe, town houses, huts by the trees.
  map.building(B.cafe, 2, 35, { room: 'taba_house4', lines: ['Welcome to the cafe! Trainers come here after a long day on the routes.'] });
  home(B.townhouse, 7, 35, 'Did you come up PATH B? That river is cold this time of year!');
  block(B.dome, 2, 41);
  block(B.dome, 6, 41);
  park(map, 10, 41, 3, 3, {});

  // ---- South: lodges either side of the road in, with huts behind.
  home(B.lodge, 18, 35, 'I grew up in this city. It has grown so big since the BATTLE TOWER went up!');
  home(B.lodgeRed, 29, 35, 'Welcome to the MAIN CITY! Mind the traffic on the avenues.');
  bushes(map, [[17, 43], [19, 43], [21, 43], [30, 43], [32, 43], [34, 43]]);

  // ---- South-east: a dojo, a cottage, a tudor house.
  home(B.dojo, 39, 36, 'DOJO MASTER: Train hard! Every battle makes you stronger.');
  home(B.cottageGrey, 44, 36, 'My kids play in the alleys all day long.');
  block(B.tudor, 39, 40);

  // ---- The gates: the number painted on the road in front of each.
  const MARKS = { 1: [36, 3], 2: [46, 12], 3: [46, 32], 4: [36, 40], 5: [14, 40], 6: [3, 32], 7: [3, 12], 8: [14, 3] };
  for (const gate of worldplan.plan().gates) {
    const g = GATES[gate.number];
    const first = gate.routes[0].number;
    // Gate 1 is open from the start; each later one only once every route
    // before it is cleared and its milestones beaten: no skipping ahead.
    const requires = first > 1 ? { route: first - 1, gate: gate.number, all: true } : undefined;
    g.tiles.forEach(([x, y], i) => map.warp(x, y, { map: `route-${first}`, x: 8 + i, y: 1, facing: 'down', requires }));
    const [mx, my] = MARKS[gate.number];
    map.mark(mx, my, String(gate.number));
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
    ['veteran', 'Veteran', 'knightlord', 20, 30, ['Fill your TRAINER EXP bar on the routes, then come back here for your milestone.', 'Each one beaten opens the next route.']],
    ['tourist', 'Tourist', 'fashionista', 31, 30, ['I came all this way to see the BATTLE TOWER. It is even taller than I imagined!']],
    ['worker', 'Office Worker', 'ceo', 45, 13, ['I take the long way round every morning. The avenues all lead to a gate!']],
    ['kid', 'Little Girl', 'childactor_blonde', 15, 20, ['The trainers on the routes never move. If you can see them, they can see you!']],
    ['jogger', 'Jogger', 'cooldude_blue', 30, 12, ['Round the city twice before breakfast! The avenues make a great running track.']],
    ['granny', 'Old Lady', 'granny', 26, 33, ['When I was young, all of this was grass. Now look at it!']],
    ['fan', 'Tower Fan', 'cooldude_blonde', 34, 28, ['One day I will see a champion fight up there. One day!']],
    ['artist', 'Artist', 'magician_blonde', 27, 4, ['The alleys here are full of shortcuts, if you know where to look.']],
    ['shopper', 'Shopper', 'homemaker_blonde', 19, 12, ['The MART here has the same stock as the shop on Discord. So handy!']],
    ['hiker', 'Hiker', 'miner', 37, 38, ['Off to GATE 4 again. The mountains past it are something else.']],
    ['student', 'Student', 'heroine', 42, 12, ['I am studying at the TRAINER SCHOOL. Type matchups are on the test tomorrow!']],
    ['fisher', 'Fisherman', 'fisher', 6, 33, ['The sea routes past GATE 6 have the biggest catches. Or so I hear.']],
    ['postman', 'Postman', 'postboy', 8, 25, ['Letters for the whole city, and not a single one for me.']],
    ['kid2', 'Boy', 'childactor', 43, 25, ["Bet you can't find all the alleys in the city!"]],
    ['monk', 'Monk', 'monk', 49, 42, ['Patience. Every gate opens in its own time.']],
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
