'use strict';

/**
 * Every map in the website's world, by id, checked once at load.
 */

const { DIRS } = require('./builder');

const MAPS = {};
for (const map of [...require('./world').maps, require('./devtown'), require('./testroute')]) {
  if (MAPS[map.id]) throw new Error(`two maps are called ${map.id}`);
  MAPS[map.id] = map;
}

/** Where everyone starts: home. */
const START = 'town-1';

// Every exit has to land somewhere you can stand.
for (const map of Object.values(MAPS)) {
  for (const w of map.warps) {
    // Routes and stops are built later, on first use (routegen.js).
    if (/^(route|stop)-\d+$/.test(w.to.map)) continue;
    const to = MAPS[w.to.map];
    if (!to) throw new Error(`${map.id}: exit at ${w.x},${w.y} goes to a map that doesn't exist (${w.to.map})`);
    if (to.solid[w.to.y]?.[w.to.x] !== false) throw new Error(`${map.id}: exit at ${w.x},${w.y} lands in a wall on ${to.id}`);
  }
  const trainerIds = new Set();
  for (const t of map.trainers) {
    if (trainerIds.has(t.id)) throw new Error(`${map.id}: two trainers are called ${t.id}`);
    trainerIds.add(t.id);
  }
}

/**
 * A map by id. Routes and their stops ("route-N", "stop-N") are built from
 * the world plan the first time they're asked for (routegen.js).
 */
function get(id) {
  if (MAPS[id]) return MAPS[id];
  // Inside a building: "in:<map>:<door x>,<door y>" (interiors.js).
  const upstairs = /^(in:[a-z0-9-]+:\d+,\d+):up$/.exec(String(id));
  if (upstairs) {
    const down = get(upstairs[1]);
    const room = down && require('./interiors').buildUpstairs(id, down);
    if (room) MAPS[id] = room;
    return room || null;
  }
  const inside = /^in:([a-z0-9-]+):(\d+),(\d+)$/.exec(String(id));
  if (inside) {
    const outside = get(inside[1]);
    const door = outside && outside.doors.find((d) => d.x === Number(inside[2]) && d.y === Number(inside[3]));
    if (!door) return null;
    const room = require('./interiors').buildRoom(id, outside, door);
    MAPS[id] = room;
    return room;
  }
  // The BATTLE TOWER's battle room; its way out leads down to the lobby.
  if (id === 'tower-arena') {
    const arena = require('./interiors').arena();
    const city = get('main-city');
    const desk = city.doors.find((d) => d.station === 'battle');
    const lobbyId = `in:main-city:${desk.x},${desk.y}`;
    const lobby = get(lobbyId);
    arena.lobby = lobbyId;
    arena.warps[0].to = { map: lobbyId, x: lobby.spawn.x, y: lobby.spawn.y, facing: 'down' };
    MAPS[id] = arena;
    return arena;
  }
  // A Tuxemon room as it is, for looking at (dev.warp('room:healing_center')).
  if (/^room:[a-z0-9_]+$/.test(String(id))) {
    const room = require('./tmx').load(String(id).slice(5), { id, name: id });
    MAPS[id] = room;
    return room;
  }
  const built = require('./routegen').build(String(id));
  if (built) MAPS[id] = built;
  return built;
}

/** Characters that exist; anyone else is drawn as a stand-in rather than not at all. */
const CHARACTERS = new Set(require('fs').readdirSync(require('path').join(__dirname, '..', 'sprites', 'tuxemon', 'characters')).map((f) => f.replace(/\.png$/, '')));
const looks = (sprite) => (CHARACTERS.has(sprite) ? sprite : 'cooldude');

/**
 * What the browser is sent: the picture and what blocks you, but not what
 * decides outcomes (which grass is a one-battle patch, trainers' teams).
 *
 * @param {object} map
 * @param {(trainerId: string) => boolean} beaten
 */
function publicView(map, beaten, { opened = () => false, found = () => false, spot = (t) => t } = {}) {
  return {
    id: map.id,
    name: map.name,
    kind: map.kind,
    background: map.background,
    width: map.width,
    height: map.height,
    layers: map.layers,
    solid: map.solid,
    terrain: map.terrain,
    signs: map.signs,
    doors: map.doors,
    warps: map.warps.map((w) => ({ x: w.x, y: w.y })),
    // A trainer who leaves once beaten (AIDE at Town 1's gate) is gone.
    trainers: map.trainers.filter((t) => !(t.leaves && beaten(t.id))).map((t) => {
      const at = spot(t);
      return { id: t.id, name: t.name, sprite: looks(t.sprite), x: at.x, y: at.y, facing: t.facing, beaten: beaten(t.id) };
    }),
    obstacles: (map.obstacles || []).map((o) => ({ ...o, open: opened(o) })),
    npcs: (map.npcs || []).map((n) => ({
      id: n.id, name: n.name, sprite: looks(n.sprite), x: n.x, y: n.y, facing: n.facing, lines: n.lines, action: n.action || null,
      // How far they wander from where they stand (0: they stay put).
      wander: n.wander != null ? n.wander : n.action ? 0 : 2,
    })),
    surf: Boolean(map.surf),
    marks: map.marks || [],
    items: (map.items || []).map((i) => ({ x: i.x, y: i.y, found: found(i.id) })),
  };
}

/**
 * The parts publicView leaves out, for the owner's dev overlay: one-battle
 * patch tiles, and every tile a trainer can see you on.
 */
function secrets(map) {
  const patches = [];
  for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) if (map.patchAt[y][x]) patches.push([x, y]);
  const sight = [];
  for (const t of map.trainers) {
    const [dx, dy] = DIRS[t.facing];
    let x = t.x;
    let y = t.y;
    for (let i = 1; i <= t.sight; i++) {
      x += dx;
      y += dy;
      if (!map.solid[y] || map.solid[y][x] !== false || map.trainers.some((o) => o.x === x && o.y === y)) break;
      sight.push([x, y]);
    }
  }
  return { patches, sight, trainers: map.trainers.map((t) => ({ id: t.id, team: t.team })) };
}

module.exports = { MAPS, START, DIRS, get, publicView, secrets };
