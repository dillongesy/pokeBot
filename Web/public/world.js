'use strict';

/**
 * The overworld: a small town on a 240x160 canvas (the GBA's screen), scaled
 * up with crisp pixels.
 *
 * Every picture comes from the Tuxemon assets in Web/sprites/tuxemon (served
 * at /sprites/tuxemon): the town is laid out below from tile numbers in its
 * tilesets, the player is Tuxemon's adventurer, and the grass and splash
 * effects are its animations. Credits: /sprites/CREDITS.txt.
 *
 * The town has three layers, as Tuxemon's own maps do: the ground, things on
 * it (trees, buildings, tall grass), and what is drawn over the player (roofs,
 * the tops of signs).
 *
 * Movement is on the grid: tap a direction to turn, hold it to walk, hold B
 * (X / Shift) to run. Walk into a door to go in; face a sign and press A
 * (Z / Enter / Space) to read it. Tall grass rustles as you go through it;
 * shallow water splashes; deep water can't be entered.
 */

(function () {
  const TILE = 16;
  const VIEW_W = 240;
  const VIEW_H = 160;
  const WALK_MS = 200;
  const RUN_MS = 110;
  // A tap shorter than this only turns the player.
  const TURN_MS = 90;

  const BASE = '/sprites/tuxemon';

  /** The tilesets, by the letter used in tile names below ("o111"). */
  const SHEETS = {
    o: { src: `${BASE}/tilesets/core_outdoor.png`, columns: 37 },
    b: { src: `${BASE}/tilesets/core_buildings.png`, columns: 47 },
    s: { src: `${BASE}/tilesets/core_set_pieces.png`, columns: 31 },
  };

  /**
   * Animated tiles, from the tileset's own .tsx: a tile name shows these
   * frames in turn, each for `ms`.
   */
  const ANIMS = {
    o1268: { frames: [1269, 1270, 1271], ms: 200 },
    o941: { frames: [941, 942, 943, 944, 945, 946, 947, 948], ms: 150 },
    o1482: { frames: [1482, 1483, 1484, 1485, 1486], ms: 250 },
    o1556: { frames: [1556, 1557, 1558, 1559, 1560], ms: 250 },
    o1704: { frames: [1704, 1705, 1706, 1707, 1708], ms: 250 },
  };

  // -------------------------------------------------------------------------
  // Tile names in the Tuxemon tilesets
  // -------------------------------------------------------------------------

  const TILES = {
    grass: 'o111',
    tallGrass: 'o1246',
    // A pine: two tiles of top over two of trunk.
    treeTop: ['o1319', 'o1320'],
    treeBottom: ['o1356', 'o1357'],
    // Sand path on grass, as a rectangle.
    path: { tl: 'o116', t: 'o117', tr: 'o118', l: 'o153', c: 'o154', r: 'o155', bl: 'o190', b: 'o191', br: 'o192' },
    // Water's edge on grass, around shallow water.
    shore: { tl: 'o571', t: 'o572', tr: 'o573', l: 'o608', r: 'o610', bl: 'o645', b: 'o646', br: 'o647' },
    shallow: 'o1268',
    deep: 'o941',
    flowers: ['o1482', 'o1556', 'o1704'],
    // A signpost: its post, and its board drawn over the player.
    signPost: 's199',
    signBoard: 's168',
  };

  /** The blue-roofed shop: a row of roof drawn over the player, then 3 rows. */
  const SHOP = {
    above: [['b245', 'b246', 'b247', 'b248', 'b249']],
    body: [
      ['b292', 'b293', 'b294', 'b295', 'b296'],
      ['b339', 'b340', 'b341', 'b342', 'b343'],
      ['b386', 'b387', 'b388', 'b389', 'b390'],
    ],
    door: { dx: 2 },
  };

  /** The red-roofed house; its door is drawn on, in the last column. */
  const HOUSE = {
    above: [['b423', 'b424', 'b425', 'b426', 'b427']],
    body: [
      ['b470', 'b471', 'b472', 'b473', 'b474'],
      ['b517', 'b518', 'b519', 'b520', 'b521'],
      ['b564', 'b565', 'b566', 'b567', 'b568'],
    ],
    overlay: [{ dx: 4, dy: 1, tile: 'b181' }, { dx: 4, dy: 2, tile: 'b228' }],
    door: { dx: 4 },
  };

  // -------------------------------------------------------------------------
  // The town
  // -------------------------------------------------------------------------

  const MAP_W = 22;
  const MAP_H = 18;

  const grid = (fill) => Array.from({ length: MAP_H }, () => Array(MAP_W).fill(fill));
  const ground = grid(TILES.grass);
  const objects = grid(null);
  const overlays = grid(null);
  const above = grid(null);
  const solid = grid(false);
  /** null, 'tall' (grass), 'shallow' or 'deep' (water). */
  const terrain = grid(null);

  const inside = (x, y) => x >= 0 && y >= 0 && x < MAP_W && y < MAP_H;
  function set(layer, x, y, tile) {
    if (inside(x, y)) layer[y][x] = tile;
  }
  function block(x, y) {
    if (inside(x, y)) solid[y][x] = true;
  }

  /** A rectangle drawn with a 9-piece set (corners, edges, middle). */
  function rect(layer, set9, x0, y0, w, h, middle = set9.c) {
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
        set(layer, x, y, piece ? set9[piece] : middle);
      }
    }
  }

  // Pines all round, in 2x2 cells.
  const CELLS_W = MAP_W / 2;
  const CELLS_H = MAP_H / 2;
  for (let cy = 0; cy < CELLS_H; cy++) {
    for (let cx = 0; cx < CELLS_W; cx++) {
      if (cx > 0 && cy > 0 && cx < CELLS_W - 1 && cy < CELLS_H - 1) continue;
      const x = cx * 2;
      const y = cy * 2;
      [[0, 0, TILES.treeTop[0]], [1, 0, TILES.treeTop[1]], [0, 1, TILES.treeBottom[0]], [1, 1, TILES.treeBottom[1]]].forEach(
        ([dx, dy, tile]) => {
          set(objects, x + dx, y + dy, tile);
          block(x + dx, y + dy);
        }
      );
    }
  }

  /** The two stations. `door` is the tile you walk into; `sign` is read with A. */
  const BUILDINGS = [
    { station: 'drop', plan: SHOP, x: 3, y: 2, sign: { x: 9, y: 5 }, text: ['DROP STATION', 'Drop a wild Pokemon, then catch it by name.'] },
    { station: 'battle', plan: HOUSE, x: 13, y: 2, sign: { x: 12, y: 5 }, text: ['BATTLE STATION', 'Take your team into a battle.'] },
  ];

  for (const b of BUILDINGS) {
    const { plan } = b;
    plan.above.forEach((row, dy) => row.forEach((tile, dx) => {
      set(above, b.x + dx, b.y + dy, tile);
      block(b.x + dx, b.y + dy);
    }));
    const top = b.y + plan.above.length;
    plan.body.forEach((row, dy) => row.forEach((tile, dx) => {
      set(objects, b.x + dx, top + dy, tile);
      block(b.x + dx, top + dy);
    }));
    for (const o of plan.overlay || []) set(overlays, b.x + o.dx, top + o.dy, o.tile);
    b.door = { x: b.x + plan.door.dx, y: top + plan.body.length - 1 };

    set(objects, b.sign.x, b.sign.y, TILES.signPost);
    set(above, b.sign.x, b.sign.y - 1, TILES.signBoard);
    block(b.sign.x, b.sign.y);
  }

  // The path along the front of both stations.
  rect(ground, TILES.path, 3, 6, 16, 4);

  // A pond: a shallow rim you can wade through, deep water in the middle.
  rect(ground, TILES.shore, 3, 10, 8, 6, TILES.shallow);
  for (let y = 10; y < 16; y++) for (let x = 3; x < 11; x++) terrain[y][x] = 'shallow';
  for (let y = 12; y < 14; y++) {
    for (let x = 5; x < 9; x++) {
      set(ground, x, y, TILES.deep);
      terrain[y][x] = 'deep';
      block(x, y);
    }
  }

  // Tall grass, and flowers here and there.
  for (let y = 11; y < 16; y++) {
    for (let x = 13; x < 19; x++) {
      set(objects, x, y, TILES.tallGrass);
      terrain[y][x] = 'tall';
    }
  }
  [[11, 3], [11, 4], [12, 10], [19, 10], [2, 7], [19, 15]].forEach(([x, y], i) => set(objects, x, y, TILES.flowers[i % 3]));

  const START = { x: 11, y: 8, facing: 'up' };

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`could not load ${src}`));
      img.src = src;
    });
  }

  async function loadSheets() {
    const out = {};
    await Promise.all(Object.entries(SHEETS).map(async ([key, sheet]) => {
      out[key] = { img: await loadImage(sheet.src), columns: sheet.columns };
    }));
    return out;
  }

  /** Draw a tile by name; animated tiles show the frame for `now`. */
  function drawTile(g, sheets, name, x, y, now = 0) {
    if (!name) return;
    const sheet = sheets[name[0]];
    let id = Number(name.slice(1));
    const anim = ANIMS[name];
    if (anim) id = anim.frames[Math.floor(now / anim.ms) % anim.frames.length];
    g.drawImage(sheet.img, (id % sheet.columns) * TILE, Math.floor(id / sheet.columns) * TILE, TILE, TILE, x, y, TILE, TILE);
  }

  /** One layer as an image, leaving out animated tiles (drawn each frame). */
  function drawLayer(sheets, layer, withAnimated = false) {
    const canvas = document.createElement('canvas');
    canvas.width = MAP_W * TILE;
    canvas.height = MAP_H * TILE;
    const g = canvas.getContext('2d');
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        const name = layer[y][x];
        if (name && (withAnimated || !ANIMS[name])) drawTile(g, sheets, name, x * TILE, y * TILE);
      }
    }
    return canvas;
  }

  /** The animated tiles, as [layer, x, y, name], so only those are redrawn. */
  const animated = [];
  for (const [index, layer] of [ground, objects].entries()) {
    for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) if (ANIMS[layer[y][x]]) animated.push([index, x, y, layer[y][x]]);
  }

  // -------------------------------------------------------------------------
  // The player and effects
  //
  // characters/adventurer.png: 16x32 frames, 3 across (step, stand, step),
  // rows facing down, left, right, up. animations/grass.png and
  // splash_small.png: 16x16 frames side by side.
  // -------------------------------------------------------------------------

  const HERO = `${BASE}/characters/adventurer.png`;
  const SHADOW = `${BASE}/characters/drop_shadow.png`;
  const GRASS_FX = `${BASE}/animations/grass.png`;
  const SPLASH_FX = `${BASE}/animations/splash_small.png`;
  const HERO_W = 16;
  const HERO_H = 32;
  const HERO_ROW = { down: 0, left: 1, right: 2, up: 3 };
  /** How long each effect frame shows, and how many times the effect plays. */
  const FX = { grass: { ms: 150, loops: 2 }, splash: { ms: 90, loops: 1 } };

  // -------------------------------------------------------------------------
  // The game loop
  // -------------------------------------------------------------------------

  const DIRS = {
    up: [0, -1],
    down: [0, 1],
    left: [-1, 0],
    right: [1, 0],
  };

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} hooks
   * @param {(station: string) => void} hooks.enter      walked into a door
   * @param {(lines: string[]) => void} hooks.read       read a sign
   * @param {() => boolean} hooks.paused                 a menu is open
   */
  function create(canvas, hooks) {
    const g = canvas.getContext('2d');
    canvas.width = VIEW_W;
    canvas.height = VIEW_H;
    g.imageSmoothingEnabled = false;

    let sheets = null;
    let layers = null;
    const art = {};
    loadSheets().then((loaded) => {
      sheets = loaded;
      layers = {
        ground: drawLayer(loaded, ground),
        objects: drawLayer(loaded, objects),
        overlays: drawLayer(loaded, overlays),
        above: drawLayer(loaded, above),
      };
    }, (err) => console.error(err));
    for (const [key, src] of Object.entries({ hero: HERO, shadow: SHADOW, grass: GRASS_FX, splash: SPLASH_FX })) {
      loadImage(src).then((img) => { art[key] = img; }, (err) => console.error(err));
    }

    const player = {
      x: START.x,
      y: START.y,
      facing: START.facing,
      // Mid-step: where from, when it started, how long it takes.
      from: null,
      started: 0,
      duration: WALK_MS,
      stepCount: 0,
    };

    /** Effects playing out on tiles: { kind, x, y, started }. */
    const effects = [];

    /** Directions held, most recent last. */
    const held = [];
    let heldSince = 0;
    let running = false;
    let fade = 0;

    const doorAt = (x, y) => BUILDINGS.find((b) => b.door.x === x && b.door.y === y) || null;
    const signAt = (x, y) => BUILDINGS.find((b) => b.sign.x === x && b.sign.y === y) || null;
    const terrainAt = (x, y) => (inside(x, y) ? terrain[y][x] : null);

    function tryMove(now) {
      const dir = held[held.length - 1];
      if (!dir) return;

      // A tap turns; holding walks.
      if (player.facing !== dir) {
        player.facing = dir;
        heldSince = now;
        return;
      }
      if (now - heldSince < TURN_MS && player.stepCount === 0) return;

      const [dx, dy] = DIRS[dir];
      const nx = player.x + dx;
      const ny = player.y + dy;

      const door = doorAt(nx, ny);
      if (door && dir === 'up') {
        held.length = 0;
        fade = now;
        hooks.enter(door.station);
        return;
      }

      if (!inside(nx, ny) || solid[ny][nx]) return;

      player.from = { x: player.x, y: player.y };
      player.x = nx;
      player.y = ny;
      player.started = now;
      player.duration = running ? RUN_MS : WALK_MS;
      player.stepCount += 1;

      // Grass rustles as you step in; water splashes behind you.
      const ground = terrainAt(nx, ny);
      if (ground === 'tall') effects.push({ kind: 'grass', x: nx, y: ny, started: now });
      if (ground === 'shallow') effects.push({ kind: 'splash', x: nx, y: ny, started: now + (running ? 0 : 60) });
    }

    function interact() {
      const [dx, dy] = DIRS[player.facing];
      const x = player.x + dx;
      const y = player.y + dy;
      const sign = signAt(x, y);
      if (sign) hooks.read(sign.text);
      const door = doorAt(x, y);
      if (door) hooks.enter(door.station);
    }

    /** Where the player is drawn, in pixels, including mid-step. */
    function position(now) {
      if (!player.from) return { x: player.x * TILE, y: player.y * TILE, t: 0 };
      const t = Math.min(1, (now - player.started) / player.duration);
      return {
        x: (player.from.x + (player.x - player.from.x) * t) * TILE,
        y: (player.from.y + (player.y - player.from.y) * t) * TILE,
        t,
      };
    }

    function drawEffects(now, camX, camY, front) {
      for (let i = effects.length - 1; i >= 0; i--) {
        const fx = effects[i];
        const img = art[fx.kind];
        const frames = img ? img.width / TILE : 1;
        const tick = Math.floor((now - fx.started) / FX[fx.kind].ms);
        if (tick >= frames * FX[fx.kind].loops) {
          effects.splice(i, 1);
          continue;
        }
        // Grass is drawn in front of the player; splashes on the water.
        if (!img || tick < 0 || (fx.kind === 'grass') !== front) continue;
        g.drawImage(img, (tick % frames) * TILE, 0, TILE, TILE, fx.x * TILE - camX, fx.y * TILE - camY, TILE, TILE);
      }
    }

    function frame(now) {
      if (player.from && now - player.started >= player.duration) {
        player.from = null;
        if (!held.length) player.stepCount = 0;
      }
      if (!player.from && !hooks.paused()) tryMove(now);

      const pos = position(now);

      // Camera, centred on the player, kept inside the map.
      const camX = Math.max(0, Math.min(MAP_W * TILE - VIEW_W, Math.round(pos.x + TILE / 2 - VIEW_W / 2)));
      const camY = Math.max(0, Math.min(MAP_H * TILE - VIEW_H, Math.round(pos.y + TILE / 2 - VIEW_H / 2)));
      const view = (img) => g.drawImage(img, camX, camY, VIEW_W, VIEW_H, 0, 0, VIEW_W, VIEW_H);

      g.fillStyle = '#000';
      g.fillRect(0, 0, VIEW_W, VIEW_H);

      if (layers) {
        view(layers.ground);
        for (const [index, x, y, name] of animated) {
          if (index === 0) drawTile(g, sheets, name, x * TILE - camX, y * TILE - camY, now);
        }
        view(layers.objects);
        for (const [index, x, y, name] of animated) {
          if (index === 1) drawTile(g, sheets, name, x * TILE - camX, y * TILE - camY, now);
        }
        view(layers.overlays);
      }
      drawEffects(now, camX, camY, false);

      // The player: shadow, then the frame. Steps alternate feet.
      const sx = Math.round(pos.x - camX);
      const tileY = Math.round(pos.y - camY);
      const top = tileY + TILE - HERO_H;
      const where = terrainAt(player.x, player.y);
      const wading = where === 'shallow';
      if (art.shadow && !wading) g.drawImage(art.shadow, sx, top);
      if (art.hero) {
        const walking = player.from && pos.t > 0.15 && pos.t < 0.85;
        const column = walking ? (player.stepCount % 2 ? 0 : 2) : 1;
        // Ankle-deep in water: the bottom of the sprite is under the surface.
        const cut = wading && !player.from ? 3 : 0;
        g.drawImage(art.hero, column * HERO_W, HERO_ROW[player.facing] * HERO_H, HERO_W, HERO_H - cut, sx, top, HERO_W, HERO_H - cut);
      }

      // Standing in tall grass hides the feet: the grass's lower half goes back on top.
      if (sheets && !player.from && where === 'tall') {
        const sheet = sheets.o;
        const id = Number(TILES.tallGrass.slice(1));
        const half = TILE / 2;
        g.drawImage(sheet.img, (id % sheet.columns) * TILE, Math.floor(id / sheet.columns) * TILE + half, TILE, half, sx, tileY + half, TILE, half);
      }
      drawEffects(now, camX, camY, true);

      if (layers) view(layers.above);

      // A quick fade on going through a door.
      if (fade) {
        const a = Math.max(0, 1 - (now - fade) / 350);
        if (a <= 0) fade = 0;
        else {
          g.fillStyle = `rgba(0,0,0,${a})`;
          g.fillRect(0, 0, VIEW_W, VIEW_H);
        }
      }

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);

    return {
      press(dir) {
        if (!held.includes(dir)) {
          held.push(dir);
          if (!player.from) heldSince = performance.now();
        }
      },
      release(dir) {
        const at = held.indexOf(dir);
        if (at >= 0) held.splice(at, 1);
      },
      releaseAll() {
        held.length = 0;
      },
      setRunning(on) {
        running = on;
      },
      interact,
      /** Back outside a building's door, facing away from it. */
      leave(station) {
        const b = BUILDINGS.find((x) => x.station === station);
        if (!b) return;
        player.x = b.door.x;
        player.y = b.door.y + 1;
        player.from = null;
        player.facing = 'down';
        player.stepCount = 0;
        fade = performance.now();
      },
    };
  }

  /** The whole town at once, for checking the layout. */
  async function preview() {
    const sheets = await loadSheets();
    const canvas = document.createElement('canvas');
    canvas.width = MAP_W * TILE;
    canvas.height = MAP_H * TILE;
    const g = canvas.getContext('2d');
    for (const layer of [ground, objects, overlays, above]) g.drawImage(drawLayer(sheets, layer, true), 0, 0);
    return canvas;
  }

  window.World = { create, preview, VIEW_W, VIEW_H };
})();
