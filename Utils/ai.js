'use strict';

/**
 * How opponents decide what to do, modelled on Pokemon Emerald's trainer AI,
 * with Generation 4's switching.
 *
 * Moves (Emerald). Every usable move starts at a score of 100, a set of
 * scripts adjusts it, and the highest score is used; ties are broken at
 * random. The scripts, as in Emerald's battle_ai_scripts:
 *
 *   checkBadMove     about -10 for a move that would fail or do nothing:
 *                    status on a statused or immune target, a maxed stat,
 *                    healing at full HP, an absorbed or no-effect attack,
 *                    Fake Out after the first turn, or a move this engine
 *                    doesn't model (screens, confusion, Taunt...)
 *   tryToFaint       +4 for a move that knocks the target out, +2 more with
 *                    priority; -1 for Explosion-type moves otherwise
 *   checkViability   per-effect judgement, with Emerald's dice rolls: boosts
 *                    at full health, Thunder Wave on a faster target, healing
 *                    when hurt, Explosion when nearly done, no repeat Protect
 *   hpAware          no setting up when low, no healing or Explosion when
 *                    healthy, no status on a target about to faint
 *   preferStrongest  the strongest attack gets +2 most of the time
 *
 * Who uses which, as Emerald's trainer flags do:
 *
 *   wild        checkBadMove - a random move, but never one that would fail
 *   trainer     checkBadMove, tryToFaint, checkViability
 *   milestone   all five (gym leaders, the Elite Four, champions)
 *
 * Switching (Generation 4). Wild Pokemon never switch. Trainers switch when:
 *
 *   - none of their moves can affect the target at all; or
 *   - they are at a significant disadvantage: the target hits them super
 *     effectively for at least half their health, they deal back less than
 *     half of that, and something on the bench resists it (two times in
 *     three); or
 *   - a bench Pokemon's ability absorbs the target's best attack (Flash Fire,
 *     Water Absorb, Levitate...), one time in three.
 *
 * They never switch while holding a super effective move, while boosted, while
 * trapped, or within a few turns of their last switch. A fainted Pokemon is
 * replaced by whatever matches up best.
 */

const content = require('./content');
const damage = require('./damage');
const typechart = require('./typechart');
const effects = require('./battleeffects');
const field = require('./field');
const movepower = require('./movepower');
const cond = require('./conditions');
const statusMoves = require('./statusmoves');

const BASE_SCORE = 100;

/** Turns before the same Pokemon can switch out again, so it never ping-pongs. */
const SWITCH_COOLDOWN = 3;

/** Statuses the engine knows, and the types each can't affect. */
const STATUS_IMMUNE = {
  burn: ['fire'],
  freeze: ['ice'],
  paralysis: ['electric'],
  poison: ['poison', 'steel'],
  sleep: [],
};

/** PokeAPI stat names to the engine's stage keys. */
const STAGE_KEY = {
  attack: 'attack',
  defense: 'defense',
  'special-attack': 'specialAttack',
  'special-defense': 'specialDefense',
  speed: 'speed',
  accuracy: 'accuracy',
  evasion: 'evasion',
};

const MAX_STAGE = 6;

/** Moves whose user faints. */
const SELF_FAINT = new Set(['explosion', 'self-destruct', 'misty-explosion', 'memento', 'final-gambit']);
const FIRST_TURN_ONLY = new Set(['fake-out', 'first-impression']);
const PROTECTS = new Set(['protect', 'detect', 'kings-shield', 'spiky-shield', 'baneful-bunker', 'endure']);

/** Script sets per kind of battle. */
const FLAGS = {
  // Wild Pokemon still pick at random, but never a move that would fail
  // outright (Rain Dance in the rain, Thunder Wave on a Ground type).
  wild: ['checkBadMove'],
  trainer: ['checkBadMove', 'tryToFaint', 'checkViability'],
  milestone: ['checkBadMove', 'tryToFaint', 'checkViability', 'hpAware', 'preferStrongest'],
};

const percent = (mon) => (mon.maxHp > 0 ? (mon.hp / mon.maxHp) * 100 : 0);
const hasType = (mon, types) => (mon.types || []).some((t) => types.includes(String(t).toLowerCase()));
const isDamaging = (move) => move.damageClass !== 'status';
const ailmentOf = (move) => {
  const ailment = move.meta && move.meta.ailment;
  return ailment === 'bad-poison' ? 'poison' : ailment;
};
const isStatusMove = (move) => !isDamaging(move) && STATUS_IMMUNE[ailmentOf(move)] !== undefined;
// Rest heals fully (and sleeps); the engine handles it by name.
const isHealing = (move) => !isDamaging(move) && ((move.meta && move.meta.healing > 0) || move.name === 'rest');
/** Move targets that mean the user itself (Howl is "user-and-allies"). */
const SELF_TARGETS = new Set(['user', 'user-and-allies', 'users-field', 'user-or-ally']);
const onSelf = (move) => SELF_TARGETS.has(move.target);

