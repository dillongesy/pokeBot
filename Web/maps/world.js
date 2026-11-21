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

const CITY_W = 64;
const CITY_H = 64;
/** The city's radius, in tiles: the forest starts beyond it. */
const CITY_R = 31;

/**
 * The eight gates: the two exit tiles on the city's edge, and where you stand
 * coming back in. Clockwise from the north.
 */
const GATES = {
  1: { tiles: [[42, 0], [43, 0]], inside: [{ x: 42, y: 2, facing: 'down' }, { x: 43, y: 2, facing: 'down' }] },
  2: { tiles: [[63, 20], [63, 21]], inside: [{ x: 61, y: 20, facing: 'left' }, { x: 61, y: 21, facing: 'left' }] },
  3: { tiles: [[63, 42], [63, 43]], inside: [{ x: 61, y: 42, facing: 'left' }, { x: 61, y: 43, facing: 'left' }] },
  4: { tiles: [[42, 63], [43, 63]], inside: [{ x: 42, y: 61, facing: 'up' }, { x: 43, y: 61, facing: 'up' }] },
  5: { tiles: [[20, 63], [21, 63]], inside: [{ x: 20, y: 61, facing: 'up' }, { x: 21, y: 61, facing: 'up' }] },
  6: { tiles: [[0, 42], [0, 43]], inside: [{ x: 2, y: 42, facing: 'right' }, { x: 2, y: 43, facing: 'right' }] },
  7: { tiles: [[0, 20], [0, 21]], inside: [{ x: 2, y: 20, facing: 'right' }, { x: 2, y: 21, facing: 'right' }] },
  8: { tiles: [[20, 0], [21, 0]], inside: [{ x: 20, y: 2, facing: 'down' }, { x: 21, y: 2, facing: 'down' }] },
};


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
  map.warp(12, 0, { map: 'main-city', x: 30, y: CITY_H - 3, facing: 'up' });
  map.warp(13, 0, { map: 'main-city', x: 31, y: CITY_H - 3, facing: 'up' });
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
 * The MAIN CITY: a round metropolis in a ring of forest. The BATTLE TOWER
 * stands in the plaza in the middle; four stone avenues cross the city,
 * two north-south and two east-west, and run on out through the forest as
 * the eight gates (each pair leaves the way its routes go). Every block
 * between them is packed with buildings, row on row, each row's doors on an
 * alley or an avenue; most are just part of the city (no door). Each gate
 * has its number painted on the avenue in front of it.
 */
