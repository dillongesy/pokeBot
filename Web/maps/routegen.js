'use strict';

/**
 * Builds every route, and the stop at its end, from the world plan
 * (Web/worldplan.js). Seeded, so every player gets the same maps.
 *
 * A route runs away from the city the way its gate faces (north, east,
 * south or west: HEADING). In walking order it holds exactly the plan's
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
 * Route N's way in connects to where the gate starts (or the stop before
 * it), its way out to stop N. Leaving stop N for Route N+1 needs Route N cleared
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
const gates = () => require('./world').GATES;

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
// Which way each gate's routes run
// ---------------------------------------------------------------------------

/**
 * Each gate's routes lead away from the city the way the gate faces: out
 * the north gates and you walk north, out the east gates east. (Gates 1 and
 * 8 are on the city's north edge, 2 and 3 east, 4 and 5 south, 6 and 7 west.)
 */
const HEADING = { 1: 'up', 8: 'up', 2: 'right', 3: 'right', 4: 'down', 5: 'down', 6: 'left', 7: 'left' };
const STEP_OF = { down: [0, 1], up: [0, -1], right: [1, 0], left: [-1, 0] };
const NAME_OF = (dx, dy) => (dx > 0 ? 'right' : dx < 0 ? 'left' : dy > 0 ? 'down' : 'up');

/**
 * A route is laid out "along" (0 at the way in, L - 1 at the way out) and
 * "across" (0 to WIDTH - 1, LEFT to RIGHT inside the trees), then turned to
 * run the way its gate heads. Facings: 'down' is onward, 'up' back the way
 * you came, 'left' and 'right' across.
 */
function frame(heading, L, across = WIDTH) {
  const [ax, ay] = STEP_OF[heading];
  // Across runs left to right on a north-south route, top to bottom on an east-west one.
  const [cx, cy] = ay ? [1, 0] : [0, 1];
  const vertical = Boolean(ay);
  const pt = (a, c) => ({
    x: vertical ? c : ax > 0 ? a : L - 1 - a,
    y: vertical ? (ay > 0 ? a : L - 1 - a) : c,
  });
  return {
    heading,
    vertical,
    width: vertical ? across : L,
    height: vertical ? L : across,
    pt,
    /** A rectangle: `la` tiles along from a0, `lc` across from c0. */
    rect(a0, c0, la, lc) {
      const p = pt(a0, c0);
      const q = pt(a0 + la - 1, c0 + lc - 1);
      return { x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), w: Math.abs(q.x - p.x) + 1, h: Math.abs(q.y - p.y) + 1 };
    },
    face(f) {
      if (f === 'down') return NAME_OF(ax, ay);
      if (f === 'up') return NAME_OF(-ax, -ay);
      if (f === 'right') return NAME_OF(cx, cy);
      return NAME_OF(-cx, -cy);
    },
  };
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

// ---------------------------------------------------------------------------
// A route
// ---------------------------------------------------------------------------

/**
 * A route's pieces in walking order, and its length. The same random
 * numbers drawn in the same order as ever, so its battles never change;
 * `random` carries on from here for building it.
 */
