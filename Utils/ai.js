'use strict';

/**
 * How opponents decide what to do: Pokemon Emerald's battle AI, ported from
 * its scripts (pret/pokeemerald: data/battle_ai_scripts.s,
 * src/battle_ai_script_commands.c and src/battle_ai_switch_items.c).
 *
 * Moves. Every usable move starts at 100 and a set of scripts adjusts it;
 * the highest score is used, ties broken at random. Before scoring, each
 * attack gets one damage roll (85-100%, no critical hits), which decides
 * whether it would knock the target out and which attack is the strongest.
 *
 *   checkBadMove     about -10 for a move that would fail or do nothing:
 *                    an immune or absorbing target, status on a statused
 *                    target, a maxed stat, healing at full HP, Fake Out after
 *                    the first turn, a move this engine doesn't model
 *   tryToFaint       +4 for a move that knocks the target out (+6 with
 *                    priority); -1 for any other attack that isn't the
 *                    strongest; +2 most of the time for a 4x hit
 *   checkViability   Emerald's per-effect judgement, dice rolls included:
 *                    when to boost (full health, not already +3), when to
 *                    heal, Thunder Wave on something faster, Toxic, Protect,
 *                    Explosion when nearly done, Hyper Beam, Superpower...
 *
 * Who uses which, as Emerald's trainer flags do:
 *
 *   wild        checkBadMove (Emerald's wild Pokemon have none at all)
 *   trainer     checkBadMove, tryToFaint (Emerald's route trainers have only
 *               checkBadMove; these also go for knockouts and their best attack)
 *   milestone   checkBadMove, tryToFaint, checkViability (the gym leader and
 *               Elite Four set)
 *
 * A trainer that can knock the target out always does, picking at random
 * among the moves that would (a priority one first).
 *
 * Switching: Emerald's ShouldSwitch (see switchTarget). Wild Pokemon never
 * switch, ordinary trainers rarely do. A fainted Pokemon is replaced by
 * whatever matches up best.
 */

const content = require('./content');
const damage = require('./damage');
const typechart = require('./typechart');
const effects = require('./battleeffects');
const field = require('./field');
const movepower = require('./movepower');
const cond = require('./conditions');
const statusMoves = require('./statusmoves');
const rules = require('./moverules');

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
const PROTECTS = new Set([
  'protect', 'detect', 'kings-shield', 'spiky-shield', 'baneful-bunker', 'silk-trap', 'burning-bulwark', 'obstruct', 'endure',
]);

/** Script sets per kind of battle. */
const FLAGS = {
  // Wild Pokemon pick at random, but never a move that would fail outright
  // (Rain Dance in the rain, Thunder Wave on a Ground type).
  wild: ['checkBadMove'],
  trainer: ['checkBadMove', 'tryToFaint'],
  milestone: ['checkBadMove', 'tryToFaint', 'checkViability'],
};

const percent = (mon) => (mon.maxHp > 0 ? (mon.hp / mon.maxHp) * 100 : 0);
const { abilityOf, itemOf } = cond;
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
/** Move targets that mean the opposing Pokemon itself (not its side of the field, nor the whole field). */
const FOE_TARGETS = new Set([
  'selected-pokemon', 'selected-pokemon-me-first', 'all-opponents', 'all-other-pokemon', 'random-opponent', 'all-pokemon',
]);
const aimsAtFoe = (move) => FOE_TARGETS.has(move.target);

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
  if (abilityOf(attacker) === 'skill-link') return meta.maxHits;
  return meta.minHits === 2 && meta.maxHits === 5 ? 3.1 : (meta.minHits + meta.maxHits) / 2;
}

/**
 * Type effectiveness exactly as the engine works it out (Utils/battle.js):
 * Foresight and Miracle Eye, grounded fliers (Gravity, Smack Down, Iron Ball),
 * then Freeze-Dry, Flying Press and Thousand Arrows. Without a battle, the
 * plain type chart.
 */
function typeAgainst(move, defender, state) {
  const of = (type) => (state ? cond.effectiveness(type, defender, state.field) : typechart.effectiveness(type, defender.types));
  return rules.adjustEffectiveness({ move, defender, state }, of(move.type), of);
}

/**
 * Whether an ability or item stops the move outright (Levitate, Volt Absorb,
 * Flash Fire, Wonder Guard, Air Balloon). A grounded target can't float over
 * a Ground move, as in the engine.
 */
function absorbedBy(defender, move, eff, state) {
  const grounded = String(move.type).toLowerCase() === 'ground' && state &&
    (cond.grounded(defender, state.field) || move.name === 'thousand-arrows');
  return grounded ? null : effects.absorbs(defender, move, eff);
}

/** Effectiveness with absorbing abilities counted as no effect (Emerald's AI_TypeCalc). */
function typeResult(move, defender, state) {
  const eff = typeAgainst(move, defender, state);
  if (eff === 0 || absorbedBy(defender, move, eff, state)) return 0;
  return eff;
}

/**
 * Damage at a given roll (0-1 across the 85-100% spread), without a critical
 * hit, the way the engine calculates it.
 *
 * Variable power (Low Kick, Gyro Ball) and fixed damage (Seismic Toss, Final
 * Gambit) come from Utils/movepower.js, and power that depends on the battle
 * (Hex, Acrobatics, Brine) from Utils/moverules.js, as in the engine;
 * multi-hit moves count their average number of hits.
 */
function expectedDamage(attacker, defender, move, roll = 0.5, sides = {}) {
  if (!move || !isDamaging(move)) return 0;
  if (move.name === 'hidden-power' && attacker.hiddenPowerType) move = { ...move, type: attacker.hiddenPowerType };
  const { state = null, sideIndex = 0, foeMovesFirst = false } = sides;

  const eff = typeAgainst(move, defender, state);
  if (eff === 0 || absorbedBy(defender, move, eff, state)) return 0;

  const verdict = movepower.resolve(move, { attacker, defender, rng: () => 0.5 });
  if (verdict.kind === 'fail') return 0;
  if (verdict.kind === 'fixed') return Math.max(0, verdict.damage || 0);
  if (verdict.kind === 'ohko') return defender.hp * ((move.accuracy || 30) / 100);

  let power = verdict.kind === 'power' ? verdict.power : move.power;
  if (state) {
    // What this turn will look like, not what last turn left behind: whether
    // the target moves first (Payback, Revenge, Bolt Beak), and nobody has
    // been hit or had a stat dropped yet (Assurance, Lash Out).
    const before = { total: 0, physical: 0, special: 0 };
    power = rules.powerFor({
      state,
      sideIndex,
      attacker: {
        ...attacker,
        damageTakenThisTurn: foeMovesFirst ? { total: 1, physical: 1, special: 1 } : before,
        statsDroppedThisTurn: false,
      },
      defender: { ...defender, damageTakenThisTurn: before },
      move,
      turn: { foeMoved: foeMovesFirst },
      events: [],
      effectiveness: eff,
    }, power, 0);
  }
  if (!power || !Number.isFinite(power)) return 0;
  const sized = power !== move.power ? { ...move, power } : move;

  // The same pieces the engine puts together (Utils/battle.js): items and
  // abilities, weather, screens and terrain, and the stats each move uses
  // (Psyshock hits Defense, Foul Play uses the target's Attack).
  const parts = effects.damageParts(attacker, defender, sized, eff, power);
  if (state) {
    const weatherOut = field.weatherDamageMultiplier(state.field, sized);
    const weatherIn = field.weatherDefenceMultiplier(state.field, defender, sized);
    if (weatherOut !== 1) parts.extraModifiers.push(weatherOut);
    if (weatherIn !== 1) parts.defenceModifiers.push(weatherIn);
    parts.extraModifiers.push(...cond.damageModifiers(state, sideIndex, attacker, defender, sized, sized.type, false));
  }
  const src = state
    ? rules.statSources({ state, sideIndex, attacker, defender, move: sized }, attacker, defender, sized)
    : { attacker, defender, move: sized };

  const result = damage.calculate({
    attacker: src.attacker,
    defender: src.defender,
    move: src.move,
    roll,
    critical: false,
    power,
    effectiveness: eff,
    attackModifiers: parts.attackModifiers,
    defenceModifiers: parts.defenceModifiers,
    extraModifiers: parts.extraModifiers,
    stabMultiplier: parts.stabMultiplier,
    ignoreBurn: parts.ignoreBurn,
  });

  const dealt = Math.max(0, result.damage) * averageHits(attacker, move);
  return Number.isFinite(dealt) ? dealt : 0;
}

