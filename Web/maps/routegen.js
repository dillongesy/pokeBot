'use strict';

/**
 * Builds every route, and the stop at its end, from the world plan
 * (Web/worldplan.js). Seeded, so every player gets the same maps.
 *
 * A route runs top to bottom. In walking order it holds exactly the plan's
 * battles:
 *
 *   wild     a band of grass right across the way (a one-battle patch) at
 *            the plan's level for that battle
 *   trainer  a trainer at the side, watching the whole width, with a team of
 *            the plan's size, the ace at the plan's level
 *   boss     the last battle on a boss route: a full team at the bottom
 *
 * Between them: open ground, flowers, trees at the edges, and optional grass
 * off to the side. Long routes get a rest stop between legs. A route with a
 * hidden item (plan.pockets) has a Poke Ball in a nook behind an obstacle
 * that only a later field move opens.
 *
 * Route N's top connects to where the gate starts (or the stop before it),
 * its bottom to stop N. Leaving stop N for Route N+1 needs Route N cleared
 * and milestone N beaten (warp.requires, checked by Web/overworld.js).
 *
 * Map ids: "route-N" and "stop-N". Built on first use and kept.
 */

const { MapBuilder } = require('./builder');
const { TILES, BUILDINGS, GROUNDS, BIOME_GROUND, ROCKS } = require('./tiles');
const ROCK = ROCKS[0];
const worldplan = require('../worldplan');

const WIDTH = 18;
const LEFT = 2;
const RIGHT = WIDTH - 3;
const INNER = RIGHT - LEFT + 1;
const MIDDLE = 8;

/** The gates in the Main City (world.js): where each gate's first route leads back to. */
const { GATES } = require('./world');