function layout(n) {
  const found = routeAndGate(n);
  if (!found) return null;
  const { gate, route } = found;
  const random = rng(`${worldplan.SEED}:route-${n}`);
  const pieces = [{ kind: 'entry', rows: 4 }];
  let leg = 0;
  let inLeg = 0;
  const legSize = route.legs[0] ? route.legs[0].total : route.sequence.length;
  const pocketAt = new Set(route.pockets.map((_, i) => Math.floor(((i + 1) * route.sequence.length) / (route.pockets.length + 1))));
  route.sequence.forEach((battle, i) => {
    if (inLeg === legSize && leg < route.legs.length - 1) {
      leg += 1;
      inLeg = 0;
      pieces.push({ kind: 'rest', rows: 6, name: route.legs[leg - 1].restStop, leg });
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
  let length = 0;
  for (const p of pieces) {
    if (p.kind === 'pocket' && length % 2) length += 1;
    p.y = length;
    length += p.rows;
  }
  if (length % 2) length += 1;
  pieces[pieces.length - 1].y = length - 2;
  return { gate, route, random, pieces, length, F: frame(HEADING[gate.number], length) };
}

/**
 * Where you stand arriving on a route or stop: at its start (coming from the
 * city or the stop before) or its end (coming back from further on). The
 * exits are two tiles wide; `i` is which of the two. Worked out without
 * building the map.
 */
function arrival(id, end, i) {
  const m = /^(route|stop)-(\d+)$/.exec(id);
  const n = Number(m[2]);
  if (m[1] === 'route') {
    const { F, length } = layout(n);
    const at = end === 'start' ? F.pt(1, MIDDLE + i) : F.pt(length - 2, MIDDLE + i);
    return { map: id, ...at, facing: F.face(end === 'start' ? 'down' : 'up') };
  }
  const { gate } = routeAndGate(n);
  const S = stopFrame(HEADING[gate.number]);
  const at = end === 'start' ? S.pt(1, MIDDLE + i) : S.pt(S.length - 2, MIDDLE + i);
  return { map: id, ...at, facing: S.face(end === 'start' ? 'down' : 'up') };
}

/** Where the start of Route N leads back to: two tiles, for the two-wide way out. */
function behind(n, gate) {
  if (n === gate.routes[0].number) return gates()[gate.number].inside.map((p) => ({ map: 'main-city', ...p }));
  return [0, 1].map((i) => arrival(`stop-${n - 1}`, 'end', i));
}

function buildRoute(n) {
  const laid = layout(n);
  if (!laid) return null;
  const { gate, route, random, pieces, length: height, F } = laid;
  const pool = poolFor(route.biome);
  const locals = LOCALS[route.biome] || LOCALS.meadow;

  const map = new MapBuilder({
    id: `route-${n}`,
    name: route.name,
    kind: 'route',
    width: F.width,
    height: F.height,
    levels: { lo: route.levels.lo, hi: route.levels.hi },
    background: route.background,
    ground: GROUNDS[BIOME_GROUND[route.biome] || 'grass'],
  });
  map.pool = pool;
  map.heading = F.heading;
  const groundFlowers = map.ground.flowers;
  // Shapes laid out along and across, turned the way the route runs.
  const at = (a, c) => F.pt(a, c);
  const box = (a0, c0, la, lc) => F.rect(a0, c0, la, lc);
  const tree = (a, c) => {
    const r = box(a, c, 2, 2);
    map.tree(r.x, r.y);
  };
  const rock = (a, c) => {
    const p = at(a, c);
    map.set('objects', p.x, p.y, ROCKS[(p.x * 7 + p.y * 13) % ROCKS.length]).block(p.x, p.y);
  };
  /** Trees (or rocks) right across the way, `rows` deep, but for a gap. */
  const wall = (a0, rows, gap0, gap1) => {
    const inGap = (c) => c >= gap0 && c <= gap1;
    const trees = (map.ground.border || 'trees') === 'trees';
    for (let a = a0; a < a0 + rows; a += 2) {
      for (let c = LEFT; c <= RIGHT; c += 2) {
        const span = [c, c + 1].filter((x) => x <= RIGHT);
        if (trees && span.length === 2 && !span.some(inGap) && a + 1 < a0 + rows) {
          tree(a, c);
          continue;
        }
        for (const x of span) if (!inGap(x)) for (const r of [a, a + 1]) if (r < a0 + rows) rock(r, x);
      }
    }
  };

  // Pines all round; open at the way in and the way out.
  const cell = (p) => [Math.floor(p.x / 2), Math.floor(p.y / 2)];
  map.border([cell(at(0, MIDDLE)), cell(at(height - 1, MIDDLE))]);
  // The sand path has grass edges: only on grass.
  if (map.ground.tile === TILES.grass) {
    const r = box(0, MIDDLE - 1, 5, 3);
    map.path(r.x, r.y, r.w, r.h);
  }

  let trainerCount = 0;
  let patchCount = 0;
  for (const p of pieces) {
    if (p.kind === 'entry') {
      const s = at(2, MIDDLE - 3);
      map.sign(s.x, s.y, [route.name.toUpperCase(), `${gate.name} · ${route.biome}`]);
    } else if (p.kind === 'gap') {
      // Something to look at, never in the way: flowers, and now and then
      // optional grass against the edge.
      for (let a = p.y; a < p.y + p.rows; a++) {
        if (groundFlowers.length && random() < 0.25) {
          const c = LEFT + Math.floor(random() * INNER);
          const f = at(a, c);
          map.decorate(f.x, f.y, pickOf(random, groundFlowers));
        }
      }
      if (p.rows >= 3 && random() < 0.35) {
        const side = random() < 0.5 ? LEFT : RIGHT - 2;
        const r = box(p.y, side, Math.min(2, p.rows - 1), 3);
        map.grass(r.x, r.y, r.w, r.h);
      }
    } else if (p.kind === 'wild') {
      // Trees (rocks on rocky land and at sea) across the way, with a gap
      // full of grass you have to go through: one battle.
      patchCount += 1;
      const gap = LEFT + 2 * Math.floor(random() * 5);
      wall(p.y, p.rows, gap, gap + 5);
      const r = box(p.y, gap, p.rows, 6);
      map.patch(`p${patchCount}`, r.x, r.y, r.w, r.h, p.rows, p.battle.level);
    } else if (p.kind === 'trainer' || p.kind === 'boss') {
      trainerCount += 1;
      const boss = p.kind === 'boss';
      const fromLeft = boss ? false : random() < 0.5;
      const [cls, sprite] = boss ? ['Boss', pickOf(random, BOSS_SPRITES)] : pickOf(random, locals);
      const spot = at(boss ? p.y + 2 : p.y + 1, boss ? MIDDLE : fromLeft ? LEFT : RIGHT);
      map.trainer({
        id: `t${trainerCount}`,
        name: boss ? `Boss Trainer ${route.stop.name.split(' ').pop()}` : `${cls} ${trainerCount}`,
        sprite,
        x: spot.x,
        y: spot.y,
        // A boss looks back down the route at you; others across the whole way.
        facing: F.face(boss ? 'up' : fromLeft ? 'right' : 'left'),
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
      const spot = at(p.y + 2, RIGHT);
      map.trainer({
        id: 'rival',
        rival: true,
        name: 'AIDE',
        sprite: 'cooldude_red',
        x: spot.x,
        y: spot.y,
        facing: F.face('left'),
        sight: INNER - 1,
        level: ace,
        team: teamFor(random, pool, size, ace - 1),
        before: [
          gate.number === 1 ? "AIDE: There you are! I've been training nonstop. Let's see who's stronger!" : `AIDE: Gate ${gate.number} already? Don't think I've been slacking!`,
        ],
        won: [
          'AIDE: Argh, not again!',
          "AIDE: I've been training every day, you know. You're just... really good.",
          "AIDE: Fine. I'll get even stronger. Don't you dare slow down!",
        ],
        after: ["AIDE: I'll beat you next time. Just you wait!"],
        reward: { coins: 40 + n },
      });
    } else if (p.kind === 'rest') {
      const whole = box(p.y, 0, p.rows, WIDTH);
      map.place(`rest-${n}-${p.leg}`, p.name, whole);
      // A rest house (someone with advice; no POKéMON CENTER on a route),
      // always upright with its door facing down onto open ground: on the
      // right of a north-south route, at the top of an east-west one.
      const house = BUILDINGS.brick;
      const hw = house.body[0].length;
      const hh = house.above.length + house.body.length;
      let hx;
      let hy;
      if (F.vertical) {
        hx = RIGHT - 4;
        hy = F.heading === 'down' ? whole.y + 1 : whole.y;
        if (map.ground.tile === TILES.grass) map.path(MIDDLE - 2, whole.y + 1, 5, 4);
        map.sign(MIDDLE - 4, whole.y + 2, [p.name.toUpperCase(), 'Take a breather before the next stretch.']);
      } else {
        hx = whole.x;
        hy = LEFT;
        if (map.ground.tile === TILES.grass) map.path(whole.x + 1, MIDDLE - 1, 4, 4);
        map.sign(whole.x + 1, MIDDLE + 5, [p.name.toUpperCase(), 'Take a breather before the next stretch.']);
      }
      if (map.ground.border !== 'water' && hw <= (F.vertical ? 5 : p.rows) && hh <= (F.vertical ? p.rows : 6)) {
        map.building(house, hx, hy, { lines: [pickOf(random, REST_TIPS)] });
      }
    } else if (p.kind === 'pocket') {
      // A 2x2 nook against the edge: pines either side along the way, the
      // obstacle on its open side, a Poke Ball and some optional grass inside.
      const hm = worldplan.HMS.find((h) => h.move === p.pocket.hm);
      tree(p.y, LEFT);
      tree(p.y + 4, LEFT);
      const g1 = box(p.y + 2, LEFT + 1, 2, 1);
      map.grass(g1.x, g1.y, g1.w, g1.h);
      const g2 = at(p.y + 3, LEFT);
      map.grass(g2.x, g2.y, 1, 1);
      const ball = at(p.y + 2, LEFT);
      map.item(ball.x, ball.y, `ball-${n}`, { item: hiddenItem(random) });
      for (const a of [p.y + 2, p.y + 3]) {
        const o = at(a, LEFT + 2);
        map.obstacle(o.x, o.y, hm.move, hm.after);
      }
    }
  }

  if (map.ground.border === 'water') {
    map.surf = true;
    for (let y = 0; y < F.height; y++) {
      for (let x = 0; x < F.width; x++) {
        if (map.layers.objects[y][x] === TILES.tallGrass) {
          map.layers.objects[y][x] = null;
          map.set('ground', x, y, TILES.deep);
        }
      }
    }
  }

  // Ways out: back the way you came, and on to the stop.
  const back = behind(n, gate);
  [0, 1].forEach((i) => {
    const inn = at(0, MIDDLE + i);
    const out = at(height - 1, MIDDLE + i);
    map.warp(inn.x, inn.y, back[i]);
    map.warp(out.x, out.y, arrival(`stop-${n}`, 'start', i));
  });
  map.spawn = { ...at(1, MIDDLE), facing: F.face('down') };
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

/**
 * A stop's frame: 20 tiles along, 18 across on a north-south route; on an
 * east-west one 22 along and 20 across (room for houses above and below the
 * road through it).
 */
function stopFrame(heading) {
  const vertical = heading === 'up' || heading === 'down';
  const length = vertical ? STOP_HEIGHT : 22;
  const F = frame(heading, length, vertical ? WIDTH : 20);
  F.length = length;
  // A north-south stop is drawn the same both ways round (its houses face
  // south either way); only which end is the way in changes.
  if (heading === 'up') {
    const down = frame('down', length);
    F.pt = (a, c) => down.pt(length - 1 - a, c);
  }
  return F;
}

function buildStop(n) {
  const found = routeAndGate(n);
  if (!found) return null;
  const { gate, route } = found;
  const random = rng(`${worldplan.SEED}:stop-${n}`);
  const stop = route.stop;
  const town = stop.kind === 'town';
  const S = stopFrame(HEADING[gate.number]);

  const ground = GROUNDS[BIOME_GROUND[route.biome] || 'grass'];
  const map = new MapBuilder({
    id: `stop-${n}`,
    name: stop.name,
    kind: town ? 'town' : 'route',
    width: S.width,
    height: S.height,
    background: route.background,
    // Towns stand on land even on the open sea.
    ground: ground.border === 'water' ? GROUNDS.sand : ground,
  });
  map.encounterRate = 0;
  map.heading = S.heading;

  const last = n === gate.routes[gate.routes.length - 1].number;
  const cell = (p) => [Math.floor(p.x / 2), Math.floor(p.y / 2)];
  const wayIn = S.pt(0, MIDDLE);
  const wayOut = S.pt(S.length - 1, MIDDLE);
  map.border(last ? [cell(wayIn)] : [cell(wayIn), cell(wayOut)]);
  const flowerKinds = map.ground.flowers.length ? map.ground.flowers : TILES.flowers;
  const flower = (x, y) => map.decorate(x, y, pickOf(random, flowerKinds));

  if (S.vertical) {
    // North-south: the road straight down the middle, houses either side.
    if (map.ground.tile === TILES.grass) map.path(MIDDLE - 1, 0, 4, STOP_HEIGHT);
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
      townFolk(map, random, (k) => ({ x: k % 2 ? MIDDLE + 3 : MIDDLE - 2, y: 15 + k, facing: k % 2 ? 'left' : 'right' }));
      for (let k = 0; k < 4; k++) flower(LEFT + Math.floor(random() * INNER), 14 + Math.floor(random() * 4));
    } else {
      map.sign(MIDDLE - 3, 3, [stop.name.toUpperCase(), stopWords(stop, route, gate)]);
      for (let k = 0; k < 10; k++) flower(LEFT + Math.floor(random() * INNER), 2 + Math.floor(random() * 15));
      stopThings(map, random, stop, route, n, { bench: [LEFT + 1, 9], spot: [MIDDLE + 4, 8], trees: [[RIGHT - 1, 12], [LEFT, 12]] });
    }
  } else {
    // East-west: the road straight across the middle, houses above it
    // (doors onto the road) and below it (doors onto the lane by the trees).
    const W = S.width;
    if (map.ground.tile === TILES.grass) map.path(0, MIDDLE - 1, W, 4);
    if (town) {
      const flip = random() < 0.5;
      const left = 3;
      const right = W - 8;
      map.building(BUILDINGS.centerSmall, flip ? right : left, 3, { station: 'center' });
      map.building(BUILDINGS.martBlue, flip ? left : right, 3, { station: 'mart' });
      const homeA = BUILDINGS[pickOf(random, HOMES)];
      const homeB = BUILDINGS[pickOf(random, [...HOMES, ...SHOPS])];
      const below = (b, x) => map.building(b, x, 16 - (b.above.length + b.body.length) + 1, { lines: pickOf(random, FOLK_LINES) });
      below(homeA, left);
      below(homeB, right);
      map.sign(Math.floor(W / 2) - 1, 5, [stop.name.toUpperCase(), `${gate.name} · after ${route.name}`]);
      townFolk(map, random, (k) => ({ x: 8 + 2 * k, y: 12 + k, facing: k % 2 ? 'left' : 'right' }));
      for (let k = 0; k < 4; k++) flower(LEFT + Math.floor(random() * (W - 4)), 12 + Math.floor(random() * 5));
    } else {
      map.sign(4, 5, [stop.name.toUpperCase(), stopWords(stop, route, gate)]);
      for (let k = 0; k < 10; k++) flower(LEFT + Math.floor(random() * (W - 4)), 2 + Math.floor(random() * 15));
      stopThings(map, random, stop, route, n, { bench: [8, 4], spot: [W - 8, 13], trees: [[W - 5, 13], [3, 13]] });
    }
  }

  // Back to the route, and (unless it's the gate's last) on to the next.
  [0, 1].forEach((i) => {
    const inn = S.pt(0, MIDDLE + i);
    map.warp(inn.x, inn.y, arrival(`route-${n}`, 'end', i));
    if (!last) {
      // On to the next route: only once this one is cleared and its milestone beaten.
      const out = S.pt(S.length - 1, MIDDLE + i);
      map.warp(out.x, out.y, { ...arrival(`route-${n + 1}`, 'start', i), requires: { route: n } });
    }
  });
  map.spawn = { ...S.pt(2, MIDDLE), facing: S.face('down') };
  return require('./world').finish(map);
}

/** Two or three townspeople, each with something different to say. */
function townFolk(map, random, spotOf) {
  const used = new Set();
  for (let k = 0; k < 2 + Math.floor(random() * 2); k++) {
    let lines = pickOf(random, FOLK_LINES);
    for (let t = 0; t < 4 && used.has(lines); t++) lines = pickOf(random, FOLK_LINES);
    used.add(lines);
    map.npc({ id: `folk${k}`, name: 'Townsperson', sprite: pickOf(random, FOLK), ...spotOf(k), lines });
  }
}

/** What the sign at a stop that isn't a town says. */
function stopWords(stop, route, gate) {
  return {
    reward: 'Someone left something here for travellers.',
    boss: `The boss of ${route.name.toUpperCase()} trains here.`,
    landmark: `The end of ${gate.name}. Well done for making it this far!`,
  }[stop.kind];
}

/** A stop that isn't a town: a bench, and its prize, fan or Lootbox. */
function stopThings(map, random, stop, route, n, { bench, spot, trees }) {
  const [bx, by] = bench;
  map.set('objects', bx, by, 'o1288').set('objects', bx + 1, by, 'o1289').block(bx, by).block(bx + 1, by);
  const [sx, sy] = spot;
  if (stop.kind === 'reward') {
    // A modest prize for getting here: less than the route's own battles paid.
    map.item(sx, sy, `poi-${n}`, { coins: 50 + 2 * n });
  } else if (stop.kind === 'landmark') {
    // The end of a gate: a Lootbox, one per gate.
    map.item(sx, sy, `landmark-${n}`, { item: require('../../Utils/lootbox').LOOTBOX });
    for (const [tx, ty] of trees) map.tree(tx, ty);
  } else if (stop.kind === 'boss') {
    map.npc({
      id: 'fan', name: 'Fan', sprite: pickOf(random, FOLK), x: sx, y: sy, facing: 'left',
      lines: [`Did you beat the boss of ${route.name.toUpperCase()}? Wow! I could never.`],
    });
  }
}

/** Build a route or stop by its map id, or null. */
function build(id) {
  const m = /^(route|stop)-(\d+)$/.exec(id);
  if (!m) return null;
  const n = Number(m[2]);
  return m[1] === 'route' ? buildRoute(n) : buildStop(n);
}

module.exports = { build, poolFor, arrival, HEADING, STOP_HEIGHT };
