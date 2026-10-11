'use strict';

/**
 * Working out how far along a quest somebody is.
 *
 * One evaluator for both shapes of quest:
 *
 *   requires  a list of { dex, form? } - progress is how many are owned
 *   goal      a counter - { kind, count, type? } - progress is the counter
 *
 * Goal kinds (achievements are implemented as goal quests):
 *
 *   total-caught   how many Pokemon caught, ever
 *   type-caught    how many of one type caught
 *   coins-spent    coins spent, ever
 *   shiny-caught   shinies caught. With `withoutIncense: true` only natural
 *                  shinies count (the Shiny Dropper rule).
 *
 * Nothing here touches the database. A caller builds a snapshot once and
 * evaluates every quest against it, which keeps full recalculation cheap.
 */

const db = require('./db');

/**
 * Everything about a player that any quest could ask about.
 *
 * `owned` holds "dex" and "dex:form" keys, so a requirement can ask for a
 * species or for one specific form of it and both are a set lookup.
 */
function snapshot(userId) {
  const handle = db.open();

  const user = handle
    .prepare('SELECT total_caught, total_spent FROM users WHERE discord_user_id = ?')
    .get(userId) || { total_caught: 0, total_spent: 0 };

  const rows = handle
    .prepare(
      `SELECT species_id, form_folder, shiny, shiny_natural, types
       FROM pokemon WHERE current_trainer_id = ?`
    )
    .all(userId);

  const owned = new Set();
  const typeCounts = new Map();
  let shinyCaught = 0;
  let shinyNaturalCaught = 0;

  for (const row of rows) {
    owned.add(String(row.species_id));
    owned.add(`${row.species_id}:${row.form_folder}`);

    if (row.shiny) shinyCaught += 1;
    if (row.shiny && row.shiny_natural) shinyNaturalCaught += 1;

    for (const type of String(row.types || '').split(',')) {
      if (!type) continue;
      typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
    }
  }

  return {
    owned,
    typeCounts,
    shinyCaught,
    shinyNaturalCaught,
    // total_caught includes released Pokemon, unlike the party size.
    totalCaught: user.total_caught || 0,
    totalSpent: user.total_spent || 0,
    partySize: rows.length,
  };
}

/** How many of a requires-list the player owns. */
function countOwned(requires, snap) {
  let have = 0;
  for (const entry of requires) {
    const key = entry.form ? `${entry.dex}:${entry.form}` : String(entry.dex);
    if (snap.owned.has(key)) have += 1;
  }
  return have;
}

/** The current value of a counter goal. */
function goalValue(goal, snap) {
  switch (goal.kind) {
    case 'total-caught':
      return snap.totalCaught;
    case 'coins-spent':
      return snap.totalSpent;
    case 'shiny-caught':
      // `withoutIncense`: shinies from a Shiny Incense don't count, whoever
      // paid for it.
      return goal.withoutIncense ? snap.shinyNaturalCaught : snap.shinyCaught;
    case 'type-caught':
      return snap.typeCounts.get(String(goal.type || '').toLowerCase()) || 0;
    default:
      return 0;
  }
}

/**
 * Evaluate one quest.
 *
 * @returns {{ progress: number, required: number, complete: boolean }}
 */
function evaluate(quest, snap) {
  if (quest.goal) {
    const required = Math.max(1, quest.goal.count || 1);
    const progress = Math.min(goalValue(quest.goal, snap), required);
    return { progress, required, complete: progress >= required };
  }

  const requires = quest.requires || [];
  const required = Math.max(1, Math.min(quest.count || requires.length, requires.length));
  const progress = Math.min(countOwned(requires, snap), required);

  return { progress, required, complete: progress >= required };
}

/** Which requirements of a quest are still missing. Behind .questprogress. */
function missing(quest, snap) {
  if (!quest.requires) return [];
  return quest.requires.filter((entry) => {
    const key = entry.form ? `${entry.dex}:${entry.form}` : String(entry.dex);
    return !snap.owned.has(key);
  });
}

module.exports = { snapshot, evaluate, missing, countOwned, goalValue };
