'use strict';

/**
 * The gold shop - the source of truth.
 *
 * Gold is earned only by finishing quests, and it buys buffs that affect the
 * player rather than any one Pokemon. These don't exist in the games, so they
 * are defined in full here. The importer writes this to
 * Data/GoldShop/data.json.
 *
 * Every buff is permanent.
 *
 *   Amulet Coin      30g           one-off   2x coins, own drops only
 *   Shiny Charm      50g           one-off   2x shiny rate
 *   Critical Drop    15/20/25/30g  4 tiers   +6.25% each
 *   Cooldown Reducer 15/20/25/30g  4 tiers   -30 seconds each
 *
 * Tiers share a `buff` key and each has a `tier: n`. Buying a tier sets the
 * buff's value to that tier's cumulative total, and tiers must be bought in
 * order.
 *
 * `buff` must match the names the code reads:
 *
 *   coin_multiplier     scales the coins a catch pays        (store.awardCatchCoins)
 *   cooldown_reduction  fraction off the drop cooldown       (store.startDropCooldown)
 *   crit_drop           chance a drop refreshes its cooldown (store.startDropCooldown)
 *   shiny_multiplier    scales the shiny rate                (Commands/drop.js)
 *
 * crit_drop is capped by maxCritDropChance in Utils/rates.js. All four tiers
 * together reach exactly that cap.
 */

/** Each Critical Drop tier adds 6.25%. Four of them reach the 25% cap. */
const CRIT_PER_TIER = 0.0625;

/**
 * Each Cooldown Reducer tier takes 30 seconds off a five-minute cooldown.
 *
 * Stored as a fraction, which is what store.startDropCooldown applies.
 */
const COOLDOWN_SECONDS_PER_TIER = 30;
const BASE_COOLDOWN_SECONDS = 300;
const COOLDOWN_PER_TIER = COOLDOWN_SECONDS_PER_TIER / BASE_COOLDOWN_SECONDS;

/** Build the four tiers of a stacking buff from their prices. */
function tiers({ idPrefix, name, buff, prices, perTier, describe }) {
  return prices.map((price, index) => {
    const tier = index + 1;

    return {
      id: `${idPrefix}-${tier}`,
      name: `${name} ${tier}`,
      buff,
      tier,
      // Cumulative: the value is the total once this tier is owned.
      value: Number((perTier * tier).toFixed(6)),
      durationHours: null,
      price,
      description: describe(tier),
    };
  });
}

module.exports = {
  currency: 'gold',

  items: [
    {
      id: 'amulet-coin',
      name: 'Amulet Coin',
      buff: 'coin_multiplier',
      value: 2,
      durationHours: null,
      price: 30,
      description: 'Doubles the coins you earn. Only on drops you made yourself.',
    },
    {
      id: 'shiny-charm',
      name: 'Shiny Charm',
      buff: 'shiny_multiplier',
      value: 2,
      durationHours: null,
      price: 50,
      description: 'Doubles the shiny rate, from 1 in 4096 to 1 in 2048.',
    },

    ...tiers({
      idPrefix: 'critical-drop',
      name: 'Critical Drop',
      buff: 'crit_drop',
      prices: [15, 20, 25, 30],
      perTier: CRIT_PER_TIER,
      describe: (tier) =>
        `Adds 6.25% to the chance a drop instantly refreshes its own cooldown. ` +
        `Takes you to ${(CRIT_PER_TIER * tier * 100).toFixed(2)}%.`,
    }),

    ...tiers({
      idPrefix: 'cooldown-reducer',
      name: 'Cooldown Reducer',
      buff: 'cooldown_reduction',
      prices: [15, 20, 25, 30],
      perTier: COOLDOWN_PER_TIER,
      describe: (tier) =>
        `Takes 30 seconds off your drop cooldown. ` +
        `Brings it to ${Math.round(BASE_COOLDOWN_SECONDS - COOLDOWN_SECONDS_PER_TIER * tier)}s.`,
    }),
  ],

  CRIT_PER_TIER,
  COOLDOWN_PER_TIER,
  BASE_COOLDOWN_SECONDS,
};
