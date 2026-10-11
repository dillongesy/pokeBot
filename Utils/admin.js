'use strict';

/**
 * Who is allowed to run the admin commands - .forcespawn and .give.
 *
 * Two levels:
 *
 *   Owner   one person, DISCORD_OWNER_ID in .env. Cannot be changed at
 *           runtime. The only one who can add or remove admins.
 *   Admin   anyone the owner has added (the `admins` table). Can run
 *           .forcespawn and .give.
 *
 * Keeping the owner in .env means wiping the database can never lock the
 * owner out, and no first admin has to be inserted by hand.
 *
 * With DISCORD_OWNER_ID unset, there is no owner and the admin commands
 * refuse everyone.
 */

const db = require('./db');

/** A Discord snowflake, and nothing else. */
const isSnowflake = (value) => typeof value === 'string' && /^\d{15,25}$/.test(value);

/**
 * The owner's id, or null.
 *
 * Read on every call rather than cached, since scripts may load .env after
 * this module.
 */
function ownerId() {
  const raw = (process.env.DISCORD_OWNER_ID || '').trim();
  return isSnowflake(raw) ? raw : null;
}

const isOwner = (userId) => Boolean(ownerId()) && String(userId) === ownerId();

/** Everyone the owner has added, newest first. */
function list() {
  return db
    .open()
    .prepare('SELECT discord_user_id, added_by, added_at, note FROM admins ORDER BY added_at DESC')
    .all();
}

/** Is this person allowed to run an admin command? The owner always is. */
function isAdmin(userId) {
  if (!userId) return false;
  if (isOwner(userId)) return true;

  const row = db
    .open()
    .prepare('SELECT 1 AS ok FROM admins WHERE discord_user_id = ?')
    .get(String(userId));

  return Boolean(row);
}

/**
 * Add an admin.
 *
 * @returns {{ ok: boolean, message: string }}
 */
function add(userId, { by, note = null } = {}) {
  const id = String(userId);

  if (!isSnowflake(id)) return { ok: false, message: 'That is not a Discord user id.' };
  if (isOwner(id)) return { ok: false, message: 'You are the owner already.' };

  // The insert itself checks for duplicates, so concurrent calls are safe.
  const result = db
    .open()
    .prepare(
      `INSERT INTO admins (discord_user_id, added_by, added_at, note)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(discord_user_id) DO NOTHING`
    )
    .run(id, String(by || ownerId() || 'unknown'), Date.now(), note);

  if (!result.changes) return { ok: false, message: 'They are already an admin.' };
  return { ok: true, message: 'Added.' };
}

/** Remove an admin. The owner is not in the table, so cannot be removed. */
function remove(userId) {
  const id = String(userId);

  if (isOwner(id)) {
    return { ok: false, message: 'The owner is set in .env and cannot be removed here.' };
  }

  const result = db.open().prepare('DELETE FROM admins WHERE discord_user_id = ?').run(id);

  if (!result.changes) return { ok: false, message: 'They were not an admin.' };
  return { ok: true, message: 'Removed.' };
}

/**
 * The line to send when somebody who is not an admin tries an admin command.
 *
 * Always the same message, so it reveals nothing about the configuration.
 */
const DENIED = 'That command is for the bot owner.';

module.exports = { ownerId, isOwner, isAdmin, list, add, remove, isSnowflake, DENIED };
