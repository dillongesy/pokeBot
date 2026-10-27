'use strict';

/**
 * Top-level drop rates for PokeDropperV2.
 *
 * Which form of a species drops is decided per species in formrates.js.
 * This file only covers how rare the species itself is, and shinies.
 */

module.exports = {
  /** 1 in N chance that a drop is shiny. Rolled separately from everything else. */
  shinyRate: 4096,

  /**
   * Chance of each rarity, in percent. These add up to 100.
   *
   * Babies and pseudo-legendaries count as normal.
   * Paradox Pokemon count as legendary.
   */
  rarity: {
    normal: 98,
    legendary: 0.75,
    ultraBeast: 0.75,
    mythical: 0.5,
  },

  /**
   * Extra rarity percentage points while a Shiny Incense is active.
   *
   * Added to the base rates above, with `normal` reduced by the same total so
   * the table still sums to 100. A natural shiny uses the base rates.
   *
   *              base     with incense    added
   *   legendary   0.75%        5%         +4.25
   *   mythical    0.5%         2.5%       +2.0
   *   ultra beast 0.75%        2.5%       +1.75
   *
   * Stored as differences so changing a base rate keeps the incense bonus.
   */
  shinyIncenseAddedRates: {
    legendary: 4.25,
    mythical: 2,
    ultraBeast: 1.75,
  },

  /**
   * The level a wild Pokemon drops at.
   *
   * The level band is derived per species from its evolution levels, in
   * Utils/pokemon.js wildLevelRange:
   *
   *   Trapinch   1-34    up to one below the 35 it evolves at
   *   Vibrava    35-44   from 35, to one below Flygon's 45
   *   Flygon     45-75   from 45 up to the maximum
   *
   * Species with no evolution levels on either side get the whole range.
   */
  wildLevels: {
    /** Maximum wild level. */
    cap: 75,

    /**
     * How strongly levels are weighted toward the bottom of the band.
     *
     * The odds halve this many times across the whole band, so at 8 the top
     * level is 1/256 as likely as the bottom. It is measured across the band
     * rather than per level, so narrow and wide bands lean by the same
     * proportion.
     *
     * Effect on the widest band, 1-75:
     *
     *          half of them   level 75      what it feels like
     *          at or below    turns up
     *    0        level 38    1 in 75       flat, no lean at all
     *    4        level 17    1 in 409      a gentle slope
     *    8        level 10    1 in 3,533    the current setting
     *   10        level 8     1 in 11,442   the top half goes quiet
     *
     * This only shifts levels within each species' own band (a Flygon is
     * never below 45). It matters most for the species with no evolution
     * levels, which span the full 1-75.
     */
    falloff: 8,

    /**
     * Legendaries, mythicals and Ultra Beasts don't evolve, so their levels
     * are spread evenly across the range.
     */
    legendary: [1, 75],
  },

  /**
   * How much of a name .hint gives away, as a fraction of its letters.
   *
   * Punctuation is not counted and is always shown.
   */
  hintRevealFraction: 0.5,

  /** Percent chance a wild Pokemon has its hidden ability instead of a normal one. */
  hiddenAbilityPercent: 5,

  /**
   * Coins paid for a catch, rolled evenly between the two.
   *
   * An Amulet Coin doubles it, but only for catching your own drop (enforced
   * in store.awardCatchCoins).
   */
  catchCoins: { min: 5, max: 25 },

  /**
   * Multiplier applied to every shop price.
   *
   * Applied centrally in content.shop() so the economy can be rebalanced with
   * one number. Prices never round below 1.
   */
  priceScale: 0.1,

  // Releasing intentionally pays nothing, so there is no releaseCoins setting.

  /** How long a user must wait between drops, in milliseconds. */
  dropCooldownMs: 5 * 60 * 1000,

  /**
   * Maximum Critical Drop chance, as a fraction. A crit refunds the drop
   * cooldown.
   */
  maxCritDropChance: 0.25,

  /**
   * Trainer progression settings. The rules are in Utils/trainer.js and
   * Utils/obedience.js.
   *
   * Trainer level starts at 1 and the obedience cap at `startingCap`, rising
   * by one per trainer level. Each level is gated behind the next milestone:
   *
   *   win battles -> fill the bar -> milestone unlocks -> beat it -> level up
   *
   * With expPerOpponentLevel 5 and levelExpBase 400:
   *
   *   trainer  cap   exp to next   exp per win   wins
   *         1   10           400            50      8
   *        10   19          4000            95     43
   *        25   34         10000           170     59
   *        50   59         20000           295     68
   *        75   84         30000           420     72
   *
   * Wins per level grow much more slowly than the exp required, because
   * opponents are worth more as the cap rises.
   */
  trainer: {
    /** The obedience cap at trainer level 1. */
    startingCap: 10,

    /** Trainer exp for a win, multiplied by the opponent's level. */
    expPerOpponentLevel: 5,

    /**
     * Exp needed to fill the bar at level n, as `levelExpBase * n`.
     *
     * Linear on purpose; the difficulty comes from the milestone battles.
     */
    levelExpBase: 400,

    /**
     * What a Pokemon that was in the fight but did not land the knockout
     * earns, as a fraction of the full award.
     *
     * Non-zero so switch-training works.
     */
    benchShare: 0.5,

    /**
     * What a Pokemon that stayed on the bench earns (Exp. Share), as a
     * fraction of the full award. Kept low so battling is still the fastest
     * way to level.
     */
    shareRate: 0.2,

    /**
     * Experience scaling (see trainer.expScale):
     *
     *   below the opponent's level   reduced in proportion
     *   at it                        the full award
     *   over the obedience cap       tapers to a floor at MAX_OVER_CAP
     *
     * Without this, opponents scaling to the cap would level Pokemon far past
     * the point where they stop obeying. Neither floor is zero.
     */
    expUnderFloor: 0.15,
    expOverFloor: 0.05,

    /**
     * Exponent for the below-parity reduction.
     *
     * At 1.0 the opponent's level would cancel out entirely, so beating a
     * stronger opponent would pay no more. A square root means beating a
     * Pokemon ten levels higher pays about a fifth more.
     */
    expFightUpPower: 0.5,

    /** Losing costs nothing. */
    lossPenalty: 0,
  },

  /**
   * What `.battle` puts in front of you.
   *
   * The mix shifts from mostly wild to mostly trainers as the player
   * progresses. Utils/encounter.js interpolates between the two ends.
   */
  battle: {
    /** Percent of ordinary battles that are wild, at the first milestone... */
    wildAtStart: 90,

    /** ...and at the last. The rest are trainers with a team. */
    wildAtEnd: 20,

    /**
     * How many Pokemon a random trainer brings.
     *
     * At least two, so trainer battles differ from wild ones.
     */
    minNpcTeam: 2,
    maxNpcTeam: 6,

    /**
     * How far either side of the level anchor an opponent can appear.
     *
     * Kept small so fights stay balanced around the cap.
     */
    wildSpread: 2,

    /**
     * Opponent level bands, rolled per opponent.
     *
     * Measured from the level anchor (encounter.levelAnchor): the cap, or the
     * strongest Pokemon brought if that is higher. Most opponents are near
     * it, and some are lower so that newer catches can still win fights.
     * Rewards scale with the opponent's level, so weak opponents can't be
     * farmed.
     *
     * The top band uses absolute offsets from the anchor; the others use
     * fractions of it (fractions near the anchor would be too narrow at low
     * levels).
     *
     * Simulated over a whole climb, these keep the average opponent within
     * about three levels of the party.
     */
    levelBands: [
      { weight: 65, offsetFrom: -2, offsetTo: 2 },
      { weight: 25, fractionFrom: 0.8, fractionTo: 0.95 },
      { weight: 10, fractionFrom: 0.5, fractionTo: 0.75 },

      /**
       * Above the anchor, to keep ordinary battles challenging (players bring
       * six Pokemon; opponents bring two to six).
       *
       * `rampsWith` scales the weight by the player's progress, so early
       * battles stay gentle. See encounter.variedLevel.
       */
      { weight: 15, offsetFrom: 3, offsetTo: 6, rampsWith: 'progress' },
    ],

    /**
     * Coins for a win: a small flat range, so the shop stays meaningful at
     * every level.
     */
    coinsPerWin: { min: 1, max: 10 },

    /** What a milestone pays on top, as a multiple of the ordinary reward. */
    milestoneBonus: 5,
  },

  /**
   * Daily quests (Utils/daily.js, `.daily`).
   *
   * Twice as many battles as catches, since battles have no cooldown. Days
   * run midnight to midnight in `timezone`, daylight saving included.
   */
  daily: {
    timezone: 'America/Chicago',
    timezoneLabel: 'Central',

    catchTarget: 5,
    battleTarget: 10,

    /** Paid when the catch quest is finished. */
    catchCoins: 250,

    /**
     * Paid when the battle quest is finished: a Rare Candy this often,
     * otherwise a random TM that at least one Pokemon can learn.
     */
    rareCandyChance: 0.5,

    /** Paid for voting on top.gg. */
    voteLootboxes: 1,

    /** Paid on top once all three are done. */
    bonusLootboxes: 2,
  },
};