// ---------------------------------------------------------------------------
// Seeded randomness (the same as the plan's)
// ---------------------------------------------------------------------------

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed) {
  let a = hash(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pickOf = (random, list) => list[Math.floor(random() * list.length)];

// ---------------------------------------------------------------------------
// Who lives where
// ---------------------------------------------------------------------------

/** The types of Pokemon found in each biome. */
const BIOME_TYPES = {
  meadow: ['normal', 'grass', 'bug', 'flying', 'fairy'],
  forest: ['bug', 'grass', 'poison', 'normal'],
  beach: ['water', 'ground', 'normal', 'flying'],
  coast: ['water', 'flying', 'electric'],
  jungle: ['grass', 'bug', 'poison', 'dragon'],
  'river valley': ['water', 'grass', 'ground'],
  mountain: ['rock', 'ground', 'fighting', 'flying'],
  cave: ['rock', 'ground', 'dark', 'poison'],
  desert: ['ground', 'fire', 'rock'],
  canyon: ['rock', 'ground', 'fighting', 'fire'],
  'open sea': ['water'],
  reef: ['water', 'dark'],
  snowfield: ['ice', 'normal', 'water'],
  'ice cave': ['ice', 'rock', 'steel'],
  blizzard: ['ice', 'steel'],
  summit: ['ice', 'dragon', 'rock', 'flying'],
};

/** Trainers met in each kind of land: [class, sprite]. */
const LOCALS = {
  meadow: [['Youngster', 'cooldude'], ['Lass', 'heroine'], ['Picnicker', 'picnicker'], ['Bug Catcher', 'childactor']],
  forest: [['Bug Catcher', 'childactor'], ['Picnicker', 'picnicker'], ['Camper', 'cooldude_brown'], ['Beauty', 'florist']],
  beach: [['Swimmer', 'swimmer'], ['Beauty', 'beachcomber'], ['Sailor', 'riverboatcaptain'], ['Fisherman', 'fisher']],
  coast: [['Fisherman', 'fisher'], ['Sailor', 'riverboatcaptain'], ['Swimmer', 'swimmer_blue'], ['Bird Keeper', 'postboy']],
  jungle: [['Ranger', 'rogue_green'], ['Bug Catcher', 'childactor'], ['Psychic', 'magician'], ['Camper', 'cooldude_blonde']],
  'river valley': [['Fisherman', 'fisher'], ['Ranger', 'rogue'], ['Picnicker', 'picnicker'], ['Swimmer', 'swimmer_green']],
  mountain: [['Hiker', 'miner'], ['Black Belt', 'monk'], ['Bird Keeper', 'postboy'], ['Veteran', 'knight']],
  cave: [['Hiker', 'miner_blue'], ['Scientist', 'scientist'], ['Black Belt', 'monk_black'], ['Psychic', 'witch']],
  desert: [['Ranger', 'rogue_copper'], ['Hiker', 'miner_yellow'], ['Psychic', 'magician_black'], ['Ace Trainer', 'ninja']],
  canyon: [['Hiker', 'miner_red'], ['Black Belt', 'monk_red'], ['Veteran', 'knight_red'], ['Ace Trainer', 'warrior']],
  'open sea': [['Swimmer', 'swimmer_orange'], ['Sailor', 'riverboatcaptain'], ['Fisherman', 'fisher_fiery'], ['Beauty', 'beachcomber_blue']],
  reef: [['Swimmer', 'swimmer_red'], ['Scientist', 'scientist_black'], ['Sailor', 'riverboatcaptain'], ['Ace Trainer', 'ninja_blue']],
  snowfield: [['Ace Trainer', 'knight_yellow'], ['Veteran', 'granny_blue'], ['Hiker', 'miner_green'], ['Cool Trainer', 'cooldude_blue']],
  'ice cave': [['Scientist', 'scientist_brown'], ['Hiker', 'miner_blue'], ['Psychic', 'witch'], ['Cool Trainer', 'ninja_red']],
  blizzard: [['Ace Trainer', 'warrior'], ['Veteran', 'knightlord'], ['Cool Trainer', 'dragonrider_blue'], ['Black Belt', 'monk_blue']],
  summit: [['Ace Trainer', 'dragonrider'], ['Veteran', 'knightlord'], ['Cool Trainer', 'dragonrider_fiery'], ['Psychic', 'magician_blonde']],
};

const BOSS_SPRITES = ['boss', 'boss_blue', 'boss_green', 'boss_orange', 'boss_red', 'overseer', 'ceo'];

/** Battle lines, game style. */
/** What a beaten trainer says if you talk to them again. */
const AFTER_LINES = [
  'You really are strong. Good luck out there!',
  "I'll train harder. Next time, I won't lose!",
  'Your POKéMON look like they trust you a lot.',
  "Phew. I need a rest after that one.",
  'Keep going. The next stretch is even tougher!',
];

const LINES = [
  "Hey! You look like you could use a battle!",
  "A TRAINER! Let's see what you've got!",
  "Our eyes met! That means we battle!",
  "I've been training all day. Don't hold back!",
  "You can't get past without beating me!",
  "Let's see if your POKéMON are any good!",
];

let speciesCache = null;

/**
 * Every species a wild Pokemon could be: not legendary, mythical, an Ultra
 * Beast or Paradox, and the first in its line (encounter.ageAppropriate
 * evolves it to suit the level). Weighted by catch rate, so common Pokemon
 * are common.
 */
function allSpecies() {
  if (speciesCache) return speciesCache;
  const { loadSpecies } = require('../../Utils/pokemon');
  const index = require('../../Data/Pokemon/index.json');
  const typesOf = new Map();
  for (const f of index.forms) if (f.isDefault && !typesOf.has(f.speciesId)) typesOf.set(f.speciesId, f.types || []);
  speciesCache = [];
  for (const s of index.species) {
    const r = s.rarity || {};
    if (r.isLegendary || r.isMythical || r.isUltraBeast || r.isParadox) continue;
    const full = loadSpecies(s.id);
    if (!full || (full.evolution && full.evolution.evolvesFrom)) continue;
    speciesCache.push({ species: s.id, types: typesOf.get(s.id) || [], weight: Math.max(3, r.captureRate || 45) });
  }
  return speciesCache;
}

const poolCache = new Map();
function poolFor(biome) {
  if (!poolCache.has(biome)) {
    const types = BIOME_TYPES[biome] || ['normal'];
    poolCache.set(biome, allSpecies().filter((s) => s.types.some((t) => types.includes(t))).map(({ species, weight }) => ({ species, weight })));
  }
  return poolCache.get(biome);
}

function weighted(random, pool) {
  const total = pool.reduce((sum, p) => sum + p.weight, 0);
  let roll = random() * total;
  for (const p of pool) {
    roll -= p.weight;
    if (roll < 0) return p.species;
  }
  return pool[pool.length - 1].species;
}

/** A trainer's team: the ace at the battle's level, the rest a little under. */
function teamFor(random, pool, size, level) {
  const team = [];
  for (let i = 0; i < size; i++) {
    const last = i === size - 1;
    team.push({ species: weighted(random, pool), level: last ? level : Math.max(2, level - 1 - Math.floor(random() * 3)), evolve: true });
  }
  return team;
}

// ---------------------------------------------------------------------------
// Rewards
// ---------------------------------------------------------------------------

/**
 * What a hidden Poke Ball can hold: one item from these shop sections (the
 * same catalogue .shop sells), picked by the seed so it's the same for
 * everyone. Worth 50-900 coins: a nice find, not a fortune.
 */
const HIDDEN_SECTIONS = ['Evolution Items', 'Trade Items', 'Held Gear', 'Training', 'Type Boosters', 'Berries', 'Repels & Incenses'];
let hiddenCache = null;
function hiddenItem(random) {
  if (!hiddenCache) {
    const shop = require('../../Utils/content').shop();
    hiddenCache = shop.sections.filter((s) => HIDDEN_SECTIONS.includes(s.name)).flatMap((s) => s.items.map((i) => i.item));
    if (!hiddenCache.length) hiddenCache = ['rare-candy'];
  }
  return pickOf(random, hiddenCache);
}

// ---------------------------------------------------------------------------
// Looking up the plan
// ---------------------------------------------------------------------------

function routeAndGate(n) {
  for (const gate of worldplan.plan().gates) {
    const route = gate.routes.find((r) => r.number === n);
    if (route) return { gate, route };
  }
  return null;
}

/** Where the top of Route N leads back to: two tiles, for the two-wide exit. */
function above(n, gate) {
  if (n === gate.routes[0].number) return GATES[gate.number].inside.map((p) => ({ map: 'main-city', ...p }));
  return [0, 1].map((i) => ({ map: `stop-${n - 1}`, x: MIDDLE + i, y: STOP_HEIGHT - 2, facing: 'up' }));
}

// ---------------------------------------------------------------------------
// A route
// ---------------------------------------------------------------------------

function buildRoute(n) {
  const found = routeAndGate(n);
  if (!found) return null;
  const { gate, route } = found;
  const random = rng(`${worldplan.SEED}:route-${n}`);
  const pool = poolFor(route.biome);
  const locals = LOCALS[route.biome] || LOCALS.meadow;

  // Lay the route out first as a list of pieces, to know its height.
  const pieces = [{ kind: 'entry', rows: 4 }];
  let leg = 0;
  let inLeg = 0;
  const legSize = route.legs[0] ? route.legs[0].total : route.sequence.length;
  const pocketAt = new Set(route.pockets.map((_, i) => Math.floor(((i + 1) * route.sequence.length) / (route.pockets.length + 1))));
  route.sequence.forEach((battle, i) => {
    if (inLeg === legSize && leg < route.legs.length - 1) {
      leg += 1;
      inLeg = 0;
      pieces.push({ kind: 'rest', rows: 6, name: route.legs[leg - 1].restStop });
    }
    inLeg += 1;
    pieces.push({ kind: 'gap', rows: 2 + Math.floor(random() * 3) });
    if (pocketAt.has(i)) pieces.push({ kind: 'pocket', rows: 6, pocket: route.pockets[[...pocketAt].indexOf(i)] });
    // A patch of grass in a gap between trees: 4 rows to cross.
    if (battle.kind === 'wild') pieces.push({ kind: 'wild', rows: 4, battle, index: i });
    else pieces.push({ kind: battle.kind, rows: battle.kind === 'boss' ? 4 : 3, battle, index: i });
  });
  // The rival waits near the end of every gate's last route: a hard fight, once per gate.
  if (n === gate.routes[gate.routes.length - 1].number) pieces.push({ kind: 'gap', rows: 2 }, { kind: 'rival', rows: 4 });
  pieces.push({ kind: 'gap', rows: 3 }, { kind: 'exit', rows: 2 });

  // Pockets sit on even rows so their trees line up with the border's.
  let height = 0;
  for (const p of pieces) {
    if (p.kind === 'pocket' && height % 2) height += 1;
    p.y = height;
    height += p.rows;
  }
  if (height % 2) height += 1;
  const exitPiece = pieces[pieces.length - 1];
  exitPiece.y = height - 2;

  const map = new MapBuilder({
    id: `route-${n}`,
    name: route.name,
    kind: 'route',
    width: WIDTH,
    height,
    levels: { lo: route.levels.lo, hi: route.levels.hi },
    background: route.background,
    ground: GROUNDS[BIOME_GROUND[route.biome] || 'grass'],
  });
  map.pool = pool;
  const groundFlowers = map.ground.flowers;

  // Pines down both sides; open at the top and bottom middle.
  const midCell = MIDDLE / 2;
  map.border([[midCell, 0], [midCell, height / 2 - 1]]);
  // The sand path has grass edges: only on grass.
  if (map.ground.tile === TILES.grass) map.path(MIDDLE - 1, 0, 3, 5);

  let trainerCount = 0;
  let patchCount = 0;
  for (const p of pieces) {
    if (p.kind === 'entry') {
      map.sign(MIDDLE - 3, 2, [route.name.toUpperCase(), `${gate.name} · ${route.biome}`]);
    } else if (p.kind === 'gap') {
      // Something to look at, never in the way: flowers, and now and then
      // optional grass against the edge.
      for (let y = p.y; y < p.y + p.rows; y++) {
        if (groundFlowers.length && random() < 0.25) map.decorate(LEFT + Math.floor(random() * INNER), y, pickOf(random, groundFlowers));
      }
      if (p.rows >= 3 && random() < 0.35) {
        const side = random() < 0.5 ? LEFT : RIGHT - 2;
        map.grass(side, p.y, 3, Math.min(2, p.rows - 1));
      }
    } else if (p.kind === 'wild') {
      // Trees (rocks on rocky land and at sea) across the way, with a gap
      // full of grass you have to go through: one battle.
      patchCount += 1;
      const gap = LEFT + 2 * Math.floor(random() * 5);
      map.wall(p.y, LEFT, RIGHT, gap, gap + 5, p.rows);
      map.patch(`p${patchCount}`, gap, p.y, 6, p.rows, p.rows, p.battle.level);
    } else if (p.kind === 'trainer' || p.kind === 'boss') {
      trainerCount += 1;
      const boss = p.kind === 'boss';
      const fromLeft = boss ? false : random() < 0.5;
      const [cls, sprite] = boss ? ['Boss', pickOf(random, BOSS_SPRITES)] : pickOf(random, locals);
      const row = p.y + 1;
      const x = boss ? MIDDLE : fromLeft ? LEFT : RIGHT;
      map.trainer({
        id: `t${trainerCount}`,
        name: boss ? `Boss Trainer ${route.stop.name.split(' ').pop()}` : `${cls} ${trainerCount}`,
        sprite,
        x,
        y: boss ? p.y + 2 : row,
        // A boss looks up the route at you; others across the whole way.
        facing: boss ? 'up' : fromLeft ? 'right' : 'left',
        sight: boss ? 3 : INNER - 1,
        team: teamFor(random, pool, Math.max(1, p.battle.team), p.battle.level),
        before: boss ? [`So you made it to the end of ${route.name.toUpperCase()}. Let's see if you deserve to!`] : [pickOf(random, LINES)],
        after: boss ? ['You earned your way through. Go on!'] : [pickOf(random, AFTER_LINES)],
        // About four average .battle wins' worth of coins, on top of the battle's own.
        reward: boss ? { coins: 20 + Math.floor(n / 2) } : null,
      });
    } else if (p.kind === 'rival') {
      // His own starter (chosen against yours) leads; Web/overworld.js adds it per player.
      const size = Math.min(5, 1 + gate.number);
      const ace = route.levels.hi + 3;
      map.trainer({
        id: 'rival',
        rival: true,
        name: 'AIDE',
        sprite: 'cooldude_red',
        x: RIGHT,
        y: p.y + 2,
        facing: 'left',
        sight: INNER - 1,
        level: ace,
        team: teamFor(random, pool, size, ace - 1),
        before: [
          gate.number === 1 ? "AIDE: There you are! I've been training nonstop. Let's see who's stronger!" : `AIDE: Gate ${gate.number} already? Don't think I've been slacking!`,
        ],
        after: ["AIDE: I'll beat you next time. Just you wait!"],
        reward: { coins: 40 + n },
      });
    } else if (p.kind === 'rest') {
      map.place(`rest-${n}-${leg}`, p.name, p.y, p.y + p.rows - 1);
      if (map.ground.tile === TILES.grass) map.path(MIDDLE - 2, p.y + 1, 5, 4);
      map.sign(MIDDLE - 4, p.y + 2, [p.name.toUpperCase(), 'Take a breather before the next stretch.']);
      if (map.ground.border !== 'water') {
        // A rest house: someone with advice. No POKéMON CENTER on a route.
        map.building(BUILDINGS.brick, RIGHT - 4, p.y + 1, { lines: [pickOf(random, REST_TIPS)] });
      }
    } else if (p.kind === 'pocket') {
      // A 2x2 nook at the left: pines above and below, the obstacle on its
      // right, a Poke Ball and some optional grass inside.
      const hm = worldplan.HMS.find((h) => h.move === p.pocket.hm);
      map.tree(LEFT, p.y);
      map.tree(LEFT, p.y + 4);
      map.grass(LEFT + 1, p.y + 2, 1, 2);
      map.grass(LEFT, p.y + 3, 1, 1);
      map.item(LEFT, p.y + 2, `ball-${n}`, { item: hiddenItem(random) });
      map.obstacle(LEFT + 2, p.y + 2, hm.move, hm.after);
      map.obstacle(LEFT + 2, p.y + 3, hm.move, hm.after);
    }
  }

  if (map.ground.border === 'water') {
    map.surf = true;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < WIDTH; x++) {
        if (map.layers.objects[y][x] === TILES.tallGrass) {
          map.layers.objects[y][x] = null;
          map.set('ground', x, y, TILES.deep);
        }
      }
    }
  }

  // Exits: back up the way you came, and down to the stop.
  const back = above(n, gate);
  map.warp(MIDDLE, 0, back[0]);
  map.warp(MIDDLE + 1, 0, back[1]);
  map.warp(MIDDLE, height - 1, { map: `stop-${n}`, x: MIDDLE, y: 1, facing: 'down' });
  map.warp(MIDDLE + 1, height - 1, { map: `stop-${n}`, x: MIDDLE + 1, y: 1, facing: 'down' });
  map.spawn = { x: MIDDLE, y: 1, facing: 'down' };
  return map.build();
}

