'use strict';

/**
 * Lootboxes, the most common quest reward.
 *
 * Opening one:
 *
 *   1. pick a tier, using the fixed odds below
 *   2. pick one item from that tier, uniformly
 *
 * Shop items only declare which tier they belong to, so adding an item never
 * requires re-balancing the others. A tier's odds are fixed (ssr is always
 * exactly 1%); the items within it share that chance equally.
 *
 * Every shop entry must declare a tier (or `none`). The importer rejects
 * entries without one.
 */

const content = require('./content');

/** The slug of the box itself. Quests award this; .useitem opens it. */
const LOOTBOX = 'lootbox';

/**
 * The chance of each tier, in percent. Adds up to 100.
 */
const TIERS = {
  common: 58,
  rare: 22,
  epic: 7,
  ssr: 1,
  tm: 12,
};

/**
 * TMs get their own tier rather than joining `common`. There are about 340
 * TMs and 221 other items, so putting TMs in `common` would make most boxes
 * give a TM and dilute every other item.
 *
 * Twelve percent, taken out of common's seventy: roughly one box in eight
 * gives a TM.
 */

/** How each tier reads, and what colour it opens in. */
const TIER_LOOK = {
  common: { label: 'Common', color: 0xb9bbbe },
  rare: { label: 'Rare', color: 0x3498db },
  epic: { label: 'Epic', color: 0x9b59b6 },
  ssr: { label: 'SSR', color: 0xf1c40f },
  tm: { label: 'TM', color: 0x1abc9c },
};

let poolCache = null;

/**
 * Everything a lootbox can give, grouped by tier.
 *
 * Read from the shop: every shop item except those marked `none`.
 */
function pool() {
  if (poolCache) return poolCache;

  const byTier = {};
  for (const tier of Object.keys(TIERS)) byTier[tier] = [];

  for (const section of content.shop().sections || []) {
    for (const entry of section.items || []) {
      if (!entry.tier || entry.tier === 'none') continue;
      if (!byTier[entry.tier]) continue;

      // A box can never contain another box.
      if (entry.item === LOOTBOX) continue;

      byTier[entry.tier].push(entry.item);
    }
  }

  poolCache = byTier;
  return byTier;
}

/** Drop the cached pool. Call after re-importing the shop. */
function reload() {
  poolCache = null;
  return pool();
}

/**
 * The effective odds per item. Sums to 100 across all non-empty tiers.
 *
 * @returns {Array<{ item, tier, percent }>}
 */
function odds() {
  const byTier = pool();
  const live = Object.keys(TIERS).filter((tier) => byTier[tier].length);

  // Empty tiers can't be rolled, so their share is spread over the others.
  const total = live.reduce((sum, tier) => sum + TIERS[tier], 0) || 1;

  const rows = [];
  for (const tier of live) {
    const share = (TIERS[tier] / total) * 100;
    for (const item of byTier[tier]) {
      rows.push({ item, tier, percent: share / byTier[tier].length });
    }
  }

  return rows.sort((a, b) => b.percent - a.percent);
}

/** Pick a tier, skipping any that is empty. */
function rollTier() {
  const byTier = pool();
  const live = Object.keys(TIERS).filter((tier) => byTier[tier].length);

  if (!live.length) return null;

  const total = live.reduce((sum, tier) => sum + TIERS[tier], 0);
  let roll = Math.random() * total;

  for (const tier of live) {
    roll -= TIERS[tier];
    if (roll < 0) return tier;
  }

  return live[live.length - 1];
}

/**
 * Open one box.
 *
 * Does not write anything; the caller removes the box and grants the prize.
 *
 * @returns {{ tier: string, item: string } | null}
 */
function roll() {
  const tier = rollTier();
  if (!tier) return null;

  const items = pool()[tier];
  return { tier, item: items[Math.floor(Math.random() * items.length)] };
}

module.exports = { LOOTBOX, TIERS, TIER_LOOK, pool, odds, roll, rollTier, reload };

// `node Utils/lootbox.js [n]` - what is in the pool, and what 10,000 opens give.
if (require.main === module) {
  const byTier = pool();

  console.log('Lootbox pool, from the shop:');
  for (const [tier, percent] of Object.entries(TIERS)) {
    const items = byTier[tier];
    const each = items.length ? (percent / items.length).toFixed(4) : '0';
    console.log(`  ${tier.padEnd(7)} ${String(percent).padStart(3)}%  ${String(items.length).padStart(3)} items  ${each}% each`);
  }

  const never = [];
  for (const section of content.shop().sections || []) {
    for (const entry of section.items || []) {
      if (entry.tier === 'none') never.push(entry.item);
    }
  }
  console.log(`\nNever drops (${never.length}): ${never.join(', ')}`);

  const runs = parseInt(process.argv[2], 10) || 10000;
  const seen = {};
  for (let i = 0; i < runs; i += 1) {
    const got = roll();
    seen[got.tier] = (seen[got.tier] || 0) + 1;
  }

  console.log(`\n${runs.toLocaleString('en-US')} opens:`);
  for (const [tier, n] of Object.entries(seen)) {
    console.log(`  ${tier.padEnd(7)} ${((n / runs) * 100).toFixed(2)}%  (want ${TIERS[tier]}%)`);
  }
}
