'use strict';

/**
 * The web world's plan: every town, route, gate and hidden item, generated
 * from one fixed seed so every player walks the same world.
 *
 * This is the layout and the balance, not the tiles. The tile maps are built
 * from it later.
 *
 * Shape:
 *
 *   Town 1 (home, the lab) -> Path a -> Town 2 -> Path b -> the Main City
 *
 *   The Main City is a ring with the Battle Tower in the middle, where the
 *   milestones are fought. Eight gates lead out, one per region of the
 *   milestone ladder (Gate 1 holds milestones 1-10, Gate 2 holds 11-20...).
 *   Each gate is one long road: Route N, a stop, Route N+1, a stop...
 *
 *   Route N is the route walked at trainer level N. It opens once Route N-1
 *   is cleared and milestone N-1 is beaten (Route 1 is open from the start).
 *
 * Balance:
 *
 *   A route's one-time battles (one per unavoidable grass patch, plus its
 *   trainers) pay ordinary trainer exp, 5 x the opponent's level, exactly as
 *   .battle does. Opponent levels are fixed per route, and battles are added
 *   until the route pays the exp that trainer level needs (Utils/trainer.js).
 *   So clearing Route N fills the bar for level N, the same as the wins .battle
 *   would take.
 *
 *   Route levels start low (Route 1 is Lv 2-6 for a Lv 5 starter) and catch
 *   up with the obedience cap by Route 8. After that they sit just under the
 *   cap, like .battle's opponents.
 *
 *   Optional grass pays the same per win and never runs out, like .battle.
 *
 * Pure and deterministic: `node Web/worldplan.js` prints it.
 */

const rates = require('../Utils/rates');
const trainer = require('../Utils/trainer');
const milestones = require('../Utils/milestones');

/** Change it and the whole world is rebuilt differently. */
const SEED = 'pokedropper-dev-build-a';

/** The most battles between two places to rest; longer routes get rest stops. */
const MAX_LEG_BATTLES = 25;

/** The chance a route has a hidden item (one at most). */
const POCKET_CHANCE = 0.35;

/** Every route has at least this many trainers, whatever the wild share says. */
const MIN_TRAINERS = 2;

/** Rough walking per battle, in tiles, for the length estimate. */
const TILES_PER_BATTLE = 12;

/**
 * Field moves, and how many milestones open each. Nobody has to know the
 * move; the count alone lets you use it.
 */
const HMS = [
  { move: 'Cut', after: 2, blocks: 'small tree' },
  { move: 'Flash', after: 5, blocks: 'dark cave' },
  { move: 'Rock Smash', after: 8, blocks: 'cracked rock' },
  { move: 'Surf', after: 10, blocks: 'water' },
  { move: 'Strength', after: 20, blocks: 'boulder' },
  { move: 'Rock Climb', after: 30, blocks: 'rocky wall' },
  { move: 'Waterfall', after: 40, blocks: 'waterfall' },
  { move: 'Dive', after: 50, blocks: 'deep sea' },
  { move: 'Defog', after: 60, blocks: 'whiteout' },
  { move: 'Whirlpool', after: 70, blocks: 'whirlpool' },
];

/**
 * Each gate's land, in ladder order. Every route on a gate takes one of its
 * biomes; `background` is the battle background (Tuxemon's ui/combat set).
 */
const GATE_BIOMES = [
  [{ biome: 'meadow', background: 'grass' }, { biome: 'forest', background: 'forest' }],
  [{ biome: 'beach', background: 'beach' }, { biome: 'coast', background: 'sea' }],
  [{ biome: 'jungle', background: 'forest' }, { biome: 'river valley', background: 'valley' }],
  [{ biome: 'mountain', background: 'cliff' }, { biome: 'cave', background: 'cave' }],
  [{ biome: 'desert', background: 'desert' }, { biome: 'canyon', background: 'canyon' }],
  [{ biome: 'open sea', background: 'ocean' }, { biome: 'reef', background: 'underwater' }],
  [{ biome: 'snowfield', background: 'snowplain' }, { biome: 'ice cave', background: 'cavern' }],
  [{ biome: 'blizzard', background: 'snow' }, { biome: 'summit', background: 'cliff' }],
];