function mainCity() {
  const W = CITY_W;
  const H = CITY_H;
  const map = new MapBuilder({
    id: 'main-city', name: 'Main City', kind: 'town', width: W, height: H, background: 'stadium',
    ground: { tile: TILES.grass, flowers: [], border: 'trees' },
  });
  map.encounterRate = 0;
  const S = PAVING.stone;
  const R = CITY_R;
  /** How far a tile's middle is from the middle of the city. */
  const dist = (x, y) => Math.hypot(x + 0.5 - W / 2, y + 0.5 - H / 2);

  // ---- The avenues (and the road in from PATH B).
  // Narrow, like the big cities in the games: each avenue is as wide as its
  // gates. The tower's square is between them, shops along its north side.
  const AVE_X = [[20, 21], [42, 43]];
  const AVE_Y = [[20, 21], [42, 43]];
  const ROAD = [30, 31];
  const PLAZA = { x0: 22, y0: 28, x1: 41, y1: 41 };
  const onAvenue = (x, y) => AVE_X.some(([a, b]) => x >= a && x <= b) || AVE_Y.some(([a, b]) => y >= a && y <= b)
    || (x >= ROAD[0] && x <= ROAD[1] && y > PLAZA.y1)
    || (x >= PLAZA.x0 && x <= PLAZA.x1 && y >= PLAZA.y0 && y <= PLAZA.y1);

  // ---- The forest round the edge: whole pines (2x2) wherever they'd stand
  // outside the city, except along the ways out.
  const ways = new Set();
  for (const [x0] of AVE_X) for (let cy = 0; cy < H / 2; cy++) ways.add(`${x0 / 2},${cy}`);
  for (const [y0] of AVE_Y) for (let cx = 0; cx < W / 2; cx++) ways.add(`${cx},${y0 / 2}`);
  for (let cy = H / 4; cy < H / 2; cy++) ways.add(`${ROAD[0] / 2},${cy}`);
  const tree = Array.from({ length: H }, () => Array(W).fill(false));
  for (let cy = 0; cy < H / 2; cy++) {
    for (let cx = 0; cx < W / 2; cx++) {
      if (ways.has(`${cx},${cy}`)) continue;
      if (Math.hypot(cx * 2 + 1 - W / 2, cy * 2 + 1 - H / 2) <= R - 1) continue;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) tree[cy * 2 + dy][cx * 2 + dx] = true;
    }
  }
  /** Inside the city: not forest, and inside the circle (or on a way out). */
  const city = (x, y) => x >= 0 && y >= 0 && x < W && y < H && !tree[y][x] && (dist(x, y) <= R || onAvenue(x, y));

  // ---- The ground: concrete in the city, stone on the avenues, grass under the pines.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!city(x, y)) continue;
      map.set('ground', x, y, onAvenue(x, y) ? S : PAVING.concrete);
    }
  }
  for (let cy = 0; cy < H / 2; cy++) for (let cx = 0; cx < W / 2; cx++) if (tree[cy * 2][cx * 2]) map.tree(cx * 2, cy * 2);
  // Where nothing may be built: the avenues, and (below) the big buildings.
  const taken = Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => !city(x, y) || onAvenue(x, y)));
  const take = (x, y, w, h) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (taken[yy]) taken[yy][xx] = true;
  };

  const B = BUILDINGS;
  const size = (plan) => ({ w: plan.body[0].length, h: plan.above.length + plan.body.length });
  /** A building with its bottom (door) row on `bottom`, from x. */
  const put = (plan, x, bottom, door = {}) => {
    const { w, h } = size(plan);
    map.building(plan, x, bottom - h + 1, door);
    take(x, bottom - h + 1, w, h);
    // Nothing is built on its doorstep.
    const step = { x: x + plan.door.dx, y: bottom + 1 };
    if (step.y < H && taken[step.y][step.x] === false) taken[step.y][step.x] = 'alley';
  };

  // ---- The square: the BATTLE TOWER in the middle (its door on the road
  // in from PATH B), fountains, statues, banners and a lawn round it.
  put(B.tower, 27, 40, { station: 'battle' });
  map.sign(26, 40, ['BATTLE TOWER', 'Every milestone is fought here.']);
  prop(map, PROPS.fountain, 23, 29);
  prop(map, PROPS.fountain, 38, 29);
  prop(map, PROPS.statue, 25, 33);
  prop(map, PROPS.statue, 37, 33);
  prop(map, PROPS.banner, 23, 39);
  prop(map, PROPS.banner, 39, 39);
  park(map, 37, 34, 4, 4, {});
  take(37, 34, 4, 4);

  // ---- The big buildings, each on an avenue (or the square).
  put(B.shopYellow, 22, 27, { station: 'drop' });
  put(B.center, 22, 51, { station: 'center' });
  put(B.martBlue, 32, 47, { station: 'mart' });
  put(B.cafe, 22, 19, { room: 'taba_house4', lines: ['Welcome to the cafe! Trainers come here after a long day on the routes.'] });
  put(B.officeGold, 35, 19, { lines: ['This is the office of the BATTLE TOWER. Every challenger is recorded here.'] });
  put(B.hall, 44, 41, { lines: ['TEACHER: Welcome to the TRAINER SCHOOL! Lesson one: a POKéMON above your obedience cap will not listen to you in battle.'] });
  put(B.deptStore, 12, 41, { lines: ['DEPARTMENT STORE: Five floors of everything! ...Only the first floor is open today, sorry.'] });

  // ---- Everything else: rows of buildings packed into every block, each
  // row's doors on the alley (or avenue) below it. One in four has someone
  // home to talk to.
  const random = seeded('main-city');
  // Mostly offices and shops (it's a city), some homes, a few huts.
  const FILL = [B.officeWhite, B.officeGrey, B.officeCyan, B.officeWhite, B.officeGrey, B.officeCyan, B.officeSmall, B.officeSmall,
    B.shopGreen, B.shopGrey, B.shopWhite, B.shopPurple, B.shopGrey, B.shopPurple,
    B.tudor, B.tudor, B.cottageBrown, B.cottageGrey, B.dome, B.dojo, B.cafe];
  const HOMES_SAY = [
    'I grew up in this city. It has grown so big since the BATTLE TOWER went up!',
    'Did you come up PATH B? That river is cold this time of year!',
    'My grandfather built this house before the TOWER went up.',
    'My POKéMON loves the fountains in the plaza.',
    'They say every gate leads to a land from a different region.',
    'We plan the routes past the gates. Every trainer out there is placed just so.',
    'Shh! The baby is sleeping.',
    'My kids play in the alleys all day long.',
    'Some rocks and trees on the routes can only be cleared by POKéMON moves. They open up as you beat more milestones.',
    'The city never sleeps! Neither do I, apparently.',
    'I just moved here from TOWN 2. It is so much busier!',
    'FLORIST: Every flower in the city is grown right here!',
  ];
  let said = 0;
  const BLOCKS = [
    { x0: 0, x1: 19, y0: 0, y1: 19 }, { x0: 22, x1: 41, y0: 0, y1: 19 }, { x0: 44, x1: 63, y0: 0, y1: 19 },
    { x0: 0, x1: 19, y0: 22, y1: 41 }, { x0: 22, x1: 41, y0: 22, y1: 27 }, { x0: 44, x1: 63, y0: 22, y1: 41 },
    { x0: 0, x1: 19, y0: 44, y1: 63 }, { x0: 22, x1: 29, y0: 44, y1: 63 }, { x0: 32, x1: 41, y0: 44, y1: 63 }, { x0: 44, x1: 63, y0: 44, y1: 63 },
  ];
  const BAND = 6;
  const free = (x, y) => city(x, y) && taken[y][x] === false;
  const walkable = (x, y) => city(x, y) && (onAvenue(x, y) || taken[y][x] !== true);
  for (const b of BLOCKS) {
    // The lowest row with city in it, then bands of buildings up from there,
    // an alley under each.
    let bottom = b.y1;
    while (bottom >= b.y0 && ![...Array(b.x1 - b.x0 + 1)].some((_, i) => city(b.x0 + i, bottom))) bottom -= 1;
    if (b.y1 + 1 < H && onAvenue(b.x0 + 1, b.y1 + 1)) bottom = b.y1;
    else bottom -= 1; // the lowest row is the alley
    const alleys = [];
    while (bottom - 2 >= b.y0) {
      alleys.push(bottom + 1);
      // The row's tallest building decides where the next row up starts:
      // one alley above its roof.
      let top = bottom - 3;
      for (let x = b.x0; x <= b.x1;) {
        // Taller buildings first (a row of them packs the block); the
        // little huts only fill the gaps left over.
        const order = FILL.map((p) => [random() + (6 - size(p).h) * 0.12 + (size(p).h <= 3 ? 0.6 : 0), p]).sort((p, q) => p[0] - q[0]).map(([, p]) => p);
        const fits = order.find((plan) => {
          const { w, h } = size(plan);
          if (h > BAND || x + w - 1 > b.x1) return false;
          for (let yy = bottom - h + 1; yy <= bottom; yy++) for (let xx = x; xx < x + w; xx++) if (yy < b.y0 || !free(xx, yy)) return false;
          // Its door opens onto somewhere you can walk.
          return walkable(x + plan.door.dx, bottom + 1);
        });
        if (!fits) {
          x += 1;
          continue;
        }
        const talks = said < HOMES_SAY.length && random() < 0.28;
        put(fits, x, bottom, talks ? { lines: [HOMES_SAY[said++]] } : {});
        top = Math.min(top, bottom - size(fits).h + 1);
        x += size(fits).w;
      }
      bottom = top - 2;
    }
    // Keep the alleys clear (nothing was built on them).
    for (const y of alleys) for (let x = b.x0; x <= b.x1; x++) if (y < H && city(x, y) && taken[y][x] === false) taken[y][x] = 'alley';
  }

  // ---- The gates: out along the avenues, the number painted in front of each.
  const MARKS = { 1: [42, 6], 2: [56, 20], 3: [56, 42], 4: [42, 56], 5: [20, 56], 6: [6, 42], 7: [6, 20], 8: [20, 6] };
  const routegen = require('./routegen');
  for (const gate of worldplan.plan().gates) {
    const g = GATES[gate.number];
    const first = gate.routes[0].number;
    // Gate 1 is open from the start; each later one only once every route
    // before it is cleared and its milestones beaten: no skipping ahead.
    const requires = first > 1 ? { route: first - 1, gate: gate.number, all: true } : undefined;
    g.tiles.forEach(([x, y], i) => map.warp(x, y, { ...routegen.arrival(`route-${first}`, 'start', i), requires }));
    const [mx, my] = MARKS[gate.number];
    map.mark(mx, my, String(gate.number));
  }

  // In from PATH B, at the bottom middle.
  map.warp(30, H - 1, { map: 'path-b', x: 12, y: 1, facing: 'down' });
  map.warp(31, H - 1, { map: 'path-b', x: 13, y: 1, facing: 'down' });

  // People about town. The taxi driver waits on the road in (he walks
  // straight down to you the first time you arrive).
  map.npc({
    id: 'taxi', name: 'Taxi Driver', sprite: 'riverboatcaptain', x: 30, y: 55, facing: 'down',
    lines: ["My FARFETCH'D taxi flies anywhere you've been! Press M to FLY."],
  });
  const folk = [
    ['veteran', 'Veteran', 'knightlord', ['Fill your TRAINER EXP bar on the routes, then come back here for your milestone.', 'Each one beaten opens the next route.']],
    ['tourist', 'Tourist', 'fashionista', ['I came all this way to see the BATTLE TOWER. It is even taller than I imagined!']],
    ['worker', 'Office Worker', 'ceo', ['I take the long way round every morning. The avenues all lead to a gate!']],
    ['kid', 'Little Girl', 'childactor_blonde', ['The trainers on the routes never move. If you can see them, they can see you!']],
    ['jogger', 'Jogger', 'cooldude_blue', ['Round the city twice before breakfast! The avenues make a great running track.']],
    ['granny', 'Old Lady', 'granny', ['When I was young, all of this was grass. Now look at it!']],
    ['fan', 'Tower Fan', 'cooldude_blonde', ['One day I will see a champion fight up there. One day!']],
    ['artist', 'Artist', 'magician_blonde', ['The alleys here are full of shortcuts, if you know where to look.']],
    ['shopper', 'Shopper', 'homemaker_blonde', ['The MART here has the same stock as the shop on Discord. So handy!']],
    ['hiker', 'Hiker', 'miner', ['The north gates lead north, the east gates east. Simple! Well, once you know.']],
    ['student', 'Student', 'heroine', ['I am studying at the TRAINER SCHOOL. Type matchups are on the test tomorrow!']],
    ['fisher', 'Fisherman', 'fisher', ['The sea routes out west have the biggest catches. Or so I hear.']],
    ['postman', 'Postman', 'postboy', ['Letters for the whole city, and not a single one for me.']],
    ['kid2', 'Boy', 'childactor', ["Bet you can't find all the alleys in the city!"]],
    ['monk', 'Monk', 'monk', ['Patience. Every gate opens in its own time.']],
    ['clerk', 'Office Worker', 'scientist', ['Lunch break! The cafe up north does the best sandwiches in town.']],
    ['guard', 'Gate Guard', 'soldier', ['GATE 1 is the first one every trainer takes. The others open in order, one at a time.']],
    ['busker', 'Musician', 'magician', ['La la la! Nobody stops to listen in the big city...']],
    ['tourist2', 'Tourist', 'fashionista_blue', ['The POKéMON CENTER is right by the road in. Handy after PATH B!']],
    ['courier', 'Courier', 'postboy_green', ['Parcel for the DEPARTMENT STORE! ...Which floor? There is only one open.']],
    ['banker', 'Banker', 'ceo', ['Every coin you earn on Discord spends the same here. Lovely.']],
    ['teen', 'Teen', 'goth', ['The BATTLE TOWER lights up at night. Not that anyone sleeps here.']],
  ];
  // Spread out on the avenues and alleys, never in a doorway, on a way
  // out, or on the road the taxi driver walks down.
  const doorstep = new Set(map.doors.map((d) => `${d.x},${d.y + 1}`));
  const people = [{ x: 30, y: 55 }];
  for (const [id, name, sprite, lines] of folk) {
    for (let tries = 0; tries < 400; tries++) {
      const x = 3 + Math.floor(random() * (W - 6));
      const y = 3 + Math.floor(random() * (H - 6));
      if (!onAvenue(x, y) || !city(x, y) || map.solid[y][x] || doorstep.has(`${x},${y}`) || dist(x, y) > R - 2) continue;
      if (x >= ROAD[0] && x <= ROAD[1] && y > PLAZA.y1) continue;
      if (people.some((p) => Math.abs(p.x - x) + Math.abs(p.y - y) < 6)) continue;
      people.push({ x, y });
      map.npc({ id, name, sprite, x, y, facing: 'down', lines });
      break;
    }
  }
  map.spawn = { x: 30, y: H - 4, facing: 'up' };
  return finish(map);
}

/** Seeded random numbers (the same city for everyone). */
function seeded(text) {
  let a = [...text].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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
