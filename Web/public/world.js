'use strict';

/**
 * The overworld: a small town drawn on a 240x160 canvas (the GBA's screen),
 * scaled up with crisp pixels.
 *
 * All the art is drawn here in code - tiles, buildings and the player - so
 * there are no outside assets yet. Each tile is 16x16, the screen is 15x10
 * tiles, and the camera follows the player.
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

  const C = {
    outline: '#283038',
    grass: '#7ccf6a',
    grassTuft: '#5db456',
    grassDeep: '#3f9447',
    tall: '#4fae4f',
    tallTip: '#8fe07a',
    path: '#ead9a2',
    pathDot: '#d6c085',
    water: '#4aa0e6',
    waterLight: '#9ad6ff',
    waterDeep: '#3482c8',
    leaf: '#3f9a4b',
    leafLight: '#62c264',
    leafDark: '#2b6b38',
    trunk: '#7a5230',
    wall: '#f4ecd9',
    wallShade: '#d5c9ae',
    window: '#8fd3ff',
    windowDark: '#4f8fc8',
    door: '#5b4a3a',
    teal: '#29a39b',
    tealLight: '#5fd1c6',
    tealDark: '#1d7570',
    orange: '#e2703a',
    orangeLight: '#ff9a62',
    orangeDark: '#a84d24',
    signWood: '#b98a52',
    signLight: '#e3b878',
    flowerA: '#f05a6a',
    flowerB: '#ffd34a',
    white: '#ffffff',
  };

  // -------------------------------------------------------------------------
  // The map
  //
  //   R tree      G grass     T tall grass   F flowers   P path
  //   W water     B building  D door         S sign
  // -------------------------------------------------------------------------

  const MAP = [
    'RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR',
    'RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR',
    'RRGGGGGGGGGGGGGGGGGGGGGGGGGGGGRR',
    'RRGBBBBBBGGGGFGGGGGFGGBBBBBBBGRR',
    'RRGBBBBBBGGGGGGGGGGGGGBBBBBBBGRR',
    'RRGBBBBBBGGGGGGGGGGGGGBBBBBBBGRR',
    'RRGBBBDBBGGGGGGGGGGGGGBBBDBBBGRR',
    'RRGGSGPGGGGGGGGGGGGGGGGSGPGGGGRR',
    'RRGGGGPPPPPPPPPPPPPPPPPPPPGGGGRR',
    'RRGGGGGGGGGGGGPPGGGGGGGGGGGGGGRR',
    'RRGFFGGGGGGGGGPPGGGGGGGGGGGFFGRR',
    'RRGWWWWWGGGGGGPPGGGGTTTTTTTTGGRR',
    'RRGWWWWWWGGGGGPPGGGGTTTTTTTTGGRR',
    'RRGWWWWWWGGGGGPPGGGGTTTTTTTTGGRR',
    'RRGGWWWWGGGGGGPPGGGGTTTTTTTTGGRR',
    'RRGGGGGGGGFFGGPPGGGGGGGGGGGGGGRR',
    'RRGGGGGGGGGGGGPPGGGGGGGGGGGGGGRR',
    'RRGGGGGGGGGGGGPPGGGGGGGGGGGGGGRR',
    'RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR',
    'RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR',
  ];

  const MAP_W = MAP[0].length;
  const MAP_H = MAP.length;
  MAP.forEach((row, y) => {
    if (row.length !== MAP_W) console.warn(`map row ${y} is ${row.length} wide, not ${MAP_W}`);
  });

  /** The two stations. `door` is the tile you walk into. */
  const BUILDINGS = [
    { station: 'drop', x: 3, y: 3, w: 6, h: 4, door: { x: 6, y: 6 }, roof: [C.teal, C.tealLight, C.tealDark], label: 'DROP' },
    { station: 'battle', x: 22, y: 3, w: 7, h: 4, door: { x: 25, y: 6 }, roof: [C.orange, C.orangeLight, C.orangeDark], label: 'BATTLE' },
  ];

  const SIGNS = {
    '4,7': ['DROP STATION', 'Drop a wild Pokemon, then catch it by name.'],
    '23,7': ['BATTLE STATION', 'Take your team into a battle.'],
  };

  const START = { x: 15, y: 15, facing: 'up' };

  const tileAt = (x, y) => (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H ? 'R' : MAP[y][x]);

  /** A stable pseudo-random number per tile, for grass tufts and such. */
  const hash = (x, y, salt = 0) => {
    let h = (x * 374761393 + y * 668265263 + salt * 2147483647) | 0;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };

  // -------------------------------------------------------------------------
  // Drawing tiles
  // -------------------------------------------------------------------------

  function px(g, x, y, color, w = 1, h = 1) {
    g.fillStyle = color;
    g.fillRect(x, y, w, h);
  }

  function grass(g, ox, oy, tx, ty) {
    px(g, ox, oy, C.grass, TILE, TILE);
    for (let i = 0; i < 3; i++) {
      const x = ox + Math.floor(hash(tx, ty, i) * 13) + 1;
      const y = oy + Math.floor(hash(tx, ty, i + 9) * 13) + 1;
      px(g, x, y + 1, C.grassTuft);
      px(g, x + 2, y + 1, C.grassTuft);
      px(g, x + 1, y, C.grassTuft);
    }
  }

  function tallGrass(g, ox, oy) {
    px(g, ox, oy, C.tall, TILE, TILE);
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 4; col++) {
        const x = ox + col * 4 + (row ? 2 : 0);
        const y = oy + row * 8 + 2;
        px(g, x, y + 1, C.grassDeep, 1, 5);
        px(g, x + 1, y, C.tallTip, 1, 5);
        px(g, x + 2, y + 2, C.grassDeep, 1, 4);
      }
    }
  }

  function flowers(g, ox, oy, tx, ty) {
    grass(g, ox, oy, tx, ty);
    const spots = [[3, 3], [10, 5], [5, 11], [12, 12]];
    spots.forEach(([x, y], i) => {
      const petal = i % 2 ? C.flowerB : C.flowerA;
      px(g, ox + x - 1, oy + y, petal);
      px(g, ox + x + 1, oy + y, petal);
      px(g, ox + x, oy + y - 1, petal);
      px(g, ox + x, oy + y + 1, petal);
      px(g, ox + x, oy + y, C.white);
    });
  }

  function path(g, ox, oy, tx, ty) {
    px(g, ox, oy, C.path, TILE, TILE);
    for (let i = 0; i < 4; i++) {
      px(g, ox + Math.floor(hash(tx, ty, i + 3) * 15), oy + Math.floor(hash(tx, ty, i + 7) * 15), C.pathDot);
    }
    // Soft edge where it meets grass.
    if (!'PD'.includes(tileAt(tx, ty - 1))) px(g, ox, oy, C.pathDot, TILE, 1);
    if (!'PD'.includes(tileAt(tx, ty + 1))) px(g, ox, oy + 15, C.pathDot, TILE, 1);
    if (!'PD'.includes(tileAt(tx - 1, ty))) px(g, ox, oy, C.pathDot, 1, TILE);
    if (!'PD'.includes(tileAt(tx + 1, ty))) px(g, ox + 15, oy, C.pathDot, 1, TILE);
  }

  function water(g, ox, oy, tx, ty, frame) {
    px(g, ox, oy, C.water, TILE, TILE);
    // Darker rim along any shore.
    if (tileAt(tx, ty - 1) !== 'W') px(g, ox, oy, C.waterDeep, TILE, 2);
    if (tileAt(tx - 1, ty) !== 'W') px(g, ox, oy, C.waterDeep, 2, TILE);
    if (tileAt(tx + 1, ty) !== 'W') px(g, ox + 14, oy, C.waterDeep, 2, TILE);
    if (tileAt(tx, ty + 1) !== 'W') px(g, ox, oy + 14, C.waterDeep, TILE, 2);
    const shift = frame ? 3 : 0;
    px(g, ox + 3 + shift, oy + 5, C.waterLight, 4, 1);
    px(g, ox + 8 - shift, oy + 10, C.waterLight, 4, 1);
  }

  function tree(g, ox, oy) {
    // A round canopy over a short trunk; neighbours overlap into a forest.
    px(g, ox + 6, oy + 12, C.trunk, 4, 4);
    g.fillStyle = C.leafDark;
    g.beginPath();
    g.arc(ox + 8, oy + 7, 7.5, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = C.leaf;
    g.beginPath();
    g.arc(ox + 8, oy + 6.5, 6, 0, Math.PI * 2);
    g.fill();
    px(g, ox + 4, oy + 3, C.leafLight, 3, 2);
    px(g, ox + 9, oy + 5, C.leafLight, 2, 2);
    px(g, ox + 6, oy + 8, C.leafLight, 2, 1);
  }

  function sign(g, ox, oy, tx, ty) {
    grass(g, ox, oy, tx, ty);
    px(g, ox + 7, oy + 9, C.trunk, 2, 6);
    px(g, ox + 2, oy + 2, C.outline, 12, 9);
    px(g, ox + 3, oy + 3, C.signWood, 10, 7);
    px(g, ox + 3, oy + 3, C.signLight, 10, 2);
    px(g, ox + 5, oy + 6, C.trunk, 6, 1);
    px(g, ox + 5, oy + 8, C.trunk, 4, 1);
  }

  function building(g, b) {
    const x = b.x * TILE;
    const y = b.y * TILE;
    const w = b.w * TILE;
    const h = b.h * TILE;
    const [roof, roofLight, roofDark] = b.roof;
    const roofH = 34;

    // Walls
    px(g, x, y + roofH - 2, C.outline, w, h - roofH + 2);
    px(g, x + 1, y + roofH - 1, C.wall, w - 2, h - roofH);
    px(g, x + 1, y + h - 5, C.wallShade, w - 2, 4);

    // Roof: overhanging, with stripes and a lighter ridge.
    px(g, x - 2, y + 2, C.outline, w + 4, roofH);
    px(g, x - 1, y + 3, roof, w + 2, roofH - 2);
    for (let row = y + 9; row < y + roofH - 2; row += 6) px(g, x - 1, row, roofDark, w + 2, 1);
    px(g, x - 1, y + 3, roofLight, w + 2, 3);

    // The station's name on a plate on the roof.
    const plateW = b.label.length * 8 + 8;
    const plateX = x + Math.floor((w - plateW) / 2);
    px(g, plateX, y + 13, C.outline, plateW, 13);
    px(g, plateX + 1, y + 14, C.white, plateW - 2, 11);
    g.fillStyle = roofDark;
    g.font = '8px "Press Start 2P", monospace';
    g.textBaseline = 'top';
    g.fillText(b.label, plateX + 5, y + 16);

    // Windows either side of the door.
    const doorX = b.door.x * TILE;
    const doorY = b.door.y * TILE;
    const windows = [x + 8, x + w - 24];
    windows.forEach((wx) => {
      if (Math.abs(wx - doorX) < 18) return;
      px(g, wx, y + roofH + 4, C.outline, 16, 12);
      px(g, wx + 1, y + roofH + 5, C.window, 14, 10);
      px(g, wx + 1, y + roofH + 5, C.windowDark, 14, 3);
      px(g, wx + 7, y + roofH + 5, C.outline, 1, 10);
    });

    // Door, with a mat.
    px(g, doorX + 2, doorY + 1, C.outline, 12, 15);
    px(g, doorX + 3, doorY + 2, C.door, 10, 14);
    px(g, doorX + 3, doorY + 2, C.window, 10, 4);
    px(g, doorX + 10, doorY + 9, C.signLight, 2, 2);
  }

  /** The whole map as one image. Water is redrawn as it ripples. */
  function drawMap(frame = 0) {
    const canvas = document.createElement('canvas');
    canvas.width = MAP_W * TILE;
    canvas.height = MAP_H * TILE;
    const g = canvas.getContext('2d');

    for (let ty = 0; ty < MAP_H; ty++) {
      for (let tx = 0; tx < MAP_W; tx++) {
        const ox = tx * TILE;
        const oy = ty * TILE;
        const t = MAP[ty][tx];
        if (t === 'T') tallGrass(g, ox, oy);
        else if (t === 'F') flowers(g, ox, oy, tx, ty);
        else if (t === 'P') path(g, ox, oy, tx, ty);
        else if (t === 'W') water(g, ox, oy, tx, ty, frame);
        else if (t === 'S') sign(g, ox, oy, tx, ty);
        else grass(g, ox, oy, tx, ty);
      }
    }

    // Trees last, row by row, so lower canopies overlap the ones above.
    for (let ty = 0; ty < MAP_H; ty++) {
      for (let tx = 0; tx < MAP_W; tx++) if (MAP[ty][tx] === 'R') tree(g, tx * TILE, ty * TILE);
    }

    BUILDINGS.forEach((b) => building(g, b));
    return canvas;
  }

  // -------------------------------------------------------------------------
  // The player
  // -------------------------------------------------------------------------

  const PALETTE = {
    k: C.outline,
    c: '#3456c8',
    C: '#6d8ff2',
    h: '#5a3a22',
    s: '#f8c9a0',
    j: '#e2553a',
    J: '#ff8c5c',
    p: '#3a4a7a',
    b: '#2c2c34',
    w: '#ffffff',
  };

  /** Left halves of the front and back views; mirrored to make the whole. */
  const FRONT = [
    '........',
    '....kkkk',
    '...kCCCC',
    '..kcCCCC',
    '..kccccc',
    '.kkkkkkk',
    '..khssss',
    '..ksskss',
    '...kssss',
    '...kjjJw',
    '..kjjjJJ',
    '..ksjjjj',
    '...kpppp',
    '...kpppk',
    '...kbbbk',
    '....kkk.',
  ];
  const BACK = [
    '........',
    '....kkkk',
    '...kCCCC',
    '..kcCCCC',
    '..kccccc',
    '..kkkkkk',
    '..khhhhh',
    '..khhhhh',
    '...khhhh',
    '...kjjjj',
    '..kjjjJJ',
    '..ksjjjj',
    '...kpppp',
    '...kpppk',
    '...kbbbk',
    '....kkk.',
  ];
  /** Facing left; facing right is this mirrored. */
  const SIDE = [
    '................',
    '.....kkkkk......',
    '....kCCCCCk.....',
    '...kcCCCCCck....',
    '..kkkcccccck....',
    '.kkkkkkkkkkk....',
    '...ksssshhhk....',
    '...kskshhhhk....',
    '....kssshhk.....',
    '.....kjjjk......',
    '....kjjjJJk.....',
    '....kjsjJJk.....',
    '....kkppppk.....',
    '.....kpppk......',
    '.....kbbbk......',
    '......kkk.......',
  ];

  const whole = (half) => half.map((row) => row + row.split('').reverse().join(''));
  const mirror = (rows) => rows.map((row) => row.split('').reverse().join(''));

  /** One leg lifted, for the walking frames. */
  function stepOf(rows, side) {
    const out = rows.slice();
    if (side === 'left') {
      out[13] = out[13].slice(0, 8).replace('kpppk', 'kbbbk') + out[13].slice(8);
      out[14] = out[14].slice(0, 8).replace('kbbbk', '.kkk.') + out[14].slice(8);
      out[15] = out[15].slice(0, 8).replace(/k/g, '.') + out[15].slice(8);
    } else {
      out[13] = out[13].slice(0, 8) + out[13].slice(8).replace('kpppk', 'kbbbk');
      out[14] = out[14].slice(0, 8) + out[14].slice(8).replace('kbbbk', '.kkk.');
      out[15] = out[15].slice(0, 8) + out[15].slice(8).replace(/k/g, '.');
    }
    return out;
  }

  function sideStep(rows) {
    const out = rows.slice();
    out[13] = '....kpk.kpk.....';
    out[14] = '....kbk.kbk.....';
    out[15] = '................';
    return out;
  }

  function sprite(rows) {
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const g = canvas.getContext('2d');
    rows.forEach((row, y) => {
      for (let x = 0; x < 16; x++) {
        const color = PALETTE[row[x]];
        if (color) px(g, x, y, color);
      }
    });
    return canvas;
  }

  function playerFrames() {
    const front = whole(FRONT);
    const back = whole(BACK);
    const left = SIDE.map((row) => row.padEnd(16, '.').slice(0, 16));
    const right = mirror(left);
    return {
      down: [front, stepOf(front, 'left'), front, stepOf(front, 'right')].map(sprite),
      up: [back, stepOf(back, 'left'), back, stepOf(back, 'right')].map(sprite),
      left: [left, sideStep(left), left, sideStep(left)].map(sprite),
      right: [right, sideStep(right), right, sideStep(right)].map(sprite),
    };
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

    let maps = [drawMap(0), drawMap(1)];
    const frames = playerFrames();

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

    function walkable(x, y) {
      const t = tileAt(x, y);
      return t === 'G' || t === 'P' || t === 'T' || t === 'F';
    }

    function doorAt(x, y) {
      return BUILDINGS.find((b) => b.door.x === x && b.door.y === y) || null;
    }

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

      if (!walkable(nx, ny)) return;

      player.from = { x: player.x, y: player.y };
      player.x = nx;
      player.y = ny;
      player.started = now;
      player.duration = running ? RUN_MS : WALK_MS;
      player.stepCount += 1;
    }

    function interact() {
      const [dx, dy] = DIRS[player.facing];
      const key = `${player.x + dx},${player.y + dy}`;
      if (SIGNS[key]) hooks.read(SIGNS[key]);
      const door = doorAt(player.x + dx, player.y + dy);
      if (door) hooks.enter(door.station);
    }

    /** Where the player is drawn, in pixels, including mid-step. */
    function position(now) {
      if (!player.from) return { x: player.x * TILE, y: player.y * TILE, moving: false, t: 0 };
      const t = Math.min(1, (now - player.started) / player.duration);
      return {
        x: (player.from.x + (player.x - player.from.x) * t) * TILE,
        y: (player.from.y + (player.y - player.from.y) * t) * TILE,
        moving: t < 1,
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

      const map = maps[Math.floor(now / 600) % 2];
      g.drawImage(map, camX, camY, VIEW_W, VIEW_H, 0, 0, VIEW_W, VIEW_H);

      // Shadow, then the player. Steps alternate feet.
      const sx = Math.round(pos.x - camX);
      const sy = Math.round(pos.y - camY) - 4;
      g.fillStyle = 'rgba(0,0,0,0.22)';
      g.beginPath();
      g.ellipse(sx + 8, sy + 15.5, 5.5, 2, 0, 0, Math.PI * 2);
      g.fill();
      const walking = player.from && pos.t > 0.25 && pos.t < 0.75;
      const step = walking ? (player.stepCount % 2 ? 1 : 3) : 0;
      g.drawImage(frames[player.facing][step], sx, sy);

      // Standing in tall grass hides the feet.
      if (!player.from && tileAt(player.x, player.y) === 'T') {
        tallGrass(makeClip(g, sx, sy + 10), sx, sy + 4);
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

    /** Clip drawing to the bottom of the player's tile (feet in the grass). */
    function makeClip(ctx, x, y) {
      return {
        set fillStyle(v) { ctx.fillStyle = v; },
        fillRect(rx, ry, w, h) {
          const top = Math.max(ry, y);
          const bottom = Math.min(ry + h, y + 6);
          if (bottom > top) ctx.fillRect(rx, top, w, bottom - top);
        },
      };
    }

    document.fonts.ready.then(() => {
      maps = [drawMap(0), drawMap(1)];
    });

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

  window.World = { create, VIEW_W, VIEW_H };
})();