// Stat moves are status moves only (Swords Dance, Growl). An attack with a
// stat side effect (Psychic's Special Defense drop) is judged as an attack.
const raises = (move) =>
  !isDamaging(move) && onSelf(move) && (move.statChanges || []).some((c) => c.change > 0);
const lowers = (move) =>
  !isDamaging(move) && !onSelf(move) && (move.statChanges || []).some((c) => c.change < 0);
const stageOf = (mon, stat) => (mon.stages && mon.stages[STAGE_KEY[stat]]) || 0;

/** Emerald's dice: "if_random_less_than n" is n in 256. */
const chance = (rng, outOf256) => rng() * 256 < outOf256;

/** Average hits for a multi-hit move: 2-5 averages about 3, Skill Link always 5. */
function averageHits(attacker, move) {
  const meta = move.meta || {};
  if (!meta.minHits || !meta.maxHits) return 1;
  if (meta.minHits === meta.maxHits) return meta.minHits;
  if (attacker.ability === 'skill-link') return meta.maxHits;
  return meta.minHits === 2 && meta.maxHits === 5 ? 3.1 : (meta.minHits + meta.maxHits) / 2;
}

/**
 * Expected damage at an average roll, the way the engine calculates it.
 *
 * Variable power (Low Kick, Gyro Ball) and fixed damage (Seismic Toss, Final
 * Gambit) come from Utils/movepower.js, as in the engine; multi-hit moves
 * count their average number of hits.
 */
function expectedDamage(attacker, defender, move) {
  if (!move || !isDamaging(move)) return 0;

  const eff = typechart.effectiveness(move.type, defender.types);
  if (eff === 0 || effects.absorbs(defender, move, eff)) return 0;

  const verdict = movepower.resolve(move, { attacker, defender, rng: () => 0.5 });
  if (verdict.kind === 'fail') return 0;
  if (verdict.kind === 'fixed') return verdict.damage;
  if (verdict.kind === 'ohko') return defender.hp * ((move.accuracy || 30) / 100);

  const sized = verdict.kind === 'power' ? { ...move, power: verdict.power } : move;
  const parts = effects.damageParts(attacker, defender, sized, eff);
  const result = damage.calculate({
    attacker,
    defender,
    move: sized,
    roll: 0.5,
    critical: false,
    attackModifiers: parts.attackModifiers,
    defenceModifiers: parts.defenceModifiers,
    extraModifiers: parts.extraModifiers,
    stabMultiplier: parts.stabMultiplier,
    ignoreBurn: parts.ignoreBurn,
  });

  return Math.max(0, result.damage) * averageHits(attacker, move);
}

/** Speed as the engine sees it (paralysis, Choice Scarf...). */
const speedOf = (mon) => require('./battle').effectiveSpeed(mon);

const effectiveness = (move, target) => typechart.effectiveness(move.type, target.types);

// ---------------------------------------------------------------------------
// The scripts. Each returns a score change for one move.
// ---------------------------------------------------------------------------

/**
 * Does the engine do anything with this move? Status moves it doesn't model
 * (screens, confusion, Taunt, Safeguard, Teleport...) have no effect here, so
 * a trainer using one would waste its turn.
 */
function hasEffectHere(move) {
  if (isDamaging(move)) return true;
  if (STATUS_IMMUNE[ailmentOf(move)] !== undefined) return true;
  if (ailmentOf(move) === 'confusion') return true;
  if (statusMoves.has(move.name)) return true;
  if ((move.statChanges || []).length) return true;
  if (isHealing(move)) return true;
  if (SELF_FAINT.has(move.name)) return true;

  return Boolean(
    field.WEATHER_MOVES[move.name] || field.isProtect(move) || field.isLeechSeed(move) || field.isSubstitute(move)
  );
}