/**
 * Would `dealt` knock the target out? Not through a Substitute (it takes the
 * hit), nor past Sturdy or a Focus Sash at full health (single hits only).
 */
function wouldFaint(target, dealt, move) {
  if (!(dealt >= target.hp) || dealt <= 0) return false;
  if (target.substitute > 0) return false;
  const holdsOn = abilityOf(target) === 'sturdy' || itemOf(target) === 'focus-sash';
  if (holdsOn && target.hp >= target.maxHp && averageHits({ ability: null }, move) <= 1) return false;
  return true;
}

/** Does the target move before the user this turn? Speed, flipped by Trick Room. */
function movesFirst(mon, other, state) {
  const trickRoom = Boolean(state && state.field && state.field.trickRoom);
  return trickRoom ? speedOf(mon) < speedOf(other) : speedOf(mon) > speedOf(other);
}

/**
 * Which kinds of attack a Pokemon uses: from its attacks, or, with none, from
 * whichever attacking stat is higher. Replaces Emerald's type lists, which
 * stood for physical and special before each move had its own.
 */
function attackStyle(mon) {
  const attacks = (mon.moves || []).filter((entry) => entry.data && isDamaging(entry.data));
  if (attacks.length) {
    return {
      physical: attacks.some((entry) => entry.data.damageClass === 'physical'),
      special: attacks.some((entry) => entry.data.damageClass === 'special'),
    };
  }
  const physical = (mon.stats.attack || 0) >= (mon.stats.specialAttack || 0);
  return { physical, special: !physical };
}

/** Speed as the engine sees it (paralysis, Choice Scarf...). */
const speedOf = (mon) => require('./battle').effectiveSpeed(mon);


// ---------------------------------------------------------------------------
// The scripts. Each returns a score change for one move.
// ---------------------------------------------------------------------------

/**
 * Does the engine do anything with this move? Status moves it doesn't model
 * (screens, confusion, Taunt, Safeguard, Teleport...) have no effect here, so
 * a trainer using one would waste its turn.
 */
function hasEffectHere(move) {
  if (content.doublesOnly(move.name)) return false;
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
  const foeSide = state ? state.sides[1 - sideIndex].conditions || {} : {};

  // Status moves with their own effect say themselves why they'd fail
  // (Reflect already up, nothing to Encore, no bench to Baton Pass to...).
  if (state && statusMoves.has(move.name)) {
    const why = statusMoves.wouldFail({ state, sideIndex, attacker: user, defender: target, move, turn: turn || {} });
    if (why) return -10;
  }

  // Powder on Grass, Prankster on Dark, sound on Soundproof.
  if (cond.immuneTo(user, target, move)) return -10;

  // Underground, underwater or up in the sky: only a few moves reach it.
  if (aimsAtFoe(move) && !rules.canReach(move, target)) return -10;

  // A Substitute stops status moves aimed at it (sound moves get through).
  if (!isDamaging(move) && aimsAtFoe(move) && target.substitute > 0 && cond.blockedBySubstitute(move)) return -10;

  // Magic Bounce sends status moves straight back.
  if (!isDamaging(move) && aimsAtFoe(move) && abilityOf(target) === 'magic-bounce') return -10;

  // Priority moves can't touch a grounded target on Psychic Terrain, nor one
  // with Queenly Majesty, Dazzling or Armor Tail.
  const priority = (move.priority || 0) + effects.priorityBonus(user, move);
  if (priority > 0 && aimsAtFoe(move)) {
    if (state && state.field.terrain === 'psychic' && cond.grounded(target, state.field)) return -10;
    if (['queenly-majesty', 'dazzling', 'armor-tail'].includes(abilityOf(target))) return -10;
  }

  // Heal Pulse and Floral Healing would heal the player in a single battle.
  if (!isDamaging(move) && !onSelf(move) && move.meta && move.meta.healing > 0) return -10;

  // Fling with nothing held, Natural Gift without a berry, Spit Up and
  // Swallow with nothing stockpiled.
  if (['fling', 'natural-gift', 'spit-up', 'swallow'].includes(move.name) &&
      movepower.resolve(move, { attacker: user, defender: target, rng: () => 0.5 }).kind === 'fail') {
    return -10;
  }

  // Pain Split that would cost HP; Endeavor against something with less HP.
  if (move.name === 'pain-split' && painSplitGain(user, target) <= 0) return -10;
  if (move.name === 'endeavor' && target.hp <= user.hp) return -10;

  // Entry hazards with nobody left to send in.
  if (['stealth-rock', 'spikes', 'toxic-spikes', 'sticky-web'].includes(move.name) && targetAlone) return -10;

  // Swallow with nothing stockpiled; Splash and Celebrate, which do nothing.
  if (move.name === 'swallow' && !user.stockpile) return -10;
  if (['splash', 'celebrate', 'hold-hands', 'happy-hour'].includes(move.name)) return -10;

  // Metal Burst and Comeuppance hit back only after being hit, so they fail
  // when the user moves first.
  if (['metal-burst', 'comeuppance'].includes(move.name) && movesFirst(user, target, state)) return -10;

  // A weather that is already up.
  if (state && field.WEATHER_MOVES[move.name] && state.field.weather === field.WEATHER_MOVES[move.name]) return -10;

  // Confusion: not on something already confused, with Own Tempo, or behind
  // Safeguard or Misty Terrain.
  if (!isDamaging(move) && ailmentOf(move) === 'confusion') {
    if (target.volatiles && target.volatiles.confusion) return -10;
    if (abilityOf(target) === 'own-tempo') return -10;
    if (state && cond.sideBlocksStatus(state, 1 - sideIndex, target, 'confusion', user)) return -10;
  }

  // Safeguard and the terrains stop major statuses too.
  if (state && isStatusMove(move) && cond.sideBlocksStatus(state, 1 - sideIndex, target, ailmentOf(move), user)) {
    return -10;
  }

  if (isDamaging(move)) {
    if (typeResult(move, target, state) === 0) return -10;

    // Dream Eater on something awake, Last Resort too early, Burn Up without
    // its type... The ones that depend on this turn's moves (Focus Punch,
    // Shell Trap, Upper Hand) can't be known in advance.
    if (!['focus-punch', 'shell-trap', 'upper-hand'].includes(move.name) &&
        rules.failReason({ attacker: user, defender: target, move, state, sideIndex, turn: turn || {} })) {
      return -10;
    }
  }

  if (FIRST_TURN_ONLY.has(move.name) && user.turnsActive) return -10;

  if (isStatusMove(move)) {
    const ailment = ailmentOf(move);
    if (target.status) return -10;
    if (hasType(target, STATUS_IMMUNE[ailment])) return -10;
    // Only Thunder Wave respects type immunity (Ground); Hypnosis still hits a
    // Dark type, as in the engine.
    if (move.name === 'thunder-wave' && typeAgainst(move, target, state) === 0) return -10;
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
    if ([user, target].some((mon) => abilityOf(mon) === 'damp')) return -10;
    if (userAlone && !targetAlone) return -10;
  }

  if (move.name === 'leech-seed' && (hasType(target, ['grass']) || target.seededBy)) return -10;

  if (raises(move) && move.statChanges.every((c) => c.change <= 0 || stageOf(user, c.stat) >= MAX_STAGE)) {
    return -10;
  }

  if (lowers(move)) {
    if (move.statChanges.every((c) => c.change >= 0 || stageOf(target, c.stat) <= -MAX_STAGE)) return -10;
    // Mist, and the abilities that stop stat drops.
    if (foeSide.mist && abilityOf(user) !== 'infiltrator') return -10;
    const guard = abilityOf(target);
    if (['clear-body', 'white-smoke', 'full-metal-body'].includes(guard)) return -10;
    const only = (stat) => move.statChanges.every((c) => c.change >= 0 || c.stat === stat);
    if ((guard === 'hyper-cutter' && only('attack')) || (guard === 'keen-eye' && only('accuracy')) ||
        (guard === 'big-pecks' && only('defense'))) return -10;
  }

  if (isHealing(move) && user.hp >= user.maxHp) return -8;


  return 0;
}