/**
 * Which obstacles look right in each biome, for the hidden pockets. No Dive
 * spots in the desert.
 */
const BIOME_OBSTACLES = {
  meadow: ['Cut', 'Rock Smash', 'Strength', 'Surf', 'Flash', 'Rock Climb', 'Waterfall'],
  forest: ['Cut', 'Flash', 'Strength', 'Surf', 'Waterfall', 'Defog'],
  beach: ['Rock Smash', 'Strength', 'Surf', 'Dive', 'Whirlpool', 'Rock Climb'],
  coast: ['Surf', 'Dive', 'Whirlpool', 'Waterfall', 'Rock Climb', 'Rock Smash'],
  jungle: ['Cut', 'Waterfall', 'Surf', 'Defog', 'Rock Climb', 'Strength'],
  'river valley': ['Surf', 'Waterfall', 'Whirlpool', 'Rock Climb', 'Strength', 'Cut'],
  mountain: ['Rock Smash', 'Strength', 'Rock Climb', 'Waterfall', 'Flash', 'Defog'],
  cave: ['Flash', 'Rock Smash', 'Strength', 'Rock Climb', 'Surf', 'Waterfall', 'Dive'],
  desert: ['Rock Smash', 'Strength', 'Rock Climb', 'Defog', 'Cut'],
  canyon: ['Rock Climb', 'Strength', 'Rock Smash', 'Waterfall', 'Surf', 'Defog'],
  'open sea': ['Dive', 'Whirlpool', 'Waterfall', 'Defog'],
  reef: ['Dive', 'Whirlpool'],
  snowfield: ['Defog', 'Strength', 'Rock Smash', 'Rock Climb', 'Whirlpool', 'Surf'],
  'ice cave': ['Flash', 'Strength', 'Rock Climb', 'Rock Smash', 'Dive'],
  blizzard: ['Defog', 'Rock Climb', 'Strength'],
  summit: ['Defog', 'Rock Climb', 'Strength'],
};

// ---------------------------------------------------------------------------
// Seeded randomness
// ---------------------------------------------------------------------------

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32: small, fast, and the same everywhere. */
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

const between = (random, lo, hi) => lo + Math.floor(random() * (hi - lo + 1));

/** "a", "b", ... "z", "aa", "ab" - placeholder names until real ones exist. */
function letters(n) {
  let out = '';
  let k = n;
  do {
    out = String.fromCharCode(97 + (k % 26)) + out;
    k = Math.floor(k / 26) - 1;
  } while (k >= 0);
  return out;
}

// ---------------------------------------------------------------------------
// Levels and battles
// ---------------------------------------------------------------------------

/**
 * Opponent levels on Route N: the middle and the spread either side.
 *
 * Route 1 is centred on 4 (Lv 2-6). The centre climbs 1.6 a route until it
 * meets two under the cap, then follows the cap.
 */
function routeLevels(n) {
  const cap = trainer.capFor(n);
  const center = Math.min(cap - 2, Math.round(4 + (n - 1) * 1.6));
  return { lo: Math.max(2, center - 2), hi: center + 2, center, cap };
}

/** The share of a route's battles that are wild grass, per .battle's mix. */
function wildShare(n) {
  const { wildAtStart, wildAtEnd } = rates.battle;
  const through = Math.min(1, (n - 1) / milestones.total());
  return (wildAtStart + (wildAtEnd - wildAtStart) * through) / 100;
}

/** How many Pokemon a route trainer brings, per .battle's growth. */
function teamSize(n) {
  const { minNpcTeam, maxNpcTeam } = rates.battle;
  const through = Math.min(1, (n - 1) / milestones.total());
  return Math.min(maxNpcTeam, minNpcTeam + Math.floor(through * (maxNpcTeam - minNpcTeam + 1)));
}

