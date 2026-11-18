'use strict';

/**
 * Builds a map for the website's overworld: its tiles, what can be walked on,
 * and everything that happens there (signs, doors, exits, grass, trainers).
 *
 * Maps live on the server. Web/overworld.js uses the whole thing to check
 * every step; the browser is sent a view without the parts that decide
 * outcomes (which grass is a one-battle patch, what a trainer's team is).
 *
 * Tile names are "<sheet><id>" in the Tuxemon tilesets (see tiles.js).
 *
 * Coordinates are tiles, x right and y down.
 */

const { TILES, OBSTACLES, ROCKS, HEDGE } = require('./tiles');
const { opacity } = require('./opacity');

/** A building tile is a wall when at least this much of it is drawn. */
const WALL_OPACITY = 0.45;

/** The grass ledge you hop down (o444-446: left end, middle, right end). */
const LEDGE = { l: 'o444', c: 'o445', r: 'o446' };

const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

class MapBuilder {
  /**
   * @param {object} info
   * @param {string} info.id
   * @param {string} info.name     shown when you arrive
   * @param {'town'|'route'} info.kind  a town is where you wake after a black-out
   * @param {number} info.width
   * @param {number} info.height
   * @param {{lo:number, hi:number}} [info.levels]  wild Pokemon levels
   * @param {number} [info.encounterRate]  chance per step in optional grass
   */
  constructor({ id, name, kind, width, height, levels = null, encounterRate = 1 / 8, background = 'grass', ground = null }) {
    Object.assign(this, { id, name, kind, width, height, levels, encounterRate, background });
    const grid = (fill) => Array.from({ length: height }, () => Array(width).fill(fill));
    /** The land: tiles.js GROUNDS (grass unless said otherwise). */
    this.ground = ground || { tile: TILES.grass, flowers: TILES.flowers, border: 'trees' };
    this.layers = { ground: grid(this.ground.tile), objects: grid(null), overlays: grid(null), above: grid(null) };
    this.solid = grid(false);
    /** null, 'tall', 'shallow' or 'deep'. */
    this.terrain = grid(this.ground.terrain || null);
    /** Which one-battle patch a tile is in, if any. */
    this.patchAt = grid(null);
    /** Where the sand path runs; its edges are worked out in build(). */
    this.pathMask = grid(false);
    this.signs = [];
    this.doors = [];
    this.warps = [];
    this.patches = [];
    this.trainers = [];
    /** People to talk to. */
    this.npcs = [];
    /** Field-move obstacles: { x, y, hm, after, tile, top, says }. */
    this.obstacles = [];
    /** Poke Balls lying around: { x, y, id }. */
    this.items = [];
    /** Named stretches (rest stops), visited by walking into them: { id, name, y0, y1 }. */
    this.places = [];
    /** Wild Pokemon here: [{ species, weight }] (optional grass and patches). */
    this.pool = null;
    this.spawn = null;
  }

