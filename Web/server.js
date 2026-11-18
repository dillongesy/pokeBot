'use strict';

/**
 * The website: pokedropper.dgesy.org.
 *
 * Runs inside the bot's own process (started from index.js), so it shares
 * everything that lives in memory - who is in a battle, the party locks,
 * open button prompts - as well as the database. That is what keeps the site
 * and Discord in step: a `.d` on Discord starts the same cooldown the site
 * shows, and a battle on one blocks a battle on the other.
 *
 * Plain node:http, no framework:
 *
 *   GET  /                      the game (Web/public)
 *   GET  /auth/login|callback|logout
 *   GET  /api/me                who is logged in
 *   GET  /api/stream            live updates (server-sent events)
 *   POST /api/run               start something at a station
 *   POST /api/press             a button on one of the station's messages
 *   GET  /api/file/...          an image or file a message carries
 *   GET  /api/world             the map you're on and where you stand
 *   POST /api/step              one step (checked by Web/overworld.js)
 *   POST /api/dev               the owner's dev console (DISCORD_OWNER_ID only)
 *   GET  /api/intro             the opening: is it needed, starters, outfits
 *   POST /api/intro             pick an outfit, or the starter (once per prestige)
 *   POST /api/pickup            pick up the Poke Ball you're facing
 *   GET  /api/fly               where you can fly to
 *   POST /api/fly               fly there
 *   GET  /api/party|bag|trainer the pause menu (Web/menus.js)
 *   GET  /api/shop              the MART's stock; POST /api/shop buys
 *   GET  /api/tower             the next milestone; POST /api/tower goes up or down
 *   GET  /api/item-sprite/<id>  an item's picture
 *
 * Station actions run the bot's real commands through Web/virtual.js.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

const auth = require('./auth');
const virtual = require('./virtual');
const overworld = require('./overworld');
const intro = require('./intro');
const menus = require('./menus');
const store = require('../Utils/store');
const partylock = require('../Utils/partylock');
const crashlog = require('../Utils/crashlog');
const admin = require('../Utils/admin');

const PUBLIC_DIR = path.join(__dirname, 'public');
const SPRITES_DIR = path.join(__dirname, 'sprites');
const STATUS_EVERY_MS = 2_000;
const HEARTBEAT_MS = 25_000;
const MAX_BODY = 8 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * The stations, and the actions each one offers. The Battle Tower only holds
 * milestones: on the web, routes are what .battle is on Discord.
 */
const STATIONS = {
  drop: ['drop', 'catch'],
  battle: ['milestone'],
  // The POKéMON MART: the bot's own .shop and .buy, so stock and prices match Discord.
  mart: ['shop', 'buy'],
};

/** The latest login seen per player, so the overworld can start battles as them. */
const sessions = new Map();

let client = null;
let commands = null;
let catcher = null;

function send(res, status, body, headers = {}) {
  const json = typeof body !== 'string';
  res.writeHead(status, {
    'Content-Type': json ? 'application/json' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(json ? JSON.stringify(body) : body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}

/** POSTs must come from the site itself (cookies are SameSite=Lax as well). */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    const host = new URL(origin).host;
    return host === req.headers.host || host === new URL(auth.config().base).host;
  } catch {
    return false;
  }
}

/** What the HUD shows: the drop timer and what the player is busy with. */
function statusOf(userId) {
  const battle = require('../Commands/battle');
  return {
    dropReadyIn: store.cooldownRemaining(userId),
    inBattle: battle.active.has(userId),
    busy: partylock.heldBy(userId),
  };
}

/** The player's live battle as data (Commands/battle.js webView), or null. */
function battleSnapshot(userId) {
  const battleCommand = require('../Commands/battle');
  const state = battleCommand.active.get(userId);
  return state ? battleCommand.webView(state) : null;
}

// ---------------------------------------------------------------------------
// Live updates
// ---------------------------------------------------------------------------

/** userId -> Set of open event streams */
const streams = new Map();

function push(userId, event, data) {
  for (const res of streams.get(userId) || []) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

/** Forward every change on the player's station channels to their browser tabs. */
const watched = new Set();
function channelsOf(session) {
  return Object.keys(STATIONS).map((station) => {
    const channel = virtual.channelFor(session, station, client);
    if (!watched.has(channel.id)) {
      watched.add(channel.id);
      channel.on('update', (update) => {
        // Battle updates carry the battle as data too, for the battle screen.
        push(session.id, 'update', channel.station === 'battle' ? { ...update, battle: battleSnapshot(session.id) } : update);
        push(session.id, 'status', statusOf(session.id));
      });
    }
    return channel;
  });
}

function stream(req, res, session) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    // Nginx would otherwise hold the events back.
    'X-Accel-Buffering': 'no',
  });

  const snapshot = {};
  for (const channel of channelsOf(session)) {
    snapshot[channel.station] = channel.messages.map((m) => m.toJSON());
  }
  res.write(`event: snapshot\ndata: ${JSON.stringify({ stations: snapshot, status: statusOf(session.id), battle: battleSnapshot(session.id) })}\n\n`);

  if (!streams.has(session.id)) streams.set(session.id, new Set());
  streams.get(session.id).add(res);

  // The drop timer and battles can change from Discord too, so keep sending.
  let last = '';
  const status = setInterval(() => {
    const now = JSON.stringify(statusOf(session.id));
    if (now !== last) res.write(`event: status\ndata: ${now}\n\n`);
    last = now;
  }, STATUS_EVERY_MS);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);

  req.on('close', () => {
    clearInterval(status);
    clearInterval(heartbeat);
    const open = streams.get(session.id);
    if (open) {
      open.delete(res);
      if (!open.size) streams.delete(session.id);
    }
  });
}

