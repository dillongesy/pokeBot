'use strict';

/**
 * The website's overworld, decided on the server.
 *
 * The browser draws the world and predicts your steps so walking feels
 * immediate, but every step is sent here and checked: it must be next to where
 * you stand, onto something you can stand on, and not while you're battling.
 * A refused step sends back where you really are.
 *
 * Everything that pays out is decided here too:
 *
 *   One-battle grass patches. Entering a patch rolls which step (from the 2nd
 *   up to the patch's depth) starts its battle, so it never starts on the
 *   first step and always before you can leave the far side. Win it and the
 *   patch is done for this prestige. Lose, run or have nobody who will fight,
 *   and nothing is spent: the roll starts over next time you go in.
 *
 *   Optional grass: a wild battle on a step now and then (the map's rate),
 *   forever, paying what .battle pays.
 *
 *   Trainers: after each step, an unbeaten trainer who can see you (straight
 *   along the way they face, nothing in between) stops you and battles you.
 *   Beaten trainers stay beaten for this prestige.
 *
 *   Losing: you black out and wake at the last town you visited.
 *
 * Progress is stored per prestige (web_progress), so a prestige restarts the
 * world without deleting anything.
 *
 * Battles themselves are the bot's real battles, started through the
 * `fight` function Web/server.js hands to configure().
 *
 * Exploring (the owner's dev console, see dev() below): a second position
 * that is never saved. While exploring, nothing starts a battle, trainers
 * don't see you, doors stay shut and nothing is marked done, so the owner can
 * look round every map (noclip and warp included) without touching their
 * real progress. Leaving puts them back where they really were.
 */

const db = require('../Utils/db');
const store = require('../Utils/store');
const maps = require('./maps');

/** Steps can arrive this close together (a run step is 110 ms in the browser)... */
const STEP_REFILL_MS = 95;
/** ...with a little bunching from the network allowed. */
const STEP_BURST = 4;

/** userId -> the live state. Loaded from web_position on first use. */
const players = new Map();

/**
 * userId -> the owner's dev settings: { ghost, noclip, overlay }, where
 * `ghost` is the exploring position (never saved), or null when playing for real.
 */
const devs = new Map();
const devOf = (userId) => devs.get(userId) || null;
/** Faster steps are fine while exploring (the browser's speed setting). */
const GHOST_REFILL_MS = 25;
const GHOST_BURST = 8;

let fight = null;
let notify = () => {};

/**
 * @param {object} hooks
 * @param {(userId: string, foe: object) => Promise<{won:boolean, lost:boolean}|{error:string}>} hooks.fight
 *        start a battle; resolves when it's over
 * @param {(userId: string, event: string, data: object) => void} hooks.notify
 *        send something to the player's open pages
 */