/**
 * Emerald's AI_TryToFaint. A move that knocks the target out (at this turn's
 * pre-rolled damage) gets +4, +6 with priority; Explosion gets nothing for it.
 * Any other attack that isn't the strongest available gets -1, and a 4x super
 * effective one +2 about two times in three.
 */
function tryToFaint({ move, sim }) {
  if (!isDamaging(move)) return 0;

  if (sim.kills) {
    if (SELF_FAINT.has(move.name)) return 0;
    return move.priority > 0 ? 6 : 4;
  }

  if (sim.power === 'weaker') return -1;
  if (sim.effectiveness >= 4 && !sim.chance(80)) return 2;
  return 0;
}

// Emerald's AI_CheckViability, effect by effect. `if_random_less_than n` skips
// the score change n times in 256, so a change below applies when
// `!roll(n)`. HP is a percentage, and `targetFaster` means the target strikes
// first on speed alone.


const lastMoveOf = (mon) => (mon.lastMove ? content.move(mon.lastMove) : null);
const badlyPoisoned = (mon) => mon.status === 'poison' && mon.toxicCounter > 0;
const seeded = (mon) => Boolean(mon.seededBy);
const vol = (mon) => mon.volatiles || {};
/** Moves the player's Pokemon has been seen to use, as Emerald's battle history keeps. */
const seenMoves = (mon) => new Set(vol(mon).usedMoves || []);

/** A stat raise (Swords Dance, Calm Mind): AI_CV_AttackUp and its siblings. */
function cvStatUp(c, stat, hpBranch) {
  let s = 0;
  if (stageOf(c.user, stat) >= 3) {
    if (!c.roll(100)) s -= 1;
  } else if (c.hp === 100 && !c.roll(128)) {
    s += 2;
  }
  return s + hpBranch(c);
}

const atkUpHp = (threshold) => (c) => {
  if (c.hp > 70) return 0;
  if (c.hp < 40) return -2;
  return c.roll(threshold) ? 0 : -2;
};

/** Defense Up and Special Defense Up also look at what the target last used. */
const defUpHp = (wantPhysical) => (c) => {
  if (c.hp >= 70 && c.roll(200)) return 0;
  if (c.hp < 40) return -2;
  const last = lastMoveOf(c.target);
  if (last && isDamaging(last)) {
    const physical = last.damageClass === 'physical';
    if (physical !== wantPhysical) return -2;
  }
  return c.roll(60) ? 0 : -2;
};

function cvAccuracyUp(c) {
  let s = 0;
  if (stageOf(c.user, 'accuracy') >= 3 && !c.roll(50)) s -= 2;
  if (c.hp <= 70) s -= 2;
  return s;
}

function cvEvasionUp(c) {
  const { user, target } = c;
  let s = 0;
  if (c.hp >= 90 && !c.roll(100)) s += 3;
  if (stageOf(user, 'evasion') >= 3 && !c.roll(128)) s -= 1;
  if (badlyPoisoned(target)) {
    if (c.hp > 50 || !c.roll(80)) { if (!c.roll(50)) s += 3; }
  }
  if (seeded(target) && !c.roll(70)) s += 3;
  if (vol(user).ingrain && !c.roll(128)) s += 2;
  if (vol(target).cursed && !c.roll(70)) s += 3;
  if (c.hp > 70 || stageOf(user, 'evasion') === 0) return s;
  if (c.hp < 40 || c.targetHp < 40) return s - 2;
  return c.roll(70) ? s : s - 2;
}

function cvSpeedUp(c) {
  if (!c.targetFaster) return -3;
  return c.roll(70) ? 0 : 3;
}

function cvDragonDance(c) {
  if (c.targetFaster) return c.roll(128) ? 0 : 1;
  if (c.hp > 50) return 0;
  return c.roll(70) ? 0 : -1;
}

/** Growl, Charm, Eerie Impulse: only worth it if the target attacks that way. */
function cvAttackDown(c, stat, kind) {
  const stage = stageOf(c.target, stat);
  let s = 0;
  if (stage !== 0) {
    s -= 1;
    if (c.hp <= 90) s -= 1;
    if (stage <= -3 && !c.roll(50)) s -= 2;
  }
  if (c.targetHp <= 70) s -= 2;
  if (!attackStyle(c.target)[kind] && !c.roll(50)) s -= 2;
  return s;
}

/** Leer, Screech, Sand Attack's opposite numbers: Defense, Special Defense and evasion drops. */
function cvOtherDown(c, stat) {
  let s = 0;
  if (c.hp < 70 || stageOf(c.target, stat) <= -3) {
    if (!c.roll(50)) s -= 2;
  }
  if (c.targetHp <= 70) s -= 2;
  return s;
}

function cvSpeedDown(c) {
  if (!c.targetFaster) return -3;
  return c.roll(70) ? 0 : 2;
}

function cvAccuracyDown(c) {
  const { user, target } = c;
  let s = 0;
  if (c.hp < 70 || c.targetHp <= 70) {
    if (!c.roll(100)) s -= 1;
  }
  if (stageOf(user, 'accuracy') <= -2 && !c.roll(80)) s -= 2;
  if (badlyPoisoned(target) && !c.roll(70)) s += 2;
  if (seeded(target) && !c.roll(70)) s += 2;
  if (vol(user).ingrain && !c.roll(128)) s += 1;
  if (vol(target).cursed && !c.roll(70)) s += 2;
  if (c.hp > 70 || stageOf(target, 'accuracy') === 0) return s;
  if (c.hp < 40 || c.targetHp < 40) return s - 2;
  return c.roll(70) ? s : s - 2;
}

const BOOSTABLE = ['attack', 'defense', 'special-attack', 'special-defense', 'evasion'];
const DROPPABLE = ['attack', 'defense', 'special-attack', 'special-defense', 'accuracy'];

