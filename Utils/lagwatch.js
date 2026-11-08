'use strict';

/**
 * Notice when the bot freezes.
 *
 * Node runs everything on one thread, and the database calls are
 * synchronous, so anything slow (a big query, a slow disk) holds up every
 * other command and button press until it finishes. Discord gives a button
 * press 3 seconds; past that it shows "didn't respond in time".
 *
 * A timer ticks every TICK_MS. If a tick arrives much later than it should,
 * the thread was blocked for that long, and a log is written to Logs/ with the
 * commands that were running just before (see Utils/crashlog.js).
 */

const crashlog = require('./crashlog');

const TICK_MS = 500;

/** A freeze this long or longer is logged. */
const LOG_OVER_MS = 1500;

/** At most one log per this long, so a bad stretch doesn't flood the folder. */
const QUIET_MS = 60_000;

/** The latest commands and presses, newest last. */
const recent = [];
const KEEP = 15;

/** Remember what just started, for the next freeze log. */
function note(what) {
  recent.push({ at: new Date().toISOString(), what });
  if (recent.length > KEEP) recent.shift();
}

let started = false;

function start() {
  if (started) return;
  started = true;

  let expected = Date.now() + TICK_MS;
  let lastLogged = 0;

  const timer = setInterval(() => {
    const now = Date.now();
    const late = now - expected;
    expected = now + TICK_MS;

    if (late < LOG_OVER_MS || now - lastLogged < QUIET_MS) return;
    lastLogged = now;

    const error = new Error(`The bot was frozen for ${(late / 1000).toFixed(1)} seconds`);
    crashlog.record('slow', error, {
      frozenMs: late,
      memoryMb: Math.round(process.memoryUsage().rss / 1e6),
      // What was going on: the freeze is usually the last one or two.
      recent: [...recent],
    });
  }, TICK_MS);

  if (timer.unref) timer.unref();
}

module.exports = { start, note, LOG_OVER_MS };