/** About -10 for a move that would fail or do nothing. */
function checkBadMove({ user, target, move, userAlone, targetAlone, state, sideIndex, turn }) {
  if (!hasEffectHere(move)) return -10;

  // Status moves with their own effect say themselves why they'd fail
  // (Reflect already up, nothing to Encore, no bench to Baton Pass to...).
  if (state && statusMoves.has(move.name)) {
    const why = statusMoves.wouldFail({ state, sideIndex, attacker: user, defender: target, move, turn: turn || {} });
    if (why) return -10;
  }

  // Powder on Grass, Prankster on Dark, sound on Soundproof.
  if (cond.immuneTo(user, target, move)) return -10;

  // Heal Pulse and Floral Healing would heal the player in a single battle.
  if (!isDamaging(move) && !onSelf(move) && move.meta && move.meta.healing > 0) return -10;

  // Fling with nothing held, Natural Gift without a berry, Spit Up and
  // Swallow with nothing stockpiled.
  if (['fling', 'natural-gift', 'spit-up', 'swallow'].includes(move.name) &&
      movepower.resolve(move, { attacker: user, defender: target, rng: () => 0.5 }).kind === 'fail') {
    return -10;
  }

  // A weather that is already up.
  if (state && field.WEATHER_MOVES[move.name] && state.field.weather === field.WEATHER_MOVES[move.name]) return -10;

  // Confusion: not on something already confused, with Own Tempo, or behind
  // Safeguard or Misty Terrain.
  if (!isDamaging(move) && ailmentOf(move) === 'confusion') {
    if (target.volatiles && target.volatiles.confusion) return -10;
    if (target.ability === 'own-tempo') return -10;
    if (state && cond.sideBlocksStatus(state, 1 - sideIndex, target, 'confusion', user)) return -10;
  }

  // Safeguard and the terrains stop major statuses too.
  if (state && isStatusMove(move) && cond.sideBlocksStatus(state, 1 - sideIndex, target, ailmentOf(move), user)) {
    return -10;
  }

  if (isDamaging(move)) {
    const eff = effectiveness(move, target);
    if (eff === 0 || effects.absorbs(target, move, eff)) return -10;
  }

  if (FIRST_TURN_ONLY.has(move.name) && user.turnsActive) return -10;

  if (isStatusMove(move)) {
    const ailment = ailmentOf(move);
    if (target.status) return -10;
    if (hasType(target, STATUS_IMMUNE[ailment])) return -10;
    // Only Thunder Wave respects type immunity (Ground); Hypnosis still hits a
    // Dark type, as in the engine.
    if (move.name === 'thunder-wave' && effectiveness(move, target) === 0) return -10;
    if (!effects.statusAllowed(target, ailment)) return -10;
  }

  // Swagger and Flatter are worth it for the confusion (Norman's favourite),
  // not the boost: useless if the target can't be confused.
  if (!isDamaging(move) && !onSelf(move) && (move.statChanges || []).length &&
      move.statChanges.every((c) => c.change > 0) && ailmentOf(move) !== 'confusion') {
    return -10;
  }

  // Explosions: Damp stops them, and blowing up its last Pokemon while the
  // player still has others just loses (Emerald's AI_CBM_Explosion).
  if (SELF_FAINT.has(move.name) && move.name !== 'memento') {
    if ([user, target].some((mon) => mon.ability === 'damp')) return -10;
    if (userAlone && !targetAlone) return -10;
  }

  if (move.name === 'leech-seed' && (hasType(target, ['grass']) || target.seededBy)) return -10;

  if (raises(move) && move.statChanges.every((c) => c.change <= 0 || stageOf(user, c.stat) >= MAX_STAGE)) {
    return -10;
  }

  if (lowers(move) && move.statChanges.every((c) => c.change >= 0 || stageOf(target, c.stat) <= -MAX_STAGE)) {
    return -10;
  }

  if (isHealing(move) && user.hp >= user.maxHp) return -8;

  // Exploding when the target can't be hit, or when it would lose the battle.
  if (SELF_FAINT.has(move.name) && move.name !== 'memento' && effectiveness(move, target) === 0) return -10;

  return 0;
}

/** +4 for a knockout (+2 more with priority); Explosion-type moves -1 otherwise. */
function tryToFaint({ user, target, move }) {
  if (!isDamaging(move)) return 0;

  if (expectedDamage(user, target, move) >= target.hp) {
    if (SELF_FAINT.has(move.name)) return 0;
    return move.priority > 0 ? 6 : 4;
  }

  return SELF_FAINT.has(move.name) ? -1 : 0;
}