function cvHaze(c) {
  const { user, target } = c;
  let s = 0;
  const badForUs = BOOSTABLE.some((st) => stageOf(user, st) > 2) || DROPPABLE.some((st) => stageOf(target, st) < -2);
  if (badForUs && !c.roll(50)) s -= 3;
  const goodForUs = BOOSTABLE.some((st) => stageOf(target, st) > 2) || DROPPABLE.some((st) => stageOf(user, st) < -2);
  if (goodForUs) return c.roll(50) ? s : s + 3;
  return c.roll(50) ? s : s - 1;
}

function cvRoar(c) {
  if (!BOOSTABLE.some((st) => stageOf(c.target, st) > 2)) return -3;
  return c.roll(128) ? 0 : 2;
}

/** How much a healing move restores. */
function healAmount(user, move, state) {
  if (move.name === 'rest') return user.maxHp;
  let share = (move.meta && move.meta.healing) || 50;
  // Morning Sun and friends: two thirds in sun, a quarter in other weather.
  const weather = state && state.field.weather;
  if (['morning-sun', 'synthesis', 'moonlight'].includes(move.name) && weather) share = weather === 'sun' ? 66 : 25;
  return Math.floor((user.maxHp * share) / 100);
}

/**
 * Whether healing this turn is worth the turn, against the target's next
 * hit (`c.incoming`, its strongest attack at a high roll):
 *
 *   - moving first: healing that lets it survive a hit it otherwise wouldn't
 *     is a strong play; healing that still leaves it inside one hit is wasted
 *   - moving second: it takes the hit first, so if that knocks it out the
 *     heal never happens
 *
 * Returns a score change, or null when neither applies and Emerald's HP
 * thresholds decide.
 */
function healOutlook(c, restored) {
  const { user, incoming } = c;
  if (!incoming) return null;
  const healed = Math.min(user.maxHp, user.hp + restored);
  if (!c.targetFaster) {
    if (incoming >= user.hp && incoming < healed) return c.roll(20) ? 3 : 4;
    if (incoming >= healed) return -3;
    return null;
  }
  if (incoming >= user.hp) return -5;
  // Healing less than it loses each turn only delays the end.
  if (restored < incoming * 0.75 && c.hp > 33) return -2;
  return null;
}

/**
 * Recover and the like: Emerald's HP thresholds, after healOutlook. (Emerald's
 * own script scores -8 whenever the user is faster and not at full health,
 * skipping the branch meant for that case; this follows the intended branch.)
 */
function cvHeal(c) {
  if (c.hp === 100) return -3;
  const outlook = healOutlook(c, healAmount(c.user, c.move, c.state));
  if (outlook != null) return outlook;
  if (!c.targetFaster) {
    if (c.hp < 50) return healUp(c);
    if (c.hp > 80) return -3;
    return c.roll(70) ? healUp(c) : -3;
  }
  if (c.hp < 70 || c.roll(30)) return healUp(c);
  return -3;
}
const healUp = (c) => (c.roll(20) ? 0 : 2);

function cvHealWeather(c) {
  const weather = c.state && c.state.field.weather;
  if (['hail', 'snow', 'rain', 'sandstorm'].includes(weather)) return -2 + cvHeal(c);
  return cvHeal(c);
}

function cvRest(c) {
  const up = () => (c.roll(10) ? 0 : 3);
  if (c.hp === 100) return -8;
  const outlook = healOutlook(c, c.user.maxHp);
  if (outlook != null && outlook < 0) return outlook;
  if (c.targetFaster) {
    if (c.hp < 60) return up();
    if (c.hp > 70) return -3;
    return c.roll(50) ? up() : -3;
  }
  if (c.hp < 40) return up();
  if (c.hp > 50) return -3;
  return c.roll(70) ? up() : -3;
}

/** Toxic and Leech Seed. */
function cvToxic(c) {
  let s = 0;
  const attacks = (c.user.moves || []).some((entry) => isDamaging(entry.data));
  if (attacks) {
    if (c.hp <= 50 && !c.roll(50)) s -= 3;
    if (c.targetHp <= 50 && !c.roll(50)) s -= 3;
  }
  const stalls = (c.user.moves || []).some((entry) =>
    PROTECTS.has(entry.name) || (raises(entry.data) && entry.data.statChanges.some((x) => x.stat === 'special-defense')));
  if (stalls && !c.roll(60)) s += 2;
  return s;
}

function cvPoison(c) {
  if (c.hp < 50 || c.targetHp <= 50) return -1;
  return 0;
}

function cvParalyze(c) {
  if (c.targetFaster) return c.roll(20) ? 0 : 3;
  return c.hp > 70 ? 0 : -1;
}

function cvSleep(c) {
  const seen = seenMoves(c.user);
  const follows = ['dream-eater', 'nightmare'].some((name) => seen.has(name) || (c.user.moves || []).some((m) => m.name === name));
  return follows && !c.roll(128) ? 1 : 0;
}

function cvConfuse(c) {
  if (c.targetHp > 70) return 0;
  let s = 0;
  if (!c.roll(128)) s -= 1;
  if (c.targetHp <= 50) s -= 1;
  if (c.targetHp <= 30) s -= 1;
  return s;
}

/** Swagger and Flatter: a coin flip for +1, then judged as confusion. */
function cvFlatter(c) {
  return (c.roll(128) ? 0 : 1) + cvConfuse(c);
}

/** Light Screen, Reflect, Aurora Veil: only worth it against the kind of attack the target uses. */
function cvLightScreen(c, kinds) {
  if (c.hp < 50) return -2;
  const style = attackStyle(c.target);
  if (kinds.some((kind) => style[kind])) return 0;
  return c.roll(50) ? 0 : -2;
}

function cvSubstitute(c) {
  let s = 0;
  if (c.hp <= 90) {
    if (c.hp <= 70) {
      if (c.hp <= 50 && !c.roll(100)) s -= 1;
      if (!c.roll(100)) s -= 1;
    }
    if (!c.roll(100)) s -= 1;
  }
  if (c.targetFaster) return s;
  const last = lastMoveOf(c.target);
  if (!last || isDamaging(last)) return s;
  const ailment = ailmentOf(last);
  const tempting =
    (['sleep', 'poison', 'paralysis', 'burn'].includes(ailment) && !c.target.status) ||
    (ailment === 'confusion' && !vol(c.target).confusion) ||
    (last.name === 'leech-seed' && !seeded(c.target));
  return tempting && !c.roll(100) ? s + 1 : s;
}

function cvProtect(c) {
  const { user, target } = c;
  const streak = user.protectStreak || 0;
  if (streak > 1) return -2;
  const hurting = (mon) => badlyPoisoned(mon) || vol(mon).cursed || vol(mon).perish !== undefined ||
    vol(mon).attract || seeded(mon) || vol(mon).yawn;
  const seen = seenMoves(target);
  const theyHeal = [...seen].some((name) => { const m = content.move(name); return m && isHealing(m); }) ||
    seen.has('defense-curl');
  // Emerald scores nothing then (-2 only after Lock-On, which nothing here uses).
  if (hurting(user) || theyHeal) return 0;
  let s = 2;
  if (!c.roll(128)) s -= 1;
  if (streak) {
    s -= 1;
    if (!c.roll(128)) s -= 1;
  }
  return s;
}

function cvEndure(c) {
  if (c.hp < 4) return -1;
  if (c.hp < 35) return c.roll(70) ? 0 : 1;
  return -1;
}

function cvBellyDrum(c) {
  return c.hp < 90 ? -2 : 0;
}