// ---------------------------------------------------------------------------
// The stop at the end of a route
// ---------------------------------------------------------------------------

const STOP_HEIGHT = 20;

/** Townsfolk, and what they might say. */
const FOLK = ['granny', 'cooldude', 'heroine_brown', 'fisher', 'florist', 'homemaker', 'postboy', 'childactor', 'monk', 'tennisplayer', 'scientist', 'barmaid', 'picnicker', 'beachcomber'];
const FOLK_LINES = [
  ['Did you come from the MAIN CITY? It feels so far away from here!'],
  ['The trainers on the next route are tougher than the last. Be ready!'],
  ['If your POKéMON stop listening, your TRAINER LEVEL is too low for them. Beat more milestones!'],
  ['I heard there are POKé BALLS hidden behind rocks and trees on the routes.', 'Some can only be reached after beating enough milestones.'],
  ['You can FLY back here any time once you have been here.'],
  ['Every route has some grass off to the side. Wild POKéMON live there forever!'],
  ['My grandpa says the BATTLE TOWER used to be a lighthouse. I am not sure I believe him.'],
  ['Lose a battle and you wake up at the last POKéMON CENTER you visited. Nothing else is lost!'],
];
/** What the people in rest houses say. */
const REST_TIPS = [
  "Long route, isn't it? Every battle out here pays the same TRAINER EXP as one on Discord.",
  'The grass right across the path always holds exactly one POKéMON. The grass off to the side never runs out.',
  'If you are tired of battling here, you can FLY back to town and come back later. Nothing you beat comes back.',
  'Trainers out here only see straight ahead. But on a route, they see the whole way across!',
  'Your team is healed after every battle, so push on!',
];
const HOMES = ['cottageBrown', 'cottageRed', 'cottageGrey', 'brick', 'cafe'];
const SHOPS = ['shopYellow', 'shopGreen', 'shopGrey', 'shopWhite'];

