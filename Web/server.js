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
 *
 * Station actions run the bot's real commands through Web/virtual.js.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

const auth = require('./auth');
const virtual = require('./virtual');
const store = require('../Utils/store');
const partylock = require('../Utils/partylock');
const crashlog = require('../Utils/crashlog');

const PUBLIC_DIR = path.join(__dirname, 'public');
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

/** The stations, and the actions each one offers. */
const STATIONS = {
  drop: ['drop', 'catch'],
  battle: ['battle', 'milestone'],
};

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
        push(session.id, 'update', update);
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
  res.write(`event: snapshot\ndata: ${JSON.stringify({ stations: snapshot, status: statusOf(session.id) })}\n\n`);

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

function serveStatic(res, pathname) {
  const wanted = pathname === '/' ? '/index.html' : pathname;
  const full = path.normalize(path.join(PUBLIC_DIR, wanted));
  if (!full.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return send(res, 404, 'Not found');
  }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
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

  if (req.method === 'GET' && pathname === '/api/me') {
    return send(res, 200, { user: session, status: statusOf(session.id) });
  }
  if (req.method === 'GET' && pathname === '/api/stream') return stream(req, res, session);

  const filePath = /^\/api\/file\/([a-z]+)\/(web-\d+)\/(\d+)$/.exec(pathname);
  if (req.method === 'GET' && filePath) return file(res, session, filePath[1], filePath[2], filePath[3]);

  if (req.method === 'POST' && (pathname === '/api/run' || pathname === '/api/press')) {
    if (!sameOrigin(req)) return send(res, 403, { error: 'Bad origin.' });
    let body;
    try {
      body = await readJson(req);
    } catch {
      return send(res, 400, { error: 'Bad request.' });
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
  return server;
}

module.exports = { start, statusOf, STATIONS };