function cvCurse(c) {
  if (hasType(c.user, ['ghost'])) return c.hp > 80 ? 0 : -1;
  const def = stageOf(c.user, 'defense');
  let s = 0;
  if (def > 3) return 0;
  if (!c.roll(128)) s += 1;
  if (def > 1) return s;
  if (!c.roll(128)) s += 1;
  if (def > 0) return s;
  if (!c.roll(128)) s += 1;
  return s;
}

/** What Pain Split would gain the user, in HP (negative: it would lose some). */
function painSplitGain(user, target) {
  const shared = Math.floor((user.hp + target.hp) / 2);
  return Math.min(user.maxHp, shared) - user.hp;
}

/**
 * Pain Split: worth it for the HP it actually gains. Emerald judges it on
 * percentages alone, which can split HP with a frail target and lose some;
 * this weighs the real HP, and whether the gain lets it live through the next
 * hit.
 */
function cvPainSplit(c) {
  const gain = painSplitGain(c.user, c.target);
  if (gain <= 0) return -10;
  const outlook = healOutlook(c, gain);
  if (outlook != null) return outlook;
  const share = gain / c.user.maxHp;
  if (share >= 0.4) return 3;
  if (share >= 0.25) return 2;
  if (share >= 0.1) return 0;
  return -2;
}

function cvWeather(c, weather) {
  const now = c.state && c.state.field.weather;
  if (weather === 'rain' && c.targetFaster && abilityOf(c.user) === 'swift-swim') return 1;
  if (c.hp < 40) return -1;
  const others = ['sun', 'rain', 'sandstorm', 'hail', 'snow'].filter((w) => w !== weather);
  if (others.includes(now)) return 1;
  if (weather === 'rain' && abilityOf(c.user) === 'rain-dish') return 1;
  return 0;
}

// Attacks with a judgement of their own.

const weakHit = (c) => c.sim.effectiveness > 0 && c.sim.effectiveness < 1;

function cvSelfKO(c) {
  let s = 0;
  const evasion = stageOf(c.target, 'evasion');
  if (evasion >= 1) {
    s -= 1;
    if (evasion >= 4 && !c.roll(128)) s -= 1;
  }
  if (c.hp >= 80 && !c.targetFaster) return c.roll(50) ? s : s - 3;
  if (c.hp > 50) return c.roll(50) ? s : s - 1;
  if (!c.roll(128)) s += 1;
  if (c.hp <= 30 && !c.roll(50)) s += 1;
  return s;
}

function cvAbsorb(c) {
  return weakHit(c) && !c.roll(50) ? -3 : 0;
}

function cvRecharge(c) {
  if (weakHit(c)) return -1;
  if (c.targetFaster) return c.hp < 60 ? 0 : -1;
  return c.hp > 40 ? -1 : 0;
}

function cvChargeUp(c) {
  if (weakHit(c)) return -2;
  if ([...seenMoves(c.target)].some((name) => PROTECTS.has(name))) return -2;
  return c.hp > 38 ? 0 : -1;
}

function cvSemiInvulnerable(c) {
  if ([...seenMoves(c.target)].some((name) => PROTECTS.has(name))) return -1;
  const encourage = () => (c.roll(80) ? 0 : 1);
  if (badlyPoisoned(c.target) || vol(c.target).cursed || seeded(c.target)) return encourage();
  const weather = c.state && c.state.field.weather;
  if ((weather === 'hail' || weather === 'snow') && hasType(c.user, ['ice'])) return encourage();
  if (weather === 'sandstorm' && hasType(c.user, ['rock', 'ground', 'steel'])) return encourage();
  if (c.targetFaster) return 0;
  return encourage();
}

function cvHighCrit(c) {
  if (weakHit(c)) return 0;
  if (c.sim.effectiveness < 2 && c.roll(128)) return 0;
  return c.roll(128) ? 0 : 1;
}

/** Superpower and Close Combat: better as a last act than an opener. */
function cvSuperpower(c) {
  if (weakHit(c) || stageOf(c.user, 'attack') < 0) return -1;
  if (c.targetFaster) return c.hp < 60 ? 0 : -1;
  return c.hp > 40 ? -1 : 0;
}

/** Overheat and its kind: best while still healthy. */
function cvOverheat(c) {
  if (weakHit(c)) return -1;
  if (c.targetFaster) return c.hp > 80 ? 0 : -1;
  return c.hp > 60 ? 0 : -1;
}

/**
 * Eruption and Water Spout. Emerald checks the target's HP here; the power
 * depends on the user's, which is what this checks.
 */
function cvEruption(c) {
  if (weakHit(c)) return -1;
  if (c.targetFaster) return c.hp > 70 ? 0 : -1;
  return c.hp > 50 ? 0 : -1;
}

function cvRevenge(c) {
  if (c.target.status === 'sleep' || vol(c.target).attract || vol(c.target).confusion) return -2;
  return c.roll(180) ? -2 : 2;
}

function cvFocusPunch(c) {
  if (weakHit(c)) return -1;
  if (c.target.status === 'sleep') return 1;
  if (vol(c.target).attract || vol(c.target).confusion) {
    if (c.roll(100)) return 0;
    return c.user.substitute > 0 ? 5 : 1;
  }
  if (!c.user.turnsActive) return 0;
  return c.roll(100) ? 0 : 1;
}

function cvFlail(c) {
  if (c.targetFaster) {
    if (c.hp > 60) return -1;
    if (c.hp > 40) return 0;
  } else {
    if (c.hp > 33) return -1;
    if (c.hp > 20) return 0;
    if (c.hp < 8) return 1 + (c.roll(100) ? 0 : 1);
  }
  return c.roll(100) ? 0 : 1;
}

function cvEndeavor(c) {
  if (c.targetHp < 70) return -1;
  if (c.targetFaster) return c.hp > 50 ? -1 : 1;
  return c.hp > 40 ? -1 : 1;
}

function cvTrap(c) {
  const t = c.target;
  const stuck = badlyPoisoned(t) || vol(t).cursed || vol(t).perish !== undefined || vol(t).attract;
  return stuck && !c.roll(128) ? 1 : 0;
}

function cvKnockOff(c) {
  if (c.targetHp < 30 || !c.user.turnsActive) return 0;
  return c.roll(180) ? 0 : 1;
}

// Moves from after Emerald, judged the way Emerald judges its nearest
// equivalent.

/** Will-O-Wisp (Emerald has no script for it): like Thunder Wave, aimed at physical attackers. */
function cvBurn(c) {
  if (!attackStyle(c.target).physical) return c.hp > 70 ? 0 : -1;
  return c.roll(20) ? 0 : 3;
}

/** Stealth Rock, Spikes, Toxic Spikes, Sticky Web: early, while the target has others to send in. */
function cvHazard(c) {
  if (c.targetAlone) return -10;
  if (c.hp < 50) return -1;
  return c.roll(128) ? 0 : 1;
}

/** Tailwind: Emerald's Speed Up, for the whole side. */
const cvTailwind = cvSpeedUp;

/** Trick Room: set it up when the target is faster; end it when it's helping the target. */
function cvTrickRoom(c) {
  const on = c.state && c.state.field.trickRoom;
  if (on) return c.rawTargetFaster ? -10 : 2;
  return c.rawTargetFaster ? (c.roll(70) ? 0 : 3) : -10;
}

