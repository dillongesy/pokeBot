'use strict';

/**
 * Reads a Tuxemon room (a Tiled .tmx map, in Web/maps/tuxemon) into the same
 * shape MapBuilder.build() makes, so interiors are Tuxemon's own rooms.
 *
 * What's taken from the file:
 *   tile layers     the lower ones become ground / objects / overlays (and
 *                   overlays2 for a fourth), "Above player" ones become above
 *   Collisions      rectangles, turned into solid tiles
 *   Events          the teleport tile out (the doormat), and where the
 *                   room's people stand (create_npc)
 *
 * Tile names are "<sheet letter><id>" as everywhere else; the browser's
 * world.js knows each sheet's picture by its letter.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOMS_DIR = path.join(__dirname, 'tuxemon');
const TILESETS_DIR = path.join(__dirname, '..', 'sprites', 'tuxemon', 'tilesets');

/** Tileset name -> the letter tile names use. */
const LETTERS = {
  core_outdoor: 'o',
  core_buildings: 'b',
  'core_set pieces': 's',
  core_set_pieces: 's',
  core_indoor_floors: 'f',
  core_indoor_walls: 'w',
  core_indoor_stairs: 't',
};

const attr = (tag, name) => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
};

/** Every tileset the map uses: where its ids start, and its letter. */
function tilesets(xml) {
  const out = [];
  const re = /<tileset\b[^>]*?(?:\/>|>[\s\S]*?<\/tileset>)/g;
  let m;
  while ((m = re.exec(xml))) {
    const tag = m[0];
    let name = attr(tag, 'name');
    const source = attr(tag, 'source');
    if (!name && source) {
      // An external .tsx: its name is the file's.
      name = path.basename(source, '.tsx');
      const tsx = path.join(TILESETS_DIR, `${name.replace(/ /g, '_')}.tsx`);
      if (fs.existsSync(tsx)) name = attr(fs.readFileSync(tsx, 'utf8'), 'name') || name;
    }
    const letter = LETTERS[name];
    if (!letter) throw new Error(`room uses a tileset with no letter: ${name}`);
    out.push({ firstgid: Number(attr(tag, 'firstgid')), letter });
  }
  return out.sort((a, b) => b.firstgid - a.firstgid);
}

/** One layer's tile ids, row by row. */
function decode(data, width, height) {
  const raw = zlib.inflateSync(Buffer.from(data.trim(), 'base64'));
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = [];
    // The top three bits are flips; Tuxemon's rooms don't rely on them.
    for (let x = 0; x < width; x++) row.push(raw.readUInt32LE((y * width + x) * 4) & 0x1fffffff);
    rows.push(row);
  }
  return rows;
}

/**
 * @param {string} file   e.g. "healing_center"
 * @param {object} info   { id, name }
 * @returns {object} a built map, plus `people` (where the room's own people
 *          stand, by Tuxemon's name for them) and `exit` (the doormat)
 */
function load(file, { id, name }) {
  const xml = fs.readFileSync(path.join(ROOMS_DIR, `${file}.tmx`), 'utf8');
  const head = /<map\b[^>]*>/.exec(xml)[0];
  const width = Number(attr(head, 'width'));
  const height = Number(attr(head, 'height'));
  const sets = tilesets(xml);
  const nameOf = (gid) => {
    if (!gid) return null;
    const set = sets.find((s) => gid >= s.firstgid);
    return set ? `${set.letter}${gid - set.firstgid}` : null;
  };

  const grid = (fill) => Array.from({ length: height }, () => Array(width).fill(fill));
  const layers = { ground: grid(null), objects: grid(null), overlays: grid(null), overlays2: grid(null), above: grid(null) };
  const lower = ['ground', 'objects', 'overlays', 'overlays2'];
  let next = 0;
  const layerRe = /<layer\b([^>]*)>\s*<data[^>]*>([\s\S]*?)<\/data>/g;
  let m;
  while ((m = layerRe.exec(xml))) {
    const layerName = attr(m[1], 'name') || '';
    const rows = decode(m[2], width, height);
    const target = /above/i.test(layerName) ? 'above' : lower[Math.min(next++, lower.length - 1)];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const tile = nameOf(rows[y][x]);
        if (tile) layers[target][y][x] = tile;
      }
    }
  }

  // Collisions: rectangles in pixels.
  const solid = grid(false);
  const group = (title) => {
    const g = new RegExp(`<objectgroup\\b[^>]*name="${title}"[^>]*>([\\s\\S]*?)<\\/objectgroup>`, 'i').exec(xml);
    return g ? g[1] : '';
  };
  const objectRe = /<object\b([^>]*?)(?:\/>|>([\s\S]*?)<\/object>)/g;
  const collisions = group('Collisions');
  while ((m = objectRe.exec(collisions))) {
    const x0 = Math.floor(Number(attr(m[1], 'x')) / 16);
    const y0 = Math.floor(Number(attr(m[1], 'y')) / 16);
    const w = Math.max(1, Math.round(Number(attr(m[1], 'width') || 16) / 16));
    const h = Math.max(1, Math.round(Number(attr(m[1], 'height') || 16) / 16));
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (solid[y] && x < width) solid[y][x] = true;
  }

  // Events: the way out, and where people stand.
  let exit = null;
  const people = {};
  const events = group('Events');
  objectRe.lastIndex = 0;
  while ((m = objectRe.exec(events))) {
    const body = m[2] || '';
    const x = Math.floor(Number(attr(m[1], 'x')) / 16);
    const y = Math.floor(Number(attr(m[1], 'y')) / 16);
    const teleport = /value="transition_teleport player,([^,"]+)/.exec(body);
    // The way out leads outdoors (a town or city), not upstairs.
    if (teleport && !exit && /town|city/i.test(teleport[1])) exit = { x, y };
    const npcRe = /value="create_npc ([^,"]+),(\d+),(\d+)/g;
    let n;
    while ((n = npcRe.exec(body))) if (!people[n[1]]) people[n[1]] = { x: Number(n[2]), y: Number(n[3]) };
  }
  if (!exit) throw new Error(`${file}: no way out`);
  // The doormat itself is never solid.
  solid[exit.y][exit.x] = false;

  const empty = grid(null);
  return {
    id,
    name,
    kind: 'interior',
    width,
    height,
    levels: null,
    encounterRate: 0,
    background: 'grass',
    layers,
    solid,
    terrain: grid(null),
    patchAt: empty,
    patches: [],
    signs: [],
    doors: [],
    warps: [],
    trainers: [],
    npcs: [],
    obstacles: [],
    items: [],
    places: [],
    pool: null,
    spawn: { x: exit.x, y: exit.y - 1, facing: 'up' },
    exit,
    people,
  };
}

module.exports = { load };