/** Emerald's per-effect judgement, dice rolls included. */
function checkViability({ user, target, move, rng, userFaster }) {
  const hp = percent(user);
  const targetHp = percent(target);
  let score = 0;

  // Stat boosts (Swords Dance, Calm Mind): +2 half the time at full health
  // while not already boosted; worse the more hurt it is.
  if (raises(move)) {
    const stages = move.statChanges.filter((c) => c.change > 0).map((c) => stageOf(user, c.stat));
    if (Math.max(...stages) >= 3) {
      if (chance(rng, 156)) score -= 1;
    } else if (hp >= 100 && !chance(rng, 128)) {
      score += 2;
    }
    if (hp <= 70 && (hp < 40 || !chance(rng, 40))) score -= 2;
    return score;
  }

  // Stat drops on the target (Growl, Screech).
  if (lowers(move)) {
    if (move.statChanges.some((c) => c.change < 0 && stageOf(target, c.stat) < 0)) score -= 1;
    if (hp <= 90 && chance(rng, 128)) score -= 1;
    if (targetHp <= 70) score -= 2;
    return score;
  }

  // Healing (Recover): only worth it once hurt.
  if (isHealing(move)) {
    if (hp >= 80) return -3;
    if (hp < 33) return 4;
    if (hp < 50) return chance(rng, 230) ? 3 : 0;
    return userFaster ? -1 : 0;
  }

  if (isStatusMove(move)) {
    const ailment = ailmentOf(move);

    // Thunder Wave and friends: worth a lot against something faster.
    if (ailment === 'paralysis') {
      if (!userFaster) return chance(rng, 236) ? 3 : 0;
      return hp <= 70 ? -1 : 0;
    }

    // Toxic: not on a target that's already low.
    if (ailment === 'poison') {
      if (hp <= 50 && chance(rng, 128)) score -= 1;
      if (targetHp <= 50) score -= 1;
      return score;
    }

    // Will-O-Wisp: good against physical attackers.
    if (ailment === 'burn') {
      const physical = (target.moves || []).some((m) => m.data.damageClass === 'physical');
      if (!physical) score -= 1;
      if (targetHp <= 50) score -= 1;
      return score;
    }

    // Sleep: a solid opener.
    if (ailment === 'sleep') return chance(rng, 128) ? 1 : 0;
    return 0;
  }

  // Explosion: when nearly done, not while healthy.
  if (SELF_FAINT.has(move.name)) {
    if (hp > 80) return chance(rng, 50) ? 0 : -3;
    if (hp > 50) return chance(rng, 128) ? -1 : 0;
    return chance(rng, 128) ? 1 : 0;
  }

  // Confusion (Confuse Ray, Swagger): worth less on a target already low.
  if (!isDamaging(move) && ailmentOf(move) === 'confusion') {
    if (targetHp <= 30) return -2;
    if (targetHp <= 70 && chance(rng, 128)) return -1;
    return 0;
  }

  // Protect: not twice in a row, and less often the longer it goes.
  if (PROTECTS.has(move.name)) return user.protectStreak ? -2 : chance(rng, 128) ? 0 : -1;

  // Priority attacks: good for finishing a weakened target.
  if (isDamaging(move) && move.priority > 0 && targetHp < 30) return 1;

  return score;
}

/** Emerald's HP awareness, each with an 80% chance. */
function hpAware({ user, target, move, rng }) {
  const hp = percent(user);
  const targetHp = percent(target);
  let score = 0;

  if (hp > 70 && (SELF_FAINT.has(move.name) || isHealing(move)) && chance(rng, 205)) score -= 2;
  if (hp <= 30 && (raises(move) || lowers(move) || isStatusMove(move)) && chance(rng, 205)) score -= 2;
  if (hp > 30 && hp <= 70 && raises(move) && chance(rng, 205)) score -= 2;
  if (targetHp <= 30 && (isStatusMove(move) || lowers(move)) && chance(rng, 205)) score -= 2;

  return score;
}

/** The strongest attack gets +2 most of the time. */
function preferStrongest({ move, strongest, rng }) {
  return move === strongest && chance(rng, 156) ? 2 : 0;
}

const SCRIPTS = { checkBadMove, tryToFaint, checkViability, hpAware, preferStrongest };

// ---------------------------------------------------------------------------
// Choosing a move
// ---------------------------------------------------------------------------

/**
 * Score every usable move for this kind of battle.
 *
 * @returns {Array<{slot, score}>}
 */