function configure(hooks) {
  fight = hooks.fight;
  notify = hooks.notify || notify;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function prestigeOf(userId) {
  const row = store.getUser(userId);
  return (row && row.prestige) || 0;
}

function isDone(userId, key) {
  return Boolean(
    db.open()
      .prepare('SELECT 1 FROM web_progress WHERE discord_user_id = ? AND prestige = ? AND key = ?')
      .get(userId, prestigeOf(userId), key)
  );
}

function markDone(userId, key) {
  db.open()
    .prepare('INSERT OR IGNORE INTO web_progress (discord_user_id, prestige, key, done_at) VALUES (?, ?, ?, ?)')
    .run(userId, prestigeOf(userId), key, Date.now());
}

const trainerKey = (mapId, id) => `${mapId}:trainer:${id}`;
const patchKey = (mapId, id) => `${mapId}:patch:${id}`;
const itemKey = (mapId, id) => `${mapId}:item:${id}`;

/** Milestones beaten: what opens field-move obstacles. */
function milestonesOf(userId) {
  const row = store.getUser(userId);
  return (row && row.milestones_cleared) || 0;
}

/** Is everything on Route N beaten (every patch and trainer)? */
function routeCleared(userId, n) {
  const map = maps.get(`route-${n}`);
  if (!map) return false;
  return map.patches.every((p) => isDone(userId, patchKey(map.id, p.id))) &&
    map.trainers.every((t) => isDone(userId, trainerKey(map.id, t.id)));
}

/**
 * Can this player stand here? Solid tiles can't be walked on, except an
 * obstacle they have the milestones for, or a Poke Ball they've picked up.
 */
function walkable(userId, map, x, y) {
  if (!map.solid[y] || map.solid[y][x] === undefined) return false;
  if (map.trainers.some((t) => !gone(userId, map, t) && same(spotOf(userId, map, t), x, y))) return false;
  if (!map.solid[y][x]) return true;
  const o = (map.obstacles || []).find((b) => b.x === x && b.y === y);
  if (o) return milestonesOf(userId) >= o.after;
  const item = (map.items || []).find((i) => i.x === x && i.y === y);
  if (item) return isDone(userId, itemKey(map.id, item.id));
  return false;
}

const same = (s, x, y) => s.x === x && s.y === y;
const spotPrefix = (mapId, id) => `${mapId}:trainerat:${id}:`;

/**
 * Where a trainer stands for this player: a beaten trainer stays where they
 * walked up to you (as in the games); otherwise where the map puts them.
 * Cached per player and map.
 */
function spotOf(userId, map, t) {
  const p = load(userId);
  p.spots = p.spots || {};
  if (!p.spots[map.id]) {
    p.spots[map.id] = {};
    const rows = db.open()
      .prepare('SELECT key FROM web_progress WHERE discord_user_id = ? AND prestige = ? AND key LIKE ?')
      .all(userId, prestigeOf(userId), `${map.id}:trainerat:%`);
    for (const r of rows) {
      const [id, at] = r.key.slice(`${map.id}:trainerat:`.length).split(':');
      const [x, y] = at.split(',').map(Number);
      p.spots[map.id][id] = { x, y };
    }
  }
  const moved = p.spots[map.id][t.id];
  return moved && isDone(userId, trainerKey(map.id, t.id)) ? moved : { x: t.x, y: t.y };
}

/** Remember where a trainer walked to (replacing any earlier spot). */
function rememberSpot(userId, map, t, x, y) {
  const handle = db.open();
  handle.prepare('DELETE FROM web_progress WHERE discord_user_id = ? AND prestige = ? AND key LIKE ?').run(userId, prestigeOf(userId), `${spotPrefix(map.id, t.id)}%`);
  if (x !== t.x || y !== t.y) markDone(userId, `${spotPrefix(map.id, t.id)}${x},${y}`);
  const p = load(userId);
  if (p.spots && p.spots[map.id]) {
    if (x !== t.x || y !== t.y) p.spots[map.id][t.id] = { x, y };
    else delete p.spots[map.id][t.id];
  }
}

/** A trainer who walks off once beaten (AIDE at Town 1's gate) and has. */
function gone(userId, map, t) {
  return Boolean(t.leaves) && isDone(userId, trainerKey(map.id, t.id));
}

function load(userId) {
  let p = players.get(userId);
  if (p) return p;

  store.ensureUser(userId);
  const row = db.open().prepare('SELECT * FROM web_position WHERE discord_user_id = ?').get(userId);
  const start = maps.get(maps.START);

  // A stored spot on a map that has since gone (or changed) starts over at its spawn.
  const map = row && maps.get(row.map);
  const standable = map && map.solid[row.y]?.[row.x] === false;
  p = standable
    ? { map: row.map, x: row.x, y: row.y, facing: row.facing, lastTown: row.last_town || maps.START }
    : { map: start.id, ...start.spawn, lastTown: start.id };
  p.outfit = (row && row.outfit) || 'adventurer';

  // Not stored: what's happening right now.
  p.patch = null; // { id, count, at }
  p.engaged = null; // a battle the overworld started, until it ends
  p.tokens = STEP_BURST;
  p.tokensAt = Date.now();

  players.set(userId, p);
  if (!row || !standable) save(userId, p);
  markDone(userId, `visited:${p.map}`);
  return p;
}

function save(userId, p) {
  db.open()
    .prepare(
      `INSERT INTO web_position (discord_user_id, map, x, y, facing, last_town, outfit, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (discord_user_id) DO UPDATE SET
         map = excluded.map, x = excluded.x, y = excluded.y, facing = excluded.facing,
         last_town = excluded.last_town, outfit = excluded.outfit, updated_at = excluded.updated_at`
    )
    .run(userId, p.map, p.x, p.y, p.facing, p.lastTown, p.outfit || 'adventurer', Date.now());
}

// ---------------------------------------------------------------------------
// What the browser sees
// ---------------------------------------------------------------------------

const position = (p) => ({ map: p.map, x: p.x, y: p.y, facing: p.facing });

/** How you look (Web/intro.js checks the name). Explorers look the same. */
function setOutfit(userId, outfit) {
  const p = load(userId);
  p.outfit = outfit;
  save(userId, p);
}

/** The map you're on, and where you stand on it. */
function view(userId) {
  const real = load(userId);
  const dev = devOf(userId);
  const p = (dev && dev.ghost) || real;
  const map = maps.get(p.map);
  const cleared = milestonesOf(userId);
  const out = {
    map: maps.publicView(map, (id) => isDone(userId, trainerKey(map.id, id)), {
      opened: (o) => cleared >= o.after,
      found: (id) => isDone(userId, itemKey(map.id, id)),
      spot: (t) => spotOf(userId, map, t),
    }),
    player: { ...position(p), outfit: real.outfit },
    busy: !(dev && dev.ghost) && Boolean(real.engaged),
  };
  if (dev) {
    out.dev = { exploring: Boolean(dev.ghost), noclip: dev.noclip, overlay: dev.overlay };
    // What the overlay draws: which grass is a one-battle patch, and where each trainer looks.
    if (dev.overlay) out.dev.reveal = maps.secrets(map);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function inBattle(userId) {
  return require('../Commands/battle').active.has(userId);
}

/** Take a step token, refilled over time. False when steps come too fast. */
function takeToken(p, now) {
  p.tokens = Math.min(STEP_BURST, p.tokens + (now - p.tokensAt) / STEP_REFILL_MS);
  p.tokensAt = now;
  if (p.tokens < 1) return false;
  p.tokens -= 1;
  return true;
}

const trainerAt = (map, x, y) => map.trainers.find((t) => t.x === x && t.y === y) || null;

/**
 * One step, or a bump against something.
 *
 * @param {string} userId
 * @param {{dir: string}} body
 * @returns {{ok: boolean, reason?: string, player: object, events: object[]}}
 */
function step(userId, body) {
  const dev = devOf(userId);
  if (dev && dev.ghost) return ghostStep(dev, body);
  const p = load(userId);
  const dir = String(body.dir || '');
  const delta = maps.DIRS[dir];
  const refuse = (reason) => ({ ok: false, reason, player: position(p), events: [] });

  if (!delta) return refuse('bad');
  // Nobody walks before the professor has given them a Pokemon.
  if (!require('./intro').done(userId)) return refuse('intro');
  if (p.engaged || inBattle(userId)) return refuse('battle');
  if (!takeToken(p, Date.now())) return refuse('fast');

  const map = maps.get(p.map);
  p.facing = dir;
  const nx = p.x + delta[0];
  let ny = p.y + delta[1];
  // A ledge: only ever hopped down, landing on the tile beyond it.
  if (map.terrain[ny] && map.terrain[ny][nx] === 'ledge') {
    if (dir !== 'down') return { ok: false, reason: 'blocked', player: position(p), events: [] };
    ny += 1;
  }

  // Walking up into a door opens its station; you stay outside.
  const door = map.doors.find((d) => d.x === nx && d.y === ny);
  if (door && dir === 'up') {
    // The Drop Station is a counter, not a room.
    if (door.station === 'drop') return { ok: false, reason: 'door', player: position(p), events: [{ type: 'door', station: 'drop' }] };
    // Visiting a POKéMON CENTER makes it where you wake after a white-out.
    if (door.station === 'center' && p.lastTown !== map.id && map.kind === 'town') p.lastTown = map.id;
    const room = maps.get(`in:${map.id}:${door.x},${door.y}`);
    if (room) {
      Object.assign(p, { map: room.id, ...room.spawn, patch: null });
      save(userId, p);
      return { ok: true, player: position(p), events: [{ type: 'map' }] };
    }
    return { ok: false, reason: 'door', player: position(p), events: [{ type: 'door', station: door.station || null }] };
  }

  if (!walkable(userId, map, nx, ny)) {
    return { ok: false, reason: 'blocked', player: position(p), events: [] };
  }

  // The way on to the next route: Route N cleared and milestone N beaten.
  const ahead = map.warps.find((w) => w.x === nx && w.y === ny);
  if (ahead && ahead.to.requires && ahead.to.requires.all) {
    // A gate: every route before it cleared and every milestone beaten, in
    // order. No skipping ahead to a later gate.
    const { route: n, gate } = ahead.to.requires;
    let open = milestonesOf(userId) >= n;
    for (let r = 1; open && r <= n; r++) open = routeCleared(userId, r);
    if (!open) {
      return {
        ok: false,
        reason: 'locked',
        player: position(p),
        events: [{ type: 'note', text: `GATE ${gate} is closed. Finish GATE ${gate - 1} first: clear every route up to ROUTE ${n} and beat milestone ${n} at the BATTLE TOWER.` }],
      };
    }
  } else if (ahead && ahead.to.requires) {
    const n = ahead.to.requires.route;
    if (!routeCleared(userId, n) || milestonesOf(userId) < n) {
      return {
        ok: false,
        reason: 'locked',
        player: position(p),
        events: [{ type: 'note', text: `The way ahead is closed. Clear every trainer and patch of grass on ROUTE ${n}, then beat milestone ${n} at the BATTLE TOWER.` }],
      };
    }
  }

  const from = { x: p.x, y: p.y };
  p.x = nx;
  p.y = ny;
  const events = [];

  // An exit: on to the next map. Nothing else happens on an exit tile.
  const warp = map.warps.find((w) => w.x === nx && w.y === ny);
  if (warp) {
    const to = maps.get(warp.to.map);
    Object.assign(p, { map: to.id, x: warp.to.x, y: warp.to.y, facing: warp.to.facing || dir, patch: null });
    if (to.kind === 'town') p.lastTown = to.id;
    markDone(userId, `visited:${to.id}`);
    save(userId, p);
    events.push({ type: 'map' });
    // The first time in the Main City: the taxi driver, and FLY.
    // (Marked done when the browser says it has played it: sceneSeen.)
    if (to.id === 'main-city' && !isDone(userId, FLY_KEY)) {
      events.push({ type: 'scene', id: 'fly', lines: require('./maps/world').FLY_SCENE });
    }
    return { ok: true, player: position(p), events };
  }

  // Walking into a rest stop counts as visiting it (for flying, later).
  for (const place of map.places || []) {
    if (p.y >= place.y0 && p.y <= place.y1) markDone(userId, `visited:${map.id}:${place.id}`);
  }

  const encounter = grassCheck(userId, p, map, from) || sightCheck(userId, p, map);
  if (encounter) events.push(encounter);
  save(userId, p);

  return { ok: true, player: position(p), events };
}

/** Grass: a one-battle patch, or optional grass. */
function grassCheck(userId, p, map, from) {
  const patchId = map.patchAt[p.y][p.x];

  if (patchId && !isDone(userId, patchKey(map.id, patchId))) {
    const patch = map.patches.find((x) => x.id === patchId);

    // Coming in from outside the patch starts the count, and rolls which step
    // starts the battle (2nd to the patch's depth).
    if (!p.patch || p.patch.id !== patchId || map.patchAt[from.y][from.x] !== patchId) {
      p.patch = { id: patchId, count: 0, at: 2 + Math.floor(Math.random() * (patch.depth - 1)) };
    }
    p.patch.count += 1;
    if (p.patch.count < p.patch.at) return null;

    p.patch = null;
    return startWild(userId, p, map, patchKey(map.id, patchId), patch.level);
  }

  if (!patchId) p.patch = null;

  // Optional grass. (A finished patch is quiet: its battle has been had.)
  if (!patchId && map.terrain[p.y][p.x] === 'tall' && map.encounterRate > 0 && map.levels) {
    if (Math.random() < map.encounterRate) return startWild(userId, p, map, null);
  }
  return null;
}

/** An unbeaten trainer who can see you. */
function sightCheck(userId, p, map) {
  for (const t of map.trainers) {
    const [dx, dy] = maps.DIRS[t.facing];
    let x = t.x;
    let y = t.y;
    for (let i = 1; i <= t.sight; i++) {
      x += dx;
      y += dy;
      if (!map.solid[y] || map.solid[y][x] !== false || trainerAt(map, x, y)) break;
      if (x !== p.x || y !== p.y) continue;

      const key = trainerKey(map.id, t.id);
      if (isDone(userId, key)) break;

      // They walk up to the tile next to you (the browser shows it).
      p.facing = { up: 'down', down: 'up', left: 'right', right: 'left' }[t.facing];
      return engage(userId, p, map, t, i - 1);
    }
  }
  return null;
}

/** A trainer's battle starts (they spotted you, or you spoke to them). */
function engage(userId, p, map, t, walk) {
  const [dx, dy] = maps.DIRS[t.facing];
  rememberSpot(userId, map, t, t.x + dx * walk, t.y + dy * walk);
  const team = t.rival ? [{ species: rivalOf(userId), level: t.level, evolve: true }, ...t.team] : t.team;
  begin(userId, p, { kind: 'trainer', name: t.name, team }, trainerKey(map.id, t.id), t.reward, t.won || null);
  return { type: 'trainer', id: t.id, name: t.name, walk, lines: t.before };
}

/**
 * Talking to a trainer you're facing: one you've beaten says their line;
 * one you haven't battles you, as if they'd spotted you.
 */
function challenge(userId) {
  const p = load(userId);
  const dev = devOf(userId);
  if (dev && dev.ghost) return { ok: false };
  if (p.engaged || inBattle(userId)) return { ok: false };
  const map = maps.get(p.map);
  const [dx, dy] = maps.DIRS[p.facing];
  const t = map.trainers.find((x) => same(spotOf(userId, map, x), p.x + dx, p.y + dy));
  if (!t || gone(userId, map, t)) return { ok: false };
  if (isDone(userId, trainerKey(map.id, t.id))) return { ok: true, lines: t.after && t.after.length ? t.after : [`${t.name}: That was a good battle.`] };
  return { ok: true, event: engage(userId, p, map, t, 0) };
}

/**
 * Early on (Gates 1-3 and the paths to the MAIN CITY), when a wild POKéMON
 * is far weaker than your team, you can run from it without it counting as
 * a loss (or a win), the same as a battle ended by Dragon Tail. It still
 * fights normally, and beating it pays as usual. Running from a one-battle
 * patch this way counts the patch as done, so you can move on.
 */
const OUTMATCHED_BY = 10;
const LAST_SOFT_ROUTE = 30;

function earlyMap(map) {
  const route = /^route-(\d+)$/.exec(map.id);
  return route ? Number(route[1]) <= LAST_SOFT_ROUTE : ['path-a', 'path-b', 'testroute'].includes(map.id);
}

/** Your strongest POKéMON that will fight (one that obeys, in your first six). */
function strongest(userId) {
  const { team } = store.battleTeam(userId);
  return team.length ? Math.max(...team.map((mon) => mon.level || 0)) : 0;
}

function startWild(userId, p, map, key, fixedLevel = null) {
  const { lo, hi } = map.levels;
  // A patch's battle is at the level the plan gave it; optional grass varies.
  const level = fixedLevel || lo + Math.floor(Math.random() * (hi - lo + 1));
  const softRun = earlyMap(map) && strongest(userId) >= level + OUTMATCHED_BY;
  let species;
  if (map.pool && map.pool.length) {
    // The biome's own Pokemon, common ones more often (routegen.js).
    const total = map.pool.reduce((sum, s) => sum + s.weight, 0);
    let roll = Math.random() * total;
    species = map.pool[map.pool.length - 1].species;
    for (const s of map.pool) {
      roll -= s.weight;
      if (roll < 0) {
        species = s.species;
        break;
      }
    }
  } else {
    try {
      species = require('../Commands/drop').rollDrop({ forceRarity: 'normal' }).species.id;
    } catch {
      species = 1 + Math.floor(Math.random() * 800);
    }
  }
  begin(userId, p, { kind: 'wild', team: [{ species, level }], softRun }, key);
  return { type: 'wild' };
}

/**
 * Start a battle and deal with how it ends. Steps are refused until then.
 *
 * @param {string|null} key  what winning marks done (null for optional grass)
 */
/**
 * @param {string[]|null} won  what the trainer says once you've beaten them
 */
function begin(userId, p, foe, key, reward = null, won = null) {
  p.engaged = { key };
  Promise.resolve()
    .then(() => fight(userId, foe))
    .then((result) => {
      p.engaged = null;
      if (result.error) {
        notify(userId, 'world', { message: result.error, player: position(p) });
        return;
      }
      // Ran from a far weaker wild POKéMON early on: the patch is done with.
      if (result.fled && foe.softRun && key) markDone(userId, key);
      if (result.won && key) {
        const first = !isDone(userId, key);
        markDone(userId, key);
        const got = first ? pay(userId, reward) : null;
        const lines = [...(first && won ? won : []), ...(got ? [`You got ${got} for winning!`] : [])];
        if (lines.length) {
          notify(userId, 'world', { player: position(p), refresh: true, lines });
          return;
        }
      }
      if (result.lost) {
        blackOut(userId, p);
        return;
      }
      notify(userId, 'world', { player: position(p), refresh: Boolean(result.won && key && key.includes(':trainer:')) });
    })
    .catch((err) => {
      p.engaged = null;
      console.error('web: overworld battle failed:', err);
      notify(userId, 'world', { player: position(p) });
    });
}

/**
 * A at a Poke Ball in front of you: pick it up, once per prestige.
 * Rewards come in a later build; for now it's only marked found.
 */
function pickup(userId) {
  const p = load(userId);
  const dev = devOf(userId);
  if (dev && dev.ghost) return { ok: false, text: 'Exploring: items stay where they are.' };
  const map = maps.get(p.map);
  const [dx, dy] = maps.DIRS[p.facing];
  const item = (map.items || []).find((i) => i.x === p.x + dx && i.y === p.y + dy);
  if (!item) return { ok: false, text: '' };
  const key = itemKey(map.id, item.id);
  if (isDone(userId, key)) return { ok: false, text: '' };
  markDone(userId, key);
  const got = pay(userId, item.reward);
  return { ok: true, text: got ? `You found ${got}!` : 'You found a POKé BALL, but it was empty.' };
}

/**
 * Hand over a reward: { coins } or { item, qty }. Says what it was, or null.
 */
function pay(userId, reward) {
  if (!reward) return null;
  if (reward.coins) {
    store.addCoins(userId, reward.coins);
    return `${reward.coins.toLocaleString()} coins`;
  }
  if (reward.item) {
    const qty = reward.qty || 1;
    store.addItem(userId, reward.item, qty);
    const info = require('../Utils/content').item(reward.item);
    const name = reward.item === 'lootbox' ? 'a LOOTBOX' : (info && (info.displayName || info.name)) || reward.item;
    return `${qty > 1 ? `${qty} x ` : ''}${String(name).toUpperCase()}`;
  }
  return null;
}

/**
 * The rival's starter: the one he picked against yours in the lab (stored
 * per prestige by Web/intro.js), or, for anyone without one, a fire starter.
 */
function rivalOf(userId) {
  const row = db.open()
    .prepare("SELECT key FROM web_progress WHERE discord_user_id = ? AND prestige = ? AND key LIKE 'rival:%'")
    .get(userId, prestigeOf(userId));
  return row ? Number(row.key.split(':')[1]) : 4;
}

const FLY_KEY = 'fly:unlocked';

/**
 * Everywhere this player can fly to: every town, stop and the Main City
 * they've been to, and every rest stop they've walked through. Nothing until
 * the Main City's taxi has been met.
 */
function flyPlaces(userId) {
  if (!isDone(userId, FLY_KEY)) return { unlocked: false, places: [] };
  const rows = db.open()
    .prepare("SELECT key FROM web_progress WHERE discord_user_id = ? AND prestige = ? AND key LIKE 'visited:%' ORDER BY done_at")
    .all(userId, prestigeOf(userId));
  const places = [];
  for (const { key } of rows) {
    const [, mapId, placeId] = key.split(':');
    const map = maps.get(mapId);
    if (!map) continue;
    if (placeId) {
      const place = (map.places || []).find((pl) => pl.id === placeId);
      if (place) places.push({ key, name: `${place.name} (${map.name})`, map: map.id, x: 8, y: place.y0 + 1, facing: 'down' });
    } else if (map.kind === 'town' || /^stop-/.test(map.id)) {
      places.push({ key, name: map.name, map: map.id, ...map.spawn });
    }
  }
  return { unlocked: true, places: places.map(({ key, name }) => ({ key, name })), all: places };
}

/** Fly somewhere you've been. */
function fly(userId, key) {
  const p = load(userId);
  const dev = devOf(userId);
  if (dev && dev.ghost) return { ok: false, text: 'Exploring: use dev.warp instead.' };
  if (p.engaged || inBattle(userId)) return { ok: false, text: "You can't fly in the middle of a battle!" };
  const { unlocked, all } = flyPlaces(userId);
  if (!unlocked) return { ok: false, text: "You don't have a way to FLY yet." };
  const place = all.find((pl) => pl.key === String(key));
  if (!place) return { ok: false, text: "You haven't been there yet." };
  const map = maps.get(place.map);
  Object.assign(p, { map: map.id, x: place.x, y: place.y, facing: place.facing || 'down', patch: null });
  if (map.kind === 'town') p.lastTown = map.id;
  save(userId, p);
  return { ok: true };
}

/**
 * The BATTLE TOWER: up to the battle room when a milestone is ready, and back
 * down to the lobby after.
 */
function tower(userId, action) {
  const p = load(userId);
  const dev = devOf(userId);
  if (dev && dev.ghost) return { ok: false, text: 'Exploring: no battles.' };
  const arena = maps.get('tower-arena');
  if (action === 'enter') {
    if (p.map !== arena.lobby) return { ok: false, text: 'Talk to the receptionist in the BATTLE TOWER.' };
    if (p.engaged || inBattle(userId)) return { ok: false, text: 'Finish your battle first.' };
    const info = require('./menus').tower(userId);
    if (!info.ready) return { ok: false, text: 'Your milestone is not ready yet.' };
    Object.assign(p, { map: arena.id, ...arena.spawn, patch: null });
    save(userId, p);
    return { ok: true, leader: arena.leaderSpot };
  }
  if (action === 'leave') {
    if (p.map !== arena.id) return { ok: true };
    if (inBattle(userId)) return { ok: false, text: 'Finish your battle first.' };
    const lobby = maps.get(arena.lobby);
    Object.assign(p, { map: lobby.id, ...lobby.spawn, facing: 'down', patch: null });
    save(userId, p);
    return { ok: true };
  }
  return { ok: false, text: 'Unknown.' };
}

/** Put a player somewhere (the professor walks you outside the lab after the intro). */
function moveTo(userId, mapId) {
  const p = load(userId);
  const map = maps.get(mapId);
  Object.assign(p, { map: map.id, ...map.spawn, patch: null, lastTown: map.kind === 'town' ? map.id : p.lastTown });
  save(userId, p);
  markDone(userId, `visited:${map.id}`);
}

/** Lost a battle: wake up in the last town visited. */
function blackOut(userId, p) {
  const town = maps.get(p.lastTown) || maps.get(maps.START);
  // Home in Town 1 (no POKéMON CENTER yet): you wake up in PROF. A's lab.
  const labDoor = town.id === 'town-1' && town.doors.find((d) => d.station === 'lab');
  const lab = labDoor && maps.get(`in:town-1:${labDoor.x},${labDoor.y}`);
  const wake = lab || town;
  Object.assign(p, { map: wake.id, ...wake.spawn, patch: null });
  save(userId, p);
  notify(userId, 'world', {
    player: position(p),
    refresh: true,
    // As the games say it ({PLAYER} is filled in by the page).
    whiteout: ['{PLAYER} is out of usable POKéMON!', '{PLAYER} whited out!'],
    lines: lab
      ? ['PROF. A: Oh my! Are you alright?', 'PROF. A: Your POKéMON are all rested now. Go on, give it another try!']
      : ['Your POKéMON are fighting fit again. Be careful out there!'],
  });
}

/**
 * A step while exploring: never saved, nothing happens, and with noclip
 * nothing blocks you but the map's edge.
 */
function ghostStep(dev, body) {
  const g = dev.ghost;
  const delta = maps.DIRS[String(body.dir || '')];
  const refuse = (reason, events = []) => ({ ok: false, reason, player: position(g), events });
  if (!delta) return refuse('bad');
  const now = Date.now();
  g.tokens = Math.min(GHOST_BURST, g.tokens + (now - g.tokensAt) / GHOST_REFILL_MS);
  g.tokensAt = now;
  if (g.tokens < 1) return refuse('fast');
  g.tokens -= 1;

  const map = maps.get(g.map);
  g.facing = body.dir;
  const nx = g.x + delta[0];
  let ny = g.y + delta[1];
  if (!dev.noclip && map.terrain[ny] && map.terrain[ny][nx] === 'ledge') {
    if (body.dir !== 'down') return refuse('blocked');
    ny += 1;
  }
  const door = map.doors.find((d) => d.x === nx && d.y === ny);
  if (door && body.dir === 'up' && !dev.noclip) {
    const room = door.station !== 'drop' && maps.get(`in:${map.id}:${door.x},${door.y}`);
    if (!room) return refuse('door', [{ type: 'note', text: 'That counter is shut while exploring.' }]);
    Object.assign(g, { map: room.id, ...room.spawn });
    return { ok: true, player: position(g), events: [{ type: 'map' }] };
  }
  if (!map.solid[ny] || map.solid[ny][nx] === undefined) return refuse('blocked');
  if (!dev.noclip && !walkable(dev.ownerId, map, nx, ny)) return refuse('blocked');

  g.x = nx;
  g.y = ny;
  const warp = map.warps.find((w) => w.x === nx && w.y === ny);
  if (warp) {
    Object.assign(g, { map: warp.to.map, x: warp.to.x, y: warp.to.y, facing: warp.to.facing || body.dir });
    return { ok: true, player: position(g), events: [{ type: 'map' }] };
  }
  return { ok: true, player: position(g), events: [] };
}

/**
 * The owner's dev console (Web/server.js checks it's the owner).
 *
 * @param {string} userId
 * @param {string} cmd   explore | noclip | overlay | warp | where | maps | off
 * @param {Array} args
 * @returns {{ok:boolean, text:string, reload?:boolean}}
 */
function dev(userId, cmd, args = []) {
  const real = load(userId);
  let d = devOf(userId);
  if (!d) {
    d = { ghost: null, noclip: false, overlay: false, ownerId: userId };
    devs.set(userId, d);
  }
  const on = (v) => (v === undefined || v === null ? null : Boolean(v) && v !== 'off' && v !== 'false');
  const startGhost = () => {
    if (!d.ghost) {
      if (real.engaged || inBattle(userId)) return false;
      d.ghost = { map: real.map, x: real.x, y: real.y, facing: real.facing, tokens: GHOST_BURST, tokensAt: Date.now() };
    }
    return true;
  };
  const state = () => `exploring ${d.ghost ? 'on' : 'off'}, noclip ${d.noclip ? 'on' : 'off'}, overlay ${d.overlay ? 'on' : 'off'}`;

  switch (cmd) {
    case 'explore': {
      const want = on(args[0]) ?? !d.ghost;
      if (want && !startGhost()) return { ok: false, text: 'Finish your battle first.' };
      if (!want) {
        d.ghost = null;
        d.noclip = false;
      }
      return {
        ok: true,
        reload: true,
        text: want ? `Exploring: nothing you do now is saved or counts. (${state()})` : `Back where you really are. (${state()})`,
      };
    }
    case 'noclip': {
      const want = on(args[0]) ?? !d.noclip;
      if (want && !startGhost()) return { ok: false, text: 'Finish your battle first.' };
      d.noclip = want;
      return { ok: true, reload: true, text: `Noclip ${want ? 'on (exploring is on too)' : 'off'}. (${state()})` };
    }
    case 'overlay': {
      d.overlay = on(args[0]) ?? !d.overlay;
      return {
        ok: true,
        reload: true,
        text: `Overlay ${d.overlay ? "on: red = one-battle patch, yellow = a trainer's sight" : 'off'}.`,
      };
    }
    case 'warp': {
      const map = maps.get(String(args[0] || ''));
      if (!map) return { ok: false, text: `No map "${args[0]}". Maps: ${Object.keys(maps.MAPS).join(', ')}` };
      if (!startGhost()) return { ok: false, text: 'Finish your battle first.' };
      const given = (v) => v !== undefined && v !== null && Number.isInteger(Number(v));
      const x = given(args[1]) ? Number(args[1]) : map.spawn.x;
      const y = given(args[2]) ? Number(args[2]) : map.spawn.y;
      if (!map.solid[y] || map.solid[y][x] === undefined) return { ok: false, text: `${map.id} is ${map.width}x${map.height}; ${x},${y} is off the map.` };
      Object.assign(d.ghost, { map: map.id, x, y, facing: 'down' });
      return { ok: true, reload: true, text: `Warped to ${map.name} (${map.id}) ${x},${y}. Exploring.` };
    }
    case 'where': {
      const p = d.ghost || real;
      return {
        ok: true,
        text: `${d.ghost ? 'Exploring' : 'Really'} at ${p.map} ${p.x},${p.y} facing ${p.facing}. Real position: ${real.map} ${real.x},${real.y}. (${state()})`,
      };
    }
    case 'maps':
      return { ok: true, text: Object.values(maps.MAPS).map((m) => `${m.id}: ${m.name}, ${m.kind}, ${m.width}x${m.height}`).join('\n') };
    case 'off':
      devs.delete(userId);
      return { ok: true, reload: true, text: 'Dev mode off. Back where you really are.' };
    case 'restart': {
      // Back to the very start of the web game: the opening, then Town 1,
      // with every patch, trainer, item and visit of this prestige undone.
      // The Discord profile (party, coins, milestones) isn't touched, and the
      // starter isn't given twice (starter:given survives the wipe).
      if (real.engaged || inBattle(userId)) return { ok: false, text: 'Finish your battle first.' };
      const handle = db.open();
      const prestige = (store.getUser(userId) || {}).prestige || 0;
      const had = handle
        .prepare("SELECT 1 FROM web_progress WHERE discord_user_id = ? AND prestige = ? AND key IN ('intro:done', 'starter:given')")
        .get(userId, prestige);
      if (had) markDone(userId, 'starter:given');
      handle
        .prepare("DELETE FROM web_progress WHERE discord_user_id = ? AND prestige = ? AND key <> 'starter:given'")
        .run(userId, prestige);
      handle.prepare('DELETE FROM web_position WHERE discord_user_id = ?').run(userId);
      devs.delete(userId);
      players.delete(userId);
      return { ok: true, restart: true, text: 'Restarted. The opening plays again.' };
    }
    default:
      return { ok: false, text: `Unknown command "${cmd}". Try dev.help().` };
  }
}

/** The browser has played a scene through (the taxi driver: FLY is yours). */
function sceneSeen(userId, id) {
  const p = load(userId);
  if (id === 'fly' && p.map === 'main-city') {
    markDone(userId, FLY_KEY);
    return { ok: true };
  }
  return { ok: false };
}

/** Forget a player's live state (tests, or after their position changes elsewhere). */
const forget = (userId) => players.delete(userId);

module.exports = { configure, view, step, dev, setOutfit, pickup, routeCleared, flyPlaces, fly, moveTo, tower, forget, isDone, markDone, challenge, sceneSeen, gone };
