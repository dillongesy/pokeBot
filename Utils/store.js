'use strict';

/**
 * Every database query the bot makes.
 *
 * Utils/db.js owns the connection and the schema; this file owns the reads and
 * writes, so commands never write SQL themselves.
 */

const db = require('./db');
const rates = require('./rates');
const rarity = require('./rarity');
const names = require('./names');
const content = require('./content');
const learnset = require('./learnset');
const trainer = require('./trainer');
const milestones = require('./milestones');
const rewards = require('./rewards');
const obedience = require('./obedience');
const evolution = require('./evolution');
const lootbox = require('./lootbox');
const { normaliseName, recalculateStats } = require('./pokemon');

const now = () => Date.now();

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/** Fetch a user, creating them on first sight. Every command can call this. */
function ensureUser(userId) {
  const handle = db.open();
  const timestamp = now();

  handle
    .prepare(
      `INSERT INTO users (discord_user_id, created_at, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(discord_user_id) DO NOTHING`
    )
    .run(userId, timestamp, timestamp);

  return getUser(userId);
}

function getUser(userId) {
  return db.open().prepare('SELECT * FROM users WHERE discord_user_id = ?').get(userId) || null;
}

function addCoins(userId, amount) {
  db.open()
    .prepare(
      `UPDATE users SET coins = coins + ?, updated_at = ? WHERE discord_user_id = ?`
    )
    .run(amount, now(), userId);
}

/**
 * Pay a user for a catch and return what they got.
 *
 * A flat roll regardless of rarity, doubled by an Amulet Coin only when
 * catching your own drop.
 */
function awardCatchCoins(userId, { ownDrop = true } = {}) {
  const { min, max } = rates.catchCoins;
  const base = min + Math.floor(Math.random() * (max - min + 1));
  const multiplier = ownDrop ? buffValue(userId, 'coin_multiplier', 1) || 1 : 1;
  const coins = Math.max(0, Math.round(base * multiplier));

  addCoins(userId, coins);
  return coins;
}

/**
 * Take currency off a user, but only if they have it.
 *
 * The balance check is part of the UPDATE, so concurrent purchases can't
 * overdraw.
 *
 * @returns {boolean} whether they could afford it
 */
function spend(userId, currency, amount) {
  if (currency !== 'coins' && currency !== 'gold') {
    throw new Error(`Unknown currency "${currency}".`);
  }
  if (!(amount >= 0)) throw new Error('Amount must be positive.');

  const changed = db
    .open()
    .prepare(
      `UPDATE users
       SET ${currency} = ${currency} - ?,
           total_spent = total_spent + ?,
           updated_at = ?
       WHERE discord_user_id = ? AND ${currency} >= ?`
    )
    .run(amount, currency === 'coins' ? amount : 0, now(), userId, amount);

  return changed.changes === 1;
}

