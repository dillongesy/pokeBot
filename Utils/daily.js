'use strict';

/**
 * Daily quests.
 *
 * Three a day, each paid once, plus a bonus for finishing all three:
 *
 *   catch    catch 5 Pokemon (targets are in rates.daily)
 *   battle   win 10 battles
 *   vote     vote for the bot on top.gg (checked by `.daily`, Utils/topgg.js)
 *   bonus    all three done
 *
 * Until voting is set up (no TOPGG_TOKEN, e.g. while top.gg reviews the bot),
 * the bonus only needs the catch and battle quests. Adding the token brings
 * the vote back in, with no code change.
 *
 * A day runs midnight to midnight US Central for everyone, daylight saving
 * included. Rewards are paid in the same transaction that completes the
 * quest, so a reward can't be paid twice or lost.
 */

const db = require('./db');
const rates = require('./rates');
const machines = require('./machines');
const content = require('./content');
const lootbox = require('./lootbox');
const topgg = require('./topgg');

const RARE_CANDY = 'rare-candy';

/** Whether the vote quest is part of the bonus: only once voting is set up. */
const voteCounts = () => topgg.configured();

/** How many days of rows to keep. Only today's matters, beyond vote history. */
const KEEP_DAYS = 7;

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: rates.daily.timezone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const partsFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: rates.daily.timezone,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

/** Today's date in the quest timezone, as 'YYYY-MM-DD'. */
const dayKey = (at = Date.now()) => dayFormat.format(at);

/** How far the quest timezone is ahead of UTC at this moment, in ms (negative for Central). */
function offsetAt(at) {
  const parts = Object.fromEntries(partsFormat.formatToParts(at).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second)
  );

  return asUtc - Math.floor(at / 1000) * 1000;
}

/**
 * When the current quest day ends: the next local midnight, as a timestamp.
 *
 * Works out the offset at that midnight rather than now, so the night the
 * clocks change still resets at midnight.
 */