/** Defog and Rapid Spin's purpose: only with hazards on its own side. */
function cvClearHazards(c) {
  const mine = (c.state && c.state.sides[c.sideIndex].conditions) || {};
  const has = mine.spikes || mine.toxicSpikes || mine.stealthRock || mine.stickyWeb;
  return has ? (c.roll(50) ? 1 : 2) : 0;
}

/** Sucker Punch: fails against a status move, so not when that's what the target last chose. */
function cvSuckerPunch(c) {
  const last = lastMoveOf(c.target);
  if (last && !isDamaging(last)) return -2;
  return 0;
}

/** Crush Grip, Wring Out, Hard Press: strongest while the target is healthy. */
function cvTargetHealthy(c) {
  if (c.targetFaster) return c.targetHp > 70 ? 0 : -1;
  return c.targetHp > 50 ? 0 : -1;
}

/** Wish: heals next turn, so it's judged like Recover. */
const cvWish = cvHeal;

const STAT_UP = {
  attack: (c) => cvStatUp(c, 'attack', atkUpHp(40)),
  defense: (c) => cvStatUp(c, 'defense', defUpHp(true)),
  'special-attack': (c) => cvStatUp(c, 'special-attack', atkUpHp(70)),
  'special-defense': (c) => cvStatUp(c, 'special-defense', defUpHp(false)),
  speed: cvSpeedUp,
  accuracy: cvAccuracyUp,
  evasion: cvEvasionUp,
};

const STAT_DOWN = {
  attack: (c) => cvAttackDown(c, 'attack', 'physical'),
  'special-attack': (c) => cvAttackDown(c, 'special-attack', 'special'),
  defense: (c) => cvOtherDown(c, 'defense'),
  'special-defense': (c) => cvOtherDown(c, 'special-defense'),
  evasion: (c) => cvOtherDown(c, 'evasion'),
  speed: cvSpeedDown,
  accuracy: cvAccuracyDown,
};

const RAISING_MOVES_WITH_OWN_RULE = {
  'belly-drum': cvBellyDrum,
  curse: cvCurse,
};

/** Which Emerald effect script judges this move, or null for none. */
function viabilityScript(move, sim) {
  const name = move.name;
  if (RAISING_MOVES_WITH_OWN_RULE[name]) return RAISING_MOVES_WITH_OWN_RULE[name];

  if (!isDamaging(move)) {
    if (name === 'rest') return cvRest;
    if (name === 'wish') return cvWish;
    if (name === 'will-o-wisp') return cvBurn;
    if (name === 'yawn') return cvSleep;
    if (['stealth-rock', 'spikes', 'toxic-spikes', 'sticky-web'].includes(name)) return cvHazard;
    if (name === 'tailwind') return cvTailwind;
    if (name === 'trick-room') return cvTrickRoom;
    if (name === 'defog' || name === 'tidy-up') return cvClearHazards;
    if (name === 'aurora-veil') return (c) => cvLightScreen(c, ['physical', 'special']);
    if (['morning-sun', 'synthesis', 'moonlight'].includes(name)) return cvHealWeather;
    if (isHealing(move) || name === 'swallow') return cvHeal;
    if (name === 'toxic' || name === 'leech-seed') return cvToxic;
    if (['swagger', 'flatter'].includes(name)) return cvFlatter;
    if (PROTECTS.has(name)) return name === 'endure' ? cvEndure : cvProtect;
    if (field.isSubstitute(move)) return cvSubstitute;
    if (name === 'haze') return cvHaze;
    if (['roar', 'whirlwind'].includes(name)) return cvRoar;
    if (name === 'light-screen') return (c) => cvLightScreen(c, ['special']);
    if (name === 'reflect') return (c) => cvLightScreen(c, ['physical']);
    if (name === 'rain-dance') return (c) => cvWeather(c, 'rain');
    if (name === 'sunny-day') return (c) => cvWeather(c, 'sun');
    if (name === 'hail' || name === 'snowscape') return (c) => cvWeather(c, 'hail');
    if (name === 'pain-split') return cvPainSplit;
    if (['mean-look', 'block', 'spider-web'].includes(name)) return cvTrap;
    if (SELF_FAINT.has(name)) return cvSelfKO;

    const ailment = ailmentOf(move);
    if (ailment === 'sleep') return cvSleep;
    if (ailment === 'paralysis') return cvParalyze;
    if (ailment === 'poison') return cvPoison;
    if (ailment === 'confusion') return cvConfuse;

    if (raises(move)) {
      const up = move.statChanges.filter((x) => x.change > 0).map((x) => x.stat);
      // Dragon Dance and the other speed-and-something moves; Calm Mind,
      // Cosmic Power and Bulk Up as Emerald files them.
      if (up.includes('speed') && up.length > 1) return cvDragonDance;
      if (up.includes('special-defense') && up.length > 1) return STAT_UP['special-defense'];
      if (up.includes('defense') && up.length > 1) return STAT_UP.defense;
      return STAT_UP[up[0]] || null;
    }
    if (lowers(move)) {
      const down = move.statChanges.filter((x) => x.change < 0).map((x) => x.stat);
      return STAT_DOWN[down[0]] || null;
    }
    return null;
  }

  if (SELF_FAINT.has(name)) return cvSelfKO;
  if (name === 'dream-eater') return (c) => (weakHit(c) ? -1 : 0);
  if (['sucker-punch', 'thunderclap'].includes(name)) return cvSuckerPunch;
  if (['crush-grip', 'wring-out', 'hard-press'].includes(name)) return cvTargetHealthy;
  if (['rapid-spin', 'mortal-spin'].includes(name)) return cvClearHazards;
  if (name === 'fake-out') return () => 2;
  // Emerald looks at the target's status here; Facade cares about the user's.
  if (name === 'facade') return (c) => (['poison', 'burn', 'paralysis'].includes(c.user.status) ? 1 : 0);
  if (name === 'focus-punch') return cvFocusPunch;
  if (['smelling-salts'].includes(name)) return (c) => (c.target.status === 'paralysis' ? 1 : 0);
  if (['revenge', 'avalanche'].includes(name)) return cvRevenge;
  if (['brick-break', 'psychic-fangs', 'raging-bull'].includes(name)) {
    return (c) => ((c.state && (c.state.sides[1 - c.sideIndex].conditions || {}).reflect) ? 1 : 0);
  }
  if (name === 'knock-off') return cvKnockOff;
  if (name === 'endeavor') return cvEndeavor;
  if (['flail', 'reversal'].includes(name)) return cvFlail;
  if (['super-fang', 'natures-madness', 'ruination'].includes(name)) return (c) => (c.targetHp > 50 ? 0 : -1);
  if (name === 'spit-up') return (c) => ((c.user.stockpile || 0) >= 2 && !c.roll(80) ? 2 : 0);
  if (['eruption', 'water-spout', 'dragon-energy'].includes(name)) return cvEruption;
  if (rules.RECHARGE.has(name)) return cvRecharge;
  if (rules.CHARGE[name]) return rules.CHARGE[name].vanish ? cvSemiInvulnerable : cvChargeUp;
  if (sim.selfDrop === 'special-attack') return cvOverheat;
  if (sim.selfDrop) return cvSuperpower;
  if (move.meta && move.meta.drain > 0) return cvAbsorb;
  if (field.isTrapping(move)) return cvTrap;
  if (['icy-wind', 'rock-tomb', 'mud-shot', 'electroweb', 'bulldoze'].includes(name)) return cvSpeedDown;
  if (move.meta && move.meta.critRate > 0) return cvHighCrit;
  return null;
}