function addGold(userId, amount) {
  db.open()
    .prepare('UPDATE users SET gold = gold + ?, updated_at = ? WHERE discord_user_id = ?')
    .run(amount, now(), userId);
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

/** Give a user some of an item. */
function addItem(userId, item, quantity = 1) {
  ensureUser(userId);
  db.open()
    .prepare(
      `INSERT INTO inventory (discord_user_id, item, quantity)
       VALUES (?, ?, ?)
       ON CONFLICT(discord_user_id, item)
       DO UPDATE SET quantity = quantity + excluded.quantity`
    )
    .run(userId, item, quantity);
}

/**
 * Consume some of an item.
 *
 * Like spend(), the quantity check is part of the UPDATE. Rows that reach zero
 * are deleted.
 *
 * @returns {boolean} whether they had enough
 */
function removeItem(userId, item, quantity = 1) {
  const handle = db.open();

  const changed = handle
    .prepare(
      `UPDATE inventory SET quantity = quantity - ?
       WHERE discord_user_id = ? AND item = ? AND quantity >= ?`
    )
    .run(quantity, userId, item, quantity);

  if (changed.changes !== 1) return false;

  handle
    .prepare('DELETE FROM inventory WHERE discord_user_id = ? AND item = ? AND quantity <= 0')
    .run(userId, item);

  return true;
}

function itemQuantity(userId, item) {
  const row = db
    .open()
    .prepare('SELECT quantity FROM inventory WHERE discord_user_id = ? AND item = ?')
    .get(userId, item);

  return row ? row.quantity : 0;
}

// ---------------------------------------------------------------------------
// Admin adjustments
// ---------------------------------------------------------------------------

/**
 * Change a currency by a signed amount, never going below zero. Used by .give.
 *
 * Unlike spend(), removing more than the balance doesn't fail; it removes
 * what is there and reports the amount actually moved. Runs in one immediate
 * transaction.
 *
 * total_spent is not changed, since an admin removal is not player spending.
 *
 * @returns {{ before: number, after: number, moved: number }}
 */
function adjustCurrency(userId, currency, delta) {
  if (currency !== 'coins' && currency !== 'gold') {
    throw new Error(`Unknown currency "${currency}".`);
  }

  ensureUser(userId);
  const handle = db.open();

  handle.exec('BEGIN IMMEDIATE');
  try {
    const before = handle
      .prepare(`SELECT ${currency} AS value FROM users WHERE discord_user_id = ?`)
      .get(userId).value;

    const after = Math.max(0, before + Math.trunc(delta));

    handle
      .prepare(`UPDATE users SET ${currency} = ?, updated_at = ? WHERE discord_user_id = ?`)
      .run(after, now(), userId);

    handle.exec('COMMIT');
    return { before, after, moved: after - before };
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }
}

/**
 * The same, for an item. Removing more than they hold empties the stack.
 *
 * @returns {{ before: number, after: number, moved: number }}
 */
function adjustItem(userId, item, delta) {
  ensureUser(userId);
  const handle = db.open();

  handle.exec('BEGIN IMMEDIATE');
  try {
    const row = handle
      .prepare('SELECT quantity FROM inventory WHERE discord_user_id = ? AND item = ?')
      .get(userId, item);

    const before = row ? row.quantity : 0;
    const after = Math.max(0, before + Math.trunc(delta));

    if (after === 0) {
      handle
        .prepare('DELETE FROM inventory WHERE discord_user_id = ? AND item = ?')
        .run(userId, item);
    } else {
      handle
        .prepare(
          `INSERT INTO inventory (discord_user_id, item, quantity)
           VALUES (?, ?, ?)
           ON CONFLICT(discord_user_id, item) DO UPDATE SET quantity = excluded.quantity`
        )
        .run(userId, item, after);
    }

    handle.exec('COMMIT');
    return { before, after, moved: after - before };
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }
}

/**
 * How .bag can be ordered (.inventorysort).
 *
 * Only 'custom' uses the stored position. 'shop' is applied by the caller,
 * since the shop order lives in Data/Shop.
 */
const BAG_SORTS = {
  alphabetical: 'item ASC',
  quantity: 'quantity DESC, item ASC',
  custom: 'position IS NULL, position ASC, item ASC',
  shop: 'item ASC',
};

/**
 * What a user is carrying, in whatever order they asked for.
 *
 * `sort` defaults to their saved preference. An unknown name falls back to
 * alphabetical rather than being interpolated into the query.
 */
function listInventory(userId, sort = null) {
  const user = getUser(userId);
  const wanted = sort || (user ? user.bag_sort : 'shop');
  const order = BAG_SORTS[wanted] || BAG_SORTS.alphabetical;

  return db
    .open()
    .prepare(
      `SELECT item, quantity, position FROM inventory
       WHERE discord_user_id = ? AND quantity > 0
       ORDER BY ${order}`
    )
    .all(userId);
}

/** Remember how this player likes their bag sorted. */
function setBagOrder(userId, sort) {
  ensureUser(userId);
  db.open()
    .prepare('UPDATE users SET bag_sort = ?, updated_at = ? WHERE discord_user_id = ?')
    .run(sort, now(), userId);
}

/**
 * Number every slot in a bag, in the order given.
 *
 * Like assignPartyPositions: a custom order needs every row to have a
 * position. Runs in one transaction.
 */
function assignInventoryPositions(userId, items) {
  const handle = db.open();
  const update = handle.prepare(
    'UPDATE inventory SET position = ? WHERE discord_user_id = ? AND item = ?'
  );

  handle.exec('BEGIN IMMEDIATE');
  try {
    items.forEach((item, i) => update.run(i + 1, userId, item));
    handle.exec('COMMIT');
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }

  return items.length;
}

/**
 * Swap two bag slots by the numbers shown in .bag.
 *
 * @param {object[]} ordered  the bag as it is currently displayed
 * @returns {{ ok: boolean, message?: string, moved?: object[] }}
 */
function swapInventoryPositions(userId, first, second, ordered) {
  if (first === second) return { ok: false, message: 'Those are the same slot.' };
  if (ordered.length < 2) return { ok: false, message: 'You need at least two items to swap.' };

  const bad = [first, second].find(
    (slot) => !Number.isInteger(slot) || slot < 1 || slot > ordered.length
  );
  if (bad !== undefined) {
    return { ok: false, message: `Your bag has ${ordered.length} slots, so there is no slot ${bad}.` };
  }

  const items = ordered.map((row) => row.item);
  [items[first - 1], items[second - 1]] = [items[second - 1], items[first - 1]];
  assignInventoryPositions(userId, items);

  return { ok: true, moved: [ordered[second - 1], ordered[first - 1]] };
}

/**
 * Destroy some of an item outright.
 *
 * Unlike removeItem, asking for more than the stack removes the whole stack
 * and reports how many were removed.
 *
 * @returns {{ ok: boolean, removed: number }}
 */
function trashItem(userId, item, quantity) {
  const handle = db.open();

  handle.exec('BEGIN IMMEDIATE');
  try {
    const row = handle
      .prepare('SELECT quantity FROM inventory WHERE discord_user_id = ? AND item = ?')
      .get(userId, item);

    if (!row || row.quantity <= 0) {
      handle.exec('ROLLBACK');
      return { ok: false, removed: 0 };
    }

    const removed = Math.min(row.quantity, quantity);

    if (removed >= row.quantity) {
      handle
        .prepare('DELETE FROM inventory WHERE discord_user_id = ? AND item = ?')
        .run(userId, item);
    } else {
      handle
        .prepare('UPDATE inventory SET quantity = quantity - ? WHERE discord_user_id = ? AND item = ?')
        .run(removed, userId, item);
    }

    handle.exec('COMMIT');
    return { ok: true, removed };
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Repel and incense slots
// ---------------------------------------------------------------------------

/** Slot name to column, so user input is never interpolated into SQL. */
const SLOT_COLUMNS = { repel: 'active_repel', incense: 'active_incense' };

/**
 * Move an item out of the bag and into one of the two slots.
 *
 * Runs in one transaction. Whatever was already in the slot goes back in the
 * bag.
 *
 * @returns {{ ok: boolean, replaced?: string|null, message?: string }}
 */
function equipSlot(userId, slot, item) {
  const column = SLOT_COLUMNS[slot];
  if (!column) return { ok: false, message: `There is no "${slot}" slot.` };

  ensureUser(userId);
  const handle = db.open();

  handle.exec('BEGIN IMMEDIATE');
  try {
    const held = handle
      .prepare('SELECT quantity FROM inventory WHERE discord_user_id = ? AND item = ?')
      .get(userId, item);

    if (!held || held.quantity < 1) {
      handle.exec('ROLLBACK');
      return { ok: false, message: 'notCarried' };
    }

    const current = handle
      .prepare(`SELECT ${column} AS slug FROM users WHERE discord_user_id = ?`)
      .get(userId);
    const replaced = current ? current.slug : null;

    if (replaced === item) {
      handle.exec('ROLLBACK');
      return { ok: false, message: 'alreadyEquipped' };
    }

    if (held.quantity <= 1) {
      handle.prepare('DELETE FROM inventory WHERE discord_user_id = ? AND item = ?').run(userId, item);
    } else {
      handle
        .prepare('UPDATE inventory SET quantity = quantity - 1 WHERE discord_user_id = ? AND item = ?')
        .run(userId, item);
    }

    // Return the previous item to the bag.
    if (replaced) {
      handle
        .prepare(
          `INSERT INTO inventory (discord_user_id, item, quantity) VALUES (?, ?, 1)
           ON CONFLICT(discord_user_id, item) DO UPDATE SET quantity = quantity + 1`
        )
        .run(userId, replaced);
    }

    handle
      .prepare(`UPDATE users SET ${column} = ?, updated_at = ? WHERE discord_user_id = ?`)
      .run(item, now(), userId);

    handle.exec('COMMIT');
    return { ok: true, replaced };
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }
}

/** What is equipped in each slot right now. */
function activeSlots(userId) {
  const user = getUser(userId);
  return {
    repel: user ? user.active_repel : null,
    incense: user ? user.active_incense : null,
  };
}

/**
 * Empty one slot, putting the item back in the bag.
 *
 * @returns {string|null} what came out
 */
function unequipSlot(userId, slot) {
  const column = SLOT_COLUMNS[slot];
  if (!column) return null;

  const handle = db.open();

  handle.exec('BEGIN IMMEDIATE');
  try {
    const row = handle
      .prepare(`SELECT ${column} AS slug FROM users WHERE discord_user_id = ?`)
      .get(userId);

    if (!row || !row.slug) {
      handle.exec('ROLLBACK');
      return null;
    }

    handle
      .prepare(
        `INSERT INTO inventory (discord_user_id, item, quantity) VALUES (?, ?, 1)
         ON CONFLICT(discord_user_id, item) DO UPDATE SET quantity = quantity + 1`
      )
      .run(userId, row.slug);

    handle
      .prepare(`UPDATE users SET ${column} = NULL, updated_at = ? WHERE discord_user_id = ?`)
      .run(now(), userId);

    handle.exec('COMMIT');
    return row.slug;
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Take whatever is in both slots and empty them, in one step.
 *
 * Called by each drop. The UPDATE only matches while the slots still hold
 * what was read, so concurrent drops can't use the same item twice.
 *
 * @returns {{ repel: string|null, incense: string|null }}
 */
function consumeSlots(userId) {
  const handle = db.open();

  handle.exec('BEGIN IMMEDIATE');
  try {
    const row = handle
      .prepare('SELECT active_repel, active_incense FROM users WHERE discord_user_id = ?')
      .get(userId);

    if (!row || (!row.active_repel && !row.active_incense)) {
      handle.exec('ROLLBACK');
      return { repel: null, incense: null };
    }

    handle
      .prepare(
        `UPDATE users SET active_repel = NULL, active_incense = NULL, updated_at = ?
         WHERE discord_user_id = ?`
      )
      .run(now(), userId);

    handle.exec('COMMIT');
    return { repel: row.active_repel, incense: row.active_incense };
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Cooldowns
// ---------------------------------------------------------------------------

/**
 * How long until this user may drop again, in milliseconds. Zero means now.
 */
function cooldownRemaining(userId) {
  const user = getUser(userId);
  if (!user) return 0;
  return Math.max(0, user.cooldown_end - now());
}

/**
 * Start the drop cooldown.
 *
 * With the Critical Drop buff, a successful roll clears the cooldown
 * immediately.
 *
 * @returns {{ crit: boolean, endsAt: number }}
 */
function startDropCooldown(userId) {
  const reduction = buffValue(userId, 'cooldown_reduction', 0);
  const critChance = buffValue(userId, 'crit_drop', 0);

  const crit = critChance > 0 && Math.random() < Math.min(critChance, rates.maxCritDropChance);
  const length = crit ? 0 : Math.max(0, rates.dropCooldownMs * (1 - reduction));
  const endsAt = now() + length;

  db.open()
    .prepare('UPDATE users SET cooldown_end = ?, updated_at = ? WHERE discord_user_id = ?')
    .run(endsAt, now(), userId);

  return { crit, endsAt };
}

/**
 * Turn cooldown reminders on or off, and report which it now is.
 *
 * @returns {boolean} whether reminders are now on
 */
function toggleRemind(userId, enabled = null) {
  ensureUser(userId);
  const handle = db.open();

  const current = handle
    .prepare('SELECT remind_enabled FROM users WHERE discord_user_id = ?')
    .get(userId);

  const next = enabled === null ? (current && current.remind_enabled ? 0 : 1) : enabled ? 1 : 0;

  handle
    .prepare('UPDATE users SET remind_enabled = ?, updated_at = ? WHERE discord_user_id = ?')
    .run(next, now(), userId);

  return next === 1;
}

function remindEnabled(userId) {
  const user = getUser(userId);
  return !!(user && user.remind_enabled);
}

/**
 * Everyone who is waiting on a cooldown and wants to be told when it ends.
 *
 * Includes the channel they last dropped in. Used on startup to restore
 * reminders.
 */
function pendingReminders() {
  return db
    .open()
    .prepare(
      `SELECT u.discord_user_id AS user_id,
              u.cooldown_end    AS ends_at,
              (SELECT d.channel_id FROM drops d
                WHERE d.dropped_by = u.discord_user_id
                ORDER BY d.id DESC LIMIT 1) AS channel_id
       FROM users u
       WHERE u.remind_enabled = 1 AND u.cooldown_end > ?`
    )
    .all(now())
    .filter((row) => row.channel_id);
}

// ---------------------------------------------------------------------------
// Buffs
// ---------------------------------------------------------------------------

/** A buff's value, or the fallback if the user has none or it has expired. */
function buffValue(userId, buff, fallback = 0) {
  const row = db
    .open()
    .prepare(
      `SELECT value FROM user_buffs
       WHERE discord_user_id = ? AND buff = ?
         AND (expires_at IS NULL OR expires_at > ?)`
    )
    .get(userId, buff, now());

  return row ? row.value : fallback;
}

/** Grant or replace a buff. Pass expiresAt as null for one that never lapses. */
function setBuff(userId, buff, value, expiresAt = null) {
  ensureUser(userId);
  db.open()
    .prepare(
      `INSERT INTO user_buffs (discord_user_id, buff, value, expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(discord_user_id, buff)
       DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`
    )
    .run(userId, buff, value, expiresAt);
}

function activeBuffs(userId) {
  return db
    .open()
    .prepare(
      `SELECT buff, value, expires_at FROM user_buffs
       WHERE discord_user_id = ? AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY buff`
    )
    .all(userId, now());
}

// ---------------------------------------------------------------------------
// Trainer progression
// ---------------------------------------------------------------------------

/**
 * Where this trainer stands, and what is in front of them.
 *
 * Includes the next milestone, since every caller needs both.
 */
function trainerProgress(userId) {
  const standing = trainer.progress(ensureUser(userId));

  return {
    ...standing,
    next: milestones.next(standing.milestonesCleared),
    totalMilestones: milestones.total(),
    canPrestige: trainer.canPrestige(
      { milestones_cleared: standing.milestonesCleared },
      milestones.total()
    ),
  };
}

/** The obedience cap to hand Utils/obedience.js for this trainer. */
const trainerCap = (userId) => trainerProgress(userId).cap;

/**
 * Which Elite Four members this player has beaten on a milestone, by name.
 *
 * @param {number} order  the milestone's 1-based ladder order
 * @returns {Set<string>}
 */
function eliteFourBeaten(userId, order) {
  const rows = db
    .open()
    .prepare('SELECT member FROM elite_four_wins WHERE discord_user_id = ? AND milestone = ?')
    .all(userId, order);

  return new Set(rows.map((row) => row.member));
}

/** Mark one Elite Four member as beaten. Beating them again changes nothing. */
function recordEliteFourWin(userId, order, member) {
  ensureUser(userId);
  db.open()
    .prepare(
      `INSERT OR IGNORE INTO elite_four_wins (discord_user_id, milestone, member, beaten_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(userId, order, member, now());
}

/**
 * Award trainer exp for a win, and level them up if that filled the bar.
 *
 * Runs in one immediate transaction so concurrent awards aren't lost.
 * Levelling is decided by Utils/trainer.js.
 *
 * @returns {{ gained, level, levelsGained, cap, pending, exp }}
 */
function awardTrainerExp(userId, amount) {
  ensureUser(userId);
  const handle = db.open();

  handle.exec('BEGIN IMMEDIATE');
  try {
    const row = handle.prepare('SELECT * FROM users WHERE discord_user_id = ?').get(userId);

    // Only announce a milestone unlock on the battle that fills the bar.
    const before = trainer.progress(row).pending;

    const result = trainer.addExp(row, amount);
    result.becamePending = Boolean(result.pending) && !before;

    handle
      .prepare(
        `UPDATE users SET trainer_level = ?, trainer_exp = ?, updated_at = ?
         WHERE discord_user_id = ?`
      )
      .run(result.level, result.exp, now(), userId);

    handle.exec('COMMIT');
    return result;
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Record a battle result.
 *
 * Losses cost nothing, so a loss is only counted.
 */
function recordBattle(userId, won) {
  ensureUser(userId);

  db.open()
    .prepare(
      `UPDATE users
       SET battles_won = battles_won + ?, battles_lost = battles_lost + ?, updated_at = ?
       WHERE discord_user_id = ?`
    )
    .run(won ? 1 : 0, won ? 0 : 1, now(), userId);
}

/**
 * Mark the next milestone as beaten, unlocking the next level. Only ever
 * advances by one.
 *
 * @returns {{ milestonesCleared: number, cap: number, level: number }}
 */
function clearMilestone(userId) {
  ensureUser(userId);
  const handle = db.open();

  // Every milestone is cleared; prestige is now available.
  const standing = trainer.progress(getUser(userId));
  if (standing.milestonesCleared >= milestones.total()) {
    return {
      milestonesCleared: standing.milestonesCleared,
      level: standing.level,
      cap: standing.cap,
      levelsGained: 0,
      finished: true,
    };
  }

  handle.exec('BEGIN IMMEDIATE');
  try {
    handle
      .prepare(
        `UPDATE users SET milestones_cleared = milestones_cleared + 1, updated_at = ?
         WHERE discord_user_id = ?`
      )
      .run(now(), userId);

    // Apply any level that was waiting on this milestone.
    const row = handle.prepare('SELECT * FROM users WHERE discord_user_id = ?').get(userId);
    const settled = trainer.addExp(row, 0);

    handle
      .prepare('UPDATE users SET trainer_level = ?, trainer_exp = ? WHERE discord_user_id = ?')
      .run(settled.level, settled.exp, userId);

    // An Elite Four's member wins are spent once it is cleared, so a prestige
    // starts all four again.
    handle
      .prepare('DELETE FROM elite_four_wins WHERE discord_user_id = ? AND milestone = ?')
      .run(userId, row.milestones_cleared);

    // Every milestone pays Lootboxes, in the same transaction as the clear so
    // it can only be paid once.
    const lootboxes = rates.battle.milestoneLootboxes || 0;
    if (lootboxes > 0) addItem(userId, lootbox.LOOTBOX, lootboxes);

    handle.exec('COMMIT');

    return {
      milestonesCleared: row.milestones_cleared,
      level: settled.level,
      cap: settled.cap,
      levelsGained: settled.levelsGained,
      lootboxes,
    };
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Run the ladder back to the start, keeping everything else.
 *
 * Pokemon, items, coins and quests are kept. The cap drops back to the
 * starting value, so high-level Pokemon stop obeying.
 */
function prestigeTrainer(userId) {
  ensureUser(userId);
  const handle = db.open();

  handle.exec('BEGIN IMMEDIATE');
  try {
    const row = handle.prepare('SELECT * FROM users WHERE discord_user_id = ?').get(userId);
    const reset = trainer.prestige(row);

    handle
      .prepare(
        `UPDATE users
         SET prestige = ?, trainer_level = ?, trainer_exp = ?, milestones_cleared = ?,
             updated_at = ?
         WHERE discord_user_id = ?`
      )
      .run(
        reset.prestige,
        reset.trainer_level,
        reset.trainer_exp,
        reset.milestones_cleared,
        now(),
        userId
      );

    handle.exec('COMMIT');
    return reset;
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }
}

/**
 * The team this player would take into a fight.
 *
 * The first six of their party, in the order `.party` shows them (their saved
 * `.order` preference). Any that won't obey are left out, so the player may
 * battle with fewer than six. `.party suggested` helps pick a team that obeys.
 */
function battleTeam(userId, limit = null) {
  const encounter = require('./encounter');
  const account = ensureUser(userId);
  const cap = trainerCap(userId);

  const rows = listParty(userId, {
    sort: account.party_sort || 'party',
    direction: account.party_direction || 'asc',
    limit: limit || encounter.TEAM_SIZE,
  });

  return {
    cap,
    brought: rows.length,
    ...encounter.playerTeam(rows, (id) => movesOf(id), cap),
  };
}

/**
 * The Pokemon this player should be bringing, best first.
 *
 * Everything that will obey at their cap, highest level first. Used by
 * `.party suggested` and by battle advice.
 */
function suggestedTeam(userId, limit = 12) {
  const cap = trainerCap(userId);

  return listParty(userId, {
    sort: 'level',
    direction: 'desc',
    limit,
    filter: { obeysAtCap: cap },
  });
}

/**
 * Pay out experience and EVs for one knockout, mid-battle.
 *
 * Evolutions and new moves are not handled here; they are worked out once at
 * the end of the battle (see awardBattle).
 *
 * @param {string} userId
 * @param {Array<{id, exp, evs}>} entries  from rewards.forKnockout
 * @returns {Array} one row per Pokemon that actually gained something
 */
function awardKnockout(userId, entries) {
  const handle = db.open();
  const paid = [];

  handle.exec('BEGIN IMMEDIATE');
  try {
    for (const entry of entries || []) {
      const row = handle.prepare('SELECT * FROM pokemon WHERE id = ?').get(entry.id);

      // Skip opponents (negative ids) and missing rows.
      if (!row || row.id < 0) continue;

      const changes = {
        ...rewards.expChanges(row, entry.exp),
        ...rewards.evChanges(row, entry.evs),
      };

      if (!Object.keys(changes).length) continue;

      const before = row.level;
      const after = updatePokemon(row.id, changes);

      paid.push({
        id: row.id,
        name: row.nickname || row.display_name,
        exp: entry.exp,
        level: after.level,
        levelledFrom: after.level > before ? before : null,
      });
    }

    handle.exec('COMMIT');
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }

  return paid;
}

/**
 * Pay out a finished battle.
 *
 * Writes what Utils/rewards.js decided, in one immediate transaction.
 *
 * Does not clear the milestone; that is a separate call so the caller can
 * announce it on its own.
 *
 * @param {string} userId
 * @param {object} payout  from rewards.forBattle
 * @returns {{coins, trainerExp, levelled, pokemon}} what actually happened
 */
function awardBattle(userId, payout) {
  ensureUser(userId);
  const handle = db.open();

  const result = { coins: 0, trainerExp: 0, levelled: null, pokemon: [] };

  handle.exec('BEGIN IMMEDIATE');
  try {
    if (payout.coins > 0) {
      handle
        .prepare('UPDATE users SET coins = coins + ?, updated_at = ? WHERE discord_user_id = ?')
        .run(payout.coins, now(), userId);
      result.coins = payout.coins;
    }

    // Experience was already paid per knockout (awardKnockout). Handle
    // evolutions and new moves; `payout.grew` lists who levelled and from
    // what level.
    for (const entry of payout.grew || []) {
      const row = handle.prepare('SELECT * FROM pokemon WHERE id = ?').get(entry.id);
      if (!row || row.id < 0) continue;

      const before = entry.from;
      let after = row;

      if (after.level <= before) continue;

      // Level-up evolutions. Loops because a big level jump can pass more than
      // one evolution (Caterpie -> Metapod -> Butterfree). Bounded as a
      // safeguard against bad data.
      const evolutions = [];
      const evolvedInto = [];
      let extras = [];

      if (after.level > before) {
        for (let step = 0; step < 3; step += 1) {
          const evolved = evolution.resolve(after, 'level-up', { level: after.level });
          if (!evolved) break;

          const wasCalled = after.nickname || after.display_name;
          after = updatePokemon(after.id, evolved.changes);

          evolutions.push({ from: wasCalled, into: evolved.target.name });
          evolvedInto.push(after);
          if (evolved.alsoCreates) extras.push(evolved.alsoCreates);
        }
      }

      // New level-up and evolution moves. With a free slot the move is
      // learned directly; otherwise the caller asks which move to forget
      // (Utils/moveprompt.js). `.moves <n> learn` can still teach it later,
      // since what it can learn is derived from its level.
      const { learned, offered } = learnMoves(
        row.id,
        learnset.movesOnGrowth({ ...row, level: before }, after, evolvedInto)
      );

      result.pokemon.push({
        id: row.id,
        partyNumber: row.party_number,
        metLevel: row.met_level,
        name: row.nickname || row.display_name,
        level: after.level,
        levelledFrom: after.level > before ? before : null,
        learned,
        offered,
        evolutions,
        // Shedinja is granted after this transaction commits, since granting
        // opens its own transaction.
        pendingExtras: extras,
      });
    }

    handle.exec('COMMIT');
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }

  // Grant any extra Pokemon from evolutions (Shedinja).
  for (const entry of result.pokemon) {
    for (const speciesId of entry.pendingExtras || []) {
      try {
        const born = grantExtraFromEvolution(userId, speciesId, entry.level);
        if (born) result.spawned = [...(result.spawned || []), born];
      } catch (err) {
        console.error('An evolution could not leave its extra behind:', err);
      }
    }
    delete entry.pendingExtras;
  }

  // Trainer experience uses its own transaction (see awardTrainerExp).
  if (payout.trainerExp > 0) {
    result.levelled = awardTrainerExp(userId, payout.trainerExp);
    result.trainerExp = payout.trainerExp;
  }

  recordBattle(userId, Boolean(payout.won));
  return result;
}

// ---------------------------------------------------------------------------
// Moves
// ---------------------------------------------------------------------------

/**
 * What one Pokemon knows, in slot order.
 *
 * Returns the stored rows together with each move's data.
 *
 * @returns {Array<{slot, move, ppUp, data}>} data is null if the move is
 *          missing from Data/Moves
 */
function movesOf(pokemonId) {
  return db
    .open()
    .prepare('SELECT slot, move, pp_up FROM pokemon_moves WHERE pokemon_id = ? ORDER BY slot')
    .all(pokemonId)
    .map((row) => ({
      slot: row.slot,
      move: row.move,
      ppUp: row.pp_up,
      data: content.move(row.move),
    }));
}

/**
 * Replace everything a Pokemon knows.
 *
 * Replaces all slots at once. Anything past the fourth move, and any
 * duplicates, are dropped.
 *
 * @param {Array<{name: string}|string>} moves
 * @returns {number} how many were actually stored
 */
function setMoves(pokemonId, moves) {
  const handle = db.open();

  const wanted = [];
  const seen = new Set();

  for (const entry of moves || []) {
    const name = typeof entry === 'string' ? entry : entry && entry.name;
    if (!name || seen.has(name)) continue;

    seen.add(name);
    wanted.push(name);
    if (wanted.length === learnset.MAX_MOVES) break;
  }

  handle.prepare('DELETE FROM pokemon_moves WHERE pokemon_id = ?').run(pokemonId);

  const insert = handle.prepare(
    'INSERT INTO pokemon_moves (pokemon_id, slot, move) VALUES (?, ?, ?)'
  );

  wanted.forEach((name, index) => insert.run(pokemonId, index + 1, name));

  return wanted.length;
}

/**
 * Teach one move, into a named slot or the first free one.
 *
 * @returns {{ ok: boolean, message?: string, slot?: number, replaced?: string }}
 */
function teachMove(pokemonId, moveName, slot = null) {
  const handle = db.open();

  const known = handle
    .prepare('SELECT slot, move FROM pokemon_moves WHERE pokemon_id = ? ORDER BY slot')
    .all(pokemonId);

  if (known.some((row) => row.move === moveName)) {
    return { ok: false, message: 'It already knows that move.' };
  }

  // No slot given: use the first empty one. If all four are full, fail and
  // let the caller ask which to replace.
  let target = slot;

  if (target === null) {
    const used = new Set(known.map((row) => row.slot));
    for (let i = 1; i <= learnset.MAX_MOVES; i += 1) {
      if (!used.has(i)) {
        target = i;
        break;
      }
    }
  }

  if (target === null) {
    return { ok: false, message: 'It already knows four moves. Say which one to replace.' };
  }

  if (!Number.isInteger(target) || target < 1 || target > learnset.MAX_MOVES) {
    return { ok: false, message: `A move slot is 1 to ${learnset.MAX_MOVES}.` };
  }

  const replaced = (known.find((row) => row.slot === target) || {}).move || null;

  handle
    .prepare(
      `INSERT INTO pokemon_moves (pokemon_id, slot, move) VALUES (?, ?, ?)
       ON CONFLICT(pokemon_id, slot) DO UPDATE SET move = excluded.move, pp_up = 0`
    )
    .run(pokemonId, target, moveName);

  return { ok: true, slot: target, replaced };
}

/**
 * Teach newly earned moves into any free slots.
 *
 * Moves it already knows are skipped. Whatever doesn't fit is returned so the
 * player can be asked which move to forget (Utils/moveprompt.js).
 *
 * @param {Array<{name, displayName}>} moves  in learning order
 * @returns {{ learned: string[], offered: Array<{name, displayName, level, evolution}> }}
 */
function learnMoves(pokemonId, moves) {
  const learned = [];
  const offered = [];

  for (const move of moves) {
    const known = movesOf(pokemonId);
    if (known.some((slot) => slot.move === move.name)) continue;

    if (known.length < learnset.MAX_MOVES) {
      const taught = teachMove(pokemonId, move.name);
      if (taught.ok) learned.push(move.displayName);
    } else {
      offered.push(move);
    }
  }

  return { learned, offered };
}

/** Forget one move, leaving the slot empty. Refuses to leave a Pokemon mute. */
function forgetMove(pokemonId, slot) {
  const handle = db.open();

  const known = handle
    .prepare('SELECT COUNT(*) AS n FROM pokemon_moves WHERE pokemon_id = ?')
    .get(pokemonId).n;

  if (known <= 1) {
    return { ok: false, message: 'It has to know at least one move.' };
  }

  const result = handle
    .prepare('DELETE FROM pokemon_moves WHERE pokemon_id = ? AND slot = ?')
    .run(pokemonId, slot);

  return result.changes
    ? { ok: true }
    : { ok: false, message: `There is nothing in slot ${slot}.` };
}

// ---------------------------------------------------------------------------
// Drops
// ---------------------------------------------------------------------------

/**
 * Store a freshly rolled Pokemon as wild - no trainer yet - and open a drop
 * for it in a channel.
 *
 * @returns {{ pokemonId: number, dropId: number }}
 */
function createDrop(mon, { shiny, gender, shinyNatural = false, guildId, channelId, droppedBy }) {
  const handle = db.open();
  const timestamp = now();

  const inserted = handle
    .prepare(
      `INSERT INTO pokemon (
         species_id, form_folder, form_slug, species_name, species_key, display_name,
         level, exp, nature, ability, ability_slot, gender, shiny, shiny_natural,
         iv_hp, iv_attack, iv_defense, iv_special_attack, iv_special_defense, iv_speed, iv_total,
         stat_hp, stat_attack, stat_defense, stat_special_attack, stat_special_defense, stat_speed,
         current_hp, bst, types, region, rarity, acquired_method, created_at
       ) VALUES (
         ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?, ?
       )`
    )
    .run(
      mon.speciesId,
      mon.formFolder,
      mon.formSlug,
      mon.speciesName,
      normaliseName(mon.speciesName),
      mon.displayName,
      mon.level,
      mon.experience,
      mon.nature.name,
      mon.ability ? mon.ability.name : '',
      mon.ability ? mon.ability.slot : 1,
      gender,
      shiny ? 1 : 0,
      shiny && shinyNatural ? 1 : 0,
      mon.ivs.hp,
      mon.ivs.attack,
      mon.ivs.defense,
      mon.ivs.specialAttack,
      mon.ivs.specialDefense,
      mon.ivs.speed,
      mon.ivTotal,
      mon.stats.hp,
      mon.stats.attack,
      mon.stats.defense,
      mon.stats.specialAttack,
      mon.stats.specialDefense,
      mon.stats.speed,
      mon.stats.hp,
      mon.bst,
      mon.types.join(','),
      mon.region,
      rarity.of(mon.speciesId),
      'drop',
      timestamp
    );

  const pokemonId = Number(inserted.lastInsertRowid);

  // Assign moves here, since every new Pokemon (drops and grants) is created
  // through this function.
  setMoves(pokemonId, learnset.movesAtLevel(mon.speciesId, mon.formFolder, mon.level));

  const drop = handle
    .prepare(
      `INSERT INTO drops (pokemon_id, guild_id, channel_id, dropped_by, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(pokemonId, guildId, channelId, droppedBy, timestamp);

  return { pokemonId, dropId: Number(drop.lastInsertRowid) };
}

/** Remember which message an embed went out as, so a catch can link back to it. */
function attachDropMessage(dropId, messageId) {
  db.open().prepare('UPDATE drops SET message_id = ? WHERE id = ?').run(messageId, dropId);
}

/**
 * Retire whatever is still on the board in a channel.
 *
 * There is one live drop per channel. Old drops are marked as despawned
 * rather than deleted, so their history is kept.
 *
 * @returns {number} how many were retired
 */
function despawnChannelDrops(channelId, exceptDropId = null) {
  const result = db
    .open()
    .prepare(
      `UPDATE drops SET despawned_at = ?
       WHERE channel_id = ? AND caught_by IS NULL AND despawned_at IS NULL
         AND (? IS NULL OR id != ?)`
    )
    .run(now(), channelId, exceptDropId, exceptDropId);

  return result.changes;
}

/**
 * Find a claimable drop in this channel matching a typed name.
 *
 * Names are resolved through Utils/names.js, so localised names and custom
 * aliases work. An ambiguous name may match several species, but only one
 * can be the current drop.
 */
function findOpenDropByName(channelId, name) {
  const candidates = names.resolveKeys(name);
  if (!candidates.length) return null;

  const placeholders = candidates.map(() => '?').join(', ');

  return (
    db
      .open()
      .prepare(
        `SELECT d.id AS drop_id, d.message_id, d.dropped_by, p.*
         FROM drops d
         JOIN pokemon p ON p.id = d.pokemon_id
         WHERE d.channel_id = ?
           AND d.caught_by IS NULL
           AND d.despawned_at IS NULL
           AND p.species_key IN (${placeholders})
         ORDER BY d.id DESC
         LIMIT 1`
      )
      .get(channelId, ...candidates) || null
  );
}

/** The most recent claimable drop in a channel, whatever it is. */
function newestOpenDrop(channelId) {
  return (
    db
      .open()
      .prepare(
        `SELECT d.id AS drop_id, d.message_id, d.dropped_by, p.*
         FROM drops d
         JOIN pokemon p ON p.id = d.pokemon_id
         WHERE d.channel_id = ? AND d.caught_by IS NULL AND d.despawned_at IS NULL
         ORDER BY d.id DESC
         LIMIT 1`
      )
      .get(channelId) || null
  );
}

/**
 * Hand a drop to a user.
 *
 * The UPDATE only matches while caught_by is NULL, so if two people answer at
 * once, exactly one wins.
 *
 * @returns {boolean} whether this caller got it
 */
function claimDrop(dropId, userId) {
  const handle = db.open();
  ensureUser(userId);

  const timestamp = now();
  handle.exec('BEGIN IMMEDIATE');

  try {
    const claimed = handle
      .prepare('UPDATE drops SET caught_by = ?, caught_at = ? WHERE id = ? AND caught_by IS NULL')
      .run(userId, timestamp, dropId);

    if (claimed.changes !== 1) {
      handle.exec('ROLLBACK');
      return false;
    }

    // COALESCE so met data is only ever written once.
    handle
      .prepare(
        `UPDATE pokemon
         SET original_trainer_id = COALESCE(original_trainer_id, ?),
             current_trainer_id = ?,
             party_number = ?,
             acquired_at = ?,
             met_level = COALESCE(met_level, level),
             met_channel_id =
               COALESCE(met_channel_id, (SELECT channel_id FROM drops WHERE id = ?)),
             met_guild_id =
               COALESCE(met_guild_id, (SELECT guild_id FROM drops WHERE id = ?)),
             met_at = COALESCE(met_at, ?)
         WHERE id = (SELECT pokemon_id FROM drops WHERE id = ?)`
      )
      .run(
        userId, userId, takePartyNumber(handle, userId), timestamp,
        dropId, dropId, timestamp, dropId
      );

    handle
      .prepare(
        'UPDATE users SET total_caught = total_caught + 1, updated_at = ? WHERE discord_user_id = ?'
      )
      .run(timestamp, userId);

    handle.exec('COMMIT');
    return true;
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Party
// ---------------------------------------------------------------------------

/**
 * Take the next party number for a user, and move their high-water mark on.
 *
 * Must be called inside the caller's transaction, after ensureUser, so it
 * commits or rolls back together with the ownership change.
 *
 * Numbers are never reused, so a released or traded Pokemon's number is
 * retired. The unique index in db.js enforces uniqueness.
 */
function takePartyNumber(handle, userId) {
  const row = handle
    .prepare('SELECT next_party_number FROM users WHERE discord_user_id = ?')
    .get(userId);

  const number = row ? row.next_party_number : 1;

  handle
    .prepare('UPDATE users SET next_party_number = ?, updated_at = ? WHERE discord_user_id = ?')
    .run(number + 1, now(), userId);

  return number;
}

/** Columns a user is allowed to sort their party by, mapped to real SQL. */
const SORT_COLUMNS = {
  // The party number (the default sort).
  party: 'p.party_number',

  id: 'p.id',
  dex: 'p.species_id',
  name: 'p.display_name',
  level: 'p.level',
  iv: 'p.iv_total',
  bst: 'p.bst',
  hp: 'p.stat_hp',
  attack: 'p.stat_attack',
  defense: 'p.stat_defense',
  speed: 'p.stat_speed',
  shiny: 'p.shiny',
  caught: 'p.acquired_at',

  // The custom order from .order and .party swap. NULL positions sort last.
  custom: 'CASE WHEN p.party_position IS NULL THEN 1 ELSE 0 END, p.party_position',
};

/**
 * Turn a filter object into a SQL fragment and its parameters.
 *
 * Only fixed strings and bound parameters are used.
 */
function partyWhere(userId, filter = {}) {
  const clauses = ['p.current_trainer_id = ?'];
  const params = [userId];

  if (filter.shiny) clauses.push('p.shiny = 1');

  if (filter.rarity) {
    clauses.push('p.rarity = ?');
    params.push(filter.rarity);
  }

  if (filter.speciesKeys && filter.speciesKeys.length) {
    clauses.push(`p.species_key IN (${filter.speciesKeys.map(() => '?').join(', ')})`);
    params.push(...filter.speciesKeys);
  }

  // ".p lvl 40-50". Either bound may be missing.
  if (Number.isInteger(filter.minLevel)) {
    clauses.push('p.level >= ?');
    params.push(filter.minLevel);
  }

  if (Number.isInteger(filter.maxLevel)) {
    clauses.push('p.level <= ?');
    params.push(filter.maxLevel);
  }

  // ".p suggested": the SQL fragment comes from Utils/obedience.js.
  if (Number.isInteger(filter.obeysAtCap)) {
    const rule = obedience.sqlFilter(filter.obeysAtCap, 'p');
    clauses.push(rule.sql);
    params.push(...rule.params);
  }

  return { sql: clauses.join(' AND '), params };
}

/**
 * A user's Pokemon.
 *
 * `sort` is looked up in SORT_COLUMNS rather than interpolated. `filter`
 * narrows the list (".p shiny", ".p name:" and so on).
 */
function listParty(
  userId,
  { sort = 'id', direction = 'asc', limit = 20, offset = 0, filter = {} } = {}
) {
  const column = SORT_COLUMNS[sort] || SORT_COLUMNS.id;
  const order = String(direction).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const where = partyWhere(userId, filter);

  return db
    .open()
    .prepare(
      `SELECT p.* FROM pokemon p
       WHERE ${where.sql}
       ORDER BY ${column} ${order}, p.id ASC
       LIMIT ? OFFSET ?`
    )
    .all(...where.params, limit, offset);
}

function countParty(userId, filter = {}) {
  const where = partyWhere(userId, filter);
  return db
    .open()
    .prepare(`SELECT COUNT(*) AS total FROM pokemon p WHERE ${where.sql}`)
    .get(...where.params).total;
}

/**
 * How many of each species a user owns, most-owned first.
 *
 * Used by .count and the flexdex sort.
 */
function speciesCounts(userId) {
  return db
    .open()
    .prepare(
      `SELECT species_id, species_key, species_name, display_name, rarity, COUNT(*) AS total
       FROM pokemon
       WHERE current_trainer_id = ?
       GROUP BY species_id
       ORDER BY total DESC, species_id ASC`
    )
    .all(userId);
}

/**
 * How many of one species a user owns, in total and per form. Counted in SQL,
 * since parties can be very large.
 *
 * @returns {{ total: number, byForm: Map<string, number> }}
 */
function countOwned(userId, speciesId) {
  const rows = db
    .open()
    .prepare(
      `SELECT form_folder, COUNT(*) AS n FROM pokemon
       WHERE current_trainer_id = ? AND species_id = ?
       GROUP BY form_folder`
    )
    .all(userId, speciesId);

  const byForm = new Map();
  let total = 0;

  for (const row of rows) {
    byForm.set(row.form_folder, row.n);
    total += row.n;
  }

  return { total, byForm };
}

/** The set of species ids a user currently owns. Used by .uncaught and .compare. */
function caughtSpeciesIds(userId) {
  const rows = db
    .open()
    .prepare('SELECT DISTINCT species_id FROM pokemon WHERE current_trainer_id = ?')
    .all(userId);

  return new Set(rows.map((row) => row.species_id));
}

/**
 * Give every Pokemon in a user's party an explicit position, in whatever
 * order they are currently displayed.
 *
 * Used by .order and .party swap. Runs in one transaction.
 */
function assignPartyPositions(userId, pokemonIds) {
  const handle = db.open();
  const update = handle.prepare(
    'UPDATE pokemon SET party_position = ? WHERE id = ? AND current_trainer_id = ?'
  );

  handle.exec('BEGIN IMMEDIATE');
  try {
    pokemonIds.forEach((id, i) => update.run(i + 1, id, userId));
    handle.exec('COMMIT');
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }

  return pokemonIds.length;
}

/**
 * Swap the positions of two Pokemon, given by party number. The party numbers
 * themselves don't change.
 *
 * If the party has no custom order yet, positions are assigned first.
 *
 * @returns {{ ok: boolean, message?: string, moved?: object[] }}
 */
function swapPartyPositions(userId, first, second) {
  if (first === second) return { ok: false, message: 'Those are the same Pokemon.' };

  for (const number of [first, second]) {
    if (!Number.isInteger(number) || number < 1) {
      return { ok: false, message: 'Swap which two? Try `.p swap 1 10`, using the numbers from `.party`.' };
    }
  }

  const ordered = listParty(userId, { sort: 'custom', limit: -1, offset: 0 });
  if (ordered.length < 2) return { ok: false, message: 'You need at least two Pokemon to swap.' };

  const indexOf = (number) => ordered.findIndex((row) => row.party_number === number);
  const a = indexOf(first);
  const b = indexOf(second);

  const missing = a === -1 ? first : b === -1 ? second : null;
  if (missing !== null) return { ok: false, message: noSuchNumber(userId, missing) };

  const ids = ordered.map((row) => row.id);
  [ids[a], ids[b]] = [ids[b], ids[a]];
  assignPartyPositions(userId, ids);

  return { ok: true, moved: [ordered[b], ordered[a]] };
}

/**
 * One of a user's Pokemon by its global id (used internally by trades, drops
 * and quests). For numbers a user types, use getOwnedByNumber.
 *
 * Ownership is part of the query.
 */
function getOwnedPokemon(userId, pokemonId) {
  return (
    db
      .open()
      .prepare('SELECT * FROM pokemon WHERE id = ? AND current_trainer_id = ?')
      .get(pokemonId, userId) || null
  );
}

/**
 * One of a user's Pokemon by the party number shown in .party.
 *
 * Use this for any number a user types. Ownership is part of the query, since
 * every player has their own #4.
 */
function getOwnedByNumber(userId, partyNumber) {
  if (!Number.isInteger(partyNumber)) return null;

  return (
    db
      .open()
      .prepare('SELECT * FROM pokemon WHERE current_trainer_id = ? AND party_number = ?')
      .get(userId, partyNumber) || null
  );
}

/**
 * Turn what somebody typed into a party number.
 *
 * "#12", "12" and " 12 " are all 12. Anything else, including 0 and
 * negatives, is null.
 */
function parsePartyNumber(raw) {
  const number = parseInt(String(raw ?? '').replace(/^#/, '').trim(), 10);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/** The biggest party number a user is currently using, for error messages. */
function highestPartyNumber(userId) {
  const row = db
    .open()
    .prepare('SELECT MAX(party_number) AS n FROM pokemon WHERE current_trainer_id = ?')
    .get(userId);

  return (row && row.n) || 0;
}

/**
 * What to say when a party number points at nothing.
 *
 * Since numbers are never reused, the reply also mentions the range they do
 * have and points to .party.
 */
function noSuchNumber(userId, number) {
  const highest = highestPartyNumber(userId);

  if (!highest) return 'You have not caught anything yet. Type `.d` to drop one.';

  return (
    `You have no #${number}. Your numbers go up to ${highest} ` +
    '- `.party` lists them, and they are not always contiguous, because a ' +
    'number retires with the Pokemon that had it.'
  );
}

/** The most recent catch, which is what .view defaults to. */
function latestCaught(userId) {
  return (
    db
      .open()
      .prepare(
        `SELECT * FROM pokemon WHERE current_trainer_id = ?
         ORDER BY acquired_at DESC, id DESC LIMIT 1`
      )
      .get(userId) || null
  );
}

/**
 * Write changes to a Pokemon and keep its stats consistent.
 *
 * Stats are stored for sorting, so they are recomputed here whenever level,
 * EVs or form change.
 */
function updatePokemon(pokemonId, changes) {
  const handle = db.open();
  const row = handle.prepare('SELECT * FROM pokemon WHERE id = ?').get(pokemonId);
  if (!row) return null;

  const touchesStats = Object.keys(changes).some(
    (key) =>
      key === 'level' ||
      key === 'nature' ||
      key === 'species_id' ||
      key === 'form_folder' ||
      key.startsWith('ev_') ||
      key.startsWith('iv_')
  );

  const full = touchesStats
    ? { ...changes, ...recalculateStats(row, changes) }
    : { ...changes };

  // Keep current HP inside the new maximum.
  if (full.stat_hp != null) {
    full.current_hp = Math.min(row.current_hp, full.stat_hp);
    if (changes.level != null && changes.level > row.level) full.current_hp = full.stat_hp;
  }

  const columns = Object.keys(full);
  if (!columns.length) return row;

  handle
    .prepare(`UPDATE pokemon SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
    .run(...columns.map((c) => full[c]), pokemonId);

  return handle.prepare('SELECT * FROM pokemon WHERE id = ?').get(pokemonId);
}

/**
 * Let a Pokemon go.
 *
 * The row is kept (with released_at set) rather than deleted, so drop history
 * and the original trainer are preserved.
 *
 * @returns {boolean} whether it was theirs to release
 */
function releasePokemon(userId, pokemonId) {
  const changed = db
    .open()
    .prepare(
      `UPDATE pokemon
       SET current_trainer_id = NULL, released_at = ?, equipped_item = NULL,
           party_number = NULL
       WHERE id = ? AND current_trainer_id = ? AND released_at IS NULL`
    )
    .run(now(), pokemonId, userId);

  return changed.changes === 1;
}

/**
 * Create the extra Pokemon an evolution produces (only Shedinja, from Nincada
 * evolving into Ninjask).
 *
 * @returns {object|null} the new row, or null if the species will not resolve
 */
function grantExtraFromEvolution(userId, speciesId, level = 20) {
  const { loadSpecies, loadForm, createPokemon } = require('./pokemon');

  const species = loadSpecies(speciesId);
  if (!species) return null;

  const forms = species.forms || [];
  const form = forms.find((f) => f.percentage > 0) || forms[0];
  if (!form) return null;

  const formData = loadForm(speciesId, form.folder);
  if (!formData) return null;

  const mon = createPokemon(species, formData, { level });
  return grantPokemon(userId, mon, { gender: 'genderless', method: 'evolution' });
}

/**
 * Create a Pokemon directly in someone's party, with no drop involved (for
 * Pokemon that are granted rather than caught).
 */
function grantPokemon(userId, mon, { shiny = false, gender = 'genderless', method = 'evolution' } = {}) {
  const handle = db.open();
  const timestamp = now();

  // Reuse the drop insert, then hand it over and mark how it was acquired.
  const { pokemonId } = createDrop(mon, {
    shiny,
    gender,
    guildId: null,
    channelId: `grant:${method}`,
    droppedBy: userId,
  });

  ensureUser(userId);

  handle.exec('BEGIN IMMEDIATE');
  try {
    handle
      .prepare(
        `UPDATE pokemon
         SET current_trainer_id = ?, original_trainer_id = ?, party_number = ?,
             acquired_method = ?, acquired_at = ?,
             met_level = COALESCE(met_level, level),
             met_at = COALESCE(met_at, ?)
         WHERE id = ?`
      )
      .run(
        userId, userId, takePartyNumber(handle, userId), method, timestamp,
        timestamp, pokemonId
      );
    handle.exec('COMMIT');
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }

  // There is no real drop behind it, so close the one createDrop opened.
  handle
    .prepare("UPDATE drops SET caught_by = ?, caught_at = ? WHERE pokemon_id = ?")
    .run(userId, timestamp, pokemonId);

  return handle.prepare('SELECT * FROM pokemon WHERE id = ?').get(pokemonId);
}

/** Remember how this player likes their party sorted. */
function setPartyOrder(userId, sort, direction) {
  ensureUser(userId);
  db.open()
    .prepare(
      'UPDATE users SET party_sort = ?, party_direction = ?, updated_at = ? WHERE discord_user_id = ?'
    )
    .run(sort, direction, now(), userId);
}

// ---------------------------------------------------------------------------
// Trading
// ---------------------------------------------------------------------------

/** Mark any offer whose time is up, so nothing stale is ever acted on. */
function expireTrades() {
  db.open()
    .prepare("UPDATE trades SET status = 'expired', settled_at = ? WHERE status = 'open' AND expires_at <= ?")
    .run(now(), now());
}

/** Is this Pokemon already promised to someone? */
function pendingTradeFor(pokemonId) {
  expireTrades();
  return (
    db
      .open()
      .prepare("SELECT * FROM trades WHERE offered_pokemon = ? AND status = 'open'")
      .get(pokemonId) || null
  );
}

/** Create an offer. Nothing moves until it is accepted. */
function createTrade({ fromUserId, toUserId, offeredPokemon, wantedPokemon, channelId, ttlMs }) {
  ensureUser(fromUserId);
  ensureUser(toUserId);

  const timestamp = now();
  const inserted = db
    .open()
    .prepare(
      `INSERT INTO trades
         (from_user_id, to_user_id, offered_pokemon, wanted_pokemon, channel_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(fromUserId, toUserId, offeredPokemon, wantedPokemon ?? null, channelId, timestamp, timestamp + ttlMs);

  return Number(inserted.lastInsertRowid);
}

/** The offer waiting for this user from that one, if any. */
function openTradeTo(toUserId, fromUserId = null) {
  expireTrades();

  const handle = db.open();
  return (
    (fromUserId
      ? handle
          .prepare(
            "SELECT * FROM trades WHERE to_user_id = ? AND from_user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1"
          )
          .get(toUserId, fromUserId)
      : handle
          .prepare(
            "SELECT * FROM trades WHERE to_user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1"
          )
          .get(toUserId)) || null
  );
}

/** An offer this user has made and could still take back. */
function openTradeFrom(fromUserId) {
  expireTrades();
  return (
    db
      .open()
      .prepare("SELECT * FROM trades WHERE from_user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1")
      .get(fromUserId) || null
  );
}

function settleTrade(tradeId, status) {
  return (
    db
      .open()
      .prepare("UPDATE trades SET status = ?, settled_at = ? WHERE id = ? AND status = 'open'")
      .run(status, now(), tradeId).changes === 1
  );
}

/**
 * Carry out a trade.
 *
 * Both sides move in one transaction, and every UPDATE re-checks ownership,
 * so the trade fails cleanly if anything changed since the offer.
 *
 * The original trainer is kept. Held items travel with the Pokemon.
 *
 * @returns {{ ok: boolean, reason?: string }}
 */
function executeTrade(trade) {
  const handle = db.open();
  handle.exec('BEGIN IMMEDIATE');

  try {
    const claim = handle.prepare(
      `UPDATE pokemon SET current_trainer_id = ?, party_number = ?
       WHERE id = ? AND current_trainer_id = ? AND released_at IS NULL`
    );

    // A traded Pokemon keeps its id and gets a new party number from its new
    // owner. ensureUser first, since takePartyNumber needs the user row.
    ensureUser(trade.to_user_id);
    ensureUser(trade.from_user_id);

    // The offered Pokemon goes to the person accepting.
    const toNumber = takePartyNumber(handle, trade.to_user_id);
    if (claim.run(trade.to_user_id, toNumber, trade.offered_pokemon, trade.from_user_id).changes !== 1) {
      handle.exec('ROLLBACK');
      return { ok: false, reason: 'The offered Pokemon is no longer available.' };
    }

    // ...and theirs comes back the other way, if this is a swap rather than a gift.
    if (trade.wanted_pokemon) {
      const fromNumber = takePartyNumber(handle, trade.from_user_id);
      if (claim.run(trade.from_user_id, fromNumber, trade.wanted_pokemon, trade.to_user_id).changes !== 1) {
        handle.exec('ROLLBACK');
        return { ok: false, reason: 'Your side of the trade is no longer available.' };
      }
    }

    if (
      handle
        .prepare("UPDATE trades SET status = 'accepted', settled_at = ? WHERE id = ? AND status = 'open'")
        .run(now(), trade.id).changes !== 1
    ) {
      handle.exec('ROLLBACK');
      return { ok: false, reason: 'That trade was already settled.' };
    }

    handle.exec('COMMIT');
    return { ok: true };
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Leaderboards
// ---------------------------------------------------------------------------

/** What the leaderboard can rank by, and how each one reads. */
const LEADERBOARDS = {
  caught: {
    label: 'Pokemon caught',
    sql: `SELECT discord_user_id AS id, total_caught AS score FROM users
          WHERE total_caught > 0 ORDER BY score DESC, discord_user_id ASC LIMIT ?`,
  },
  party: {
    label: 'Party size',
    sql: `SELECT current_trainer_id AS id, COUNT(*) AS score FROM pokemon
          WHERE current_trainer_id IS NOT NULL
          GROUP BY current_trainer_id ORDER BY score DESC, id ASC LIMIT ?`,
  },
  shinies: {
    label: 'Shinies',
    sql: `SELECT current_trainer_id AS id, COUNT(*) AS score FROM pokemon
          WHERE current_trainer_id IS NOT NULL AND shiny = 1
          GROUP BY current_trainer_id ORDER BY score DESC, id ASC LIMIT ?`,
  },
  coins: {
    label: 'Coins',
    sql: `SELECT discord_user_id AS id, coins AS score FROM users
          WHERE coins > 0 ORDER BY score DESC, discord_user_id ASC LIMIT ?`,
  },
  gold: {
    label: 'Gold',
    sql: `SELECT discord_user_id AS id, gold AS score FROM users
          WHERE gold > 0 ORDER BY score DESC, discord_user_id ASC LIMIT ?`,
  },
  level: {
    label: 'Highest level Pokemon',
    sql: `SELECT current_trainer_id AS id, MAX(level) AS score FROM pokemon
          WHERE current_trainer_id IS NOT NULL
          GROUP BY current_trainer_id ORDER BY score DESC, id ASC LIMIT ?`,
  },
  iv: {
    label: 'Best IVs',
    sql: `SELECT current_trainer_id AS id, MAX(iv_total) AS score FROM pokemon
          WHERE current_trainer_id IS NOT NULL
          GROUP BY current_trainer_id ORDER BY score DESC, id ASC LIMIT ?`,
  },

  // Rarity boards, using the stored rarity column.
  legendary: {
    label: 'Legendaries',
    sql: `SELECT current_trainer_id AS id, COUNT(*) AS score FROM pokemon
          WHERE current_trainer_id IS NOT NULL AND rarity = 'legendary'
          GROUP BY current_trainer_id ORDER BY score DESC, id ASC LIMIT ?`,
  },
  mythical: {
    label: 'Mythicals',
    sql: `SELECT current_trainer_id AS id, COUNT(*) AS score FROM pokemon
          WHERE current_trainer_id IS NOT NULL AND rarity = 'mythical'
          GROUP BY current_trainer_id ORDER BY score DESC, id ASC LIMIT ?`,
  },
  ultrabeast: {
    label: 'Ultra Beasts',
    sql: `SELECT current_trainer_id AS id, COUNT(*) AS score FROM pokemon
          WHERE current_trainer_id IS NOT NULL AND rarity = 'ultraBeast'
          GROUP BY current_trainer_id ORDER BY score DESC, id ASC LIMIT ?`,
  },

  // Distinct species owned, as opposed to party size.
  pokedex: {
    label: 'Pokedex completion',
    sql: `SELECT current_trainer_id AS id, COUNT(DISTINCT species_id) AS score FROM pokemon
          WHERE current_trainer_id IS NOT NULL
          GROUP BY current_trainer_id ORDER BY score DESC, id ASC LIMIT ?`,
  },

  // The only board ranking guilds rather than users. Counted from drops,
  // since the guild is recorded on the drop; Pokemon without a drop record
  // are not counted.
  server: {
    label: 'Catches by server',
    guilds: true,
    sql: `SELECT guild_id AS id, COUNT(*) AS score FROM drops
          WHERE caught_by IS NOT NULL AND guild_id IS NOT NULL
          GROUP BY guild_id ORDER BY score DESC, id ASC LIMIT ?`,
  },
};

/**
 * Who owns the most of one species.
 *
 * ".lb pikachu". Separate from LEADERBOARDS because it takes an argument. Keys
 * are bound as parameters, and an empty list returns early.
 */
function speciesLeaderboard(speciesKeys, limit = 10) {
  if (!speciesKeys || !speciesKeys.length) return [];

  return db
    .open()
    .prepare(
      `SELECT current_trainer_id AS id, COUNT(*) AS score FROM pokemon
       WHERE current_trainer_id IS NOT NULL
         AND species_key IN (${speciesKeys.map(() => '?').join(', ')})
       GROUP BY current_trainer_id ORDER BY score DESC, id ASC LIMIT ?`
    )
    .all(...speciesKeys, limit);
}

/** Top players by one measure. The board name is looked up, never interpolated. */
function leaderboard(board, limit = 10) {
  const entry = LEADERBOARDS[board] || LEADERBOARDS.caught;
  return db.open().prepare(entry.sql).all(limit);
}

/** Where one player sits on a board, or null if they are not on it. */
function leaderboardRank(board, userId) {
  const all = leaderboard(board, 1000);
  const index = all.findIndex((row) => row.id === userId);
  return index < 0 ? null : { rank: index + 1, score: all[index].score, of: all.length };
}

/** Rename a Pokemon, or clear the nickname by passing null. */
function setNickname(userId, pokemonId, nickname) {
  const changed = db
    .open()
    .prepare('UPDATE pokemon SET nickname = ? WHERE id = ? AND current_trainer_id = ?')
    .run(nickname, pokemonId, userId);

  return changed.changes === 1;
}

module.exports = {
  learnMoves,
  eliteFourBeaten,
  recordEliteFourWin,
  ensureUser,
  getUser,
  addCoins,
  cooldownRemaining,
  startDropCooldown,
  toggleRemind,
  remindEnabled,
  pendingReminders,
  buffValue,
  setBuff,
  activeBuffs,
  trainerProgress,
  trainerCap,
  awardTrainerExp,
  recordBattle,
  clearMilestone,
  prestigeTrainer,
  battleTeam,
  suggestedTeam,
  awardKnockout,
  awardBattle,
  movesOf,
  setMoves,
  teachMove,
  forgetMove,
  createDrop,
  attachDropMessage,
  findOpenDropByName,
  newestOpenDrop,
  despawnChannelDrops,
  claimDrop,
  awardCatchCoins,
  addGold,
  spend,
  addItem,
  removeItem,
  itemQuantity,
  adjustCurrency,
  adjustItem,
  listInventory,
  setBagOrder,
  assignInventoryPositions,
  swapInventoryPositions,
  trashItem,
  BAG_SORTS,
  equipSlot,
  unequipSlot,
  activeSlots,
  consumeSlots,
  SLOT_COLUMNS,
  updatePokemon,
  getOwnedPokemon,
  getOwnedByNumber,
  parsePartyNumber,
  highestPartyNumber,
  noSuchNumber,
  takePartyNumber,
  latestCaught,
  setNickname,
  releasePokemon,
  grantPokemon,
  grantExtraFromEvolution,
  expireTrades,
  pendingTradeFor,
  createTrade,
  openTradeTo,
  openTradeFrom,
  settleTrade,
  executeTrade,
  setPartyOrder,
  leaderboard,
  leaderboardRank,
  speciesLeaderboard,
  LEADERBOARDS,
  listParty,
  countParty,
  speciesCounts,
  countOwned,
  caughtSpeciesIds,
  assignPartyPositions,
  swapPartyPositions,
  SORT_COLUMNS,
};