function nextReset(at = Date.now()) {
  const [year, month, day] = dayKey(at).split('-').map(Number);
  const localMidnight = Date.UTC(year, month - 1, day + 1);

  const guess = localMidnight - offsetAt(localMidnight);
  return localMidnight - offsetAt(guess);
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** Today's row for this player, created on first use. */
function today(userId, at = Date.now()) {
  const handle = db.open();
  const day = dayKey(at);

  const existing = handle
    .prepare('SELECT * FROM daily_quests WHERE discord_user_id = ? AND day = ?')
    .get(userId, day);
  if (existing) return existing;

  const { catchTarget, battleTarget } = rates.daily;

  require('./store').ensureUser(userId);

  // Targets are stored on the row, so changing rates.js mid-day doesn't move
  // anyone's goalposts until tomorrow.
  handle
    .prepare(
      `INSERT OR IGNORE INTO daily_quests (discord_user_id, day, catch_target, battle_target)
       VALUES (?, ?, ?, ?)`
    )
    .run(userId, day, catchTarget, battleTarget);

  // Keep a week, so the table never grows past that.
  const cutoff = dayKey(at - KEEP_DAYS * 24 * 60 * 60 * 1000);
  handle
    .prepare('DELETE FROM daily_quests WHERE discord_user_id = ? AND day < ?')
    .run(userId, cutoff);

  return handle
    .prepare('SELECT * FROM daily_quests WHERE discord_user_id = ? AND day = ?')
    .get(userId, day);
}

// ---------------------------------------------------------------------------
// Rewards
// ---------------------------------------------------------------------------

function giveCoins(handle, userId, amount) {
  handle
    .prepare('UPDATE users SET coins = coins + ?, updated_at = ? WHERE discord_user_id = ?')
    .run(amount, Date.now(), userId);
}

function giveItem(handle, userId, item, quantity = 1) {
  handle
    .prepare(
      `INSERT INTO inventory (discord_user_id, item, quantity) VALUES (?, ?, ?)
       ON CONFLICT(discord_user_id, item) DO UPDATE SET quantity = quantity + excluded.quantity`
    )
    .run(userId, item, quantity);
}

const nameOf = (slug) => (content.item(slug) || {}).displayName || slug;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 'es'}`;

/** A Rare Candy or a random learnable TM. Returns its name. */
function giveBattleReward(handle, userId) {
  if (Math.random() < rates.daily.rareCandyChance) {
    giveItem(handle, userId, RARE_CANDY);
    return `a ${nameOf(RARE_CANDY)}`;
  }

  const tms = machines.all({ teachableOnly: true }).filter((tm) => content.item(tm.slug));
  if (!tms.length) {
    giveItem(handle, userId, RARE_CANDY);
    return `a ${nameOf(RARE_CANDY)}`;
  }

  const tm = tms[Math.floor(Math.random() * tms.length)];
  giveItem(handle, userId, tm.slug);
  return `${tm.displayName}`;
}

/** The bonus, if this completion made it three of three. */
function maybeBonus(handle, userId, row) {
  const needsVote = voteCounts();
  if (row.bonus_done || !(row.catch_done && row.battle_done && (row.vote_done || !needsVote))) {
    return null;
  }

  handle
    .prepare('UPDATE daily_quests SET bonus_done = 1 WHERE discord_user_id = ? AND day = ?')
    .run(userId, row.day);

  const n = rates.daily.bonusLootboxes;
  giveItem(handle, userId, lootbox.LOOTBOX, n);

  return `🎉 **${needsVote ? 'All three' : 'Both'} daily quests done!** You got ${plural(n, 'Lootbox')}.`;
}

/**
 * Apply one step of progress and pay anything it completes, atomically.
 *
 * @param {function} step  (handle, row) => notice line or null; must only
 *                         touch this player's rows
 * @returns {string[]} lines to show the player
 */
function progress(userId, step, at = Date.now()) {
  const handle = db.open();
  today(userId, at);

  const notices = [];

  handle.exec('BEGIN IMMEDIATE');
  try {
    const select = handle.prepare('SELECT * FROM daily_quests WHERE discord_user_id = ? AND day = ?');
    const day = dayKey(at);

    const said = step(handle, select.get(userId, day));
    if (said) notices.push(said);

    const bonus = maybeBonus(handle, userId, select.get(userId, day));
    if (bonus) notices.push(bonus);

    handle.exec('COMMIT');
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }

  return notices;
}

// ---------------------------------------------------------------------------
// What counts
// ---------------------------------------------------------------------------

/** A Pokemon was caught. */
function recordCatch(userId, at = Date.now()) {
  return progress(userId, (handle, row) => {
    if (row.catch_done) return null;

    const catches = row.catches + 1;
    const done = catches >= row.catch_target;

    handle
      .prepare(
        'UPDATE daily_quests SET catches = ?, catch_done = ? WHERE discord_user_id = ? AND day = ?'
      )
      .run(catches, done ? 1 : 0, userId, row.day);

    if (!done) return null;

    giveCoins(handle, userId, rates.daily.catchCoins);
    return `✅ **Daily quest done!** You caught ${row.catch_target} Pokemon and got ${rates.daily.catchCoins} coins.`;
  }, at);
}

/** A battle was won. */
function recordWin(userId, at = Date.now()) {
  return progress(userId, (handle, row) => {
    if (row.battle_done) return null;

    const wins = row.wins + 1;
    const done = wins >= row.battle_target;

    handle
      .prepare('UPDATE daily_quests SET wins = ?, battle_done = ? WHERE discord_user_id = ? AND day = ?')
      .run(wins, done ? 1 : 0, userId, row.day);

    if (!done) return null;

    const prize = giveBattleReward(handle, userId);
    return `✅ **Daily quest done!** You won ${row.battle_target} battles and got ${prize}.`;
  }, at);
}

/**
 * The newest vote already credited, on any day. Nothing is credited for a
 * vote cast at or before it, so one vote is one reward even across midnight.
 */
function lastCreditedVote(userId) {
  const row = db
    .open()
    .prepare('SELECT MAX(vote_created_at) AS at FROM daily_quests WHERE discord_user_id = ?')
    .get(userId);

  return (row && row.at) || 0;
}

/**
 * Credit a top.gg vote cast at `votedAt`, if today's vote quest is still open
 * and that vote hasn't been credited before.
 *
 * @returns {string[]} lines to show, empty if nothing was credited
 */
function recordVote(userId, votedAt, at = Date.now()) {
  return progress(userId, (handle, row) => {
    if (row.vote_done || votedAt <= lastCreditedVote(userId)) return null;

    handle
      .prepare(
        'UPDATE daily_quests SET vote_done = 1, vote_created_at = ? WHERE discord_user_id = ? AND day = ?'
      )
      .run(votedAt, userId, row.day);

    const n = rates.daily.voteLootboxes;
    giveItem(handle, userId, lootbox.LOOTBOX, n);
    return `✅ **Daily quest done!** Thanks for voting. You got ${plural(n, 'Lootbox')}.`;
  }, at);
}

module.exports = {
  dayKey,
  nextReset,
  offsetAt,
  today,
  recordCatch,
  recordWin,
  recordVote,
  lastCreditedVote,
  voteCounts,
};