  inside(x, y) {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  set(layer, x, y, tile) {
    if (this.inside(x, y)) this.layers[layer][y][x] = tile;
    return this;
  }

  block(x, y, solid = true) {
    if (this.inside(x, y)) this.solid[y][x] = solid;
    return this;
  }

  /** A rectangle drawn with a 9-piece set (corners, edges, middle). */
  rect(layer, set9, x0, y0, w, h, middle = set9.c) {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const top = y === y0;
        const bottom = y === y0 + h - 1;
        const left = x === x0;
        const right = x === x0 + w - 1;
        const piece =
          top ? (left ? 'tl' : right ? 'tr' : 't')
          : bottom ? (left ? 'bl' : right ? 'br' : 'b')
          : left ? 'l' : right ? 'r' : null;
        this.set(layer, x, y, piece ? set9[piece] : middle);
      }
    }
    return this;
  }

  /** A pine, two tiles wide and two tall, with (x, y) its top left. */
  tree(x, y) {
    [[0, 0, TILES.treeTop[0]], [1, 0, TILES.treeTop[1]], [0, 1, TILES.treeBottom[0]], [1, 1, TILES.treeBottom[1]]].forEach(
      ([dx, dy, tile]) => this.set('objects', x + dx, y + dy, tile).block(x + dx, y + dy)
    );
    return this;
  }

  /**
   * Pines in 2x2 cells all round the edge, except the cells listed in `gaps`
   * (as [cellX, cellY]).
   */
  border(gaps = []) {
    const cw = Math.floor(this.width / 2);
    const ch = Math.floor(this.height / 2);
    const open = new Set(gaps.map(([cx, cy]) => `${cx},${cy}`));
    const style = this.ground.border || 'trees';
    for (let cy = 0; cy < ch; cy++) {
      for (let cx = 0; cx < cw; cx++) {
        const edge = cx === 0 || cy === 0 || cx === cw - 1 || cy === ch - 1;
        if (!edge || open.has(`${cx},${cy}`)) continue;
        if (style === 'trees') {
          this.tree(cx * 2, cy * 2);
          continue;
        }
        // Rocks or deep water, a tile at a time.
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const x = cx * 2 + dx;
          const y = cy * 2 + dy;
          if (style === 'water') {
            this.set('ground', x, y, TILES.deep).block(x, y);
            this.terrain[y][x] = 'deep';
          } else {
            this.set('objects', x, y, ROCKS[(x * 7 + y * 13) % ROCKS.length]).block(x, y);
          }
        }
      }
    }
    return this;
  }

  /**
   * Someone standing about to talk to (A). Not a battle.
   *
   * @param {{id, name, sprite, x, y, facing, lines}} n
   */
  npc(n) {
    // Not solid: they wander (the browser keeps you from walking into them).
    this.npcs.push({ facing: 'down', ...n });
    return this;
  }

  /** A building from tiles.js, with its roof drawn over the player. */
  building(plan, x, y, door) {
    // The roof is drawn over you: you can walk behind a building, as in the games.
    plan.above.forEach((row, dy) => row.forEach((tile, dx) => this.set('above', x + dx, y + dy, tile)));
    const top = y + plan.above.length;
    // Walls are only where the picture is; see-through corners can be walked on.
    plan.body.forEach((row, dy) => row.forEach((tile, dx) => {
      this.set('objects', x + dx, top + dy, tile);
      if (opacity(tile) >= WALL_OPACITY) this.block(x + dx, top + dy);
    }));
    for (const o of plan.overlay || []) this.set('overlays', x + o.dx, top + o.dy, o.tile);
    // The door is the building's bottom-row tile you walk up into.
    this.doors.push({ x: x + plan.door.dx, y: top + plan.body.length - 1, ...door });
    return this;
  }

  /**
   * Sand path. Paint as many rectangles as you like; build() works out each
   * tile's edge or corner from its neighbours, so joins and turns line up.
   */
  path(x0, y0, w, h) {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (this.inside(x, y)) this.pathMask[y][x] = true;
    return this;
  }

  /**
   * A ledge across [x0, x0 + w): you can hop down over it, never up or along.
   * Web/overworld.js lands you on the tile below.
   */
  ledge(x0, y, w) {
    for (let x = x0; x < x0 + w; x++) {
      this.set('ground', x, y, x === x0 ? LEDGE.l : x === x0 + w - 1 ? LEDGE.r : LEDGE.c);
      this.terrain[y][x] = 'ledge';
    }
    return this;
  }

  sign(x, y, lines) {
    this.set('objects', x, y, TILES.signPost).set('above', x, y - 1, TILES.signBoard).block(x, y);
    this.signs.push({ x, y, lines });
    return this;
  }

  /**
   * Tall grass. Optional grass gives a wild battle now and then on every
   * step, forever, like .battle.
   */
  grass(x0, y0, w, h) {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        this.set('objects', x, y, TILES.tallGrass);
        this.terrain[y][x] = 'tall';
      }
    }
    return this;
  }

  /**
   * A patch of grass across the way that you can't avoid. It holds exactly
   * one wild battle, which starts on a step after the first and before you
   * can leave the far side.
   *
   * @param {string} id     unique on this map, and kept for good: progress is stored by it
   * @param {number} depth  the fewest steps it takes to cross (the rows, for a
   *                        band you walk down through)
   */
  patch(id, x0, y0, w, h, depth = h, level = null) {
    if (depth < 2) throw new Error(`${this.id}: patch ${id} must take at least 2 steps to cross`);
    this.grass(x0, y0, w, h);
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.patchAt[y][x] = id;
    // `level`: the battle's level, fixed so the route pays what the plan says.
    this.patches.push({ id, depth, level });
    return this;
  }

  /**
   * Something only a field move gets you past (Web/worldplan.js HMS). It is
   * solid until the player has cleared `after` milestones.
   */
  obstacle(x, y, hm, after) {
    const look = OBSTACLES[hm];
    if (!look) throw new Error(`${this.id}: no obstacle for ${hm}`);
    this.obstacles.push({ x, y, hm, after, tile: look.tile, top: look.top || null, says: look.says });
    this.block(x, y);
    return this;
  }

  /**
   * Something small on the ground (a flower), only where nothing else is:
   * never on a tree, a wall, a path or anything already there.
   */
  decorate(x, y, tile) {
    if (!this.inside(x, y) || this.solid[y][x] || this.layers.objects[y][x] || this.pathMask[y][x] || this.terrain[y][x]) return false;
    if (this.layers.above[y][x] || this.patchAt[y][x]) return false;
    this.set('objects', x, y, tile);
    return true;
  }

  /**
   * Trees across a row band, two rows tall, except for a gap: a chokepoint
   * the way forward has to go through. Rocky or watery land gets rocks.
   */
  wall(y, x0, x1, gapX0, gapX1, rows = 2) {
    const inGap = (c) => c >= gapX0 && c <= gapX1;
    const rock = (c, r) => this.set('objects', c, r, ROCKS[(c * 7 + r * 13) % ROCKS.length]).block(c, r);
    const trees = (this.ground.border || 'trees') === 'trees';
    for (let yy = y; yy < y + rows; yy += 2) {
      for (let x = x0; x <= x1; x += 2) {
        const span = [x, x + 1].filter((c) => c <= x1);
        // A whole pine where it fits; a rock where half of one would poke
        // into the gap (or past the edge); rocks throughout on rocky land.
        if (trees && span.length === 2 && !span.some(inGap) && yy + 1 < y + rows) {
          this.tree(x, yy);
          continue;
        }
        for (const c of span) if (!inGap(c)) for (const r of [yy, yy + 1]) if (r < y + rows) rock(c, r);
      }
    }
    return this;
  }

  /**
   * A river across the map: a grassy bank with a sandy lip above and below,
   * water between. Only the ford can be waded; the rest is too deep.
   */
  river(y, x0, x1, fordX0, fordX1, depth = 2) {
    const S = TILES.shore;
    for (let x = x0; x <= x1; x++) {
      this.set('ground', x, y, S.t);
      this.set('ground', x, y + depth + 1, S.b);
      for (let r = 1; r <= depth; r++) {
        const yy = y + r;
        this.set('ground', x, yy, TILES.shallow);
        const ford = x >= fordX0 && x <= fordX1;
        this.terrain[yy][x] = ford ? 'shallow' : 'deep';
        if (!ford) this.block(x, yy);
      }
    }
    return this;
  }

  /** A lawn edged with a low hedge (the city's parks): grass inside, solid round the edge. */
  lawn(x0, y0, w, h, { gaps = [] } = {}) {
    const H = HEDGE;
    const open = new Set(gaps.map(([x, y]) => `${x},${y}`));
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const top = y === y0, bottom = y === y0 + h - 1, left = x === x0, right = x === x0 + w - 1;
        const edge = top || bottom || left || right;
        if (!edge) {
          this.set('ground', x, y, TILES.grass);
          continue;
        }
        if (open.has(`${x},${y}`)) {
          this.set('ground', x, y, TILES.grass);
          continue;
        }
        const piece = top ? (left ? H.tl : right ? H.tr : H.t) : bottom ? (left ? H.bl : right ? H.br : H.b) : left ? H.l : H.r;
        this.set('objects', x, y, piece).block(x, y);
      }
    }
    return this;
  }

  /** A Poke Ball to pick up with A. `id` is kept for good: progress is stored by it. */
  item(x, y, id, reward = null) {
    // reward: { coins } or { item, qty } (Web/overworld.js pays it).
    this.items.push({ x, y, id, reward });
    this.block(x, y);
    return this;
  }

  /** A named stretch of the map (a rest stop), visited by walking into its rows. */
  place(id, name, y0, y1) {
    this.places.push({ id, name, y0, y1 });
    return this;
  }

  /**
   * A trainer who battles you on sight. They look `sight` tiles the way they
   * face; walls and other trainers block the view.
   *
   * @param {object} t
   * @param {string} t.id
   * @param {string} t.name     "Youngster a"
   * @param {string} t.sprite   a file in /sprites/tuxemon/characters, without .png
   * @param {Array<{species:number, level:number}>} t.team
   * @param {string[]} t.before  said when they spot you
   */
  trainer(t) {
    if (!DIRS[t.facing]) throw new Error(`${this.id}: trainer ${t.id} faces nowhere`);
    this.trainers.push({ sight: 4, before: [], ...t });
    return this;
  }

  /**
   * Stepping onto any of these tiles takes you to another map. `to` is where
   * you arrive; give each tile its own to keep a wide exit lined up.
   */
  warp(x, y, to) {
    this.warps.push({ x, y, to });
    return this;
  }

  /** Turn the painted path into tiles, each edge facing the right way. */
  layPaths() {
    const on = (x, y) => (this.inside(x, y) ? this.pathMask[y][x] : true);
    const P = TILES.path;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (!this.pathMask[y][x]) continue;
        const n = on(x, y - 1);
        const s = on(x, y + 1);
        const w = on(x - 1, y);
        const e = on(x + 1, y);
        let piece = !n && !w ? 'tl' : !n && !e ? 'tr' : !s && !w ? 'bl' : !s && !e ? 'br'
          : !n ? 't' : !s ? 'b' : !w ? 'l' : !e ? 'r' : 'c';
        // Inside a turn or a join: sand on all four sides but grass off one
        // corner. The inner-corner tile rounds that corner off.
        if (piece === 'c') {
          if (!on(x + 1, y + 1)) piece = 'ise';
          else if (!on(x - 1, y + 1)) piece = 'isw';
          else if (!on(x + 1, y - 1)) piece = 'ine';
          else if (!on(x - 1, y - 1)) piece = 'inw';
        }
        this.layers.ground[y][x] = P[piece];
      }
    }
  }

  build() {
    if (!this.spawn) throw new Error(`${this.id}: no spawn point`);
    this.layPaths();
    for (const t of this.trainers) if (!t.leaves) this.block(t.x, t.y);
    return {
      id: this.id,
      name: this.name,
      kind: this.kind,
      width: this.width,
      height: this.height,
      levels: this.levels,
      encounterRate: this.encounterRate,
      background: this.background,
      layers: this.layers,
      solid: this.solid,
      terrain: this.terrain,
      patchAt: this.patchAt,
      patches: this.patches,
      signs: this.signs,
      doors: this.doors,
      warps: this.warps,
      trainers: this.trainers,
      npcs: this.npcs,
      obstacles: this.obstacles,
      items: this.items,
      places: this.places,
      pool: this.pool,
      surf: Boolean(this.surf),
      spawn: this.spawn,
    };
  }
}

module.exports = { MapBuilder, DIRS };