/**
 * Route N's one-time battles, in walking order, until they pay the bar.
 *
 * Wild battles are one per unavoidable patch. Trainers are spread between
 * them by the wild share. The last battle on a boss route is the boss.
 */
function routeBattles(n, random, boss) {
  const { lo, hi, center } = routeLevels(n);
  const needed = trainer.expForLevel(n);
  const share = wildShare(n);
  const size = teamSize(n);

  const battles = [];
  let xp = 0;

  // The boss is a full team at the top of the band, and counts toward the bar.
  const bossBattle = boss
    ? { kind: 'boss', team: Math.min(6, size + 2), level: hi + 1 }
    : null;
  const target = needed - (bossBattle ? trainer.expForWin(bossBattle.level) : 0);

  // The first wild patch is placed first so a route opens with grass.
  let trainers = 0;
  while (xp < target) {
    const left = Math.ceil((target - xp) / trainer.expForWin(center));
    const wild = trainers + left > MIN_TRAINERS ? random() < share : false;
    if (!wild) trainers += 1;
    const level = wild ? between(random, lo, hi) : between(random, center, hi);
    const battle = wild
      ? { kind: 'wild', level }
      : { kind: 'trainer', team: size, level };
    battles.push(battle);
    xp += trainer.expForWin(level);
  }

  if (bossBattle) {
    battles.push(bossBattle);
    xp += trainer.expForWin(bossBattle.level);
  }

  return { battles, xp, needed };
}

/** Cut a route's battles into legs of at most MAX_LEG_BATTLES, evenly. */
function legsOf(battles) {
  const count = Math.ceil(battles.length / MAX_LEG_BATTLES);
  const per = Math.ceil(battles.length / count);
  const legs = [];
  for (let i = 0; i < battles.length; i += per) legs.push(battles.slice(i, i + per));
  return legs;
}

const tally = (battles) => ({
  total: battles.length,
  wild: battles.filter((b) => b.kind === 'wild').length,
  trainers: battles.filter((b) => b.kind !== 'wild').length,
});

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

