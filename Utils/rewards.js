'use strict';

/**
 * What a battle pays out.
 *
 * Pure: given a finished battle, it returns what should change, and
 * Utils/store.js applies it (the same split as Utils/items.js).
 *
 * Rules:
 *
 *   1. Losing costs nothing: no exp, levels or cooldown.
 *
 *   2. Experience is earned per knockout, win or lose, by every Pokemon still
 *      standing at that moment. A Pokemon that has fainted earns nothing from
 *      later knockouts.
 *
 *   3. Coins and trainer experience are only paid for a win.
 *
 * Experience rates:
 *
 *   landed    full - it scored the knockout
 *   watched   `benchShare` - it was on the field at some point
 *   shared    `shareRate` - it stayed on the bench (Exp. Share)
 *
 * EVs only go to Pokemon that were on the field.
 */

const rates = require('./rates');
const trainer = require('./trainer');
const encounter = require('./encounter');

/** The six stats an effort yield can name, in the column form the database uses. */
const EV_COLUMNS = {
  hp: 'ev_hp',
  attack: 'ev_attack',
  defense: 'ev_defense',
  specialAttack: 'ev_special_attack',
  specialDefense: 'ev_special_defense',
  speed: 'ev_speed',
};

/**
 * What one knockout is worth, at the moment it happens.
 *
 *   still standing   earns, at one of the three rates
 *   fainted          earns nothing from this knockout
 *
 * A Pokemon keeps whatever it earned before it fainted.
 *
 * @param {object} options
 * @param {object} options.playerSide  the player's side of the battle state
 * @param {object} options.fallen      the opponent that just fainted
 * @param {number} options.cap         the trainer's obedience cap
 * @returns {Array<{id, exp, evs}>}
 */
function forKnockout({ playerSide, fallen, cap = null }) {
  const standing = playerSide.team.filter((mon) => !mon.fainted);
  const yields = fallen.effortYield || {};

  const earned = [];

  for (const mon of standing) {
    const landed = fallen.faintedBy === mon.id;
    const onBench = !mon.participated;

    const exp = trainer.expForKnockout(
      fallen.baseExperience || 64,
      fallen.level,
      landed ? 'landed' : onBench ? 'shared' : 'watched',
      mon.level,
      cap
    );

    // EVs only go to Pokemon that were on the field.
    const evs = {};
    if (!onBench) {
      for (const [stat, amount] of Object.entries(trainer.evsForKnockout(yields))) {
        if (amount) evs[stat] = amount;
      }
    }

    if (exp > 0) earned.push({ id: mon.id, name: mon.name, exp, evs });
  }

  return earned;
}

/**
 * Work out everything a finished battle owes.
 *
 * @param {object} options
 * @param {object} options.state          a finished battle from Utils/battle.js
 * @param {string} options.kind           wild | trainer | milestone
 * @param {number} options.opponentLevel  what the fight was worth
 * @param {Function} options.rng   for the coin roll; seed it to replay a payout
 * @returns {{won, coins, trainerExp, knockouts, pokemon, clearsMilestone}}
 */
function forBattle({ state, kind = encounter.WILD, opponentLevel = 1, rng = Math.random }) {
  const [playerSide, opponentSide] = state.sides;
  const won = state.winner === 0;

  // Experience is paid per knockout during the fight (forKnockout and
  // store.awardKnockout). This only handles coins, trainer exp and milestones.
  const knockouts = opponentSide.team.filter((mon) => mon.fainted);

  const multiplier = kind === encounter.MILESTONE ? rates.battle.milestoneBonus : 1;

  // Coins are a flat amount rather than scaling with opponent level, to keep
  // the shop economy in check. Trainer exp does scale with the opponent.
  const { min, max } = rates.battle.coinsPerWin;
  const rolled = min + Math.floor(rng() * (max - min + 1));

  return {
    won,
    kind,
    knockouts: knockouts.length,

    // Rule 3: coins and trainer exp only for a win.
    coins: won ? Math.max(1, Math.round(rolled * multiplier)) : 0,
    trainerExp: won ? trainer.expForWin(opponentLevel) * multiplier : 0,

    clearsMilestone: won && kind === encounter.MILESTONE,
  };
}

/**
 * Fold a reward's effort values into a Pokemon row's existing ones.
 *
 * Returns only the changes, clamped to 252 per stat and 510 total, ready for
 * store.updatePokemon. An empty object means there is nothing to write.
 */
function evChanges(row, evs) {
  const items = require('./items');

  let spent = items.totalEvs(row);
  const changes = {};

  for (const [stat, amount] of Object.entries(evs || {})) {
    const column = EV_COLUMNS[stat];
    if (!column || !amount) continue;

    const current = row[column] || 0;
    const room = Math.min(
      amount,
      items.MAX_EV_PER_STAT - current,
      items.MAX_EV_TOTAL - spent
    );

    if (room <= 0) continue;

    changes[column] = current + room;
    spent += room;
  }

  return changes;
}

/**
 * How much experience carries a Pokemon, and to what level.
 *
 * Returns the changes for store.updatePokemon, including any new level. Uses
 * the species' growth curve, the same one Utils/pokemon.js uses for new
 * catches.
 *
 * A Pokemon at MAX_LEVEL earns nothing.
 */
