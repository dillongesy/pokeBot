'use strict';

/**
 * top.gg votes, checked on demand.
 *
 * Uses the v1 API: GET /projects/@me/votes/:discordId?source=discord with the
 * project token from the bot's top.gg dashboard (Integrations & API), stored
 * as TOPGG_TOKEN in .env. It answers with when the user last voted, or 404 if
 * they have no active vote.
 *
 * Docs: https://docs.top.gg/api/v1/votes
 *
 * Without a token every check reports "not set up", and `.daily` says so
 * instead of offering the vote quest.
 */

const API = 'https://top.gg/api/v1';

/** Give up on top.gg after this long, so `.daily` never hangs. */
const TIMEOUT_MS = 5000;

/**
 * How long a "no vote yet" answer is reused. Keeps a player running `.daily`
 * over and over from spending the bot's rate limit.
 */
const MISS_CACHE_MS = 60_000;

const misses = new Map();

const configured = () => Boolean(process.env.TOPGG_TOKEN);

/** Where players go to vote. */
const voteUrl = (botId) => `https://top.gg/bot/${botId}/vote`;

/**
 * When this Discord user last voted, if their vote is still active.
 *
 * @returns {Promise<{ ok: true, votedAt: number|null } | { ok: false, reason: string }>}
 *   votedAt is milliseconds since the epoch, or null for no active vote.
 */
async function lastVote(discordId) {
  if (!configured()) return { ok: false, reason: 'not-configured' };

  const missedAt = misses.get(discordId);
  if (missedAt && Date.now() - missedAt < MISS_CACHE_MS) return { ok: true, votedAt: null };

  let response;
  try {
    response = await fetch(
      `${API}/projects/@me/votes/${encodeURIComponent(discordId)}?source=discord`,
      {
        headers: { Authorization: `Bearer ${process.env.TOPGG_TOKEN}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }
    );
  } catch (err) {
    console.error('top.gg vote check failed:', err.message);
    return { ok: false, reason: 'unreachable' };
  }

  if (response.status === 404) {
    misses.set(discordId, Date.now());
    return { ok: true, votedAt: null };
  }

  if (!response.ok) {
    // 401/403 means the token is wrong; anything else is on top.gg's side.
    console.error(`top.gg vote check returned ${response.status}.`);
    return { ok: false, reason: response.status === 401 || response.status === 403 ? 'bad-token' : 'unreachable' };
  }

  const body = await response.json().catch(() => null);
  const votedAt = body && Date.parse(body.created_at);
  const expiresAt = body && Date.parse(body.expires_at);

  // Treat an expired or unreadable vote as no vote.
  if (!votedAt || (expiresAt && expiresAt <= Date.now())) {
    misses.set(discordId, Date.now());
    return { ok: true, votedAt: null };
  }

  misses.delete(discordId);
  return { ok: true, votedAt };
}

module.exports = { configured, voteUrl, lastVote, MISS_CACHE_MS };
