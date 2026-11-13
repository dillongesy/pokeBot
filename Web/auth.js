'use strict';

/**
 * Logging in with Discord (OAuth2, "identify" scope only).
 *
 *   /auth/login     sends the player to Discord to approve
 *   /auth/callback  Discord sends them back with a code; we swap it for their
 *                   id and name and set a session cookie
 *   /auth/logout    clears the cookie
 *
 * The session is a signed cookie (HMAC-SHA256 with WEB_SESSION_SECRET), not a
 * server-side table, so a restart of the bot doesn't log anyone out. The
 * Discord access token is used once and thrown away: the site never acts on
 * Discord as the player.
 */

const crypto = require('crypto');

const SESSION_COOKIE = 'pd_session';
const STATE_COOKIE = 'pd_oauth_state';
const SESSION_DAYS = 30;

const API = 'https://discord.com/api/v10';

function config() {
  const base = String(process.env.WEB_URL || '').replace(/\/+$/, '');
  return {
    clientId: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    base,
    redirectUri: `${base}/auth/callback`,
    secure: base.startsWith('https://'),
  };
}

let secret = null;

/** WEB_SESSION_SECRET, or a random one (sessions then end on restart). */
function sessionSecret() {
  if (secret) return secret;
  secret = process.env.WEB_SESSION_SECRET;
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    console.warn('web: no WEB_SESSION_SECRET in .env, so logins will end whenever the bot restarts.');
  }
  return secret;
}

const sign = (text) => crypto.createHmac('sha256', sessionSecret()).update(text).digest('base64url');

/** "a=1; b=2" -> { a: '1', b: '2' } */
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    out[part.slice(0, at).trim()] = decodeURIComponent(part.slice(at + 1).trim());
  }
  return out;
}

function cookie(name, value, { maxAge = null } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (config().secure) parts.push('Secure');
  if (maxAge != null) parts.push(`Max-Age=${maxAge}`);
  return parts.join('; ');
}

/** The logged-in player from the request's cookie, or null. */
function sessionOf(req) {
  const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!raw) return null;

  const [body, mac] = raw.split('.');
  if (!body || !mac) return null;

  const expected = sign(body);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;

  try {
    const session = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!session.id || session.exp < Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

function sessionCookie(user) {
  const body = Buffer.from(
    JSON.stringify({ ...user, exp: Date.now() + SESSION_DAYS * 86_400_000 })
  ).toString('base64url');
  return cookie(SESSION_COOKIE, `${body}.${sign(body)}`, { maxAge: SESSION_DAYS * 86_400 });
}

function redirect(res, location, cookies = []) {
  res.writeHead(302, { Location: location, 'Set-Cookie': cookies, 'Cache-Control': 'no-store' });
  res.end();
}

function login(req, res) {
  const { clientId, redirectUri } = config();
  const state = crypto.randomBytes(16).toString('hex');
  const url =
    'https://discord.com/oauth2/authorize?' +
    new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      scope: 'identify',
      redirect_uri: redirectUri,
      state,
      prompt: 'none',
    });
  redirect(res, url, [cookie(STATE_COOKIE, state, { maxAge: 600 })]);
}

async function callback(req, res, url) {
  const { clientId, clientSecret, redirectUri } = config();
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const expected = parseCookies(req.headers.cookie)[STATE_COOKIE];

  // Cancelled on Discord's page, or a link that didn't start here.
  if (!code || !state || state !== expected) {
    redirect(res, '/', [cookie(STATE_COOKIE, '', { maxAge: 0 })]);
    return;
  }

  try {
    const token = await fetch(`${API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`token ${r.status}`))));

    const me = await fetch(`${API}/users/@me`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`users/@me ${r.status}`))));

    const user = { id: me.id, username: me.username, globalName: me.global_name || null, avatar: me.avatar || null };
    redirect(res, '/', [sessionCookie(user), cookie(STATE_COOKIE, '', { maxAge: 0 })]);
  } catch (err) {
    console.error('web: Discord login failed:', err.message);
    redirect(res, '/?login=failed', [cookie(STATE_COOKIE, '', { maxAge: 0 })]);
  }
}

function logout(req, res) {
  redirect(res, '/', [cookie(SESSION_COOKIE, '', { maxAge: 0 })]);
}

/** Whether login can work: the secret and the site's address are set. */
function configured() {
  const { clientId, clientSecret, base } = config();
  return Boolean(clientId && clientSecret && base);
}

module.exports = { login, callback, logout, sessionOf, sessionCookie, configured, config };