function expChanges(row, gained) {
  const { experienceForLevel, MAX_LEVEL, loadSpecies } = require('./pokemon');

  if (row.level >= MAX_LEVEL) return {};

  const species = loadSpecies(row.species_id);
  const growth = (species && species.breeding && species.breeding.growthRate) || 'medium';

  const total = (row.exp || 0) + Math.max(0, Math.round(gained));

  let level = row.level;
  while (level < MAX_LEVEL && total >= experienceForLevel(growth, level + 1)) level += 1;

  return level === row.level ? { exp: total } : { exp: total, level };
}

module.exports = { EV_COLUMNS, forBattle, forKnockout, evChanges, expChanges };

// `node Utils/rewards.js` - what a fight is worth, across the ladder.
if (require.main === module) {
  const battle = require('./battle');
  const milestones = require('./milestones');

  const { min, max } = rates.battle.coinsPerWin;

  console.log(`coins are a flat ${min}-${max} a win, whatever the cap.\n`);
  console.log('  cap   trainer exp   exp to next level   wins per level');

  for (const level of [1, 10, 25, 50, 79]) {
    const cap = trainer.capFor(level);
    const exp = trainer.expForWin(cap);
    const needed = trainer.expForLevel(level);

    console.log(
      `  ${String(cap).padStart(3)}   ` +
        `${String(exp).padStart(11)}   ${String(needed).padStart(17)}   ` +
        `${String(Math.ceil(needed / exp)).padStart(14)}`
    );
  }

  console.log(`\na milestone pays ${rates.battle.milestoneBonus}x that.`);

  // The same knockout, for learners of different levels.
  console.log('\nwhat one knockout of a level-20 opponent is worth:\n');
  console.log('  pokemon level   exp   note');

  const over = require('./obedience').MAX_OVER_CAP;
  const ceiling = 20 + over;

  // Derived from MAX_OVER_CAP so the sample always covers the taper.
  const sample = [...new Set([
    2, 5, 10, 15, 20,
    20 + Math.max(1, Math.round(over / 3)),
    20 + Math.max(2, Math.round((over * 2) / 3)),
    ceiling,
    ceiling + 10,
  ])].sort((a, b) => a - b);

  for (const level of sample) {
    const gained = trainer.expForKnockout(64, 20, true, level);
    const note =
      level < 20 ? 'under the cap - earns in proportion'
        : level === 20 ? 'at the cap - the full award'
        : level >= ceiling ? 'past the obedience ceiling - all but nothing'
        : 'over the cap - tapering';

    console.log(`  ${String(level).padStart(13)}   ${String(gained).padStart(3)}   ${note}`);
  }

  console.log('\na real fight, and what it pays out:');

  const rng = battle.rngFrom(7);
  const cap = trainer.capFor(1);

  const mine = encounter.wildCombatant(6, cap + 8, { rng });
  const bench = encounter.wildCombatant(9, cap + 8, { rng });
  mine.id = 101;
  bench.id = 102;

  const fight = milestones.byOrder(1);
  const state = battle.create({
    player: { name: 'You', team: [mine, bench] },
    opponent: { name: fight.name, team: encounter.milestoneTeam(fight, cap, rng) },
    seed: 7,
    kind: 'milestone',
  });

  // Send the bench in for one turn so switch-training can be seen working.
  battle.resolveTurn(state, [{ type: 'switch', index: 1 }, { type: 'move', slot: 0 }]);
  battle.resolveTurn(state, [{ type: 'switch', index: 0 }, { type: 'move', slot: 0 }]);

  let guard = 0;
  while (!state.finished && guard < 200) {
    guard += 1;
    battle.resolveTurn(state, state.sides.map((side, i) => ({
      type: 'move',
      slot: battle.chooseMove(battle.activeOf(side), battle.activeOf(state.sides[1 - i])),
    })));

    for (let i = 0; i < 2; i += 1) {
      const side = state.sides[i];
      if (battle.activeOf(side).fainted && !battle.wipedOut(side)) {
        const free = battle.benchOf(side);
        if (free.length) battle.sendOut(state, i, free[0].index);
      }
    }
  }

  const paid = forBattle({
    state,
    kind: encounter.MILESTONE,
    opponentLevel: Math.max(...state.sides[1].team.map((m) => m.level)),
  });

  console.log(`  ${state.turn} turns, ${paid.won ? 'won' : 'lost'}`);
  console.log(`  ${paid.knockouts} knockouts`);
  console.log(`  ${paid.coins} coins, ${paid.trainerExp} trainer exp`);
  console.log(`  clears the milestone: ${paid.clearsMilestone}`);

  console.log('\nthe EV clamp:');
  const nearlyFull = {
    ev_hp: 250, ev_attack: 250, ev_defense: 0,
    ev_special_attack: 0, ev_special_defense: 0, ev_speed: 0,
  };
  console.log(`  at 500/510 already, +3 speed gives ${JSON.stringify(evChanges(nearlyFull, { speed: 3 }))}`);
  console.log(`  +10 hp on a 250 stat gives ${JSON.stringify(evChanges({ ...nearlyFull, ev_attack: 0 }, { hp: 10 }))}`);
}