// ---------------------------------------------------------------------------
// Stations
// ---------------------------------------------------------------------------

/** Run a prefix command as if the player typed it in the station's channel. */
async function runCommand(channel, alias, args = []) {
  const command = commands.get(alias);
  if (!command || !command.run) throw new Error(`no command .${alias}`);
  store.ensureUser(channel.user.id);
  const message = channel.messageFrom(`.${[alias, ...args].join(' ')}`);
  return command.run(message, args);
}

async function run(session, body) {
  const station = String(body.station || '');
  const action = String(body.action || '');
  if (!STATIONS[station] || !STATIONS[station].includes(action)) return { status: 400, body: { error: 'Unknown action.' } };

  const channel = virtual.channelFor(session, station, client);
  channelsOf(session);

  if (action === 'drop') {
    await runCommand(channel, 'd');
    return { body: { ok: true } };
  }

  if (action === 'shop') {
    await runCommand(channel, 'shop');
    return { body: { ok: true } };
  }
  if (action === 'buy') {
    // An item id like the shop shows ("fire-stone"), and how many.
    const item = String(body.text || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 48);
    const qty = Math.max(1, Math.min(99, Number.parseInt(body.qty, 10) || 1));
    if (!item) return { body: { ok: false, reason: 'empty' } };
    await runCommand(channel, 'buy', [item, String(qty)]);
    return { body: { ok: true } };
  }

  if (action === 'catch') {
    const guess = String(body.text || '').trim().slice(0, 48);
    if (!guess) return { body: { ok: false, reason: 'empty' } };

    // Only this player's drops are in their channel, so only they can catch them.
    if (!store.newestOpenDrop(channel.id)) return { body: { ok: false, reason: 'nothing' } };

    store.ensureUser(session.id);
    const caught = await catcher.tryCatch(channel.messageFrom(guess));
    return { body: { ok: caught, reason: caught ? null : 'wrong' } };
  }

  // A battle runs until it's over, so it isn't waited for here; its card
  // arrives over the event stream like any other message.
  const args = action === 'milestone' ? ['milestone'] : [];
  runCommand(channel, 'b', args).catch((err) => {
    crashlog.record('web', err, { userId: session.id, station, action });
    console.error('web: battle failed:', err);
  });
  return { body: { ok: true } };
}

async function press(session, body) {
  const station = String(body.station || '');
  if (!STATIONS[station]) return { status: 400, body: { error: 'Unknown station.' } };

  const channel = virtual.channelFor(session, station, client);
  const values = Array.isArray(body.values) ? body.values.map(String).slice(0, 25) : [];
  const taken = await channel.press(String(body.messageId || ''), String(body.customId || ''), values);
  return { body: { ok: taken, reason: taken ? null : 'expired' } };
}