function scoreMoves(user, target, kind = 'trainer', rng = Math.random, sides = {}) {
  const { state = null, sideIndex = 1 } = sides;

  // Only moves it may actually use: PP left, nothing forbidding it (Taunt,
  // Disable...), and only the encored one under Encore.
  const encored = cond.encoreSlot(user);
  const usable = (user.moves || [])
    .map((entry, slot) => ({ entry, slot }))
    .filter(({ entry, slot }) =>
      entry.pp > 0 &&
      (encored == null || slot === encored) &&
      !(state && cond.restriction(state, sideIndex, user, slot)));

  // The attack that does the most damage, for preferStrongest.
  let strongest = null;
  let most = 0;
  for (const { entry } of usable) {
    const dealt = expectedDamage(user, target, entry.data);
    if (dealt > most) {
      most = dealt;
      strongest = entry.data;
    }
  }

  const userFaster = speedOf(user) >= speedOf(target);
  const flags = FLAGS[kind] || FLAGS.trainer;

  return usable.map(({ entry, slot }) => {
    const context = {
      user,
      target,
      move: entry.data,
      rng,
      strongest,
      userFaster,
      userAlone: Boolean(sides.userAlone),
      targetAlone: Boolean(sides.targetAlone),
      state,
      sideIndex,
      turn: sides.turn || null,
    };
    const score = flags.reduce((total, flag) => total + SCRIPTS[flag](context), BASE_SCORE);
    return { slot, score };
  });
}

/** The move to use: the highest score, ties broken at random. */
function chooseMoveSlot(user, target, kind = 'trainer', rng = Math.random, sides = {}) {
  const scored = scoreMoves(user, target, kind, rng, sides);

  // Nothing usable: the engine falls back to Struggle on any slot.
  if (!scored.length) return 0;

  const best = Math.max(...scored.map((option) => option.score));
  const tied = scored.filter((option) => option.score === best);
  return tied[Math.floor(rng() * tied.length)].slot;
}

// ---------------------------------------------------------------------------
// Switching (Generation 4)
// ---------------------------------------------------------------------------

/** The most a Pokemon's moves would take off a target, as a share of its max HP. */
function bestThreat(attacker, defender) {
  let best = 0;
  for (const entry of attacker.moves || []) {
    if (entry.pp <= 0) continue;
    best = Math.max(best, expectedDamage(attacker, defender, entry.data) / Math.max(1, defender.maxHp));
  }
  return best;
}

/** Its strongest attack against a target, or null. */
function bestMove(attacker, defender) {
  let best = null;
  let most = 0;
  for (const entry of attacker.moves || []) {
    const dealt = expectedDamage(attacker, defender, entry.data);
    if (dealt > most) {
      most = dealt;
      best = entry.data;
    }
  }
  return best;
}

/** How well one of ours does against theirs: what we threaten minus what they threaten back. */
const matchup = (ours, theirs) => bestThreat(ours, theirs) - bestThreat(theirs, ours);

