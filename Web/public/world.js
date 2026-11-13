'use strict';

/**
 * The overworld: a small town on a 240x160 canvas (the GBA's screen), scaled
 * up with crisp pixels.
 *
 * The scenery comes from the tile pack in Web/sprites (served at /sprites):
 * atlas/outdoor.png holds every 16x16 tile, numbered left to right, top to
 * bottom, as in atlas/outdoor-index.csv. The town below is laid out from
 * those numbers. The player is the Emerald hero (objects/characters/hero.png).
 *
 * Movement is on the grid, as in the handheld games: tap a direction to turn,
 * hold it to walk, hold B (X / Shift) to run. Walk into a door to go in; face
 * a sign and press A (Z / Enter / Space) to read it.
 */

(function () {
  const TILE = 16;
  const VIEW_W = 240;
  const VIEW_H = 160;
  const WALK_MS = 200;
  const RUN_MS = 110;
  // A tap shorter than this only turns the player.
  const TURN_MS = 90;

  const ATLAS = '/sprites/atlas/outdoor.png';
  const ATLAS_COLUMNS = 16;

  // -------------------------------------------------------------------------
  // Tile numbers in the atlas
  // -------------------------------------------------------------------------

  const T = {
    grass: 20,
    tallGrass: 28,
    rock: 32,
    // A tree is two tiles wide: its top, then its bottom, which is darker
    // when another tree stands below it. The tip pokes into the grass above.
    treeTop: [0, 1],
    treeBottomOnTree: [11, 12],
    treeBottomOnGrass: [16, 17],
    treeTip: [66, 23],
    // The pale path, as a rectangle.
    path: { tl: 56, t: 57, tr: 58, l: 64, c: 59, r: 65, bl: 62, b: 60, br: 61 },
    // A pond, as a rectangle.
    pond: { tl: 144, t: 159, tr: 145, l: 149, c: 41, r: 150, bl: 153, b: 160, br: 154 },
    // The red-roofed house, 4x4; its door is the second tile of the last row.
    house: [
      [111, 112, 112, 113],
      [118, 119, 119, 120],
      [125, 126, 127, 128],
      [135, 136, 137, 138],
    ],
    houseSign: 139,
  };

  // -------------------------------------------------------------------------
  // The town
  // -------------------------------------------------------------------------

  const MAP_W = 20;
  const MAP_H = 16;

  /** The two stations. `door` is the tile you walk into; `sign` is read with A. */
  const BUILDINGS = [
    { station: 'drop', x: 3, y: 3, door: { x: 4, y: 6 }, sign: { x: 7, y: 6 }, text: ['DROP STATION', 'Drop a wild Pokemon, then catch it by name.'] },
    { station: 'battle', x: 12, y: 3, door: { x: 13, y: 6 }, sign: { x: 16, y: 6 }, text: ['BATTLE STATION', 'Take your team into a battle.'] },
  ];

  const START = { x: 10, y: 9, facing: 'up' };

  /** ground[y][x] is a tile number; solid[y][x] blocks walking. */
  const ground = Array.from({ length: MAP_H }, () => Array(MAP_W).fill(T.grass));
  const solid = Array.from({ length: MAP_H }, () => Array(MAP_W).fill(false));

  function put(x, y, tile, blocks = false) {
    if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return;
    ground[y][x] = tile;
    solid[y][x] = blocks;
  }

  /** A rectangle drawn with a 9-piece set (corners, edges, middle). */
  function rect(set, x0, y0, w, h, blocks = false) {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const top = y === y0;
        const bottom = y === y0 + h - 1;
        const left = x === x0;
        const right = x === x0 + w - 1;
        const piece =
          top ? (left ? 'tl' : right ? 'tr' : 't')
          : bottom ? (left ? 'bl' : right ? 'br' : 'b')
          : left ? 'l' : right ? 'r' : 'c';
        put(x, y, set[piece], blocks);
      }
    }
  }

  // Trees all round the edge, laid out in 2x2 cells.
  const CELLS_W = MAP_W / 2;
  const CELLS_H = MAP_H / 2;
  const treeCell = (cx, cy) =>
    cx < 0 || cy < 0 || cx >= CELLS_W || cy >= CELLS_H || cx === 0 || cy === 0 || cx === CELLS_W - 1 || cy === CELLS_H - 1;

  for (let cy = 0; cy < CELLS_H; cy++) {
    for (let cx = 0; cx < CELLS_W; cx++) {
      if (!treeCell(cx, cy)) continue;
      const x = cx * 2;
      const y = cy * 2;
      const bottom = treeCell(cx, cy + 1) ? T.treeBottomOnTree : T.treeBottomOnGrass;
      put(x, y, T.treeTop[0], true);
      put(x + 1, y, T.treeTop[1], true);
      put(x, y + 1, bottom[0], true);
      put(x + 1, y + 1, bottom[1], true);
    }
  }
  // Tips of the bottom row of trees, over the grass above them.
  for (let cx = 1; cx < CELLS_W - 1; cx++) {
    put(cx * 2, MAP_H - 3, T.treeTip[0], true);
    put(cx * 2 + 1, MAP_H - 3, T.treeTip[1], true);
  }

  // The path in front of both stations.
  rect(T.path, 3, 7, 14, 3);

  // A pond, some tall grass and a few rocks.
  rect(T.pond, 3, 10, 4, 3, true);
  for (let y = 10; y <= 12; y++) for (let x = 12; x <= 16; x++) put(x, y, T.tallGrass);
  put(8, 11, T.rock, true);
  put(17, 8, T.rock, true);
  put(10, 4, T.rock, true);

  // The stations, each with its sign by the door.
  for (const b of BUILDINGS) {
    T.house.forEach((row, dy) => row.forEach((tile, dx) => put(b.x + dx, b.y + dy, tile, true)));
    put(b.sign.x, b.sign.y, T.houseSign, true);
  }

  const tileAt = (x, y) => (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H ? null : ground[y][x]);
  const blocked = (x, y) => x < 0 || y < 0 || x >= MAP_W || y >= MAP_H || solid[y][x];

  // -------------------------------------------------------------------------
  // Drawing the map
  // -------------------------------------------------------------------------

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`could not load ${src}`));
      img.src = src;
    });
  }

  function drawTile(g, atlas, tile, x, y) {
    g.drawImage(atlas, (tile % ATLAS_COLUMNS) * TILE, Math.floor(tile / ATLAS_COLUMNS) * TILE, TILE, TILE, x, y, TILE, TILE);
  }

  /** The whole town as one image. */
  function drawMap(atlas) {
    const canvas = document.createElement('canvas');
    canvas.width = MAP_W * TILE;
    canvas.height = MAP_H * TILE;
    const g = canvas.getContext('2d');
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) drawTile(g, atlas, ground[y][x], x * TILE, y * TILE);
    }
    return canvas;
  }

  // -------------------------------------------------------------------------
  // The player
  //
  // objects/characters/hero.png: 16x24 cells, columns facing down, up and
  // left (right is left mirrored); rows 0-2 walking (standing, then each
  // foot), rows 3-5 running. Cut from soulcaliburfan's rip of the Emerald
  // hero, feet aligned to the bottom of each cell.
  // -------------------------------------------------------------------------

  const HERO = '/sprites/objects/characters/hero.png';
  const HERO_W = 16;
  const HERO_H = 24;
  const HERO_COLUMN = { down: 0, up: 1, left: 2, right: 2 };

  /** Which row of the sheet: a step alternates feet, with standing between. */
  function heroRow(step, running) {
    const base = running ? 3 : 0;
    return base + [0, 1, 0, 2][step];
  }

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

    let atlas = null;
    let map = null;
    let hero = null;
    loadImage(ATLAS).then((img) => {
      atlas = img;
      map = drawMap(img);
    }, (err) => console.error(err));
    loadImage(HERO).then((img) => { hero = img; }, (err) => console.error(err));

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

    /** Directions held, most recent last. */
    const held = [];
    let heldSince = 0;
    let running = false;
    let fade = 0;

    const doorAt = (x, y) => BUILDINGS.find((b) => b.door.x === x && b.door.y === y) || null;
    const signAt = (x, y) => BUILDINGS.find((b) => b.sign.x === x && b.sign.y === y) || null;

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

      if (blocked(nx, ny)) return;

      player.from = { x: player.x, y: player.y };
      player.x = nx;
      player.y = ny;
      player.started = now;
      player.duration = running ? RUN_MS : WALK_MS;
      player.stepCount += 1;
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

      g.fillStyle = '#000';
      g.fillRect(0, 0, VIEW_W, VIEW_H);
      if (map) g.drawImage(map, camX, camY, VIEW_W, VIEW_H, 0, 0, VIEW_W, VIEW_H);

      // Shadow, then the player, feet on the bottom of the tile. Steps
      // alternate feet; running uses its own frames.
      const sx = Math.round(pos.x - camX);
      const tileY = Math.round(pos.y - camY);
      g.fillStyle = 'rgba(0,0,0,0.22)';
      g.beginPath();
      g.ellipse(sx + 8, tileY + 14.5, 5.5, 2, 0, 0, Math.PI * 2);
      g.fill();
      if (hero) {
        const walking = player.from && pos.t > 0.25 && pos.t < 0.75;
        const step = walking ? (player.stepCount % 2 ? 1 : 3) : 0;
        const fast = Boolean(player.from) && player.duration === RUN_MS;
        const srcX = HERO_COLUMN[player.facing] * HERO_W;
        const srcY = heroRow(step, fast) * HERO_H;
        const top = tileY + TILE - HERO_H;
        if (player.facing === 'right') {
          g.save();
          g.translate(sx + HERO_W, top);
          g.scale(-1, 1);
          g.drawImage(hero, srcX, srcY, HERO_W, HERO_H, 0, 0, HERO_W, HERO_H);
          g.restore();
        } else {
          g.drawImage(hero, srcX, srcY, HERO_W, HERO_H, sx, top, HERO_W, HERO_H);
        }
      }

      // Standing in tall grass hides the feet: redraw the grass's lower half over them.
      if (atlas && !player.from && tileAt(player.x, player.y) === T.tallGrass) {
        const tile = T.tallGrass;
        const half = TILE / 2;
        g.drawImage(atlas, (tile % ATLAS_COLUMNS) * TILE, Math.floor(tile / ATLAS_COLUMNS) * TILE + half, TILE, half, sx, tileY + half, TILE, half);
      }

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
    return drawMap(await loadImage(ATLAS));
  }

  window.World = { create, preview, VIEW_W, VIEW_H };
})();
