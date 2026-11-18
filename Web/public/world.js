'use strict';

/**
 * The overworld, drawn on a 240x160 canvas (the GBA's screen) scaled up with
 * crisp pixels.
 *
 * Maps come from the server (GET /api/world), which also checks every step
 * (POST /api/step, see Web/overworld.js). Steps are shown straight away and
 * sent in order; if the server refuses one, the player snaps back to where
 * the server says they are. Grass battles and trainers are decided there and
 * arrive as events on a step's answer.
 *
 * Every picture comes from the Tuxemon assets in Web/sprites/tuxemon (served
 * at /sprites/tuxemon). Credits: /sprites/CREDITS.txt.
 *
 * Maps have three layers, as Tuxemon's own do: the ground, things on it
 * (trees, buildings, tall grass), and what is drawn over the player (roofs,
 * the tops of signs).
 *
 * Movement is on the grid: tap a direction to turn, hold it to walk, hold B
 * (X / Shift) to run. Walk into a door to go in; face a sign and press A
 * (Z / Enter / Space) to read it.
 */

(function () {
  const TILE = 16;
  const VIEW_W = 240;
  const VIEW_H = 160;
  const WALK_MS = 200;
  /** Going through a door or an exit: the fade to black, and back in. */
  const FADE_OUT_MS = 320;
  const FADE_IN_MS = 520;
  /** A ledge hop: two tiles in one smooth arc, this long and this high (px). */
  const HOP_MS = 520;
  const HOP_HEIGHT = 12;
  const RUN_MS = 110;
  // A tap shorter than this only turns the player.
  const TURN_MS = 90;
  // Steps shown ahead of the server's answers, at most.
  const MAX_AHEAD = 3;
  // How long a trainer takes per tile walking up, and the "!" before it.
  const TRAINER_STEP_MS = 220;
  const ALERT_MS = 700;

  const BASE = '/sprites/tuxemon';

  /** The tilesets, by the letter used in tile names ("o111"). */
  const SHEETS = {
    o: { src: `${BASE}/tilesets/core_outdoor.png`, columns: 37 },
    b: { src: `${BASE}/tilesets/core_buildings.png`, columns: 47 },
    s: { src: `${BASE}/tilesets/core_set_pieces.png`, columns: 31 },
    // Paving, fountains, stalls and statues for the MAIN CITY.
    c: { src: `${BASE}/tilesets/core_city_and_country.png`, columns: 40 },
    // Indoors (Tuxemon's rooms, Web/maps/tmx.js).
    f: { src: `${BASE}/tilesets/core_indoor_floors.png`, columns: 46 },
    w: { src: `${BASE}/tilesets/core_indoor_walls.png`, columns: 46 },
    t: { src: `${BASE}/tilesets/core_indoor_stairs.png`, columns: 45 },
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
    // The MAIN CITY's waving banners (from the city sheet's .tsx).
    c1163: { frames: [1163, 1165, 1167, 1169, 1171], ms: 150 },
    c1164: { frames: [1164, 1166, 1168, 1170, 1172], ms: 150 },
    c1203: { frames: [1203, 1205, 1207, 1209, 1211], ms: 150 },
    c1204: { frames: [1204, 1206, 1208, 1210, 1212], ms: 150 },
  };
  // Its fountains: three 3 x 3 frames side by side on the sheet.
  for (const id of [382, 383, 384, 422, 423, 424, 462, 463, 464]) ANIMS[`c${id}`] = { frames: [id, id + 3, id + 6], ms: 180 };

  // -------------------------------------------------------------------------
  // Pictures
  //
  // characters/*.png: 16x32 frames, 3 across (step, stand, step), rows facing
  // down, left, right, up. animations/grass.png and splash_small.png: 16x16
  // frames side by side. bubbles/exclamation.png: a 16x16 "!".
  // -------------------------------------------------------------------------

  const CHAR_W = 16;
  const CHAR_H = 32;
  const ROW = { down: 0, left: 1, right: 2, up: 3 };
  /** How long each effect frame shows, and how many times the effect plays. */
  const FX = { grass: { ms: 150, loops: 2 }, splash: { ms: 90, loops: 1 }, dust: { ms: 70, loops: 1 } };

  const DIRS = {
    up: [0, -1],
    down: [0, 1],
    left: [-1, 0],
    right: [1, 0],
  };
  const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

  const images = new Map();
  /** An image by URL, loaded once; null until it has arrived. */
  function image(src) {
    let entry = images.get(src);
    if (!entry) {
      entry = { img: null };
      images.set(src, entry);
      const img = new Image();
      img.onload = () => { entry.img = img; };
      img.onerror = () => console.error(`could not load ${src}`);
      img.src = src;
    }
    return entry.img;
  }
  const character = (sprite) => image(`${BASE}/characters/${sprite}.png`);

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`could not load ${src}`));
      img.src = src;
    });
  }

  let sheetsPromise = null;
  function loadSheets() {
    if (!sheetsPromise) {
      sheetsPromise = (async () => {
        const out = {};
        await Promise.all(Object.entries(SHEETS).map(async ([key, sheet]) => {
          out[key] = { img: await loadImage(sheet.src), columns: sheet.columns };
        }));
        return out;
      })();
    }
    return sheetsPromise;
  }

  /** Draw a tile by name; animated tiles show the frame for `now`. */
  function drawTile(g, sheets, name, x, y, now = 0) {
    if (!name) return;
    const sheet = sheets[name[0]];
    if (!sheet) return;
    let id = Number(name.slice(1));
    const anim = ANIMS[name];
    if (anim) id = anim.frames[Math.floor(now / anim.ms) % anim.frames.length];
    g.drawImage(sheet.img, (id % sheet.columns) * TILE, Math.floor(id / sheet.columns) * TILE, TILE, TILE, x, y, TILE, TILE);
  }

  /** One layer as an image, leaving out animated tiles (drawn each frame). */
  function drawLayer(sheets, map, layer, withAnimated = false) {
    const canvas = document.createElement('canvas');
    canvas.width = map.width * TILE;
    canvas.height = map.height * TILE;
    const g = canvas.getContext('2d');
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const name = layer[y][x];
        if (name && (withAnimated || !ANIMS[name])) drawTile(g, sheets, name, x * TILE, y * TILE);
      }
    }
    return canvas;
  }

  /** Everything about a map that is drawn, prepared once per map. */
  function prepare(sheets, map) {
    const animated = [];
    for (const [index, layer] of [map.layers.ground, map.layers.objects].entries()) {
      for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) if (ANIMS[layer[y][x]]) animated.push([index, x, y, layer[y][x]]);
    }
    // Paint on the road (a gate's number), part of the ground.
    const ground = drawLayer(sheets, map, map.layers.ground);
    if ((map.marks || []).length) {
      const gg = ground.getContext('2d');
      gg.textAlign = 'center';
      gg.textBaseline = 'middle';
      gg.font = '24px "Press Start 2P", monospace';
      for (const m of map.marks) {
        const cx = (m.x + 1) * TILE;
        const cy = (m.y + 1) * TILE + 1;
        gg.lineWidth = 3;
        gg.strokeStyle = 'rgba(60,64,80,0.55)';
        gg.strokeText(m.text, cx, cy);
        gg.fillStyle = 'rgba(250,250,240,0.85)';
        gg.fillText(m.text, cx, cy);
      }
    }
    return {
      ground,
      objects: drawLayer(sheets, map, map.layers.objects),
      overlays: drawLayer(sheets, map, map.layers.overlays),
      overlays2: map.layers.overlays2 ? drawLayer(sheets, map, map.layers.overlays2) : null,
      above: drawLayer(sheets, map, map.layers.above),
      animated,
    };
  }

  // -------------------------------------------------------------------------
  // The game loop
  // -------------------------------------------------------------------------

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} hooks
   * @param {(station: string) => void} hooks.enter      walked into a door
   * @param {(lines: string[], done?: Function) => void} hooks.read   show text
   * @param {() => boolean} hooks.paused                 a menu is open
   * @param {(kind: 'wild'|'trainer') => void} hooks.encounter  a battle is starting
   * @param {(path: string, body: object) => Promise<object>} hooks.post
   */
  function create(canvas, hooks) {
    const g = canvas.getContext('2d');
    canvas.width = VIEW_W;
    canvas.height = VIEW_H;
    g.imageSmoothingEnabled = false;

    let sheets = null;
    let map = null;
    let drawn = null;
    /** The owner's dev mode, from the server ({exploring, noclip, overlay, reveal}), or null. */
    let devState = null;
    /** Walking speed, x1 normally (dev.speed). */
    let speed = 1;

    const art = {};
    for (const [key, src] of Object.entries({
      shadow: `${BASE}/characters/drop_shadow.png`,
      grass: `${BASE}/animations/grass.png`,
      splash: `${BASE}/animations/splash_small.png`,
      alert: `${BASE}/bubbles/exclamation.png`,
      ball: '/icon.png',
      surfboard: `${BASE}/animations/surfboard.png`,
    })) {
      loadImage(src).then((img) => { art[key] = img; }, (err) => console.error(err));
    }

    const player = {
      sprite: 'adventurer',
      x: 0,
      y: 0,
      facing: 'down',
      // Mid-step: where from, when it started, how long it takes.
      from: null,
      started: 0,
      duration: WALK_MS,
      stepCount: 0,
    };

    /** Effects playing out on tiles: { kind, x, y, started }. */
    const effects = [];
    /** A trainer walking up: { trainer, alertAt, walk, startedAt }. */
    let approach = null;

    /** Directions held, most recent last. */
    const held = [];
    let heldSince = 0;
    let running = false;
    let fade = 0;
    /** No walking until a battle the server started is over. */
    let frozen = false;

    // Steps waiting to be sent, and in flight. Sent one at a time, in order.
    const queue = [];
    let sending = false;
    let generation = 0;

    async function load() {
      const res = await fetch('/api/world');
      if (res.status === 401) return location.reload();
      const data = await res.json();
      sheets = await loadSheets();
      devState = data.dev || null;
      player.sprite = data.player.outfit || 'adventurer';
      setMap(data.map);
      place(data.player);
      frozen = Boolean(data.busy);
      if (hooks.loaded) hooks.loaded();
    }

    /** The place-name sign that drops down on arriving somewhere: { text, started }. */
    let banner = null;
    let bannerFor = null;

    function setMap(next) {
      // Somewhere new outdoors (not a building, and not back out of one).
      if (!/^(in:|room:|tower-arena)/.test(next.id) && next.id !== bannerFor) {
        banner = { text: String(next.name || '').toUpperCase(), started: performance.now() };
        bannerFor = next.id;
      }
      map = next;
      drawn = prepare(sheets, map);
      effects.length = 0;
      approach = null;
      // Each person remembers where they belong, to wander round it.
      for (const n of map.npcs || []) {
        Object.assign(n, { homeX: n.x, homeY: n.y, from: null, started: 0, next: performance.now() + 800 + Math.random() * 2500 });
      }
      for (const t of map.trainers) character(t.sprite);
      for (const n of map.npcs || []) character(n.sprite);
    }

    function place(pos) {
      player.x = pos.x;
      player.y = pos.y;
      player.facing = pos.facing;
      player.from = null;
      player.stepCount = 0;
    }

    const inside = (x, y) => map && x >= 0 && y >= 0 && x < map.width && y < map.height;
    const doorAt = (x, y) => map.doors.find((d) => d.x === x && d.y === y) || null;
    const signAt = (x, y) => map.signs.find((s) => s.x === x && s.y === y) || null;
    const trainerAt = (x, y) => map.trainers.find((t) => t.x === x && t.y === y) || null;
    const npcAt = (x, y) => (map.npcs || []).find((n) => n.x === x && n.y === y) || null;
    const NPC_STEP_MS = 300;

    /**
     * People amble about like in the games: now and then they turn, or take
     * a step, never more than `wander` tiles from home, never into you, a
     * wall, a door or an exit. They stop while you talk to them.
     */
    function wander(now) {
      if (!map) return;
      for (const n of map.npcs || []) {
        if (n.from && now - n.started >= (n.stepMs || NPC_STEP_MS)) n.from = null;
        if (scripted || n.from || n.talking || now < n.next || hooks.paused()) continue;
        n.next = now + 1200 + Math.random() * 2600;
        if (!n.wander) continue;
        const dir = Object.keys(DIRS)[Math.floor(Math.random() * 4)];
        n.facing = dir;
        if (Math.random() < 0.45) continue; // just a look round
        const nx = n.x + DIRS[dir][0];
        const ny = n.y + DIRS[dir][1];
        if (Math.abs(nx - n.homeX) > n.wander || Math.abs(ny - n.homeY) > n.wander) continue;
        if (!inside(nx, ny) || map.solid[ny][nx] || doorAt(nx, ny) || warpAt(nx, ny) || npcAt(nx, ny) || trainerAt(nx, ny)) continue;
        // Never on a doorstep, where they'd be in your way.
        if (doorAt(nx, ny - 1)) continue;
        // Indoors, never in front of the way out (or anywhere in line with it).
        if (/^in:/.test(map.id) && map.warps.some((w) => w.x === nx && ny < w.y)) continue;
        if ((nx === player.x && ny === player.y) || (player.from && nx === player.from.x && ny === player.from.y)) continue;
        n.from = { x: n.x, y: n.y };
        n.x = nx;
        n.y = ny;
        n.started = now;
      }
    }

    function npcPosition(n, now) {
      if (!n.from) return { x: n.x * TILE, y: n.y * TILE, t: 0 };
      const t = Math.min(1, (now - n.started) / (n.stepMs || NPC_STEP_MS));
      return { x: (n.from.x + (n.x - n.from.x) * t) * TILE, y: (n.from.y + (n.y - n.from.y) * t) * TILE, t };
    }
    const obstacleAt = (x, y) => (map.obstacles || []).find((o) => o.x === x && o.y === y) || null;
    const itemAt = (x, y) => (map.items || []).find((i) => i.x === x && i.y === y && !i.found) || null;
    /** Solid, unless it's an obstacle you can get past or a Poke Ball already taken. */
    function blocked(x, y) {
      if (trainerAt(x, y) || npcAt(x, y)) return true;
      if ((map.npcs || []).some((n) => n.from && n.from.x === x && n.from.y === y)) return true;
      if (!map.solid[y][x]) return false;
      const o = obstacleAt(x, y);
      if (o) return !o.open;
      const i = (map.items || []).find((it) => it.x === x && it.y === y);
      if (i) return !i.found;
      return true;
    }
    const terrainAt = (x, y) => (inside(x, y) ? map.terrain[y][x] : null);
    const warpAt = (x, y) => map.warps.some((w) => w.x === x && w.y === y);

    /** Slide back to where the server says, instead of jumping there. */
    function glideTo(pos) {
      const now = performance.now();
      const far = Math.abs(pos.x - player.x) + Math.abs(pos.y - player.y);
      player.from = { x: player.x, y: player.y };
      player.x = pos.x;
      player.y = pos.y;
      player.facing = pos.facing;
      player.started = now;
      player.duration = Math.min(400, 140 * far);
      player.hop = false;
    }

    /** Throw away steps the server hasn't seen and go where it says. */
    function snap(pos) {
      generation += 1;
      queue.length = 0;
      if (pos.map !== map.id) {
        reload();
        return;
      }
      // A step or two out: glide back. Further: jump.
      if (Math.abs(pos.x - player.x) + Math.abs(pos.y - player.y) <= 2) glideTo(pos);
      else place(pos);
    }

    async function reload() {
      generation += 1;
      queue.length = 0;
      fade = performance.now();
      await load();
    }

    async function pump() {
      if (sending) return;
      sending = true;
      try {
        while (queue.length) {
          const next = queue[0];
          const gen = generation;
          let answer;
          try {
            answer = await hooks.post('/api/step', { dir: next.dir });
          } catch {
            answer = null;
          }
          if (gen !== generation) continue;
          queue.shift();
          if (!answer || !answer.player) {
            reload();
            break;
          }
          handle(answer, next);
        }
      } finally {
        sending = false;
      }
    }

    function handle(answer, sent) {
      const events = answer.events || [];
      if (events.some((e) => e.type === 'map')) {
        // A scene on arrival (the taxi driver) plays once the new map is up.
        const scene = events.find((e) => e.type === 'scene');
        // Through a door or an exit: fade to black, then into the new place.
        frozen = true;
        fadeOut = performance.now();
        fadeOutMs = FADE_OUT_MS;
        new Promise((r) => setTimeout(r, FADE_OUT_MS)).then(() => reload()).then(() => {
          if (scene) {
            if (hooks.scene) hooks.scene(scene);
            else hooks.read(scene.lines);
            if (hooks.unlocked) hooks.unlocked();
          }
        });
        return;
      }
      const at = answer.player;
      if (!answer.ok || at.x !== sent.x || at.y !== sent.y) {
        snap(at);
      }
      for (const e of events) {
        if (e.type === 'note') hooks.read([e.text]);
        if (e.type === 'wild') {
          snap(at);
          startEncounter('wild');
        }
        if (e.type === 'trainer') startTrainer(e, at);
      }
    }

    /** A battle: the screen's transition into it is the app's (transition.js). */
    function startEncounter(kind, info = {}) {
      frozen = true;
      held.length = 0;
      generation += 1;
      queue.length = 0;
      hooks.encounter(kind, info);
    }

    /** A trainer spotted you: "!", they walk up, they speak, the battle starts. */
    function startTrainer(e, at) {
      frozen = true;
      held.length = 0;
      generation += 1;
      queue.length = 0;
      // Already there (the step you were taking): just turn, no jump. If
      // the browser had got a step or two ahead, glide back rather than snap.
      if (player.x === at.x && player.y === at.y) player.facing = at.facing;
      else glideTo(at);
      const trainer = map.trainers.find((t) => t.id === e.id);
      if (!trainer) return startEncounter('trainer');
      approach = { trainer, alertAt: performance.now(), walk: e.walk, startedAt: 0, lines: e.lines || [] };
    }

    function tryMove(now) {
      const dir = held[held.length - 1];
      if (!dir || !map) return;

      // A tap turns; holding walks.
      if (player.facing !== dir) {
        player.facing = dir;
        heldSince = now;
        return;
      }
      if (now - heldSince < TURN_MS && player.stepCount === 0) return;
      if (queue.length >= MAX_AHEAD) return;

      const [dx, dy] = DIRS[dir];
      const nx = player.x + dx;
      let ny = player.y + dy;
      // Ledges: hop down over them (two tiles in one go); never up or along.
      let hop = false;
      if (inside(nx, ny) && map.terrain[ny][nx] === 'ledge' && !(devState && devState.noclip)) {
        if (dir !== 'down') return;
        ny += 1;
        hop = true;
      }

      const noclip = Boolean(devState && devState.noclip);
      const door = doorAt(nx, ny);
      if (door && dir === 'up' && !noclip) {
        held.length = 0;
        // The server hears about it too (a POKéMON CENTER becomes where you
        // wake after a white-out). Exploring, it explains doors are shut.
        queue.push({ dir, x: player.x, y: player.y });
        pump();
        fade = now;
        // Most doors lead into a room (the server's answer moves you there);
        // the Drop Station is a counter.
        if (door.station === 'drop' && !(devState && devState.exploring)) hooks.enter('drop', door);
        return;
      }

      if (!inside(nx, ny)) return;
      if (!noclip && blocked(nx, ny)) return;

      player.from = { x: player.x, y: player.y };
      player.x = nx;
      player.y = ny;
      player.started = now;
      player.duration = hop ? HOP_MS / speed : (running ? RUN_MS : WALK_MS) / speed;
      player.hop = hop;
      player.stepCount += 1;

      queue.push({ dir, x: nx, y: ny });
      pump();

      // Grass rustles as you step in; water splashes behind you.
      const ground = terrainAt(nx, ny);
      if (ground === 'tall' && !map.surf) effects.push({ kind: 'grass', x: nx, y: ny, started: now });
      if (map.surf) effects.push({ kind: 'splash', x: player.from.x, y: player.from.y, started: now });
      if (ground === 'shallow') effects.push({ kind: 'splash', x: nx, y: ny, started: now + (running ? 0 : 60) });

      // Walking off the map: stop and wait for the next one.
      if (warpAt(nx, ny)) held.length = 0;
    }

    function interact() {
      if (!map || frozen) return;
      const [dx, dy] = DIRS[player.facing];
      const x = player.x + dx;
      const y = player.y + dy;
      const sign = signAt(x, y);
      if (sign) hooks.read(sign.lines);
      // Someone in front of you, or behind the counter in front of you.
      let npc = npcAt(x, y);
      if (!npc && inside(x, y) && map.solid[y][x]) npc = npcAt(x + dx, y + dy);
      if (npc && !npc.from) {
        npc.facing = OPPOSITE[player.facing];
        npc.talking = true;
        const done = () => {
          npc.talking = false;
          npc.next = performance.now() + 1500;
        };
        if (hooks.talk) hooks.talk(npc, done);
        else hooks.read(npc.lines, done);
      }
      const o = obstacleAt(x, y);
      if (o && !o.open) hooks.read([o.says, `(${o.hm.toUpperCase()} opens after ${o.after} milestones.)`]);
      if (itemAt(x, y)) {
        hooks.post('/api/pickup', {}).then((r) => {
          if (r && r.text) hooks.read([r.text]);
          if (r && r.ok) reload();
        });
      }
      // A trainer: beaten ones say their piece; others battle you.
      if (trainerAt(x, y) && !approach) {
        const t = trainerAt(x, y);
        hooks.post('/api/challenge', {}).then((r) => {
          if (!r || !r.ok) return;
          if (r.lines) {
            t.facing = OPPOSITE[player.facing];
            hooks.read(r.lines);
          } else if (r.event) {
            t.facing = OPPOSITE[player.facing];
            startTrainer(r.event, { map: map.id, x: player.x, y: player.y, facing: player.facing });
          }
        });
        return;
      }
      const door = doorAt(x, y);
      if (door && player.facing === 'up') {
        queue.push({ dir: 'up', x: player.x, y: player.y });
        pump();
        if (door.station === 'drop') hooks.enter('drop', door);
      }
    }

    /** Where the player is drawn, in pixels, including mid-step. */
    function position(now) {
      if (!player.from) return { x: player.x * TILE, y: player.y * TILE, t: 0, lift: 0 };
      const t = Math.min(1, (now - player.started) / player.duration);
      // Hopping a ledge: the sprite goes up in an arc while its shadow (and
      // the camera) slide along the ground, as in the games.
      const lift = player.hop ? Math.sin(t * Math.PI) * HOP_HEIGHT : 0;
      return {
        x: (player.from.x + (player.x - player.from.x) * t) * TILE,
        y: (player.from.y + (player.y - player.from.y) * t) * TILE,
        t,
        lift,
      };
    }

    function drawEffects(now, camX, camY, front) {
      for (let i = effects.length - 1; i >= 0; i--) {
        const fx = effects[i];
        if (fx.kind === 'dust') {
          const age = (now - fx.started) / 280;
          if (age >= 1) {
            effects.splice(i, 1);
            continue;
          }
          if (front) continue;
          // Two little clouds puffing out from the feet and fading.
          const bx = fx.x * TILE - camX + TILE / 2;
          const by = fx.y * TILE - camY + TILE - 3;
          g.fillStyle = `rgba(248,248,240,${0.9 * (1 - age)})`;
          for (const side of [-1, 1]) {
            const r = 2 + age * 3;
            g.beginPath();
            g.arc(bx + side * (4 + age * 7), by - age * 2, r, 0, Math.PI * 2);
            g.fill();
          }
          continue;
        }
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

    /** A character standing (or mid-step) with its feet on tile (px, py). */
    function drawCharacter(img, px, py, facing, column, camX, camY, cut = 0, lift = 0) {
      const sx = Math.round(px - camX);
      const top = Math.round(py - camY) + TILE - CHAR_H;
      if (art.shadow && !cut) g.drawImage(art.shadow, sx, top);
      if (img) g.drawImage(img, column * CHAR_W, ROW[facing] * CHAR_H, CHAR_W, CHAR_H - cut, sx, top - Math.round(lift), CHAR_W, CHAR_H - cut);
    }

    /** The dev overlay: one-battle grass in red, trainers' sight in yellow. */
    function drawReveal(camX, camY) {
      const reveal = devState && devState.overlay && devState.reveal;
      if (!reveal) return;
      g.fillStyle = 'rgba(230,40,40,0.35)';
      for (const [x, y] of reveal.patches) g.fillRect(x * TILE - camX, y * TILE - camY, TILE, TILE);
      g.fillStyle = 'rgba(250,210,40,0.4)';
      for (const [x, y] of reveal.sight) g.fillRect(x * TILE - camX, y * TILE - camY, TILE, TILE);
    }

    /** Where each trainer is drawn: in place, or partway through walking up. */
    function trainerPosition(t, now) {
      if (!approach || approach.trainer !== t || !approach.startedAt) return { x: t.x * TILE, y: t.y * TILE, moving: false };
      const [dx, dy] = DIRS[t.facing];
      const tiles = Math.min(approach.walk, (now - approach.startedAt) / TRAINER_STEP_MS);
      return { x: (t.x + dx * tiles) * TILE, y: (t.y + dy * tiles) * TILE, moving: tiles < approach.walk, tiles };
    }

    function stepApproach(now) {
      if (!approach) return;
      if (!approach.startedAt && now - approach.alertAt >= ALERT_MS) approach.startedAt = now;
      if (approach.startedAt && now - approach.startedAt >= approach.walk * TRAINER_STEP_MS && !approach.talked) {
        approach.talked = true;
        const done = () => {
          const t = approach.trainer;
          // They stay where they walked to (the server remembers it too).
          const [dx, dy] = DIRS[t.facing];
          t.x += dx * approach.walk;
          t.y += dy * approach.walk;
          approach = null;
          startEncounter('trainer', { sprite: t.sprite, name: t.name });
        };
        if (approach.lines.length) hooks.read(approach.lines, done);
        else done();
      }
    }

    /** Cutscene extras: a "!" over someone, and Pokemon flying about. */
    let alerted = null;
    let playerHidden = false;
    const flyers = [];

    /**
     * A Pokemon flying from one tile to another (fractions and off-screen
     * are fine). Resolves when it arrives; `stay` keeps it there until
     * clearFlyers().
     */
    function fly({ src, from, to, ms = 1200, arc = 24, size = 40, stay = false }) {
      return new Promise((resolve) => {
        const img = new Image();
        img.src = src;
        flyers.push({ img, from, to, ms, arc, size, stay, started: performance.now(), done: resolve });
      });
    }

    /** Someone walking up to you (the milestone leader); then `done`. */
    let leaderWalk = null;
    function walkUp(npcId, lines, done) {
      const n = (map.npcs || []).find((x) => x.id === npcId);
      if (!n) return done();
      n.wander = 0;
      n.talking = true;
      leaderWalk = { n, lines, done, next: performance.now() + 600 };
    }
    function stepLeader(now) {
      if (!leaderWalk || now < leaderWalk.next) return;
      const { n } = leaderWalk;
      if (n.from && now - n.started < NPC_STEP_MS) return;
      n.from = null;
      const dx = Math.sign(player.x - n.x);
      const dy = Math.sign(player.y - n.y);
      const far = Math.abs(player.x - n.x) + Math.abs(player.y - n.y);
      if (far <= 1) {
        n.facing = dy < 0 ? 'up' : dy > 0 ? 'down' : dx < 0 ? 'left' : 'right';
        player.facing = OPPOSITE[n.facing];
        const { lines, done } = leaderWalk;
        leaderWalk = null;
        hooks.read(lines, done);
        return;
      }
      const dir = dy ? (dy < 0 ? 'up' : 'down') : dx < 0 ? 'left' : 'right';
      n.facing = dir;
      n.from = { x: n.x, y: n.y };
      n.x += DIRS[dir][0];
      n.y += DIRS[dir][1];
      n.started = now;
      leaderWalk.next = now + NPC_STEP_MS;
    }

    // -----------------------------------------------------------------------
    // Cutscenes: a map shown without the server, everyone moved by script.
    // You can't walk; you follow.
    // -----------------------------------------------------------------------

    let scripted = false;
    const SCENE_STEP_MS = 270;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const actor = (id) => (id === 'player' ? player : (map.npcs || []).find((n) => n.id === id));

    /** One step for someone (or you), animated; resolves when it's done. */
    function stepActor(id, dir, ms = SCENE_STEP_MS) {
      const a = actor(id);
      if (!a) return Promise.resolve();
      const now = performance.now();
      a.facing = dir;
      a.from = { x: a.x, y: a.y };
      a.x += DIRS[dir][0];
      a.y += DIRS[dir][1];
      a.started = now;
      if (id === 'player') {
        a.duration = ms;
        a.hop = false;
        a.stepCount += 1;
      } else a.stepMs = ms;
      return wait(ms);
    }

    /** The shortest way from one tile to another round walls and people. */
    function findPath(from, to, { ignore = [] } = {}) {
      const key = (x, y) => `${x},${y}`;
      const people = new Set([...(map.npcs || []).filter((n) => !ignore.includes(n.id)).map((n) => key(n.x, n.y)), ...map.trainers.map((t) => key(t.x, t.y))]);
      if (!ignore.includes('player')) people.add(key(player.x, player.y));
      const prev = new Map([[key(from.x, from.y), null]]);
      const q = [[from.x, from.y]];
      while (q.length) {
        const [x, y] = q.shift();
        if (x === to.x && y === to.y) {
          const dirs = [];
          let k = key(x, y);
          while (prev.get(k)) {
            const [d, pk] = prev.get(k);
            dirs.unshift(d);
            k = pk;
          }
          return dirs;
        }
        for (const [d, [dx, dy]] of Object.entries(DIRS)) {
          const nx = x + dx;
          const ny = y + dy;
          const k = key(nx, ny);
          if (!inside(nx, ny) || prev.has(k)) continue;
          const goal = nx === to.x && ny === to.y;
          if (!goal && (map.solid[ny][nx] || people.has(k) || terrainAt(nx, ny) === 'ledge')) continue;
          prev.set(k, [d, key(x, y)]);
          q.push([nx, ny]);
        }
      }
      return null;
    }

    const scene = {
      /** Show a map (from /api/scene) with you on it; walking is locked. */
      stage(next, pos, cast = []) {
        scripted = true;
        frozen = true;
        held.length = 0;
        generation += 1;
        queue.length = 0;
        setMap(next);
        place(pos);
        // Nobody wanders off mid-scene; the cast goes where the script says.
        for (const n of map.npcs) n.wander = 0;
        for (const c of cast) scene.add(c);
        fade = performance.now();
      },
      /** How you look in the scene (the outfit just chosen). */
      dress(sprite) {
        player.sprite = sprite;
        character(sprite);
      },
      add(n) {
        map.npcs = (map.npcs || []).filter((x) => x.id !== n.id);
        map.npcs.push({ wander: 0, facing: 'down', lines: [], ...n, homeX: n.x, homeY: n.y, from: null, started: 0, next: Infinity });
        character(n.sprite);
      },
      remove(id) {
        map.npcs = (map.npcs || []).filter((x) => x.id !== id);
      },
      at(id) {
        const a = actor(id);
        return a ? { x: a.x, y: a.y, facing: a.facing } : null;
      },
      /** Is this tile free to stand on? */
      free(x, y) {
        return inside(x, y) && !map.solid[y][x] && !npcAt(x, y) && !trainerAt(x, y) && !(player.x === x && player.y === y);
      },
      face(id, dir) {
        const a = actor(id);
        if (a) a.facing = dir;
      },
      /** Turn to face someone. */
      faceTo(id, otherId) {
        const a = actor(id);
        const b = actor(otherId);
        if (!a || !b) return;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        a.facing = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'up' : 'down';
      },
      step: (id, dir, ms) => stepActor(id, dir, ms),
      /** Walk someone to a tile, round everything in the way. */
      async walkTo(id, to, ms = SCENE_STEP_MS) {
        const a = actor(id);
        if (!a) return false;
        const path = findPath(a, to, { ignore: [id] });
        if (!path) return false;
        for (const d of path) await stepActor(id, d, ms);
        return true;
      },
      /**
       * Clear the way for someone heading to a tile: anyone standing on
       * their path steps aside (you to the right if you can, others up), all
       * at once, so nobody has to walk through anyone.
       */
      async makeWay(id, to) {
        const a = actor(id);
        if (!a) return;
        const everyone = ['player', ...(map.npcs || []).map((n) => n.id)];
        const route = findPath(a, to, { ignore: everyone }) || [];
        const onPath = new Set();
        let x = a.x;
        let y = a.y;
        for (const d of route) {
          x += DIRS[d][0];
          y += DIRS[d][1];
          onPath.add(`${x},${y}`);
        }
        for (const other of everyone.filter((o) => o !== id)) {
          const b = actor(other);
          if (!b || !onPath.has(`${b.x},${b.y}`)) continue;
          // The nearest spot off the path they can walk to (you prefer to
          // step right, others up), walking through the path if they must.
          const pref = other === 'player' ? ['right', 'up', 'left', 'down'] : ['up', 'right', 'left', 'down'];
          const key = (px, py) => `${px},${py}`;
          const seen = new Set([key(b.x, b.y)]);
          const q = [[b.x, b.y]];
          let dest = null;
          while (q.length && !dest) {
            const [cx, cy] = q.shift();
            for (const d of pref) {
              const nx = cx + DIRS[d][0];
              const ny = cy + DIRS[d][1];
              const k = key(nx, ny);
              if (seen.has(k) || !inside(nx, ny) || map.solid[ny][nx] || terrainAt(nx, ny) === 'ledge') continue;
              seen.add(k);
              const occupied = (npcAt(nx, ny) && npcAt(nx, ny) !== b) || trainerAt(nx, ny) || (other !== 'player' && player.x === nx && player.y === ny);
              if (occupied) continue;
              if (!onPath.has(k) && !(nx === to.x && ny === to.y)) {
                dest = { x: nx, y: ny };
                break;
              }
              q.push([nx, ny]);
            }
          }
          if (dest) await scene.walkTo(other, dest);
          scene.faceTo(other, id);
        }
      },
      /** A free tile next to someone, the nearest to `from`. */
      beside(id, from) {
        const a = actor(id);
        if (!a) return null;
        const spots = Object.values(DIRS).map(([dx, dy]) => ({ x: a.x + dx, y: a.y + dy })).filter((s) => scene.free(s.x, s.y));
        spots.sort((p, q) => Math.abs(p.x - from.x) + Math.abs(p.y - from.y) - (Math.abs(q.x - from.x) + Math.abs(q.y - from.y)));
        return spots[0] || null;
      },
      /**
       * Someone leads and you follow one step behind, as in the games: each
       * step, they move on and you step into where they were.
       */
      async lead(id, to, ms = SCENE_STEP_MS) {
        const a = actor(id);
        if (!a) return;
        const path = findPath(a, to, { ignore: [id] }) || [];
        for (const d of path) {
          const was = { x: a.x, y: a.y };
          const toward = was.x > player.x ? 'right' : was.x < player.x ? 'left' : was.y > player.y ? 'down' : 'up';
          const near = Math.abs(was.x - player.x) + Math.abs(was.y - player.y) === 1;
          await Promise.all([stepActor(id, d, ms), near ? stepActor('player', toward, ms) : wait(ms)]);
        }
      },
      /** Fade to black (held until the next stage). */
      async fadeOut(ms = 350) {
        fadeOut = performance.now();
        fadeOutMs = ms;
        await wait(ms);
      },
      /** Back to the real game: the server's map and position. */
      async end() {
        scripted = false;
        await reload();
        fadeOut = 0;
        frozen = false;
      },
      get active() {
        return scripted;
      },
    };
    let fadeOut = 0;
    let fadeOutMs = 350;

    /** The place-name sign: slides down, waits, slides back up. */
    const BANNER_MS = 2600;
    function drawBanner(now) {
      if (!banner) return;
      const t = now - banner.started;
      if (t > BANNER_MS) {
        banner = null;
        return;
      }
      const ease = (k) => 1 - (1 - k) * (1 - k);
      const shown = t < 320 ? ease(t / 320) : t > BANNER_MS - 320 ? ease((BANNER_MS - t) / 320) : 1;
      g.font = '8px "Press Start 2P", monospace';
      const w = Math.max(80, Math.ceil(g.measureText(banner.text).width) + 20);
      const h = 22;
      const x = 6;
      const y = Math.round(-h + shown * (h + 6));
      // A wooden sign with a cream face, like the games' location signs.
      g.fillStyle = '#6a4a2a';
      g.fillRect(x, y, w, h);
      g.fillStyle = '#a8784a';
      g.fillRect(x + 1, y + 1, w - 2, h - 2);
      g.fillStyle = '#f8f0d8';
      g.fillRect(x + 3, y + 3, w - 6, h - 6);
      g.fillStyle = '#383028';
      g.textBaseline = 'middle';
      g.fillText(banner.text, x + 10, y + h / 2 + 1);
    }

    function frame(now) {
      if (player.from && now - player.started >= player.duration) {
        // Landing from a ledge: a puff of dust either side.
        if (player.hop) effects.push({ kind: 'dust', x: player.x, y: player.y, started: now });
        player.hop = false;
        player.from = null;
        if (!held.length) player.stepCount = 0;
      }
      if (!player.from && !frozen && !approach && !leaderWalk && !hooks.paused()) tryMove(now);
      stepApproach(now);
      stepLeader(now);
      wander(now);

      g.fillStyle = '#000';
      g.fillRect(0, 0, VIEW_W, VIEW_H);

      if (map && drawn) {
        const pos = position(now);

        // Camera, centred on the player, kept inside the map.
        const fit = (size, view, at) => (size <= view ? -Math.round((view - size) / 2) : Math.max(0, Math.min(size - view, Math.round(at + TILE / 2 - view / 2))));
        const camX = fit(map.width * TILE, VIEW_W, pos.x);
        const camY = fit(map.height * TILE, VIEW_H, pos.y);
        const view = (img) => g.drawImage(img, -camX, -camY);

        view(drawn.ground);
        for (const [index, x, y, name] of drawn.animated) if (index === 0) drawTile(g, sheets, name, x * TILE - camX, y * TILE - camY, now);
        view(drawn.objects);
        for (const [index, x, y, name] of drawn.animated) if (index === 1) drawTile(g, sheets, name, x * TILE - camX, y * TILE - camY, now);
        view(drawn.overlays);
        if (drawn.overlays2) view(drawn.overlays2);
        // Obstacles still in the way, and Poke Balls not yet picked up.
        for (const o of map.obstacles || []) {
          if (o.open) continue;
          drawTile(g, sheets, o.tile, o.x * TILE - camX, o.y * TILE - camY, now);
          if (o.top) drawTile(g, sheets, o.top, o.x * TILE - camX, (o.y - 1) * TILE - camY, now);
        }
        if (art.ball) {
          for (const i of map.items || []) {
            if (!i.found) g.drawImage(art.ball, 0, 0, art.ball.width, art.ball.height, i.x * TILE - camX + 1, i.y * TILE - camY + 1, TILE - 2, TILE - 2);
          }
        }
        drawReveal(camX, camY);
        drawEffects(now, camX, camY, false);

        // Everyone, back to front, so nearer characters overlap further ones.
        const people = map.trainers.map((t) => {
          const at = trainerPosition(t, now);
          const column = at.moving ? (Math.floor(at.tiles * 2) % 2 ? 0 : 2) : 1;
          return { y: at.y, draw: () => drawCharacter(character(t.sprite), at.x, at.y, t.facing, column, camX, camY) };
        });
        for (const n of map.npcs || []) {
          const at = npcPosition(n, now);
          const column = n.from && at.t > 0.2 && at.t < 0.8 ? ((n.x + n.y) % 2 ? 0 : 2) : 1;
          people.push({ y: at.y, draw: () => drawCharacter(character(n.sprite), at.x, at.y, n.facing, column, camX, camY) });
        }
        const where = terrainAt(player.x, player.y);
        const wading = where === 'shallow';
        people.push({
          y: pos.y,
          draw: () => {
            if (playerHidden) return;
            const walking = player.from && pos.t > 0.15 && pos.t < 0.85;
            const column = walking ? (player.stepCount % 2 ? 0 : 2) : 1;
            if (map.surf) {
              const bob = Math.round(Math.sin(now / 260));
              const sx = Math.round(pos.x - camX);
              const sy = Math.round(pos.y - camY);
              if (art.surfboard) g.drawImage(art.surfboard, sx - 4, sy - 2 + bob);
              const img = character(player.sprite);
              if (img) g.drawImage(img, CHAR_W, ROW[player.facing] * CHAR_H, CHAR_W, 22, sx, sy + TILE - CHAR_H + 4 + bob, CHAR_W, 22);
              return;
            }
            // Ankle-deep in water: the bottom of the sprite is under the surface.
            drawCharacter(character(player.sprite), pos.x, pos.y, player.facing, player.hop && player.from ? 1 : column, camX, camY, wading && !player.from ? 3 : 0, pos.lift);
            // Standing in tall grass hides the feet: the grass's lower half goes back on top.
            if (!player.from && where === 'tall' && !map.surf) {
              const name = map.layers.objects[player.y][player.x];
              const sheet = name && sheets[name[0]];
              if (sheet) {
                const id = Number(name.slice(1));
                const half = TILE / 2;
                g.drawImage(sheet.img, (id % sheet.columns) * TILE, Math.floor(id / sheet.columns) * TILE + half, TILE, half,
                  Math.round(pos.x - camX), Math.round(pos.y - camY) + half, TILE, half);
              }
            }
          },
        });
        people.sort((a, b) => a.y - b.y).forEach((p) => p.draw());
        drawEffects(now, camX, camY, true);

        view(drawn.above);

        // The "!" over a trainer who has spotted you.
        if (approach && !approach.startedAt && art.alert) {
          const t = approach.trainer;
          g.drawImage(art.alert, t.x * TILE - camX, t.y * TILE - camY - CHAR_H + 2);
        }
        // A "!" over anyone a cutscene points at.
        if (alerted && now < alerted.until && art.alert) {
          const n = (map.npcs || []).find((x) => x.id === alerted.id);
          if (n) g.drawImage(art.alert, n.x * TILE - camX, n.y * TILE - camY - CHAR_H + 2);
        }
        // Pokemon in the air (FARFETCH'D's taxi).
        for (let i = flyers.length - 1; i >= 0; i--) {
          const f = flyers[i];
          const t = Math.min(1, (now - f.started) / f.ms);
          const ease = t * t * (3 - 2 * t);
          const fx = (f.from.x + (f.to.x - f.from.x) * ease) * TILE;
          const fy = (f.from.y + (f.to.y - f.from.y) * ease) * TILE - Math.sin(t * Math.PI) * f.arc - Math.abs(Math.sin(now / 90)) * 2;
          if (f.img.complete && f.img.naturalWidth) {
            const size = f.size;
            g.save();
            if (f.to.x > f.from.x) {
              // Facing the way it flies.
              g.translate(Math.round(fx - camX + TILE / 2), 0);
              g.scale(-1, 1);
              g.drawImage(f.img, -size / 2, Math.round(fy - camY - size + TILE), size, size);
            } else {
              g.drawImage(f.img, Math.round(fx - camX + TILE / 2 - size / 2), Math.round(fy - camY - size + TILE), size, size);
            }
            g.restore();
          }
          if (t >= 1 && !f.stay) {
            flyers.splice(i, 1);
            f.done();
          } else if (t >= 1 && !f.resolved) {
            f.resolved = true;
            f.done();
          }
        }
      }

      drawBanner(now);
      // A cutscene fading out: black, held until the next stage.
      if (fadeOut) {
        if (fade > fadeOut) fadeOut = 0;
        else {
          g.fillStyle = `rgba(0,0,0,${Math.min(1, (now - fadeOut) / fadeOutMs)})`;
          g.fillRect(0, 0, VIEW_W, VIEW_H);
        }
      }
      // A quick fade on doors, maps and battles.
      if (fade) {
        const a = Math.max(0, 1 - (now - fade) / FADE_IN_MS);
        if (a <= 0) fade = 0;
        else {
          g.fillStyle = `rgba(0,0,0,${a})`;
          g.fillRect(0, 0, VIEW_W, VIEW_H);
        }
      }

      requestAnimationFrame(frame);
    }

    load().catch((err) => console.error(err));
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
      /** Back out of a building's door, facing away from it. */
      leave() {
        player.facing = 'down';
        player.stepCount = 0;
        fade = performance.now();
      },
      /** Back from a battle: the world fades in from black. */
      fadeIn() {
        fade = performance.now();
      },
      /**
       * The server says where you are (after a battle, a black-out, or on
       * reconnecting). `refresh` reloads the map, for a beaten trainer.
       */
      sync(pos, refresh) {
        if (scripted) return;
        frozen = false;
        if (!map || refresh || pos.map !== map.id) {
          reload();
          return;
        }
        snap(pos);
      },
      get busy() {
        return frozen || Boolean(approach);
      },
      /** Load the map and position again (after a dev command). */
      refresh: () => reload(),
      /** Freeze or free walking (cutscenes). */
      setFrozen(on) {
        frozen = Boolean(on);
        if (on) held.length = 0;
      },
      /** Put someone on this map (the milestone leader), by id. */
      addNpc(n) {
        if (!map) return;
        map.npcs = (map.npcs || []).filter((x) => x.id !== n.id);
        map.npcs.push({ wander: 0, facing: 'down', lines: [], ...n, homeX: n.x, homeY: n.y, from: null, started: 0, next: Infinity });
        character(n.sprite);
      },
      walkUp,
      scene,
      fly,
      clearFlyers: () => { flyers.length = 0; },
      alert(id, ms = 900) {
        alerted = { id, until: performance.now() + ms };
        return new Promise((r) => setTimeout(r, ms));
      },
      /** Where you stand, for cutscenes. */
      get player() {
        return { x: player.x, y: player.y, facing: player.facing };
      },
      set hidden(on) {
        playerHidden = Boolean(on);
      },
      get mapId() {
        return map && map.id;
      },
      setSpeed(n) {
        speed = n;
      },
      get speed() {
        return speed;
      },
      get dev() {
        return devState;
      },
      /** The battle background for where you are (Tuxemon's ui/combat set). */
      get background() {
        return map && map.background;
      },
    };
  }

  /** A whole map at once, for checking a layout. */
  async function preview(map) {
    const sheets = await loadSheets();
    const canvas = document.createElement('canvas');
    canvas.width = map.width * TILE;
    canvas.height = map.height * TILE;
    const g = canvas.getContext('2d');
    for (const layer of ['ground', 'objects', 'overlays', 'overlays2', 'above']) if (map.layers[layer]) g.drawImage(drawLayer(sheets, map, map.layers[layer], true), 0, 0);
    return canvas;
  }

  window.World = { create, preview, VIEW_W, VIEW_H, OPPOSITE };
})();
