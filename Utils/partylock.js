'use strict';

/**
 * Who is busy, and with what.
 *
 * Battles and trades both read the party once and act on it later, so the
 * party must not change in between:
 *
 *   - A battle's combatants are built from rows read at the start. Releasing
 *     or trading one mid-fight would send rewards to the wrong place.
 *   - A trade refers to specific Pokemon, so reordering or releasing during a
 *     trade could change what gets handed over.
 *
 * While a player is in a battle or trade, reordering, releasing and trading
 * are blocked. Viewing, dropping, catching and buying still work.
 *
 * Battle holds are kept in memory, like the battles themselves, so a restart
 * clears both together.
 */

/** userId -> { reason, since }. */
const holders = new Map();

/** What a hold is for. Only used to word the refusal. */
const BATTLE = 'battle';
const TRADE = 'trade';

const WORDING = {
  [BATTLE]: 'You are in the middle of a battle.',
  [TRADE]: 'You have a trade waiting.',
};

/**
 * Take a hold. Idempotent.
 */
function hold(userId, reason) {
  if (!userId) return;
  holders.set(String(userId), { reason, since: Date.now() });
}

/** Release a hold. Safe to call when there is none. */
function release(userId) {
  if (!userId) return;
  holders.delete(String(userId));
}

/**
 * What is holding this user, or null.
 *
 * Checks two sources: battle holds in memory, and pending trades in the
 * `trades` table (which survive a restart). Callers only need this one check.
 */
function heldBy(userId) {
  const entry = holders.get(String(userId));
  if (entry) return entry.reason;

  // Required lazily, since most calls are answered by the map above.
  try {
    const store = require('./store');
    if (store.openTradeFrom(userId) || store.openTradeTo(userId)) return TRADE;
  } catch {
    // No database available (e.g. in tests): there are no trades to check.
  }

  return null;
}

/**
 * The reason to refuse, in words, or null to go ahead.
 *
 * Each message explains what to do about it.
 *
 * @param {string} userId
 * @param {string} what   what they were trying to do, for the sentence
 */
function refusalFor(userId, what = 'change your party') {
  const reason = heldBy(userId);
  if (!reason) return null;

  const fix =
    reason === BATTLE
      ? 'Finish it, forfeit, or wait for it to time out.'
      : 'Finish or cancel it first.';

  return `${WORDING[reason] || 'You are busy.'} You cannot ${what} until then. ${fix}`;
}

/** How many holds are open. For the self-check and for tests. */
const count = () => holders.size;

/** Clear all holds. For tests only. */
function clear() {
  holders.clear();
}

module.exports = { BATTLE, TRADE, hold, release, heldBy, refusalFor, count, clear };

// `node Utils/partylock.js` - a quick demonstration.
if (require.main === module) {
  const me = '123';

  console.log('nothing held:', refusalFor(me) === null ? 'ok' : 'FAIL');

  hold(me, BATTLE);
  console.log('battle:', refusalFor(me, 'reorder your party'));

  hold(me, TRADE);
  console.log('trade:  ', refusalFor(me, 'release a Pokemon'));

  release(me);
  console.log('released:', refusalFor(me) === null ? 'ok' : 'FAIL');
  console.log('holds open:', count());
}