/** Whether a switch should happen now, and to which bench index. Null to stay in. */
function switchTarget(state, sideIndex, rng = Math.random) {
  const side = state.sides[sideIndex];
  const foeSide = state.sides[1 - sideIndex];
  const mine = side.team[side.active];
  const theirs = foeSide.team[foeSide.active];

  if (!mine || !theirs || mine.fainted || theirs.fainted || mine.trapped) return null;
  if (mine.lastSwitchTurn != null && state.turn - mine.lastSwitchTurn < SWITCH_COOLDOWN) return null;

  const bench = side.team
    .map((mon, index) => ({ mon, index }))
    .filter(({ mon, index }) => index !== side.active && !mon.fainted);
  if (!bench.length) return null;

  const best = (pick) => {
    let found = null;
    for (const { mon, index } of bench) {
      const score = pick(mon);
      if (score != null && (!found || score > found.score)) found = { index, score };
    }
    return found ? found.index : null;
  };

  // 1. Nothing it has can affect the target at all: always switch.
  const anyEffect = (mine.moves || []).some((entry) => {
    const move = entry.data;
    if (entry.pp <= 0) return false;
    if (!isDamaging(move)) return checkBadMove({ user: mine, target: theirs, move }) === 0;
    const eff = effectiveness(move, theirs);
    return eff > 0 && !effects.absorbs(theirs, move, eff);
  });

  if (!anyEffect) return best((mon) => matchup(mon, theirs));

  // Never while holding a super effective move, or while boosted.
  const hasSuperEffective = (mine.moves || []).some(
    (entry) => entry.pp > 0 && isDamaging(entry.data) && effectiveness(entry.data, theirs) >= 2
  );
  const boosted = Object.values(mine.stages || {}).some((stage) => stage > 0);
  if (hasSuperEffective || boosted) return null;

  const threat = bestMove(theirs, mine);

  // 2. A bench Pokemon whose ability absorbs their best attack, one time in three.
  if (threat && rng() < 1 / 3) {
    const absorber = best((mon) =>
      effects.absorbs(mon, threat, effectiveness(threat, mon)) ? matchup(mon, theirs) + 1 : null
    );
    if (absorber != null) return absorber;
  }

  // 3. A significant disadvantage: hit super effectively for half its health
  //    or more while dealing less than half that back (a losing trade by far),
  //    with a resist on the bench.
  if (threat && effectiveness(threat, mine) >= 2) {
    const taking = expectedDamage(theirs, mine, threat) / Math.max(1, mine.hp);
    const answer = bestMove(mine, theirs);
    const dealing = answer ? expectedDamage(mine, theirs, answer) / Math.max(1, theirs.hp) : 0;

    if (taking >= 0.5 && dealing < Math.min(0.5, taking / 2) && rng() < 2 / 3) {
      const current = matchup(mine, theirs);
      return best((mon) =>
        effectiveness(threat, mon) <= 0.5 && matchup(mon, theirs) > current ? matchup(mon, theirs) : null
      );
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// What the engine calls
// ---------------------------------------------------------------------------

/**
 * The opponent's whole decision for a turn.
 *
 * @returns {{ type: 'move', slot } | { type: 'switch', index }}
 */
function chooseAction(state, sideIndex, rng = Math.random) {
  const side = state.sides[sideIndex];
  const mine = side.team[side.active];
  const theirs = state.sides[1 - sideIndex].team[state.sides[1 - sideIndex].active];
  const kind = state.kind === 'wild' ? 'wild' : state.kind === 'milestone' ? 'milestone' : 'trainer';

  if (kind !== 'wild') {
    const index = switchTarget(state, sideIndex, rng);
    if (index != null) {
      side.team[index].lastSwitchTurn = state.turn;
      return { type: 'switch', index };
    }
  }

  // Whether either side is down to its last Pokemon (Explosion's rule).
  const alone = (s) => s.team.filter((mon) => !mon.fainted).length <= 1;
  const sides = { userAlone: alone(side), targetAlone: alone(state.sides[1 - sideIndex]), state, sideIndex };

  return { type: 'move', slot: chooseMoveSlot(mine, theirs, kind, rng, sides) };
}

/** Who to send in after a faint: the best matchup against their active Pokemon. */
function chooseReplacement(state, sideIndex) {
  const side = state.sides[sideIndex];
  const theirs = state.sides[1 - sideIndex].team[state.sides[1 - sideIndex].active];

  let best = null;
  side.team.forEach((mon, index) => {
    if (mon.fainted || index === side.active) return;
    const score = theirs ? matchup(mon, theirs) : 0;
    if (!best || score > best.score) best = { index, score };
  });

  return best ? best.index : null;
}

module.exports = {
  chooseAction,
  chooseMoveSlot,
  chooseReplacement,
  scoreMoves,
  matchup,
  FLAGS,
};

// `node Utils/ai.js` - how often each move gets picked, by kind of battle.
if (require.main === module) {
  const encounter = require('./encounter');
  const battle = require('./battle');

  const make = (id, moves) => {
    const mon = encounter.wildCombatant(id, 40, { rng: battle.rngFrom(`ai${id}`) });
    const template = mon.moves[0];
    mon.moves = moves.map((name) => ({ ...template, name, data: content.move(name), pp: 20, maxPp: 20 }));
    return effects.attach(mon);
  };

  const user = make(282, ['psychic', 'thunder-wave', 'calm-mind', 'recover']);
  const target = make(101, ['thunderbolt']);
  target.stats.speed = 999;

  console.log('Gardevoir (Psychic, Thunder Wave, Calm Mind, Recover) vs a faster, healthy Electrode:');
  for (const kind of ['wild', 'trainer', 'milestone']) {
    const counts = {};
    for (let i = 0; i < 4000; i += 1) {
      const name = user.moves[chooseMoveSlot(user, target, kind)].name;
      counts[name] = (counts[name] || 0) + 1;
    }
    const row = Object.entries(counts).map(([name, n]) => `${name} ${(n / 40).toFixed(0)}%`).join(', ');
    console.log(`  ${kind.padEnd(9)} ${row}`);
  }
}