function file(res, session, station, messageId, index) {
  if (!STATIONS[station]) return send(res, 404, 'Not found');
  const message = virtual.channelFor(session, station, client).find(messageId);
  const entry = message && message.files[Number(index)];
  if (!entry) return send(res, 404, 'Not found');

  const type = TYPES[path.extname(entry.name).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Cache-Control': 'private, max-age=3600' };

  if (Buffer.isBuffer(entry.data)) {
    res.writeHead(200, headers);
    res.end(entry.data);
  } else if (typeof entry.data === 'string' && fs.existsSync(entry.data)) {
    res.writeHead(200, headers);
    fs.createReadStream(entry.data).pipe(res);
  } else {
    send(res, 404, 'Not found');
  }
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

/** A short hash of a page file's contents, remembered until the file changes. */
const versions = new Map();
function versionOf(name) {
  const full = path.join(PUBLIC_DIR, name);
  if (!fs.existsSync(full)) return null;
  const { mtimeMs } = fs.statSync(full);
  const known = versions.get(full);
  if (known && known.mtimeMs === mtimeMs) return known.v;
  const v = require('crypto').createHash('sha1').update(fs.readFileSync(full)).digest('hex').slice(0, 10);
  versions.set(full, { mtimeMs, v });
  return v;
}

/**
 * The page, with each of its scripts and stylesheets linked as /app.js?v=<hash>.
 * Cloudflare (and browsers) keep .js and .css for hours whatever we say, so
 * a changed file gets a new URL instead and is fetched fresh at once.
 */
function servePage(res) {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8').replace(
    /(src|href)="\/([\w.-]+\.(?:js|css))"/g,
    (all, attr, name) => {
      const v = versionOf(name);
      return v ? `${attr}="/${name}?v=${v}"` : all;
    }
  );
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(html);
}

function serveStatic(res, pathname) {
  if (pathname === '/' || pathname === '/index.html') return servePage(res);
  // /sprites/... is the tile and object pack in Web/sprites.
  const sprites = pathname.startsWith('/sprites/');
  const dir = sprites ? SPRITES_DIR : PUBLIC_DIR;
  const wanted = sprites ? pathname.slice('/sprites'.length) : pathname === '/' ? '/index.html' : pathname;
  const full = path.normalize(path.join(dir, decodeURIComponent(wanted)));
  if (!full.startsWith(dir + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return send(res, 404, 'Not found');
  }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream',
    // The pack rarely changes; the page's own files are checked each load.
    'Cache-Control': sprites ? 'public, max-age=86400' : 'no-cache',
  });
  fs.createReadStream(full).pipe(res);
}

// ---------------------------------------------------------------------------

async function handle(req, res) {
  const url = new URL(req.url, 'http://local');
  const { pathname } = url;

  if (pathname === '/auth/login') return auth.login(req, res);
  if (pathname === '/auth/callback') return auth.callback(req, res, url);
  if (pathname === '/auth/logout') return auth.logout(req, res);

  if (!pathname.startsWith('/api/')) return serveStatic(res, pathname);

  const session = auth.sessionOf(req);
  if (!session) return send(res, 401, { error: 'Not logged in.' });
  sessions.set(session.id, session);

  if (req.method === 'GET' && pathname === '/api/me') {
    return send(res, 200, { user: session, status: statusOf(session.id), owner: admin.isOwner(session.id) });
  }
  if (req.method === 'GET' && pathname === '/api/stream') return stream(req, res, session);
  if (req.method === 'GET' && pathname === '/api/world') return send(res, 200, overworld.view(session.id));
  if (req.method === 'GET' && pathname === '/api/intro') return send(res, 200, intro.view(session.id));
  // The opening's maps, as they look to someone who hasn't started yet:
  // Town 1 and the rooms behind its doors (nothing beaten, nothing found).
  if (req.method === 'GET' && pathname === '/api/scene-map') {
    const id = String(url.searchParams.get('id') || '');
    if (id !== 'town-1' && !/^in:town-1:\d+,\d+$/.test(id)) return send(res, 404, { error: 'No such scene.' });
    const map = require('./maps').get(id);
    if (!map) return send(res, 404, { error: 'No such scene.' });
    const outfit = String(url.searchParams.get('outfit') || 'adventurer');
    const cast = require('./maps').castLooks(outfit);
    return send(res, 200, {
      ...require('./maps').publicView(map, () => false, { outfit }),
      people: map.people || null,
      spawn: map.spawn,
      // The opening's own cast, dressed so nobody looks like the player.
      cast: { prof: cast('professor', 'prof'), aide: cast('', '', true) },
    });
  }
  if (req.method === 'GET' && pathname === '/api/party') return send(res, 200, menus.party(session.id));
  if (req.method === 'GET' && pathname === '/api/townmap') return send(res, 200, menus.townMap(session.id));
  if (req.method === 'GET' && pathname === '/api/pc') return send(res, 200, menus.pc(session.id, url.searchParams.get('page')));
  if (req.method === 'GET' && pathname === '/api/bag') return send(res, 200, menus.bag(session.id));
  if (req.method === 'GET' && pathname === '/api/trainer') return send(res, 200, menus.trainer(session.id));
  if (req.method === 'GET' && pathname === '/api/shop') return send(res, 200, menus.shop(session.id));
  if (req.method === 'GET' && pathname === '/api/tower') return send(res, 200, menus.tower(session.id));
  const sprite = /^\/api\/item-sprite\/([a-z0-9-]+)$/.exec(pathname);
  if (req.method === 'GET' && sprite) return menus.itemSprite(res, sprite[1]);
  if (req.method === 'GET' && pathname === '/api/fly') {
    const { unlocked, places } = overworld.flyPlaces(session.id);
    return send(res, 200, { unlocked, places });
  }

  const filePath = /^\/api\/file\/([a-z]+)\/(web-\d+)\/(\d+)$/.exec(pathname);
  if (req.method === 'GET' && filePath) return file(res, session, filePath[1], filePath[2], filePath[3]);

  if (req.method === 'POST' && ['/api/run', '/api/press', '/api/step', '/api/dev', '/api/intro', '/api/pickup', '/api/fly', '/api/shop', '/api/tower', '/api/swap', '/api/challenge', '/api/scene-seen'].includes(pathname)) {
    if (!sameOrigin(req)) return send(res, 403, { error: 'Bad origin.' });
    let body;
    try {
      body = await readJson(req);
    } catch {
      return send(res, 400, { error: 'Bad request.' });
    }
    if (pathname === '/api/step') return send(res, 200, overworld.step(session.id, body));
    if (pathname === '/api/pickup') return send(res, 200, overworld.pickup(session.id));
    if (pathname === '/api/challenge') return send(res, 200, overworld.challenge(session.id));
    if (pathname === '/api/scene-seen') return send(res, 200, overworld.sceneSeen(session.id, String(body.id || '')));
    if (pathname === '/api/fly') return send(res, 200, overworld.fly(session.id, body.key));
    if (pathname === '/api/shop') return send(res, 200, menus.buy(session.id, body.id, body.qty));
    if (pathname === '/api/swap') return send(res, 200, menus.swap(session.id, body.a, body.b));
    if (pathname === '/api/tower') return send(res, 200, overworld.tower(session.id, String(body.action || '')));
    if (pathname === '/api/intro') {
      if (body.action === 'outfit') {
        if (!intro.isOutfit(body.outfit)) return send(res, 400, { error: 'No such outfit.' });
        overworld.setOutfit(session.id, String(body.outfit));
        return send(res, 200, { ok: true });
      }
      if (body.action === 'starter') return send(res, 200, intro.chooseStarter(session.id, body.species));
      return send(res, 400, { error: 'Unknown action.' });
    }
    if (pathname === '/api/dev') {
      // Only the owner in .env, checked here on every call, not just in the page.
      if (!admin.isOwner(session.id)) return send(res, 403, { error: 'Not allowed.' });
      const args = Array.isArray(body.args) ? body.args.slice(0, 4) : [];
      return send(res, 200, overworld.dev(session.id, String(body.cmd || ''), args));
    }
    const result = await (pathname === '/api/run' ? run : press)(session, body);
    return send(res, result.status || 200, result.body);
  }

  send(res, 404, { error: 'Not found.' });
}

