'use strict';

/**
 * Cooldown reminders.
 *
 * Anyone who has turned .remind on gets pinged in the channel they dropped in
 * when their cooldown expires.
 *
 * The opt-in is stored in the database and the timers are rebuilt on startup,
 * so reminders survive a restart.
 */

const store = require('./store');

/** userId -> timeout, so a second drop replaces the first reminder. */
const timers = new Map();

/**
 * setTimeout takes a 32-bit signed millisecond count and fires immediately for
 * anything larger. Guards against bad values in the database.
 */
const MAX_DELAY = 2147483647;

let client = null;

/** Called once from index.js so the timers have somewhere to post. */
function attach(discordClient) {
  client = discordClient;
}

function cancel(userId) {
  const existing = timers.get(userId);
  if (existing) {
    clearTimeout(existing);
    timers.delete(userId);
  }
}

/** Post the ping, if the channel still exists and we can still see it. */
async function fire(userId, channelId) {
  timers.delete(userId);

  if (!client || !store.remindEnabled(userId)) return;

  // A newer drop may have replaced this timer.
  if (store.cooldownRemaining(userId) > 0) return;

  try {
    const channel = await client.channels.fetch(channelId);
    if (channel && channel.isTextBased()) {
      await channel.send(`<@${userId}>, your drop is off cooldown!`);
    }
  } catch {
    // Channel deleted or no longer accessible; skip silently.
  }
}

/**
 * Arrange a reminder for one user, replacing any they already had.
 *
 * Does nothing if they have not opted in.
 */
function schedule(userId, channelId, endsAt) {
  cancel(userId);

  if (!channelId || !store.remindEnabled(userId)) return false;

  const delay = endsAt - Date.now();
  if (delay <= 0 || delay > MAX_DELAY) return false;

  const timer = setTimeout(() => fire(userId, channelId), delay);

  // A pending reminder should never hold the process open by itself.
  if (typeof timer.unref === 'function') timer.unref();

  timers.set(userId, timer);
  return true;
}

/** Rebuild every outstanding reminder. Called once the client is ready. */
function rearmAll() {
  let armed = 0;
  for (const row of store.pendingReminders()) {
    if (schedule(row.user_id, row.channel_id, row.ends_at)) armed += 1;
  }
  return armed;
}

/** How many reminders are currently waiting. For tests and diagnostics. */
const pending = () => timers.size;

module.exports = { attach, schedule, cancel, rearmAll, pending };
