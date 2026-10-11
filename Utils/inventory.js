'use strict';

/**
 * The bag as the player sees it - numbered slots, in their chosen order.
 *
 * Commands like ".trash 3", ".examine 3" and ".is swap 1 4" use slot numbers,
 * so the ordering lives here where every command shares it.
 *
 * resolve() accepts a slot number or a name. A bare number is a slot;
 * anything else is matched against the slug and display name.
 */

const content = require('./content');
const store = require('./store');
const { foldName } = require('./names');
const { titleCase } = require('./display');

/**
 * The shop's own running order, as a slug -> rank map.
 *
 * Used by the "shop" sort, which groups related items (stones, Mega Stones)
 * together.
 *
 * Rebuilt on every call so it stays correct after content.reload().
 */
function shopIndex() {
  const index = new Map();
  let rank = 0;

  for (const section of content.shop().sections || []) {
    for (const entry of section.items || []) {
      if (!index.has(entry.item)) index.set(entry.item, rank++);
    }
  }

  return index;
}

/** An item's display name, falling back to its slug for unknown items. */
function itemName(slug) {
  const item = content.item(slug);
  return item ? item.displayName : titleCase(slug);
}

/**
 * A user's bag, numbered from 1.
 *
 * @param {string} userId
 * @param {string} [sort]  overrides their saved preference for this one call
 * @returns {object[]} { slot, item, quantity, meta, displayName, category }
 */
function bagRows(userId, sort = null) {
  const user = store.getUser(userId);
  const wanted = sort || (user ? user.bag_sort : 'shop');

  let rows = store.listInventory(userId, wanted);

  // Shop order is applied here rather than in SQL. Items the shop doesn't
  // sell (such as quest rewards) sort after the rest, alphabetically.
  if (wanted === 'shop') {
    const index = shopIndex();
    const rank = (slug) => (index.has(slug) ? index.get(slug) : index.size);
    rows = [...rows].sort((a, b) => rank(a.item) - rank(b.item) || a.item.localeCompare(b.item));
  }

  return rows.map((row, i) => {
    const meta = content.item(row.item);
    return {
      slot: i + 1,
      item: row.item,
      quantity: row.quantity,
      position: row.position,
      meta,
      displayName: meta ? meta.displayName : titleCase(row.item),
      category: meta ? titleCase(meta.category || 'other') : 'Other',
    };
  });
}

/**
 * Find one row of a bag from what the user typed.
 *
 * Tried in order: slot number, exact slug, exact display name, then a unique
 * prefix. An ambiguous prefix is reported as an error rather than guessed.
 *
 * @returns {{ row?: object, error?: string }}
 */
function resolve(rows, query) {
  const text = String(query ?? '').trim();
  if (!text) return { error: 'Which item? Give me its number from `.bag`, or its name.' };

  // A bare number is always a slot, never a name.
  if (/^\d+$/.test(text)) {
    const slot = parseInt(text, 10);
    const row = rows.find((r) => r.slot === slot);
    if (row) return { row };

    return {
      error: rows.length
        ? `Your bag has ${rows.length} slot${rows.length === 1 ? '' : 's'}, so there is no #${slot}.`
        : 'Your bag is empty.',
    };
  }

  const folded = foldName(text);

  const exact = rows.find((r) => r.item === text.toLowerCase() || foldName(r.displayName) === folded);
  if (exact) return { row: exact };

  const partial = rows.filter(
    (r) => foldName(r.item).startsWith(folded) || foldName(r.displayName).startsWith(folded)
  );

  if (partial.length === 1) return { row: partial[0] };

  if (partial.length > 1) {
    return {
      error:
        `"${text}" matches ${partial.length} items: ` +
        partial
          .slice(0, 5)
          .map((r) => `**${r.displayName}**`)
          .join(', ') +
        (partial.length > 5 ? ', …' : '') +
        '. Be more specific, or use its number from `.bag`.',
    };
  }

  return { error: `You are not carrying anything called "${text}".` };
}

module.exports = { bagRows, resolve, shopIndex, itemName };