function build() {
  const random = rng(SEED);
  const ladder = milestones.ladder();

  let towns = 2; // Town 1 and Town 2 are the intro.
  let pois = 0;
  let bosses = 0;

  const intro = [
    { kind: 'town', name: 'Town 1', role: 'home: your house, the lab, Professor A' },
    { kind: 'path', name: 'Path a', grass: 'optional only', levels: { lo: 2, hi: 4 } },
    { kind: 'town', name: 'Town 2', role: 'first Pokemon Center' },
    { kind: 'path', name: 'Path b', grass: 'optional only', levels: { lo: 3, hi: 5 } },
    { kind: 'city', name: 'Main City', role: 'Battle Tower, Drop Station, the eight gates' },
  ];

  // Group the ladder by region: one gate each.
  const regions = [];
  for (const fight of ladder) {
    let region = regions[regions.length - 1];
    if (!region || region.region !== fight.region) {
      region = { region: fight.region, fights: [] };
      regions.push(region);
    }
    region.fights.push(fight);
  }

  const gates = regions.map((region, g) => {
    const biomes = GATE_BIOMES[g % GATE_BIOMES.length];
    const first = region.fights[0].order;
    const last = region.fights[region.fights.length - 1].order;

    // Field moves you can use on this gate's main path from its first step.
    const opened = HMS.filter((hm) => hm.after <= first - 1).map((hm) => hm.move);

    let sinceTown = 0;

    const routes = region.fights.map((fight, i) => {
      const n = fight.order;
      const final = i === region.fights.length - 1;

      // What waits at the end of the route. A town at least every other
      // route, so there is always somewhere near to fly back to.
      // Fewer towns than stops, so each town can be made by hand.
      let stop;
      const roll = random();
      if (final) stop = 'landmark';
      else if (sinceTown >= 2 || roll < 0.35) stop = 'town';
      else if (roll < 0.7) stop = 'reward';
      else stop = 'boss';
      sinceTown = stop === 'town' ? 0 : sinceTown + 1;

      const { battles, xp, needed } = routeBattles(n, random, stop === 'boss');
      const legs = legsOf(battles);

      // Hidden pockets: a Poke Ball behind an obstacle that only a later
      // milestone opens, with optional grass inside.
      const biome = biomes[Math.floor(random() * biomes.length)];

      const fits = BIOME_OBSTACLES[biome.biome] || [];
      const later = HMS.filter((hm) => hm.after >= n && fits.includes(hm.move));
      // About one route in three has one: worth coming back for, not a chore.
      const pockets = [];
      const wanted = later.length && random() < POCKET_CHANCE ? 1 : 0;
      for (let k = 0; k < wanted; k += 1) {
        // Mostly the next few field moves, so a pocket is a short wait, not 50 levels.
        const hm = later[Math.floor(random() * Math.min(later.length, 3))];
        pockets.push({ hm: hm.move, opensAt: hm.after, blocks: hm.blocks, reward: 'Poke Ball item (reward TBD)' });
      }

      let stopName;
      if (stop === 'town') stopName = `Town ${++towns}`;
      else if (stop === 'boss') stopName = `Boss Trainer ${String.fromCharCode(65 + (bosses++ % 26))}`;
      else stopName = `POI ${letters(pois++)}`;

      return {
        number: n,
        name: `Route ${n}`,
        milestone: milestones.title(fight),
        biome: biome.biome,
        background: biome.background,
        levels: routeLevels(n),
        battles: tally(battles),
        trainerTeam: teamSize(n),
        xp,
        needed,
        dotBattleWins: Math.ceil(needed / trainer.expForWin(trainer.capFor(n))),
        legs: legs.map((leg, k) => ({
          ...tally(leg),
          restStop: k < legs.length - 1 ? `Rest stop ${n}-${k + 1}` : null,
        })),
        tiles: battles.length * TILES_PER_BATTLE,
        // Every battle in walking order: what the map builder places.
        sequence: battles.map((b) => ({ kind: b.kind, level: b.level, team: b.team || 1 })),
        stop: { kind: stop, name: stopName },
        pockets,
      };
    });

    return {
      number: g + 1,
      name: `Gate ${g + 1}`,
      region: region.region,
      milestones: [first, last],
      biomes: biomes.map((b) => b.biome),
      fieldMovesOpen: opened,
      routes,
    };
  });

  return { seed: SEED, hms: HMS, intro, gates };
}

let cached = null;
const plan = () => cached || (cached = build());

module.exports = { plan, routeLevels, HMS, SEED };

// `node Web/worldplan.js` - the whole world, as a table. `--json` for the data.
if (require.main === module) {
  const world = plan();

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(world, null, 2));
    process.exit(0);
  }

  console.log(`seed "${world.seed}"\n`);
  console.log(world.intro.map((p) => p.name).join(' -> '), '\n');

  let all = 0;
  let allDot = 0;

  for (const gate of world.gates) {
    console.log(`${gate.name} (${gate.region}, milestones ${gate.milestones.join('-')}, ${gate.biomes.join(' / ')})`);
    console.log('  route  levels   battles  wild  trn   exp / needed   .b wins  legs  stop');

    for (const r of gate.routes) {
      all += r.battles.total;
      allDot += r.dotBattleWins;
      console.log(
        `  ${String(r.number).padStart(5)}  ${`${r.levels.lo}-${r.levels.hi}`.padStart(6)}  ` +
          `${String(r.battles.total).padStart(7)}  ${String(r.battles.wild).padStart(4)}  ` +
          `${String(r.battles.trainers).padStart(3)}  ${`${r.xp} / ${r.needed}`.padStart(13)}  ` +
          `${String(r.dotBattleWins).padStart(7)}  ${String(r.legs.length).padStart(4)}  ` +
          `${r.stop.name}${r.pockets.length ? `   hidden: ${r.pockets.map((p) => p.hm).join(', ')}` : ''}`
      );
    }
    console.log('');
  }

  console.log(`route battles in all: ${all}; .battle wins for the same levels: ${allDot}`);
}