/**
 * Start listening.
 *
 * @param {object} options
 * @param {import('discord.js').Client} options.client   the logged-in bot
 * @param {Map} options.byAlias   prefix commands, from Utils/commands.js
 */
function start({ client: bot, byAlias, port = Number(process.env.WEB_PORT) || 8420, host = process.env.WEB_HOST || '0.0.0.0' }) {
  client = bot;
  commands = byAlias;
  catcher = require('../Commands/catch');

  // Battles the overworld starts (grass, trainers) run in the player's Battle
  // Station channel, so they show up like any other battle.
  overworld.configure({
    fight(userId, foe) {
      const session = sessions.get(userId);
      if (!session) return Promise.resolve({ error: 'Log in again to battle.' });
      const battleCommand = require('../Commands/battle');
      const setup = battleCommand.prepareFixed(userId, foe);
      if (setup.error) return Promise.resolve({ error: setup.error });
      const channel = virtual.channelFor(session, 'battle', client);
      channelsOf(session);
      return battleCommand.begin(channel.messageFrom('.b'), setup);
    },
    notify: (userId, event, data) => push(userId, event, data),
  });

  if (!auth.configured()) {
    console.warn('web: DISCORD_CLIENT_SECRET or WEB_URL missing in .env, so Discord login will not work.');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      crashlog.record('web', err, { url: req.url });
      console.error('web: request failed:', err);
      if (!res.headersSent) send(res, 500, { error: 'Something went wrong.' });
      else res.end();
    });
  });

  server.listen(port, host, () => console.log(`web: listening on http://${host}:${port}`));
  // Build the MART's catalogue now, so the first customer doesn't wait.
  setImmediate(() => {
    try {
      menus.catalog();
    } catch (err) {
      console.error('web: could not build the shop catalogue:', err.message);
    }
  });
  return server;
}

module.exports = { start, statusOf, STATIONS };