/** Emerald's per-effect judgement, dice rolls included. */
function checkViability(context) {
  const script = viabilityScript(context.move, context.sim);
  if (!script) return 0;
  return script({
    ...context,
    hp: Math.floor(percent(context.user)),
    targetHp: Math.floor(percent(context.target)),
    roll: (n) => chance(context.rng, n),
  });
}

const SCRIPTS = { checkBadMove, tryToFaint, checkViability };

// ---------------------------------------------------------------------------
// Choosing a move
// ---------------------------------------------------------------------------

/**
 * The most one of `attacker`'s attacks would do to `defender`, at a given
 * roll. `sideIndex` is the attacker's side.
 */
function strongestHit(attacker, defender, state, sideIndex, roll = 0.5) {
  let most = 0;
  const foeMovesFirst = movesFirst(defender, attacker, state);
  for (const entry of attacker.moves || []) {
    if (entry.pp <= 0 || !entry.data || !isDamaging(entry.data)) continue;
    const move = asUsed(attacker, defender, entry.data, state, sideIndex);
    most = Math.max(most, expectedDamage(attacker, defender, move, roll, { state, sideIndex, foeMovesFirst }));
  }
  return most;
}

/**
 * Emerald's sIgnoredPowerfulMoveEffects: never "the strongest move" (nor
 * weaker). Emerald also leaves out Eruption, Water Spout and Spit Up because
 * their power varies; here their real power is worked out, so they compete.
 */
function ignoredForPower(move, sim) {
  return SELF_FAINT.has(move.name) || move.name === 'dream-eater' ||
    move.name === 'focus-punch' || rules.RECHARGE.has(move.name) ||
    (rules.CHARGE[move.name] && !rules.CHARGE[move.name].vanish) || Boolean(sim.selfDrop);
}

/** An attack that lowers its user's own Attack/Defense (Superpower) or Special Attack (Overheat). */
function selfDropOf(move) {
  if (!isDamaging(move) || !(move.meta && move.meta.category === 'damage-raise')) return null;
  const drops = (move.statChanges || []).filter((x) => x.change < 0).map((x) => x.stat);
  if (drops.includes('special-attack')) return 'special-attack';
  if (drops.includes('attack') || drops.includes('defense')) return 'attack';
  return null;
}

/** The move as it will be used this turn: Hidden Power's type, Weather Ball's... */
function asUsed(user, target, move, state, sideIndex) {
  if (!state || !isDamaging(move)) return move;
  const type = rules.typeFor({ state, sideIndex, attacker: user, defender: target, move, turn: {}, events: [] });
  return type ? { ...move, type } : move;
}

/**
 * Score every usable move for this kind of battle.
 *
 * As in Emerald, each move gets a damage roll (85-100%) once, up front, and
 * that roll decides whether it knocks the target out and which attack is the
 * strongest.
 *
 * @returns {Array<{slot, score, kills}>}
 */
function scoreMoves(user, target, kind = 'trainer', rng = Math.random, sides = {}) {
  const { state = null, sideIndex = 1 } = sides;

  // Only moves it may actually use: PP left, nothing forbidding it (Taunt,
  // Disable...), and only the encored one under Encore.
  const encored = cond.encoreSlot(user);
  const usable = (user.moves || [])
    .map((entry, slot) => ({ entry, slot, move: asUsed(user, target, entry.data, state, sideIndex) }))
    .filter(({ entry, slot }) =>
      entry.pp > 0 &&
      (encored == null || slot === encored) &&
      !(state && cond.restriction(state, sideIndex, user, slot)));

  // Emerald's "target is faster" means it moves first, so Trick Room flips it.
  const rawTargetFaster = speedOf(target) > speedOf(user);
  const targetFaster = movesFirst(target, user, state);
  const flags = FLAGS[kind] || FLAGS.trainer;

  // The pre-rolled damage of every attack.
  const battleSides = { state, sideIndex, foeMovesFirst: targetFaster };
  for (const option of usable) {
    option.selfDrop = selfDropOf(option.move);
    option.dealt = isDamaging(option.move) ? expectedDamage(user, target, option.move, rng(), battleSides) : 0;
  }
  const strongest = Math.max(0, ...usable.filter((o) => !ignoredForPower(o.move, o)).map((o) => o.dealt));

  // The target's next hit: its strongest attack at a high roll.
  const incoming = flags.includes('checkViability') ? strongestHit(target, user, state, 1 - sideIndex, 0.85) : 0;

  return usable.map(({ move, slot, dealt, selfDrop }) => {
    const sim = {
      kills: isDamaging(move) && wouldFaint(target, dealt, move),
      power: !isDamaging(move) || ignoredForPower(move, { selfDrop }) ? 'other' : dealt >= strongest ? 'strongest' : 'weaker',
      effectiveness: isDamaging(move) ? typeAgainst(move, target, state) : 1,
      selfDrop,
      chance: (n) => chance(rng, n),
    };
    const context = {
      user,
      target,
      move,
      rng,
      sim,
      targetFaster,
      rawTargetFaster,
      userFaster: !targetFaster,
      incoming,
      userAlone: Boolean(sides.userAlone),
      targetAlone: Boolean(sides.targetAlone),
      state,
      sideIndex,
      turn: sides.turn || null,
    };
    const score = flags.reduce((total, flag) => total + SCRIPTS[flag](context), BASE_SCORE);
    return { slot, score, kills: sim.kills && !SELF_FAINT.has(move.name) };
  });
}

/**
 * The move to use: the highest score, ties broken at random. A trainer that
 * can knock the target out always does, choosing among the moves that would.
 */
function chooseMoveSlot(user, target, kind = 'trainer', rng = Math.random, sides = {}) {
  const scored = scoreMoves(user, target, kind, rng, sides);

  // Nothing usable: the engine falls back to Struggle on any slot.
  if (!scored.length) return 0;

  const flags = FLAGS[kind] || FLAGS.trainer;
  const killers = flags.includes('tryToFaint') ? scored.filter((o) => o.kills && o.score >= BASE_SCORE) : [];
  const pool = killers.length ? killers : scored;

  const best = Math.max(...pool.map((option) => option.score));
  const tied = pool.filter((option) => option.score === best);
  return tied[Math.floor(rng() * tied.length)].slot;
}

// ---------------------------------------------------------------------------
// Switching (Emerald's ShouldSwitch)
// ---------------------------------------------------------------------------

/**
 * How well one of ours does against theirs: the share of their remaining HP
 * our best attack takes, minus the share of ours theirs takes back (each
 * capped at all of it). Current HP, so a Pokemon about to faint is a poor
 * choice, unless it moves first and knocks them out before they can hit back.
 */
function matchup(ours, theirs, state = null, sideIndex = 1) {
  const dealt = Math.min(1, strongestHit(ours, theirs, state, sideIndex) / Math.max(1, theirs.hp));
  if (dealt >= 1 && movesFirst(ours, theirs, state)) return 1;
  const taken = Math.min(1, strongestHit(theirs, ours, state, 1 - sideIndex) / Math.max(1, ours.hp));
  return dealt - taken;
}

const superEffectiveAgainst = (mon, foe, state, sideIndex) =>
  (mon.moves || []).filter((entry) => entry.pp > 0 && entry.data && isDamaging(entry.data) &&
    typeResult(asUsed(mon, foe, entry.data, state, sideIndex), foe, state) >= 2);

