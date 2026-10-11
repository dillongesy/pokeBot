'use strict';

/**
 * Which channels a server lets the bot work in.
 *
 * By default the bot works in every channel. Adding the first channel turns
 * the allowlist on; removing all of them turns it off again.
 *
 * The allowlist covers prefix commands, slash commands and catch attempts in
 * Commands/catch.js.
 *
 * The three channel configuration commands are exempt and work everywhere,
 * so a server that deletes its only allowed channel can still fix things.
 *
 * Messages in other channels are ignored silently.
 */

const db = require('./db');

/** A Discord snowflake, as text. Anything else is not a channel id. */
const isSnowflake = (value) => /^\d{17,20}$/.test(String(value ?? ''));

/**
 * Pull channel ids out of command arguments.
 *
 * Accepts a channel mention (`<#123>`) or a bare channel id.
 *
 * @returns {{ ids: string[], bad: string[] }}
 */
function parseChannels(args) {
  const ids = [];
  const bad = [];

  for (const raw of args || []) {
    const text = String(raw ?? '').trim();
    if (!text) continue;

    const mention = /^<#!?(\d{17,20})>$/.exec(text);
    const id = mention ? mention[1] : text;

    if (isSnowflake(id)) {
      if (!ids.includes(id)) ids.push(id);
    } else {
      bad.push(text);
    }
  }

  return { ids, bad };
}

/** Every channel this guild allows, oldest first. Empty means "all of them". */
function list(guildId) {
  return db
    .open()
    .prepare(
      `SELECT channel_id, added_by, added_at
       FROM guild_channels
       WHERE guild_id = ?
       ORDER BY added_at, channel_id`
    )
    .all(String(guildId));
}

/** How many channels this guild has allowlisted. 0 means the allowlist is off. */
function count(guildId) {
  return db
    .open()
    .prepare('SELECT COUNT(*) AS n FROM guild_channels WHERE guild_id = ?')
    .get(String(guildId)).n;
}

/**
 * May the bot work in this channel?
 *
 * DMs are always allowed. The common case (no allowlist configured) is
 * answered by a single indexed count.
 */
function isAllowed(guildId, channelId) {
  if (!guildId) return true;
  if (count(guildId) === 0) return true;

  const row = db
    .open()
    .prepare('SELECT 1 AS found FROM guild_channels WHERE guild_id = ? AND channel_id = ?')
    .get(String(guildId), String(channelId));

  return Boolean(row);
}

/**
 * Add channels to the allowlist.
 *
 * Channels already on the list are not an error; they are reported
 * separately.
 *
 * @returns {{ added: string[], already: string[] }}
 */
function allow(guildId, channelIds, addedBy = null) {
  const handle = db.open();
  const added = [];
  const already = [];

  const insert = handle.prepare(
    `INSERT INTO guild_channels (guild_id, channel_id, added_by, added_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(guild_id, channel_id) DO NOTHING`
  );

  handle.exec('BEGIN IMMEDIATE');
  try {
    for (const channelId of channelIds) {
      const result = insert.run(
        String(guildId),
        String(channelId),
        addedBy === null ? null : String(addedBy),
        Date.now()
      );

      if (result.changes > 0) added.push(String(channelId));
      else already.push(String(channelId));
    }
    handle.exec('COMMIT');
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }

  return { added, already };
}

/**
 * Take channels back off the allowlist.
 *
 * Removing the last one turns the allowlist off, so the bot works everywhere
 * again.
 *
 * @returns {{ removed: string[], missing: string[], remaining: number }}
 */
function disallow(guildId, channelIds) {
  const handle = db.open();
  const removed = [];
  const missing = [];

  const remove = handle.prepare(
    'DELETE FROM guild_channels WHERE guild_id = ? AND channel_id = ?'
  );

  handle.exec('BEGIN IMMEDIATE');
  try {
    for (const channelId of channelIds) {
      const result = remove.run(String(guildId), String(channelId));
      if (result.changes > 0) removed.push(String(channelId));
      else missing.push(String(channelId));
    }
    handle.exec('COMMIT');
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }

  return { removed, missing, remaining: count(guildId) };
}

// ---------------------------------------------------------------------------
// The gate itself
// ---------------------------------------------------------------------------

/**
 * Commands that work in every channel: the ones that view or change the
 * allowlist. Listed as aliases, since that is what gets typed.
 */
const ALWAYS_ALLOWED = new Set([
  'setchannel',
  'setchannels',
  'viewchannels',
  'channels',
  'resetchannels',
  'clearchannels',
]);

/**
 * May the bot respond to this, here?
 *
 * `name` is the command typed, or null for a catch attempt (which is also
 * subject to the allowlist).
 */
function mayAnswer(guildId, channelId, name = null) {
  if (name && ALWAYS_ALLOWED.has(String(name).toLowerCase())) return true;
  return isAllowed(guildId, channelId);
}

/**
 * Reply for a slash command used in a blocked channel. Interactions must be
 * answered, so this is sent ephemerally and points to an allowed channel.
 */
function notHere(guildId) {
  const allowed = list(guildId).slice(0, 5);

  return allowed.length
    ? `Not here - try ${allowed.map((row) => `<#${row.channel_id}>`).join(' or ')}.`
    : 'The bot is not set up to answer in this channel.';
}

/** Clear a guild's allowlist entirely, so the bot works everywhere again. */
function reset(guildId) {
  const result = db
    .open()
    .prepare('DELETE FROM guild_channels WHERE guild_id = ?')
    .run(String(guildId));

  return result.changes;
}

module.exports = {
  isSnowflake,
  parseChannels,
  list,
  count,
  isAllowed,
  allow,
  disallow,
  reset,
  ALWAYS_ALLOWED,
  mayAnswer,
  notHere,
};
