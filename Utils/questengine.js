'use strict';

/**
 * Keeping quest progress up to date while the bot runs.
 *
 * Utils/questprogress.js works out where somebody stands. This decides when to
 * ask, writes the answer down, and pays out anything that just finished.
 *
 * Progress is always recalculated from a snapshot of what the player owns,
 * never incremented. This handles the awkward cases naturally:
 *
 *   - trading a Pokemon away removes its contribution
 *   - evolving doesn't count as losing the old species
 *   - one Pokemon can't satisfy two requirements of the same quest, since
 *     requirements are matched against a Set
 *   - running it twice can't double-pay, because payment is gated on the
 *     stored `completed` flag
 *
 * Once complete, always complete: a finished quest stays finished even if the
 * player later trades the Pokemon away, so rewards are never clawed back.
 */

const db = require('./db');
const store = require('./store');
const content = require('./content');
const questprogress = require('./questprogress');
const { titleCase } = require('./display');

/** Pay out a quest reward. */
function grant(userId, reward) {
  if (!reward) return { gold: 0, coins: 0, items: [] };

  const paid = { gold: reward.gold || 0, coins: reward.coins || 0, items: [] };

  if (paid.gold) store.addGold(userId, paid.gold);
  if (paid.coins) store.addCoins(userId, paid.coins);

  for (const item of reward.items || []) {
    store.addItem(userId, item, 1);
    paid.items.push(item);
  }

  return paid;
}

/**
 * Recalculate every quest for one player, and pay for anything newly finished.
 *
 * Progress is written in one transaction.
 *
 * @param {string} userId
 * @param {object} [options]
 * @param {boolean} [options.award]  set false to recalculate without paying
 * @returns {{ completed: object[], changed: number, snapshot: object }}
 *          `completed` holds { quest, reward } for each one that just finished
 */
function sync(userId, { award = true } = {}) {
  const handle = db.open();
  const quests = content.quests();

  const snap = questprogress.snapshot(userId);

  const existing = new Map(
    handle
      .prepare('SELECT quest_id, progress, completed FROM quest_progress WHERE discord_user_id = ?')
      .all(userId)
      .map((row) => [row.quest_id, row])
  );

  const completed = [];
  const writes = [];

  for (const quest of quests) {
    const was = existing.get(quest.id);
    const wasComplete = !!(was && was.completed);

    const evaluated = questprogress.evaluate(quest, snap);

    // Completed quests stay completed (see the note at the top).
    const complete = wasComplete || evaluated.complete;
    const progress = complete ? evaluated.required : evaluated.progress;

    const unchanged = was && was.progress === progress && !!was.completed === complete;
    if (unchanged) continue;

    writes.push({ quest, progress, complete, justFinished: complete && !wasComplete });
  }

  if (!writes.length) return { completed, changed: 0, snapshot: snap };

  const now = Date.now();

  handle.exec('BEGIN IMMEDIATE');
  try {
    const write = handle.prepare(
      `INSERT INTO quest_progress (discord_user_id, quest_id, progress, completed, completed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(discord_user_id, quest_id) DO UPDATE SET
         progress = excluded.progress,
         completed = excluded.completed,
         completed_at = COALESCE(quest_progress.completed_at, excluded.completed_at)`
    );

    for (const entry of writes) {
      write.run(
        userId,
        entry.quest.id,
        entry.progress,
        entry.complete ? 1 : 0,
        entry.complete ? now : null
      );
    }

    handle.exec('COMMIT');
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }

  // Pay after the commit, so rewards are only given for saved completions.
  // The stored flag prevents paying again.
  for (const entry of writes) {
    if (!entry.justFinished) continue;
    completed.push({ quest: entry.quest, reward: award ? grant(userId, entry.quest.reward) : null });
  }

  return { completed, changed: writes.length, snapshot: snap };
}

/**
 * Sync several players at once (e.g. both sides of a trade). Duplicate ids
 * are collapsed.
 */
function syncMany(userIds, options) {
  const results = new Map();
  for (const userId of new Set(userIds.filter(Boolean))) {
    results.set(userId, sync(userId, options));
  }
  return results;
}

/**
 * A one-line announcement for a quest that just finished.
 *
 * Returns null when nothing did, so a caller can append it without checking.
 */
function announce(completed) {
  if (!completed || !completed.length) return null;

  return completed
    .map(({ quest, reward }) => {
      const parts = [];
      if (reward && reward.gold) parts.push(`**${reward.gold}** gold`);
      if (reward && reward.coins) parts.push(`**${reward.coins.toLocaleString('en-US')}** coins`);
      for (const item of (reward && reward.items) || []) {
        // Some rewards (e.g. Lootbox) are not in Data/Items, so fall back to a
        // title-cased slug like .bag does.
        const known = content.item(item);
        parts.push(`a **${known ? known.displayName : titleCase(item)}**`);
      }

      return (
        `🏅 Quest complete - **${quest.collection || quest.id}**` +
        (parts.length ? `: ${parts.join(', ')}` : '')
      );
    })
    .join('\n');
}

/** What a player has and has not finished. Behind .questprogress / .qp. */
function statusFor(userId) {
  const quests = content.quests();

  const rows = new Map(
    db
      .open()
      .prepare('SELECT quest_id, progress, completed FROM quest_progress WHERE discord_user_id = ?')
      .all(userId)
      .map((row) => [row.quest_id, row])
  );

  return quests.map((quest) => {
    const row = rows.get(quest.id);
    const required = quest.goal
      ? Math.max(1, quest.goal.count || 1)
      : Math.max(1, Math.min(quest.count || (quest.requires || []).length, (quest.requires || []).length));

    return {
      quest,
      progress: row ? row.progress : 0,
      required,
      complete: !!(row && row.completed),
    };
  });
}

module.exports = { sync, syncMany, announce, statusFor, grant };