/**
 * A switch for a matchup the active Pokemon is clearly losing. All of these
 * must hold:
 *
 *   - the target's best attack would take half or more of its remaining HP,
 *     or knock it out before it moves
 *   - it can't knock the target out, and its best attack takes less than half
 *     of the target's remaining HP
 *   - it isn't boosted
 *
 * and the replacement must resist (or be immune to) the attack that's winning,
 * and be weak to nothing else the target has, so a stronger Pokemon with the
 * same weakness (Pidgeot for Pidgey) doesn't count; take less than a third
 * of its remaining HP from the best of them; be at half health or more; and
 * hit back for at least a quarter of the target's max HP. The best such replacement goes in, four times in five.
 */
function advantageSwitch(state, sideIndex, bench, rng) {
  const side = state.sides[sideIndex];
  const mine = side.team[side.active];
  const theirs = state.sides[1 - sideIndex].team[state.sides[1 - sideIndex].active];
  const foeIndex = 1 - sideIndex;

  if (Object.values(mine.stages || {}).some((stage) => stage > 0)) return null;

  const taking = strongestHit(theirs, mine, state, foeIndex, 0.85);
  const dealing = strongestHit(mine, theirs, state, sideIndex, 0.5);
  const theyMoveFirst = movesFirst(theirs, mine, state);

  const losing = taking >= mine.hp / 2 || (theyMoveFirst && taking >= mine.hp);
  if (!losing || dealing >= theirs.hp / 2) return null;

  const attacks = (theirs.moves || [])
    .filter((entry) => entry.pp > 0 && entry.data && isDamaging(entry.data))
    .map((entry) => asUsed(theirs, mine, entry.data, state, foeIndex));
  if (!attacks.length) return null;

  // The attack that's winning the matchup.
  const hit = (move) => expectedDamage(theirs, mine, move, 0.85, { state, sideIndex: foeIndex, foeMovesFirst: !theyMoveFirst });
  const threat = attacks.reduce((top, move) => (hit(move) > hit(top) ? move : top));

  let best = null;
  for (const { mon, index } of bench) {
    if (percent(mon) < 50) continue;
    // It must resist the attack that's winning, and nothing else the target
    // has may be super effective on it.
    if (typeResult(threat, mon, state) >= 1) continue;
    if (attacks.some((move) => typeResult(move, mon, state) > 1)) continue;
    const takes = strongestHit(theirs, mon, state, foeIndex, 0.85);
    if (takes >= mon.hp / 3) continue;
    const deals = strongestHit(mon, theirs, state, sideIndex, 0.5);
    if (deals < theirs.maxHp / 4) continue;
    const score = deals / Math.max(1, theirs.hp) - takes / Math.max(1, mon.hp);
    if (!best || score > best.score) best = { index, score };
  }

  return best && rng() < 4 / 5 ? best.index : null;
}

/**
 * Whether to switch now, and to which bench index (null to stay in).
 *
 * Emerald's order: Perish Song about to land; Wonder Guard with nothing super
 * effective; a bench Pokemon that absorbs the move that just hit (Flash Fire,
 * Water Absorb, Volt Absorb...); a sleeping Natural Cure user. It stays in
 * when it has a super effective move (nine times in ten) or is boosted by more
 * than three stages in all. Otherwise it may switch to a Pokemon that's immune
 * to (one in two) or resists (one in three) the move that just hit it, and
 * hits back super effectively.
 *
 * Ordinary trainers (`careful` false) go through the same checks but take
 * each chance a third as often, and leave Natural Cure alone. Either kind
 * switches when nothing it has can affect the target at all, and never within
 * a few turns of its last switch.
 */
function switchTarget(state, sideIndex, rng = Math.random, careful = true) {
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

  // Ordinary trainers roll each chance three times over.
  const odds = (p) => rng() < (careful ? p : p / 3);
  const bestMatchup = () => {
    let found = null;
    for (const { mon, index } of bench) {
      const score = matchup(mon, theirs, state, sideIndex);
      if (!found || score > found.score) found = { index, score };
    }
    return found.index;
  };

  // Nothing it has can affect the target at all.
  const anyEffect = (mine.moves || []).some((entry) => {
    if (entry.pp <= 0) return false;
    if (!entry.data) return false;
    if (!isDamaging(entry.data)) return checkBadMove({ user: mine, target: theirs, move: entry.data, state, sideIndex }) === 0;
    return typeResult(asUsed(mine, theirs, entry.data, state, sideIndex), theirs, state) > 0;
  });
  if (!anyEffect) return bestMatchup();

  // Perish Song is about to land.
  if (vol(mine).perish === 1) return bestMatchup();

  // Wonder Guard, and nothing super effective to hit it with.
  if (abilityOf(theirs) === 'wonder-guard' && !superEffectiveAgainst(mine, theirs, state, sideIndex).length) {
    for (const { mon, index } of bench) {
      const tries = superEffectiveAgainst(mon, theirs, state, sideIndex).length;
      for (let i = 0; i < tries; i += 1) if (odds(2 / 3)) return index;
    }
  }

  const landed = vol(mine).lastLanded;
  const hasSuper = superEffectiveAgainst(mine, theirs, state, sideIndex).length > 0;

  // A bench Pokemon whose ability absorbs the move that just hit.
  const absorbsLanded = (mon) => absorbedBy(mon, landed, typeAgainst(landed, mon, state), state);
  if (landed && isDamaging(landed) && !(hasSuper && rng() < 2 / 3) && !absorbsLanded(mine)) {
    for (const { mon, index } of bench) {
      if (absorbsLanded(mon) && odds(1 / 2)) return index;
    }
  }

  // Asleep with Natural Cure, and healthy enough to come back later.
  if (careful && mine.status === 'sleep' && abilityOf(mine) === 'natural-cure' && percent(mine) >= 50 && rng() < 1 / 2) {
    return bestMatchup();
  }

  // Milestone trainers (beyond Emerald): out of a matchup it's clearly losing,
  // into something whose typing stands up to the attacker.
  if (careful) {
    const out = advantageSwitch(state, sideIndex, bench, rng);
    if (out != null) return out;
  }

  if (hasSuper && rng() < 9 / 10) return null;
  const boosts = Object.values(mine.stages || {}).reduce((sum, stage) => sum + Math.max(0, stage), 0);
  if (boosts > 3) return null;

  // Someone on the bench that the last hit can't touch (or barely can), and
  // that hits back super effectively.
  if (landed && isDamaging(landed)) {
    const findMon = (fits, p) => {
      for (const { mon, index } of bench) {
        if (!fits(typeResult(landed, mon, state))) continue;
        const tries = superEffectiveAgainst(mon, theirs, state, sideIndex).length;
        for (let i = 0; i < tries; i += 1) if (odds(p)) return index;
      }
      return null;
    };
    const immune = findMon((eff) => eff === 0, 1 / 2);
    if (immune != null) return immune;
    const resists = findMon((eff) => eff > 0 && eff < 1, 1 / 3);
    if (resists != null) return resists;
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

  // Locked into Outrage, the second turn of Dig, a recharge: the engine
  // decides, so any choice will do.
  if (rules.lockedAction(mine)) return { type: 'move', slot: 0 };

  // Held by Sky Drop, or otherwise trapped: no switching.
  if (kind !== 'wild' && !cond.switchBlocked(state, mine)) {
    const index = switchTarget(state, sideIndex, rng, kind === 'milestone');
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
    const score = theirs ? matchup(mon, theirs, state, sideIndex) : 0;
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

  // For tests: the damage prediction and its inputs.
  __test: { expectedDamage, asUsed, movesFirst, typeAgainst, wouldFaint },
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