function buildStop(n) {
  const found = routeAndGate(n);
  if (!found) return null;
  const { gate, route } = found;
  const random = rng(`${worldplan.SEED}:stop-${n}`);
  const stop = route.stop;
  const town = stop.kind === 'town';

  const ground = GROUNDS[BIOME_GROUND[route.biome] || 'grass'];
  const map = new MapBuilder({
    id: `stop-${n}`,
    name: stop.name,
    kind: town ? 'town' : 'route',
    width: WIDTH,
    height: STOP_HEIGHT,
    background: route.background,
    // Towns stand on land even on the open sea.
    ground: ground.border === 'water' ? GROUNDS.sand : ground,
  });
  map.encounterRate = 0;

  const last = n === gate.routes[gate.routes.length - 1].number;
  const midCell = MIDDLE / 2;
  map.border(last ? [[midCell, 0]] : [[midCell, 0], [midCell, STOP_HEIGHT / 2 - 1]]);
  if (map.ground.tile === TILES.grass) map.path(MIDDLE - 1, 0, 4, STOP_HEIGHT);
  const flowerKinds = map.ground.flowers.length ? map.ground.flowers : TILES.flowers;
  const flower = (x, y) => map.decorate(x, y, pickOf(random, flowerKinds));

  if (town) {
    // Every town is laid out from its own seed: which side the CENTER is on,
    // what its houses look like, who lives there.
    const flip = random() < 0.5;
    const left = LEFT;
    const right = RIGHT - 4;
    map.building(BUILDINGS.centerSmall, flip ? right : left, 2, { station: 'center' });
    map.building(BUILDINGS.martBlue, flip ? left : right, 2, { station: 'mart' });
    const homeA = BUILDINGS[pickOf(random, HOMES)];
    const homeB = BUILDINGS[pickOf(random, [...HOMES, ...SHOPS])];
    const fit = (b, x) => Math.min(x, RIGHT + 1 - b.body[0].length);
    map.building(homeA, fit(homeA, left), 8, { lines: pickOf(random, FOLK_LINES) });
    map.building(homeB, fit(homeB, right - 1), 9, { lines: pickOf(random, FOLK_LINES) });
    map.sign(MIDDLE - 2, 7, [stop.name.toUpperCase(), `${gate.name} · after ${route.name}`]);
    const used = new Set();
    for (let k = 0; k < 2 + Math.floor(random() * 2); k++) {
      let lines = pickOf(random, FOLK_LINES);
      for (let t = 0; t < 4 && used.has(lines); t++) lines = pickOf(random, FOLK_LINES);
      used.add(lines);
      map.npc({ id: `folk${k}`, name: 'Townsperson', sprite: pickOf(random, FOLK), x: k % 2 ? MIDDLE + 3 : MIDDLE - 2, y: 15 + k, facing: k % 2 ? 'left' : 'right', lines });
    }
    for (let k = 0; k < 4; k++) flower(LEFT + Math.floor(random() * INNER), 14 + Math.floor(random() * 4));
  } else {
    const what = {
      reward: 'Someone left something here for travellers.',
      boss: `The boss of ${route.name.toUpperCase()} trains here.`,
      landmark: `The end of ${gate.name}. Well done for making it this far!`,
    }[stop.kind];
    map.sign(MIDDLE - 3, 3, [stop.name.toUpperCase(), what]);
    for (let k = 0; k < 10; k++) flower(LEFT + Math.floor(random() * INNER), 2 + Math.floor(random() * 15));
    // Benches to rest on.
    map.set('objects', LEFT + 1, 9, 'o1288').set('objects', LEFT + 2, 9, 'o1289').block(LEFT + 1, 9).block(LEFT + 2, 9);
    if (stop.kind === 'reward') {
      // A modest prize for getting here: less than the route's own battles paid.
      map.item(MIDDLE + 4, 8, `poi-${n}`, { coins: 50 + 2 * n });
    } else if (stop.kind === 'landmark') {
      // The end of a gate: a Lootbox, one per gate.
      map.item(MIDDLE + 4, 8, `landmark-${n}`, { item: require('../../Utils/lootbox').LOOTBOX });
      map.tree(RIGHT - 1, 12);
      map.tree(LEFT, 12);
    } else if (stop.kind === 'boss') {
      map.npc({
        id: 'fan', name: 'Fan', sprite: pickOf(random, FOLK), x: MIDDLE + 4, y: 8, facing: 'left',
        lines: [`Did you beat the boss of ${route.name.toUpperCase()}? Wow! I could never.`],
      });
    }
  }

  map.warp(MIDDLE, 0, { map: `route-${n}`, x: MIDDLE, y: 'bottom', facing: 'up' });
  map.warp(MIDDLE + 1, 0, { map: `route-${n}`, x: MIDDLE + 1, y: 'bottom', facing: 'up' });
  if (!last) {
    // On to the next route: only once this one is cleared and its milestone beaten.
    const requires = { route: n };
    map.warp(MIDDLE, STOP_HEIGHT - 1, { map: `route-${n + 1}`, x: MIDDLE, y: 1, facing: 'down', requires });
    map.warp(MIDDLE + 1, STOP_HEIGHT - 1, { map: `route-${n + 1}`, x: MIDDLE + 1, y: 1, facing: 'down', requires });
  }
  map.spawn = { x: MIDDLE, y: 2, facing: 'down' };
  return require('./world').finish(map);
}

/** Build a route or stop by its map id, or null. */
function build(id) {
  const m = /^(route|stop)-(\d+)$/.exec(id);
  if (!m) return null;
  const n = Number(m[2]);
  const map = m[1] === 'route' ? buildRoute(n) : buildStop(n);
  if (!map) return null;
  // Exits that land on "the bottom" of a route need its height.
  for (const w of map.warps) {
    if (w.to.y === 'bottom') {
      const target = require('./index').get(w.to.map);
      w.to.y = target ? target.height - 2 : 1;
    }
  }
  return map;
}

module.exports = { build, poolFor, STOP_HEIGHT };
