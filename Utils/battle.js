'use strict';

/**
 * The battle engine.
 *
 * Pure: nothing here touches Discord, the database, the clock or
 * Math.random. Given two teams and a seed, it returns state and a list of
 * events; the caller renders them and saves the outcome. This means:
 *
 *   - wild, trainer, milestone and PvP battles all share one engine
 *   - a battle is reproducible from (teams, seed)
 *   - many battles can be simulated quickly in tests
 *
 * Covers turn order (priority, then speed), accuracy, critical hits, the
 * damage formula, STAB and type effectiveness, the five major statuses, stat
 * stages, flinching, multi-hit moves, drain and recoil, healing, PP,
 * switching, fainting and winning. Weather, Protect, traps, Leech Seed and
 * Substitute are in Utils/field.js.
 *
 * Moves with no fixed power (Seismic Toss, Low Kick, Counter, Fissure and
 * others) are resolved by Utils/movepower.js.
 *
 * Abilities and held items live in Utils/battleeffects.js and are called
 * through a fixed set of hooks (accuracy, crits, damage modifiers, absorbing,
 * surviving, reacting to hits, status, stat stages, end of turn, switching).
 *
 * Lasting conditions (confusion, screens, hazards, terrain, rooms, Taunt and
 * the rest) are in Utils/conditions.js, and status moves with an effect of
 * their own in Utils/statusmoves.js, both following the current games.
 *
 * Not yet implemented: Mega Evolution or Gigantamax during battle.
 */

const content = require('./content');
const typechart = require('./typechart');
const damage = require('./damage');
const effects = require('./battleeffects');
const movepower = require('./movepower');
const fieldRules = require('./field');
const cond = require('./conditions');
const statusMoves = require('./statusmoves');
const rules = require('./moverules');
const pokemon = require('./pokemon');

const { loadForm } = pokemon;

/** Confusion's self-hit: a 40-power typeless physical attack on itself. */
const CONFUSION_HIT = {
  name: 'confusion-self-hit',
  displayName: 'its confusion',
  type: '???',
  damageClass: 'physical',
  power: 40,
  accuracy: null,
  priority: 0,
  meta: {},
  statChanges: [],
};

/** The moves a sleeping Pokemon can still use. */
const SLEEP_MOVES = new Set(['sleep-talk', 'snore']);

/** Moves that badly poison (Toxic's damage grows each turn). */
const BADLY_POISONS = new Set(['toxic', 'poison-fang', 'malignant-chain']);

/** Attacks that switch the user out after hitting. */
const SELF_SWITCH_ATTACKS = new Set(['u-turn', 'volt-switch', 'flip-turn']);

/** Attacks that force the target out after hitting. */
const PHAZING_ATTACKS = new Set(['dragon-tail', 'circle-throw']);

/** Attacks that clear hazards from the user's own side. */
const SPINNERS = new Set(['rapid-spin', 'mortal-spin']);

/** Attacks that knock a flying target to the ground. */
const GROUNDERS = new Set(['smack-down', 'thousand-arrows']);

/** Move targets that are the user itself or the field, not the foe. */
const NOT_AT_FOE = new Set(['user', 'user-and-allies', 'users-field', 'user-or-ally', 'entire-field', 'ally']);
const aimedAtFoe = (move) => !NOT_AT_FOE.has(move.target);

/** How many Pokemon a side may bring. The games' number. */
const TEAM_SIZE = 6;

/** Safety limit on the number of turns. */
const MAX_TURNS = 300;

/**
 * Moves whose user faints after using them (Final Gambit is handled with its
 * fixed damage, but ends the same way).
 */
const USER_FAINTS = new Set(['explosion', 'self-destruct', 'misty-explosion', 'memento']);

/** The explosions, which Damp stops outright. */
const EXPLOSIONS = new Set(['explosion', 'self-destruct', 'misty-explosion', 'mind-blown']);

/** The only status move that type immunity applies to. */
const TYPE_CHECKED_STATUS = new Set(['thunder-wave']);

/** The six that take a stage, plus the two that only ever modify accuracy. */
const STAT_KEYS = [
  'attack',
  'defense',
  'specialAttack',
  'specialDefense',
  'speed',
  'accuracy',
  'evasion',
];

/** PokeAPI's stat names are hyphenated; the rest of the bot is camel. */
const STAT_ALIASES = {
  attack: 'attack',
  defense: 'defense',
  'special-attack': 'specialAttack',
  'special-defense': 'specialDefense',
  speed: 'speed',
  accuracy: 'accuracy',
  evasion: 'evasion',
};

/** The five the games call "major" - only one at a time, and it persists. */
const STATUSES = ['burn', 'poison', 'paralysis', 'sleep', 'freeze'];

/**
 * What a Pokemon does when it has nothing left.
 *
 * Struggle, used when no move has PP left, so battles can always end.
 *
 * Its '???' type is in no type chart, so it is always neutral and never gets
 * STAB, matching the games.
 */
const STRUGGLE = {
  name: 'struggle',
  displayName: 'Struggle',
  type: '???',
  damageClass: 'physical',
  power: 50,
  accuracy: null,
  pp: 1,
  priority: 0,
  meta: { drain: -25 },
  statChanges: [],
};

// ---------------------------------------------------------------------------
// Randomness
// ---------------------------------------------------------------------------

/**
 * A seeded random number generator.
 *
 * mulberry32: small, fast and easy to reimplement, so replays are exact.
 */
function rngFrom(seed) {
  let state = (typeof seed === 'number' ? seed : hashSeed(String(seed))) >>> 0;

  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Turn any string into a 32-bit seed. */
function hashSeed(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// ---------------------------------------------------------------------------
// Building a side
// ---------------------------------------------------------------------------

const freshStages = () =>
  STAT_KEYS.reduce((stages, key) => ({ ...stages, [key]: 0 }), {});

/**
 * Turn a stored Pokemon row plus its moves into something that can fight.
 *
 * Takes the row rather than an id, so the engine never reads the database.
 * HP always starts full; it does not persist between battles.
 *
 * @param {object} row    a pokemon row
 * @param {Array}  moves  from store.movesOf - {move, data}
 */
function combatantFrom(row, moves) {
  // Weight and base Attack come from the form data (needed by Low Kick, Grass
  // Knot, Heavy Slam, Heat Crash and Beat Up). loadForm is cached.
  const form = row.species_id ? loadForm(row.species_id, row.form_folder) : null;

  const known = (moves || [])
    .map((entry) => ({
      name: entry.move,
      data: entry.data || content.move(entry.move),
      ppUp: entry.ppUp || 0,
    }))
    .filter((entry) => entry.data);

  return effects.attach({
    id: row.id,
    name: row.nickname || row.display_name,
    species: row.species_name,
    speciesId: row.species_id,
    form: row.form_folder,
    level: row.level,
    shiny: Boolean(row.shiny),
    gender: row.gender || null,

    types: String(row.types || '').split(',').map((t) => t.trim()).filter(Boolean),

    stats: {
      hp: row.stat_hp,
      attack: row.stat_attack,
      defense: row.stat_defense,
      specialAttack: row.stat_special_attack,
      specialDefense: row.stat_special_defense,
      speed: row.stat_speed,
    },

    maxHp: row.stat_hp,
    hp: row.stat_hp,

    moves: known.map((entry) => {
      const base = entry.data.pp || 5;
      const max = base + entry.ppUp * Math.floor(base / 5);
      return { name: entry.name, data: entry.data, pp: max, maxPp: max };
    }),

    stages: freshStages(),
    status: null,
    statusTurns: 0,
    flinched: false,
    fainted: false,

    // Inputs for variable-power moves. Weight in kg, friendship 0-255, and
    // baseAttack is the species' base stat (used by Beat Up).
    weight: (form && form.physical && form.physical.weightKilograms) || 1,
    hiddenPowerType: pokemon.hiddenPowerType(row),
    baseAttack: (form && form.stats && form.stats.base && form.stats.base.attack) || 50,
    happiness: row.happiness != null ? row.happiness : movepower.DEFAULT_HAPPINESS,

    // Stockpile's counter, and the damage taken this turn and last turn (for
    // Counter, Mirror Coat, Metal Burst and Bide). Rolled over by resolveTurn.
    stockpile: 0,
    damageTakenThisTurn: { physical: 0, special: 0, total: 0 },
    damageTakenLastTurn: { physical: 0, special: 0, total: 0 },

    // Volatile state, cleared when the Pokemon leaves the field.
    protectedNow: false,
    protectStreak: 0,
    trapped: null,
    seededBy: null,
    substitute: 0,

    // Confusion, Taunt, Encore and the rest (Utils/conditions.js), the last
    // move it chose, and Toxic's growing counter.
    volatiles: {},
    lastMove: null,
    toxicCounter: 0,

    // Turns this Pokemon has been on the field. Zero means it hasn't acted
    // yet (see FIRST_TURN_ONLY in Utils/movepower.js).
    turnsActive: 0,

    // Which Pokemon scored the knockout. Null for burn or poison faints.
    faintedBy: null,

    // Anything that was in the fight earns experience, even for one turn.
    participated: false,

    // Ability and held item. effects.attach() resolves their definitions once.
    ability: row.ability || null,
    item: row.equipped_item || null,
  });
}

/**
 * Start a battle.
 *
 * @param {object} options
 * @param {{name, team}} options.player    team is an array of combatants
 * @param {{name, team}} options.opponent
 * @param {number|string} options.seed
 */
function create({ player, opponent, seed = Date.now(), kind = 'wild' }) {
  const sides = [
    { name: player.name, team: player.team.slice(0, TEAM_SIZE), active: 0, isPlayer: true, conditions: cond.freshSide() },
    { name: opponent.name, team: opponent.team.slice(0, TEAM_SIZE), active: 0, isPlayer: false, conditions: cond.freshSide() },
  ];

  // Older combatants (and tests) may lack the newer fields.
  for (const side of sides) {
    for (const mon of side.team) {
      if (!mon.volatiles) mon.volatiles = {};
      if (mon.toxicCounter === undefined) mon.toxicCounter = 0;
    }
  }

  for (const side of sides) side.team[side.active].participated = true;

  // Beat Up needs to see the user's whole team. This is a reference, not a
  // copy, so later faints are visible.
  for (const side of sides) {
    for (const mon of side.team) mon.allies = side.team;
  }

  const state = {
    seed,
    kind,
    turn: 0,
    sides,
    finished: false,
    winner: null,
    rngCalls: 0,

    // Field state: weather (Utils/field.js), and rooms, terrain and the rest
    // (Utils/conditions.js).
    field: { weather: null, weatherTurns: 0, setBy: null, ...cond.freshField() },

    // The last move anyone used, for Copycat.
    lastMoveUsed: null,

    // Set when Roar, Whirlwind or Teleport ends a wild battle.
    fled: false,

    // Events from the opening send-outs (e.g. Intimidate), for the caller to
    // show before turn one.
    openingEvents: [],
  };

  // Both sides' switch-in effects trigger, player first.
  for (let index = 0; index < sides.length; index += 1) {
    effects.onSendOut(
      activeOf(sides[index]),
      activeOf(sides[1 - index]),
      state.openingEvents
    );
  }

  settleEffects(state.openingEvents);

  return state;
}

/**
 * Carry out everything the effect hooks asked for.
 *
 * Drains the queued stat changes and statuses from Utils/battleeffects.js
 * through applyStage and applyStatus.
 *
 * Loops because applying one can queue another (Intimidate triggering
 * Defiant). The iteration limit is a safety guard.
 */
function settleEffects(events) {
  for (let pass = 0; pass < 8; pass += 1) {
    const pending = effects.drain();
    if (!pending.length) return;

    for (const request of pending) {
      if (request.target.fainted) continue;

      if (request.what === 'stage') {
        applyStage(request.target, request.stat, request.delta, events, request.fromFoe);
      } else if (request.what === 'status') {
        // No rng available here; only sleep needs one and no ability causes it.
        applyStatus(request.target, request.status, events);
      }
    }
  }
}

/**
 * Clear volatile state when a Pokemon leaves or enters the field.
 *
 * Stat stages are cleared separately by the caller. Status is intentionally
 * kept, as in the games.
 */
function clearVolatiles(mon) {
  if (!mon) return;

  mon.protectedNow = false;
  mon.protectStreak = 0;
  mon.flinched = false;
  mon.trapped = null;
  mon.seededBy = null;
  mon.substitute = 0;

  // Confusion, Taunt and the rest; Toxic's counter resets.
  cond.clearVolatiles(mon);
}

/** The Pokemon currently out for a side. */
const activeOf = (side) => side.team[side.active];

/** Has this whole side been knocked out? */
const wipedOut = (side) => side.team.every((mon) => mon.fainted);

/** Who can still be switched to. */
const benchOf = (side) =>
  side.team
    .map((mon, index) => ({ mon, index }))
    .filter((entry) => !entry.mon.fainted && entry.index !== side.active);

// ---------------------------------------------------------------------------
// Turn order
// ---------------------------------------------------------------------------

/**
 * Speed after stages, paralysis and anything held.
 *
 * Quick Feet both boosts speed under a status and cancels the paralysis
 * penalty; the two are checked separately.
 */
function effectiveSpeed(mon) {
  const base = mon.stats.speed * damage.stageMultiplier(mon.stages.speed);
  const paralysed = mon.status === 'paralysis' && !effects.ignoresParalysisSpeed(mon);

  return Math.floor((paralysed ? base / 2 : base) * effects.speedMultiplier(mon));
}

/**
 * Who goes first.
 *
 * Switching goes first, then move priority, then speed, then a coin flip
 * from the seeded generator (so replays stay identical).
 *
 * Priority is the move's own plus what its ability adds (Prankster, Gale
 * Wings, Triage). Within the same priority, Quick Claw can jump ahead and
 * Lagging Tail or Full Incense go last, whatever the speeds.
 */
function order(state, actions, rng) {
  const entries = state.sides.map((side, index) => {
    const action = actions[index];
    const mon = activeOf(side);

    // A switch resolves before any attack, whatever the speeds.
    if (action.type === 'switch') return { index, priority: 6, bracket: 0, speed: Infinity };

    // A locked-in move (the second turn of Dig, Outrage...) keeps its own
    // priority; a recharge has none.
    const move = action.locked ? { data: action.locked.move } : mon.moves[action.slot];
    const data = move && move.data;
    return {
      index,
      priority: ((data && data.priority) || 0) + effects.priorityBonus(mon, data),
      bracket: effects.bracketShift(mon, rng),
      // Tailwind doubles speed for its side.
      speed: effectiveSpeed(mon) * cond.speedMultiplier(state, index),
    };
  });

  // Trick Room: within the same priority, the slower one goes first.
  const direction = state.field && state.field.trickRoom ? -1 : 1;

  return entries
    .map((entry) => ({ ...entry, tiebreak: rng() }))
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        b.bracket - a.bracket ||
        (Number.isFinite(a.speed) && Number.isFinite(b.speed) ? direction * (b.speed - a.speed) : b.speed - a.speed) ||
        a.tiebreak - b.tiebreak
    )
    .map((entry) => entry.index);
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * Can this Pokemon act at all this turn?
 *
 * Returns an event to log if it cannot. Sleep and freeze are checked when the
 * Pokemon tries to move, as in the games.
 */
function canAct(mon, rng, events, foe = null, chosen = null) {
  if (mon.flinched) {
    mon.flinched = false;
    events.push({ kind: 'flinch', name: mon.name });
    // Let effects react to the flinch (Steadfast).
    effects.afterFlinch(mon, events);
    settleEffects(events);
    return false;
  }

  if (mon.status === 'sleep') {
    // Check before decrementing: the counter is the number of turns still to
    // sleep.
    if (mon.statusTurns <= 0) {
      mon.status = null;
      events.push({ kind: 'cured', name: mon.name, status: 'sleep' });
      return true;
    }

    mon.statusTurns -= 1;
    events.push({ kind: 'asleep', name: mon.name });

    // Sleep Talk and Snore are the moves you can use asleep.
    return Boolean(chosen && SLEEP_MOVES.has(chosen.name));
  }

  if (mon.status === 'freeze') {
    // 20% to thaw each turn, as in the games. Flame Wheel, Scald and the
    // like thaw the user out to be used.
    if ((chosen && rules.THAWS_USER.has(chosen.name)) || rng() < 0.2) {
      mon.status = null;
      events.push({ kind: 'cured', name: mon.name, status: 'freeze' });
      return true;
    }
    events.push({ kind: 'frozen', name: mon.name });
    return false;
  }

  // Confusion: a third of the time it hits itself instead.
  if (!cond.confusionCheck(mon, events, rng, confusionDamage)) return false;

  if (mon.status === 'paralysis' && rng() < 0.25) {
    events.push({ kind: 'paralysed', name: mon.name });
    return false;
  }

  // Attraction: half the time it is too in love to move, while the Pokemon it
  // fell for is still out.
  const v = mon.volatiles || {};
  if (v.attract && foe && foe.id === v.attract && !foe.fainted) {
    events.push({ kind: 'in-love', name: mon.name, with: foe.name });
    if (rng() < 0.5) {
      events.push({ kind: 'immobilized-by-love', name: mon.name });
      return false;
    }
  } else if (v.attract) {
    delete v.attract;
  }

  return true;
}

/** How hard a confused Pokemon hits itself: the damage formula, at its own stats. */
function confusionDamage(mon) {
  return damage.calculate({
    attacker: mon,
    defender: mon,
    move: CONFUSION_HIT,
    roll: 0.5,
    critical: false,
    effectiveness: 1,
  }).damage;
}

/** Burn and poison, applied at the end of a turn. */
function residualDamage(mon, events) {
  if (mon.fainted || !mon.status) return;
  if (mon.status !== 'burn' && mon.status !== 'poison') return;

  // Poison Heal heals instead; Magic Guard prevents it.
  const verdict = effects.residual(mon, events);
  if (verdict !== 'normal') return;

  // Bad poison (Toxic) grows by a sixteenth each turn: 1/16, 2/16, 3/16...
  const sixteenths = mon.status === 'poison' && mon.toxicCounter ? mon.toxicCounter : 1;
  if (mon.status === 'poison' && mon.toxicCounter) mon.toxicCounter = Math.min(15, mon.toxicCounter + 1);

  const hurt = Math.max(1, Math.floor((mon.maxHp * sixteenths) / 16));
  mon.hp = Math.max(0, mon.hp - hurt);

  events.push({ kind: 'residual', name: mon.name, status: mon.status, damage: hurt, hp: mon.hp });

  if (mon.hp === 0) {
    mon.fainted = true;
    // No one is credited for a burn or poison faint.
    mon.faintedBy = null;
    events.push({ kind: 'faint', name: mon.name, by: null });
  }
}

/**
 * Give a Pokemon a status, if it can take one.
 *
 * Only one status at a time, and type immunities apply (Fire types can't be
 * burned, Electric types can't be paralysed).
 */
function applyStatus(target, status, events, rng = null) {
  if (!STATUSES.includes(status)) return false;
  if (target.status || target.fainted) return false;

  // A Substitute blocks status.
  if (fieldRules.behindSubstitute(target)) return false;

  // Nobody falls asleep during an uproar.
  if (status === 'sleep' && target.uproarNearby) {
    events.push({ kind: 'note', text: `But ${target.name} can't sleep in an uproar!` });
    return false;
  }

  const immune = {
    burn: ['fire'],
    freeze: ['ice'],
    paralysis: ['electric'],
    poison: ['poison', 'steel'],
  }[status];

  if (immune && target.types.some((type) => immune.includes(type.toLowerCase()))) {
    return false;
  }

  // Immunity, Limber, Water Veil, Insomnia and the rest.
  if (!effects.statusAllowed(target, status)) {
    events.push({
      kind: 'status-blocked',
      name: target.name,
      status,
      by: effects.displayAbility(target.ability),
    });
    return false;
  }

  target.status = status;

  // Sleep lasts 1-3 turns.
  target.statusTurns = status === 'sleep' ? 1 + Math.floor((rng ? rng() : Math.random()) * 3) : 0;

  events.push({ kind: 'status', name: target.name, status });

  // Status-curing berries trigger immediately.
  effects.healthChanged(target, events);
  return true;
}

/**
 * Change a stat stage (clamped to -6..+6) and report it.
 *
 * `fromFoe` marks changes caused by the opponent, which can be blocked (Clear
 * Body) and trigger Defiant. Self-inflicted drops always apply.
 */
function applyStage(target, stat, delta, events, fromFoe = false) {
  const key = STAT_ALIASES[stat] || stat;
  if (!STAT_KEYS.includes(key)) return;
  if (target.fainted) return;

  // Apply Contrary, Simple, Clear Body and similar. Zero means blocked.
  const wanted = effects.stageDelta(target, key, delta, fromFoe);

  if (wanted === 0) {
    events.push({
      kind: 'stat-blocked',
      name: target.name,
      stat: key,
      direction: delta > 0 ? 'up' : 'down',
      by: delta < 0 ? effects.displayAbility(target.ability) : null,
    });
    return;
  }

  const before = target.stages[key] || 0;
  const after = Math.max(-6, Math.min(6, before + wanted));

  if (after === before) {
    events.push({
      kind: 'stat-blocked',
      name: target.name,
      stat: key,
      direction: wanted > 0 ? 'up' : 'down',
    });
    return;
  }

  target.stages[key] = after;
  events.push({ kind: 'stat', name: target.name, stat: key, delta: after - before, to: after });

  // For Burning Jealousy, Alluring Voice and Lash Out.
  if (after > before) target.statsRoseThisTurn = true;
  else target.statsDroppedThisTurn = true;

  if (after < before) effects.afterStatLowered(target, key, fromFoe, events);
}

// ---------------------------------------------------------------------------
// Using a move
// ---------------------------------------------------------------------------

/**
 * Apply one hit's damage, whether from the damage formula or a fixed-damage
 * move, including Sturdy, knockouts, Rocky Helmet and berries.
 *
 * @returns {number} what was actually taken off, after Sturdy and Focus Sash
 */
function landHit(attacker, defender, move, amount, detail, rng, events) {
  const { critical = false, effectiveness = 1 } = detail || {};

  // A Substitute takes the hit instead. When it breaks, excess damage does
  // not carry over to the Pokemon, as in the games.
  if (fieldRules.behindSubstitute(defender)) {
    const absorbed = Math.min(defender.substitute, amount);
    defender.substitute -= absorbed;

    events.push({
      kind: 'substitute-hit',
      name: defender.name,
      damage: absorbed,
      broke: defender.substitute <= 0,
    });

    if (defender.substitute <= 0) defender.substitute = 0;
    return 0;
  }

  // Sturdy and Focus Sash: only checked when the hit would knock the Pokemon
  // out, and leave it at 1 HP.
  let landed = amount;

  // Endure: anything that would knock it out leaves it at 1 HP this turn.
  const enduring = defender.volatiles && defender.volatiles.endure && landed >= defender.hp;
  const saved = enduring
    ? { hp: 1, source: 'Endure' }
    : effects.survives(defender, landed, rng);

  if (saved) {
    landed = defender.hp - saved.hp;
    events.push({ kind: 'endured', name: defender.name, source: saved.source });
  }

  defender.hp = Math.max(0, defender.hp - landed);

  // Record damage taken for Counter, Mirror Coat, Metal Burst and Bide, split
  // by damage class (Counter only answers physical, Mirror Coat special).
  const window = defender.damageTakenThisTurn;
  if (window) {
    window.total += landed;
    if (move.damageClass === 'physical') window.physical += landed;
    else if (move.damageClass === 'special') window.special += landed;
  }

  events.push({
    kind: 'damage',
    name: defender.name,
    damage: landed,
    hp: defender.hp,
    maxHp: defender.maxHp,
    critical,
    effectiveness,
  });

  // Rage Fist counts every hit taken; Bide stores the damage; Rage gets
  // angrier; Beak Blast burns whoever touches the heated beak.
  const hv = defender.volatiles || {};
  if (landed > 0 && attacker !== defender) {
    defender.timesHit = (defender.timesHit || 0) + 1;
    if (hv.locked && hv.locked.kind === 'bide') hv.locked.stored += landed;
    if (hv.rage && defender.hp > 0) effects.requestStage(defender, 'attack', 1, events, 'Rage');
    if (hv.beakBlast && effects.makesContact(move) && !attacker.fainted) applyStatus(attacker, 'burn', events);
  }

  if (saved && saved.consume) effects.consumeItem(defender, events);

  if (defender.hp === 0) {
    defender.fainted = true;

    // Record who scored the knockout, for experience.
    defender.faintedBy = attacker.id;

    events.push({ kind: 'faint', name: defender.name, by: attacker.id });

    const dv = defender.volatiles || {};

    // Destiny Bond takes the attacker down too.
    if (dv.destinyBond && attacker !== defender && !attacker.fainted) {
      events.push({ kind: 'destiny-bond', name: defender.name, target: attacker.name });
      attacker.hp = 0;
      attacker.fainted = true;
      events.push({ kind: 'faint', name: attacker.name });
    }

    // Grudge empties the move that did it.
    if (dv.grudge && attacker !== defender) {
      const used = attacker.moves.find((m) => m.name === move.name);
      if (used) {
        used.pp = 0;
        events.push({ kind: 'grudge', name: attacker.name, move: move.displayName });
      }
    }
  }

  // The defender's reaction to this hit (Rough Skin, Rocky Helmet, Static,
  // Weakness Policy, Aftermath). Runs per hit.
  effects.afterHitTaken({
    attacker,
    defender,
    move,
    dealt: landed,
    critical,
    effectiveness,
    rng,
    events,
  });

  // HP berries trigger when HP drops low enough.
  effects.healthChanged(defender, events);
  settleEffects(events);

  return landed;
}

/**
 * Fissure, Guillotine, Horn Drill and Sheer Cold.
 *
 * One-hit KO moves, with the games' rules: they fail against higher-level
 * targets, accuracy starts at 30% and rises with the level gap, Sturdy blocks
 * them, and Sheer Cold doesn't affect Ice types.
 */
function oneHitKnockout(attacker, defender, move, rng, events) {
  const failed = (text) => events.push({ kind: 'failed', name: attacker.name, text });

  if (defender.level > attacker.level) {
    failed(`${defender.name} is too strong to be taken down in one blow.`);
    return;
  }

  if (
    move.name === 'sheer-cold' &&
    defender.types.some((type) => String(type).toLowerCase() === 'ice')
  ) {
    failed(`It doesn't affect ${defender.name}...`);
    return;
  }

  // Sturdy.
  if (effects.blocksOneHitKo(defender)) {
    events.push({ kind: 'shrugged-off', name: defender.name, by: 'Sturdy' });
    return;
  }

  // 30% at equal levels, and a point better for every level you are above.
  const chance = (30 + attacker.level - defender.level) / 100;

  if (rng() >= chance) {
    events.push({ kind: 'miss', name: defender.name });
    return;
  }

  landHit(attacker, defender, move, defender.hp, { effectiveness: 1 }, rng, events);
  events.push({ kind: 'one-hit-ko', name: defender.name });
}

/**
 * One Pokemon uses the move in one of its slots.
 *
 * Works out what is actually used (Struggle when nothing has PP, nothing if a
 * condition forbids the move: Taunt, Disable, Torment, Heal Block, Imprison,
 * Gravity), spends the PP, then hands over to performMove.
 *
 * `turn` carries the battle state and this side's index, and what the target
 * chose this turn (Sucker Punch, Me First).
 */
function useMove(attacker, defender, slot, rng, events, arena = null, turn = null) {
  const state = turn && turn.state;
  const sideIndex = turn ? turn.index : 0;

  const allowed = (option, i) => option.pp > 0 && !(state && cond.restriction(state, sideIndex, attacker, i));
  const anyUsable = attacker.moves.some(allowed);
  const entry = attacker.moves[slot];

  // One-turn and until-it-moves effects wear off when it moves again.
  const v = attacker.volatiles || (attacker.volatiles = {});
  delete v.destinyBond;
  delete v.grudge;
  delete v.glaiveRush;

  let move;

  if (!attacker.moves.length || !anyUsable) {
    // Nothing usable (no PP, or everything forbidden): Struggle.
    move = STRUGGLE;
    events.push({ kind: 'struggle', name: attacker.name });
  } else if (!entry || entry.pp <= 0) {
    // The chosen move is out of PP but others aren't; report it rather than
    // picking a different move.
    events.push({
      kind: 'no-pp',
      name: attacker.name,
      move: entry ? entry.data.displayName : 'that move',
    });
    return;
  } else {
    const why = state && cond.restriction(state, sideIndex, attacker, slot);
    if (why) {
      events.push({ kind: 'restricted', name: attacker.name, move: entry.data.displayName, reason: why });
      return;
    }

    entry.pp -= 1;
    move = entry.data;
  }

  attacker.previousMove = attacker.lastMove;
  attacker.lastMove = move.name;

  performMove(attacker, defender, move, { entry: move === STRUGGLE ? null : entry, rng, events, arena, turn });
}

/**
 * Carry out a move. Also used for moves that call other moves (Metronome,
 * Sleep Talk, Mirror Move...) and for Magic Coat and Snatch turning a move
 * around, none of which spend PP.
 *
 * Steps, in the games' order: the move's type, power and immunities;
 * Protect and the guards; accuracy; absorption; per-hit damage; then
 * secondary effects (which don't apply to a fainted target).
 *
 * Ability and item hooks are called at the matching points;
 * Utils/battleeffects.js decides what they do. Conditions (screens, terrain,
 * confusion and the rest) are in Utils/conditions.js, and status moves with
 * their own effect in Utils/statusmoves.js.
 */
function performMove(attacker, defender, baseMove, options = {}) {
  const { rng, events, turn = null } = options;
  const state = turn && turn.state;
  const start = events.length;
  const outcome = { started: false, hits: 0, charging: false, continuing: Boolean(options.continuing) };

  executeMove(attacker, defender, baseMove, { ...options, outcome });

  // Crash damage, Steel Beam's cost, the recharge, the rampage and the
  // consecutive-use counters (Utils/moverules.js).
  rules.afterMove({
    state,
    sideIndex: turn ? turn.index : 0,
    attacker,
    defender,
    move: baseMove,
    rng,
    events,
    engine: state ? engineFor(state, rng, events, turn) : null,
  }, outcome, start);
  settleEffects(events);
}

/** The move itself; performMove wraps it. Records what happened in `options.outcome`. */
function executeMove(attacker, defender, baseMove, options = {}) {
  const { entry = null, rng, events, turn = null, called = false, powerMultiplier = 1 } = options;
  const outcome = options.outcome || {};
  const arena = options.arena || (turn && turn.state ? turn.state.field : null);
  const state = turn && turn.state;
  const sideIndex = turn ? turn.index : 0;
  const av = attacker.volatiles || (attacker.volatiles = {});
  const dv = defender.volatiles || (defender.volatiles = {});

  // Electrify and Ion Deluge turn the move Electric.
  let move = baseMove;
  if (av.electrify || (arena && arena.ionDeluge && lowerType(move.type) === 'normal')) {
    move = { ...move, type: 'electric' };
  }

  // Weather Ball, Terrain Pulse, Judgment and the rest take a type from the
  // battle.
  const ruleCtx = {
    state, sideIndex, attacker, defender, move, rng, events, turn,
    engine: state ? engineFor(state, rng, events, turn) : null,
  };
  const retyped = rules.typeFor(ruleCtx);
  if (retyped) {
    move = { ...move, type: retyped };
    ruleCtx.move = move;
  }

  // The first turn of a two-turn move only charges (Dig, Fly, Solar Beam),
  // and Bide starts storing energy.
  if (!options.continuing && state) {
    if (move.name === 'bide') {
      events.push({ kind: 'move', name: attacker.name, move: move.displayName, type: move.type, damageClass: move.damageClass });
      rules.startBide(ruleCtx);
      outcome.charging = true;
      return;
    }
    // Sky Drop has to connect first, so it starts further down.
    if (rules.CHARGE[move.name] && move.name !== 'sky-drop' && rules.startCharge(ruleCtx)) {
      outcome.charging = true;
      return;
    }
  }

  events.push({
    kind: 'move',
    name: attacker.name,
    move: move.displayName,
    type: move.type,
    damageClass: move.damageClass,
  });

  if (state) state.lastMoveUsed = move.name;

  // Powder: a Fire move explodes in its user's face.
  if (av.powder && lowerType(move.type) === 'fire') {
    const hurt = Math.max(1, Math.floor(attacker.maxHp / 4));
    events.push({ kind: 'powder-blast', name: attacker.name });
    effects.chip(attacker, hurt, events, 'Powder', 'condition-damage');
    return;
  }

  // Damp stops an explosion before it goes off, so nobody faints.
  if (EXPLOSIONS.has(move.name) && [attacker, defender].some((mon) => cond.abilityOf(mon) === 'damp')) {
    events.push({ kind: 'failed', name: attacker.name, text: 'But Damp stopped it from going off!' });
    return;
  }

  // The user faints once it has gone off, hit, miss or Protect (resolveTurn
  // handles it).
  if (USER_FAINTS.has(move.name)) attacker.selfDestructing = true;
  outcome.started = true;

  // Resolve the move's power (Utils/movepower.js handles variable-power
  // moves). Done before accuracy, since some moves fail rather than miss
  // (Fling with no item, Counter with nothing to counter). PP is still spent.
  const verdict = movepower.resolve(move, {
    attacker,
    defender,
    rng,
    entry,
    allies: attacker.allies,
    speedOf: effectiveSpeed,
    // What the target chose this turn and whether it has already moved
    // (Sucker Punch). Only known inside resolveTurn.
    ...(turn && 'foeMove' in turn ? { foeMove: turn.foeMove, foeMoved: turn.foeMoved } : {}),
  });

  if (verdict.kind === 'fail') {
    events.push({
      kind: 'failed',
      name: attacker.name,
      text: movepower.reasonText(verdict.reason, attacker.name),
    });
    return;
  }

  // Dream Eater on someone awake, Snore while awake, Last Resort too early...
  if (move.damageClass !== 'status') {
    const why = rules.failReason(ruleCtx);
    if (why) {
      events.push({ kind: 'failed', name: attacker.name, text: why });
      return;
    }
  }

  // Future Sight and Doom Desire land two turns later, on whoever is out.
  if (rules.FUTURE.has(move.name) && state) {
    rules.startFutureSight(ruleCtx);
    return;
  }

  const atFoe = aimedAtFoe(move);

  // Type and ability immunities to status moves: powder moves and Grass
  // types, Prankster and Dark types, Soundproof.
  if (atFoe) {
    const immune = cond.immuneTo(attacker, defender, move);
    if (immune) {
      events.push(
        immune === 'immune'
          ? { kind: 'immune', name: defender.name, effectiveness: 0 }
          : { kind: 'shrugged-off', name: defender.name, by: immune }
      );
      return;
    }
  }

  // Snatch steals a move the user aims at itself; Magic Coat and Magic
  // Bounce send a status move back.
  if (!called && move.damageClass === 'status' && state) {
    if (!atFoe && dv.snatch && !defender.fainted) {
      delete dv.snatch;
      events.push({ kind: 'snatched', name: defender.name, move: move.displayName });
      performMove(defender, attacker, move, { ...options, entry: null, turn: { ...turn, index: 1 - sideIndex }, called: true });
      return;
    }

    if (atFoe && (dv.magicCoat || cond.abilityOf(defender) === 'magic-bounce') && !options.bounced) {
      events.push({ kind: 'bounced', name: defender.name, move: move.displayName });
      performMove(defender, attacker, move, { ...options, entry: null, turn: { ...turn, index: 1 - sideIndex }, called: true, bounced: true });
      return;
    }
  }

  // ------------------------------------------------------------------
  // Field moves: Protect, weather, Substitute and Leech Seed resolve here
  // (see Utils/field.js).
  // ------------------------------------------------------------------

  // Any other move resets the Protect chain.
  if (!fieldRules.isProtect(move) && move.name !== 'endure') attacker.protectStreak = 0;

  if (fieldRules.isProtect(move)) {
    if (fieldRules.protectSucceeds(attacker.protectStreak, rng())) {
      attacker.protectedNow = true;
      attacker.protectStreak += 1;
      events.push({ kind: 'protected-self', name: attacker.name });
    } else {
      attacker.protectStreak = 0;
      events.push({ kind: 'failed', name: attacker.name, text: 'But it failed!' });
    }
    return;
  }

  // Status moves aimed at the user, its side or the field (screens, hazards,
  // rooms, terrains...) don't check accuracy or the target's Protect.
  const ctx = (target) => ({
    state,
    sideIndex,
    attacker,
    defender: target,
    move,
    rng,
    events,
    turn,
    engine: engineFor(state, rng, events, turn),
  });

  if (!atFoe && statusMoves.has(move.name) && state) {
    statusMoves.run(ctx(defender));
    settleEffects(events);
    return;
  }

  const weather = fieldRules.weatherFor(move);

  if (weather) {
    if (!arena) return;

    if (arena.weather === weather) {
      events.push({ kind: 'failed', name: attacker.name, text: 'But it failed!' });
      return;
    }

    setWeather(arena, weather, attacker, events);
    return;
  }

  if (fieldRules.isSubstitute(move)) {
    if (attacker.substitute > 0) {
      events.push({ kind: 'failed', name: attacker.name, text: 'It already has one!' });
      return;
    }

    const cost = fieldRules.substituteCost(attacker);

    if (!cost) {
      events.push({ kind: 'failed', name: attacker.name, text: 'But it does not have enough health!' });
      return;
    }

    attacker.hp -= cost;
    attacker.substitute = cost;
    events.push({ kind: 'substitute-up', name: attacker.name, cost, hp: attacker.hp });
    return;
  }

  // Moves aimed at itself with only stat changes or healing (Swords Dance,
  // Recover) skip accuracy and the target's Protect too.
  if (atFoe) {
    const aim = effects.accuracy(attacker, defender, move);
    const extra = state ? cond.accuracyModifiers(state, attacker, defender) : { multiplier: 1, sure: false, ignoreEvasion: false };
    const evasion = extra.ignoreEvasion ? Math.min(0, defender.stages.evasion || 0) : defender.stages.evasion;

    // A Poison type's Toxic never misses, nor does a move Magic Coat sent
    // back, nor one aimed at a Minimized target or a Glaive Rush user.
    const weatherAim = rules.weatherAccuracy(ruleCtx);
    const sure = extra.sure || options.bounced || weatherAim === Infinity || rules.sureHit(ruleCtx) ||
      (move.name === 'toxic' && (attacker.types || []).some((t) => lowerType(t) === 'poison'));

    // Underground, underwater, in the sky or vanished: only a few moves reach
    // it (Earthquake a digger, Thunder a flier), unless it can't miss.
    if (!rules.canReach(move, defender) && !aim.never && !extra.sure) {
      events.push({ kind: 'miss', name: defender.name });
      return;
    }

    // One-hit KO moves use their own accuracy rule. Thunder and Hurricane are
    // only 50% accurate in sun.
    const aimed = weatherAim && weatherAim !== Infinity ? { ...move, accuracy: weatherAim } : move;
    if (
      verdict.kind !== 'ohko' &&
      !aim.never &&
      !sure &&
      !damage.hits(aimed, rng(), attacker.stages.accuracy, evasion, aim.multiplier * extra.multiplier)
    ) {
      events.push({ kind: 'miss', name: defender.name });
      return;
    }

    // Protect blocks everything below. Checked after accuracy, so a miss is
    // reported as a miss.
    if (defender.protectedNow && !fieldRules.piercesProtect(move)) {
      events.push({ kind: 'protected', name: defender.name });
      return;
    }

    // Quick Guard, Wide Guard, Crafty Shield, Mat Block and Psychic Terrain.
    if (state) {
      const priority = (move.priority || 0) + effects.priorityBonus(attacker, move);
      const guard = cond.guardBlocks(state, sideIndex, defender, move, priority);
      if (guard) {
        events.push({ kind: 'guarded', name: defender.name, by: guard });
        return;
      }
    }

    // A Substitute stops status moves aimed at the foe (not sound moves).
    if (defender.substitute > 0 && cond.blockedBySubstitute(move)) {
      events.push({ kind: 'failed', name: attacker.name, text: 'But it failed!' });
      return;
    }
  }

  // Sky Drop's first turn: having got past accuracy and Protect, it carries
  // the target up. Both are out of reach until it comes down next turn.
  if (move.name === 'sky-drop' && !options.continuing && state) {
    rules.startCharge(ruleCtx);
    outcome.charging = true;
    return;
  }

  // Status moves aimed at the foe with an effect of their own (Taunt,
  // Encore, Roar, Trick...).
  if (atFoe && statusMoves.has(move.name) && state) {
    statusMoves.run(ctx(defender));
    settleEffects(events);
    return;
  }

  // Natural Gift takes the berry's type, which everything below must use.
  const movedType = verdict.type || move.type;
  const typeAgainst = (type) => (state
    ? cond.effectiveness(type, defender, arena)
    : typechart.effectiveness(type, defender.types));

  // Freeze-Dry, Flying Press and Thousand Arrows bend the type chart.
  const effectiveness = rules.adjustEffectiveness(ruleCtx, typeAgainst(movedType), typeAgainst);
  ruleCtx.effectiveness = effectiveness;
  ruleCtx.movedType = movedType;

  // Absorbing abilities and items (Levitate, Volt Absorb, Flash Fire, Wonder
  // Guard, Air Balloon) stop the move entirely. A grounded target (Gravity,
  // Smack Down) can't float over a Ground move, and Thousand Arrows reaches
  // anything.
  const groundedHit = lowerType(movedType) === 'ground' && state &&
    (cond.grounded(defender, arena) || move.name === 'thousand-arrows');
  const absorb = groundedHit ? null : effects.absorbs(defender, { ...move, type: movedType }, effectiveness);

  if (absorb) {
    effects.applyAbsorb(defender, absorb, move, events);
    settleEffects(events);
    return;
  }

  // Type immunity applies to every damaging move, including fixed-damage and
  // one-hit KO moves.
  if (effectiveness === 0 && move.damageClass !== 'status') {
    events.push({ kind: 'immune', name: defender.name, effectiveness: 0 });
    return;
  }

  if (verdict.kind === 'ohko') {
    oneHitKnockout(attacker, defender, move, rng, events);
    return;
  }

  // Present heals the target a fifth of the time.
  if (verdict.kind === 'heal') {
    const healed = Math.max(1, Math.floor(defender.maxHp / 4));
    const before = defender.hp;
    defender.hp = Math.min(defender.maxHp, defender.hp + healed);
    events.push({
      kind: 'present-heal',
      name: defender.name,
      amount: defender.hp - before,
      hp: defender.hp,
    });
    effects.healthChanged(defender, events);
    settleEffects(events);
    return;
  }

  const meta = move.meta || {};

  // Brick Break shatters screens before it lands.
  if (state && move.damageClass !== 'status') cond.breakScreens(state, sideIndex, move, events);

  // Magnitude announces the magnitude it rolled.
  if (verdict.magnitude) {
    events.push({ kind: 'magnitude', number: verdict.magnitude });
  }

  let dealt = 0;
  let hitsLanded = 0;
  let anyCritical = false;

  // ---- fixed damage: skips the formula ----
  //
  // No STAB, crits, damage roll or effectiveness multiplier.
  if (verdict.kind === 'fixed') {
    dealt = landHit(attacker, defender, move, rules.capDamage(ruleCtx, verdict.damage), { effectiveness: 1 }, rng, events);
    hitsLanded = 1;
    outcome.hits = 1;

    // Final Gambit: the user faints regardless, and the opponent isn't
    // credited with the knockout.
    if (verdict.selfFaint) attacker.selfDestructing = true;
  } else if (move.damageClass !== 'status') {
    // ---- the ordinary damage formula ----

    // Beat Up has one hit per conscious team member; other moves roll their
    // hit count (Skill Link always takes the maximum).
    let powers = verdict.powers || null;
    let hitCount = powers ? powers.length : 1;

    if (!powers && meta.minHits && meta.maxHits) {
      hitCount = effects.multiHitAlwaysMax(attacker)
        ? meta.maxHits
        : meta.minHits + Math.floor(rng() * (meta.maxHits - meta.minHits + 1));
    }

    const critsAllowed = effects.critAllowed(defender);
    const critBonus = effects.critStage(attacker, move) + cond.critStageBonus(attacker);
    const critForced = state ? cond.critOverride(state, sideIndex, attacker) : null;

    // Wonder Room swaps Defense and Special Defense for the hit.
    const target = arena && arena.wonderRoom
      ? { ...defender, stats: { ...defender.stats, defense: defender.stats.specialDefense, specialDefense: defender.stats.defense } }
      : defender;

    // Effectiveness is announced once per move, not per hit.
    let saidEffectiveness = false;

    // Spectral Thief steals boosts first; Fickle Beam rolls for its power.
    rules.beforeHit(ruleCtx);
    rules.rollBeforeHits(ruleCtx);

    for (let hit = 0; hit < hitCount && !defender.fainted; hit += 1) {
      // Triple Kick, Triple Axel and Population Bomb check accuracy for
      // every hit after the first, and stop at the first miss.
      if (hit > 0 && rules.EACH_HIT_CHECKS_ACCURACY.has(move.name) && !effects.accuracy(attacker, defender, move).never &&
          !damage.hits(move, rng(), attacker.stages.accuracy, defender.stages.evasion)) {
        break;
      }

      const critical = critsAllowed && critForced !== false &&
        (critForced === true || damage.crits(move, rng(), critBonus));

      // Ability and item modifiers, grouped for Utils/damage.js. Power that
      // depends on the battle (Hex, Brine, Rollout...) is worked out first.
      const basePower = rules.powerFor(ruleCtx, powers ? powers[hit] : verdict.power || move.power, hit);
      const thisPower = powerMultiplier !== 1 ? Math.floor(basePower * powerMultiplier) : basePower;
      const parts = effects.damageParts(attacker, defender, move, effectiveness, thisPower);

      // Weather: rain boosts Water and weakens Fire, sun the reverse;
      // sandstorm boosts Rock Special Defence and snow Ice Defence.
      const weatherOut = fieldRules.weatherDamageMultiplier(arena, { ...move, type: movedType });
      const weatherIn = fieldRules.weatherDefenceMultiplier(arena, defender, move);

      if (weatherOut !== 1) parts.extraModifiers.push(weatherOut);
      if (weatherIn !== 1) parts.defenceModifiers.push(weatherIn);

      // Screens, terrain, the Sports and Charge.
      if (state) {
        parts.extraModifiers.push(...cond.damageModifiers(state, sideIndex, attacker, defender, move, movedType, critical));
      }

      // Psyshock hits Defense, Foul Play uses the target's Attack, Body Press
      // the user's Defense, Sacred Sword ignores the target's stat changes.
      const src = rules.statSources(ruleCtx, attacker, target, move);

      const result = damage.calculate({
        attacker: src.attacker,
        defender: src.defender,
        move: src.move,
        roll: rng(),
        critical,
        power: thisPower,
        type: verdict.type || (move.type !== baseMove.type ? move.type : null),
        effectiveness,
        attackModifiers: parts.attackModifiers,
        defenceModifiers: parts.defenceModifiers,
        extraModifiers: parts.extraModifiers,
        stabMultiplier: parts.stabMultiplier,
        ignoreBurn: parts.ignoreBurn,
        critMultiplier: parts.critDamage,
      });

      if (result.immune) {
        events.push({ kind: 'immune', name: defender.name, effectiveness: 0 });
        return;
      }

      if (result.damage <= 0) continue;

      // Announce effectiveness and crits before the damage, as the games do.
      if (critical) {
        anyCritical = true;
        events.push({ kind: 'critical' });
      }

      if (!saidEffectiveness && result.effectiveness !== 1) {
        const line = typechart.describe(result.effectiveness);
        if (line) {
          saidEffectiveness = true;
          events.push({ kind: 'effectiveness', text: line, effectiveness: result.effectiveness });
        }
      }

      dealt += landHit(
        attacker,
        defender,
        move,
        rules.capDamage(ruleCtx, result.damage),
        { critical, effectiveness: result.effectiveness },
        rng,
        events
      );

      hitsLanded += 1;
    }

    if (hitCount > 1 && hitsLanded > 0) {
      events.push({ kind: 'multi-hit', name: attacker.name, hits: hitsLanded });
    }
    outcome.hits = hitsLanded;

    // Charge powers up one Electric move; Laser Focus one hit.
    if (lowerType(movedType) === 'electric') delete av.charged;
  }

  // Natural Gift and Fling consume the held item, and Spit Up empties the
  // stockpile, regardless of the outcome.
  if (verdict.consumesItem) effects.consumeItem(attacker, events);
  if (verdict.spendsStockpile) attacker.stockpile = 0;

  // Stockpile's counter is kept here because Spit Up and Swallow both use it.
  if (move.name === 'stockpile' && attacker.stockpile < movepower.STOCKPILE_MAX) {
    attacker.stockpile += 1;
    events.push({ kind: 'stockpile', name: attacker.name, count: attacker.stockpile });
  }

  if (dealt > 0) {
    // Life Orb and Shell Bell, once for the whole move rather than per hit.
    effects.afterDealtDamage({
      attacker,
      defender,
      move,
      dealt,
      critical: anyCritical,
      effectiveness,
      rng,
      events,
    });

    effects.healthChanged(attacker, events);
    settleEffects(events);
  }

  // Moxie and Beast Boost, only for knockouts the attacker caused.
  if (defender.fainted && defender.faintedBy === attacker.id) {
    effects.afterKnockout(attacker, defender, events);
    settleEffects(events);
  }

  // Drain and recoil share one signed field: positive heals the attacker,
  // negative hurts them. Heal Block stops the healing.
  //
  // Struggle's recoil is a quarter of the user's max HP rather than based on
  // damage dealt.
  if (meta.drain && dealt > 0) {
    const change =
      move === STRUGGLE
        ? Math.max(1, Math.floor(attacker.maxHp / 4))
        : Math.max(1, Math.floor((dealt * Math.abs(meta.drain)) / 100));

    if (meta.drain > 0) {
      if (!av.healBlock) {
        attacker.hp = Math.min(attacker.maxHp, attacker.hp + change);
        events.push({ kind: 'drain', name: attacker.name, amount: change, hp: attacker.hp });
      }
    } else if (move === STRUGGLE || effects.recoilAllowed(attacker)) {
      // Rock Head does not prevent Struggle recoil, as in the games.
      attacker.hp = Math.max(0, attacker.hp - change);
      events.push({ kind: 'recoil', name: attacker.name, amount: change, hp: attacker.hp });
      if (attacker.hp === 0) {
        attacker.fainted = true;
        events.push({ kind: 'faint', name: attacker.name });
      }
    }

    effects.healthChanged(attacker, events);
  }

  // A straight heal, as a percentage of the user's maximum.
  //
  // Swallow heals based on the stockpile count (a quarter for one, full for
  // three) and empties it. Heal Pulse and Floral Healing heal the target.
  if (meta.healing > 0) {
    const patient = atFoe && move.damageClass === 'status' ? defender : attacker;
    let percent = meta.healing;

    if (move.name === 'swallow') {
      if (!attacker.stockpile) {
        events.push({
          kind: 'failed',
          name: attacker.name,
          text: movepower.reasonText('no-stockpile', attacker.name),
        });
        return;
      }

      percent = [0, 25, 50, 100][attacker.stockpile] || 25;
      attacker.stockpile = 0;
    }

    const healed = Math.max(1, Math.floor((patient.maxHp * percent) / 100));
    const before = patient.hp;
    if (!(patient.volatiles && patient.volatiles.healBlock)) {
      patient.hp = Math.min(patient.maxHp, patient.hp + healed);
    }
    if (patient.hp !== before) {
      events.push({ kind: 'heal', name: patient.name, amount: patient.hp - before, hp: patient.hp });
    } else if (move.damageClass === 'status') {
      // Recover at full health.
      events.push({ kind: 'failed', name: attacker.name, text: 'But it failed!' });
    }
  }

  // Rest: full health, any status cured, then two turns asleep. Fails at full
  // health, or for a Pokemon that can't fall asleep (Insomnia, Vital Spirit,
  // Electric Terrain).
  if (move.name === 'rest') {
    const terrainBlocks = state && cond.sideBlocksStatus(state, sideIndex, attacker, 'sleep') === 'Electric Terrain';
    if (attacker.hp >= attacker.maxHp || !effects.statusAllowed(attacker, 'sleep') || terrainBlocks || attacker.uproarNearby) {
      events.push({ kind: 'failed', name: attacker.name, text: 'But it failed!' });
      return;
    }

    const before = attacker.hp;
    attacker.hp = attacker.maxHp;
    events.push({ kind: 'heal', name: attacker.name, amount: attacker.hp - before, hp: attacker.hp });

    // Two turns asleep: canAct counts statusTurns down and wakes it at 0.
    attacker.status = 'sleep';
    attacker.statusTurns = 2;
    attacker.toxicCounter = 0;
    events.push({ kind: 'status', name: attacker.name, status: 'sleep' });
    return;
  }

  // The user's own side: Rapid Spin and Mortal Spin clear hazards, Leech Seed
  // and traps.
  if (state && SPINNERS.has(move.name) && dealt > 0 && !attacker.fainted) {
    const c = state.sides[sideIndex].conditions || {};
    const had = c.spikes || c.toxicSpikes || c.stealthRock || c.stickyWeb || attacker.seededBy || attacker.trapped;
    delete c.spikes; delete c.toxicSpikes; delete c.stealthRock; delete c.stickyWeb;
    attacker.seededBy = null;
    attacker.trapped = null;
    if (had) events.push({ kind: 'spun-free', name: attacker.name });
  }

  // U-turn, Volt Switch and Flip Turn: out once they've hit.
  if (state && SELF_SWITCH_ATTACKS.has(move.name) && dealt > 0 && !attacker.fainted) {
    const side = state.sides[sideIndex];
    if (benchOf(side).length && !wipedOut(state.sides[1 - sideIndex])) side.pendingSwitch = {};
  }

  // Knock Off, Thief, Clear Smog, the trapping moves, Fell Stinger and the
  // rest (Utils/moverules.js).
  if (hitsLanded > 0 && move.damageClass !== 'status' && state) {
    rules.afterHit(ruleCtx, { dealt, standing: !defender.fainted });
    settleEffects(events);
  }

  // Everything below only lands on something still standing.
  if (defender.fainted || attacker.fainted) return;

  // Dragon Tail and Circle Throw drag the target out.
  if (state && PHAZING_ATTACKS.has(move.name) && dealt > 0) {
    if (!dv.ingrain && cond.abilityOf(defender) !== 'suction-cups') phaze(state, 1 - sideIndex, events, rng);
    return;
  }

  // Smack Down and Thousand Arrows bring a flying target to the ground.
  if (GROUNDERS.has(move.name) && dealt > 0) {
    rules.bringDown(defender, state, events);
    dv.smackedDown = true;
    delete dv.magnetRise;
    delete dv.telekinesis;
  }

  // Trapping moves (Wrap, Fire Spin, etc.) deal damage each turn for several
  // turns. The set comes from PokeAPI's `ailment: trap`.
  if (fieldRules.isTrapping(move) && !defender.trapped && dealt > 0) {
    defender.trapped = {
      move: move.displayName,
      turns: fieldRules.trapTurns(move, rng()),
      by: attacker.id,
    };

    events.push({
      kind: 'trapped',
      name: defender.name,
      source: move.displayName,
      turns: defender.trapped.turns,
    });
  }

  // Leech Seed. Grass types are immune.
  if (fieldRules.isLeechSeed(move)) {
    if (defender.seededBy) {
      events.push({ kind: 'failed', name: attacker.name, text: 'But it failed!' });
    } else if (!fieldRules.canBeSeeded(defender)) {
      events.push({ kind: 'immune', name: defender.name, effectiveness: 0 });
    } else {
      defender.seededBy = attacker.id;
      events.push({ kind: 'seeded', name: defender.name });
    }
    return;
  }

  // Status moves ignore type immunity, except Thunder Wave, which can't touch
  // a Ground type.
  if (TYPE_CHECKED_STATUS.has(move.name) && effectiveness === 0) {
    events.push({ kind: 'immune', name: defender.name, effectiveness: 0 });
    return;
  }

  // Sheer Force removes secondary effects (ailment, flinch and stat changes).
  const suppressed = effects.suppressesSecondaries(attacker, move);
  const ailment = normaliseAilment(meta.ailment);

  if (!suppressed && meta.ailment && meta.ailment !== 'none' && (STATUSES.includes(ailment) || ailment === 'confusion')) {
    // A status move with no listed chance always works; a damaging move with a
    // secondary ailment rolls for it. Serene Grace doubles the roll.
    const base = meta.ailmentChance || (move.damageClass === 'status' ? 100 : 0);
    const chance = move.damageClass === 'status' ? base : effects.secondaryChance(attacker, base);

    if (chance > 0 && rng() * 100 < chance) {
      if (ailment === 'confusion') {
        if (state) {
          cond.confuse(state, 1 - sideIndex, defender, events, rng, {
            attacker,
            viaStatusMove: move.damageClass === 'status',
          });
        }
      } else {
        // Safeguard, Misty Terrain and Electric Terrain (sleep) protect the
        // target's side.
        const blocked = state && cond.sideBlocksStatus(state, 1 - sideIndex, defender, ailment, attacker);

        const before = events.length;

        if (blocked) {
          if (move.damageClass === 'status') events.push({ kind: 'protected-by', name: defender.name, by: blocked });
        } else if (applyStatus(defender, ailment, events, rng)) {
          if (ailment === 'poison' && BADLY_POISONS.has(move.name)) {
            defender.toxicCounter = 1;
            // Say "badly poisoned".
            const said = events.slice(before).find((e) => e.kind === 'status' && e.name === defender.name);
            if (said) said.status = 'badly poison';
          }
        } else if (move.damageClass === 'status' && events.length === before) {
          // Nothing said why: already statused, or immune by type (Toxic on
          // a Steel type, Will-O-Wisp on a Fire type).
          events.push(
            defender.status
              ? { kind: 'failed', name: attacker.name, text: 'But it failed!' }
              : { kind: 'immune', name: defender.name, effectiveness: 0 }
          );
        }
      }
    }
  }

  // The move's flinch chance or one added by Stench/King's Rock, whichever is
  // larger (they don't stack).
  const flinchFrom = suppressed ? 0 : meta.flinchChance || 0;
  const flinchChance = Math.max(
    flinchFrom > 0 ? effects.secondaryChance(attacker, flinchFrom) : 0,
    dealt > 0 ? effects.addedFlinchChance(attacker) : 0
  );

  if (flinchChance > 0 && rng() * 100 < flinchChance) {
    // Inner Focus.
    if (effects.flinchAllowed(defender)) defender.flinched = true;
  }

  const mist = state && (state.sides[1 - sideIndex].conditions || {}).mist;

  for (const change of move.statChanges || []) {
    // For damaging moves the stat change is a secondary effect (removed by
    // Sheer Force); for status moves it is the move itself. Uses the resolved
    // power so variable-power moves are handled.
    if (suppressed && move.damageClass !== 'status') continue;

    const base = meta.statChance || (move.damageClass === 'status' ? 100 : 0);
    const chance = move.damageClass === 'status' ? base : effects.secondaryChance(attacker, base);

    if (chance > 0 && rng() * 100 >= chance) continue;

    const target = statChangeTarget(move, change) === 'user' ? attacker : defender;

    // Mist protects a side from the foe lowering its stats.
    if (target === defender && change.change < 0 && mist && cond.abilityOf(attacker) !== 'infiltrator') {
      events.push({ kind: 'protected-by', name: defender.name, by: 'Mist' });
      continue;
    }

    applyStage(target, change.stat, change.change, events, target === defender);
  }

  settleEffects(events);
}

/** A type name in lower case. */
const lowerType = (type) => String(type || '').toLowerCase();

/** Start a weather: duration (Damp Rock and friends) and the announcement. */
function setWeather(arena, weather, setter, events) {
  arena.weather = weather;
  arena.weatherTurns = fieldRules.weatherDuration(weather, setter);
  arena.setBy = setter.id;

  events.push({
    kind: 'weather-start',
    weather,
    text: fieldRules.WEATHER[weather].started,
    turns: arena.weatherTurns,
  });
}

/**
 * What Utils/statusmoves.js may ask of the engine, bound to this battle and
 * turn.
 */
function engineFor(state, rng, events, turn) {
  return {
    applyStage: (target, stat, delta, evts = events, fromFoe = false, attackerSide = null) => {
      // Mist protects from the foe's stat drops.
      if (fromFoe && delta < 0 && state && attackerSide !== null) {
        const mist = (state.sides[1 - attackerSide].conditions || {}).mist;
        if (mist) {
          evts.push({ kind: 'protected-by', name: target.name, by: 'Mist' });
          return;
        }
      }
      applyStage(target, stat, delta, evts, fromFoe);
    },
    applyStatus: (target, status, evts = events, r = rng, attackerSide = null) => {
      if (state && attackerSide !== null && cond.sideBlocksStatus(state, 1 - attackerSide, target, status)) return false;
      return applyStatus(target, status, evts, r);
    },
    performMove: (attacker, defender, move, extra = {}) => {
      const index = state.sides[0].team[state.sides[0].active] === attacker ? 0 : 1;
      performMove(attacker, defender, move, { rng, events, turn: { ...turn, index }, ...extra });
    },
    pendingSwitch: (sideIndex, options) => {
      state.sides[sideIndex].pendingSwitch = options;
    },
    phaze: (sideIndex) => phaze(state, sideIndex, events, rng),
    flee: (sideIndex, mon) => flee(state, sideIndex, mon, events),
    setWeather: (weather, setter) => {
      if (state.field.weather === weather) return;
      setWeather(state.field, weather, setter, events);
    },
  };
}

// ---------------------------------------------------------------------------
// Switching
// ---------------------------------------------------------------------------

/**
 * Bring in a Pokemon for a side. Handles the one leaving (if it is still
 * standing), Baton Pass and Shed Tail, the switch-in abilities and the
 * hazards on arrival.
 *
 * @param {object} [pass]  { pass: true } for Baton Pass; { shedTail: hp } for Shed Tail
 */
function swapIn(state, sideIndex, teamIndex, events, pass = null) {
  const side = state.sides[sideIndex];
  const other = state.sides[1 - sideIndex];
  const leaving = activeOf(side);
  const target = side.team[teamIndex];

  if (!target || target.fainted || teamIndex === side.active) return false;

  if (leaving && !leaving.fainted) {
    events.push({ kind: 'withdraw', name: leaving.name, side: side.name });

    // Switch-out effects (Natural Cure, Regenerator).
    effects.onWithdraw(leaving, events);
  }

  if (pass && pass.pass && leaving) cond.batonPass(leaving, target);

  if (leaving) {
    // Stat stages reset on switching; status does not.
    leaving.stages = freshStages();

    // Volatiles (Leech Seed, Substitute, Protect chain, confusion...) are
    // cleared too.
    clearVolatiles(leaving);

    // Whatever it was holding the foe with lets go.
    const foe = activeOf(other);
    if (foe && foe.volatiles) {
      if (foe.volatiles.meanLook && foe.volatiles.meanLook.by === leaving.id) delete foe.volatiles.meanLook;
      if (foe.volatiles.octolock === leaving.id) delete foe.volatiles.octolock;
      if (foe.volatiles.attract === leaving.id) delete foe.volatiles.attract;
    }
  }

  side.active = teamIndex;
  target.participated = true;

  // Reset the first-turn counter. The incoming Pokemon first acts next turn.
  target.turnsActive = 0;
  if (!(pass && pass.pass)) {
    target.protectedNow = false;
    target.protectStreak = 0;
  }

  // Shed Tail leaves a Substitute for the one coming in.
  if (pass && pass.shedTail) target.substitute = pass.shedTail;

  events.push({ kind: 'send-out', name: target.name, side: side.name });

  // Intimidate on the way in, then hazards and Healing Wish.
  effects.onSendOut(target, activeOf(other), events);
  cond.onArrive(state, sideIndex, target, events);
  cond.refreshSuppression(state);
  settleEffects(events);
  return true;
}

/**
 * Roar, Whirlwind, Dragon Tail: force the target out. In a wild battle that
 * ends the battle; otherwise a random healthy teammate comes in.
 */
function phaze(state, sideIndex, events, rng) {
  if (state.kind === 'wild') return flee(state, sideIndex, activeOf(state.sides[sideIndex]), events, true);

  const options = benchOf(state.sides[sideIndex]);
  if (!options.length) return false;

  const pick = options[Math.floor(rng() * options.length)];
  events.push({ kind: 'dragged-out', name: activeOf(state.sides[sideIndex]).name });
  return swapIn(state, sideIndex, pick.index, events);
}

/** End a wild battle with someone leaving (Teleport, or being blown away). */
function flee(state, sideIndex, mon, events, blownAway = false) {
  state.finished = true;
  state.fled = true;
  state.winner = null;
  events.push({ kind: blownAway ? 'blown-away' : 'teleported', name: mon.name, side: state.sides[sideIndex].name });
  events.push({ kind: 'end', winner: null, fled: true });
  return true;
}

/** PokeAPI spells a couple of these differently from the rest of the bot. */
/** Move targets that mean the user itself. */
const SELF_TARGETS = new Set(['user', 'user-and-allies', 'users-field', 'user-or-ally']);

/**
 * Who a move's stat change applies to: 'user' or 'target'.
 *
 * Attacks say so in PokeAPI's category: `damage-raise` changes the user
 * (Flame Charge's speed, but also Overheat's and Close Combat's drops),
 * `damage-lower` the target (Psychic, Crunch). Status moves go to whoever
 * they target: Swords Dance and Shell Smash the user, Growl, Memento and
 * Swagger the target. Anything unlabelled falls back to the sign.
 */
function statChangeTarget(move, change) {
  const category = move.meta && move.meta.category;

  if (move.damageClass !== 'status') {
    if (category === 'damage-raise') return 'user';
    if (category === 'damage-lower') return 'target';
    return change.change < 0 ? 'target' : 'user';
  }

  if (move.target) return SELF_TARGETS.has(move.target) ? 'user' : 'target';
  return change.change < 0 ? 'target' : 'user';
}

function normaliseAilment(ailment) {
  const map = { paralysis: 'paralysis', 'bad-poison': 'poison', poison: 'poison' };
  return map[ailment] || ailment;
}

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

/**
 * Resolve one turn.
 *
 * `actions` is one per side: `{type:'move', slot}` or `{type:'switch', index}`.
 * Returns the events produced; the state is mutated in place.
 */
function resolveTurn(state, actions, options = {}) {
  if (state.finished) return [];

  const rng = rngFrom(`${state.seed}:${state.turn}`);
  const events = [];

  state.turn += 1;

  // Which side used Explosion and the like this turn (see checkFinished).
  state.selfFaintedSide = null;
  events.push({ kind: 'turn', turn: state.turn });

  // Roll the damage-taken window forward. Counter, Mirror Coat, Metal Burst
  // and Comeuppance only use this turn's damage (so they need to move second);
  // Bide also uses the previous turn's.
  for (const side of state.sides) {
    for (const mon of side.team) {
      mon.damageTakenLastTurn = mon.damageTakenThisTurn || { physical: 0, special: 0, total: 0 };
      mon.damageTakenThisTurn = { physical: 0, special: 0, total: 0 };
    }
  }

  // Which Pokemon were out when the turn began, taken before switching. A
  // Pokemon that switches in mid-turn keeps its first-turn window for the
  // next turn.
  const wereOut = state.sides.map((side) => activeOf(side));

  // Per-turn records: stat changes (Burning Jealousy, Lash Out), the moves
  // used (Fusion Flare), and whether a teammate fainted last turn (Retaliate).
  state.movesThisTurn = [];
  for (const side of state.sides) {
    for (const mon of side.team) {
      mon.statsRoseThisTurn = false;
      mon.statsDroppedThisTurn = false;
    }
    const fainted = side.team.filter((mon) => mon.fainted).length;
    side.faintedLastTurn = side.faintCount != null && fainted > side.faintCount;
    side.faintCount = fainted;
  }

  // Locked in: the second turn of Dig or Solar Beam, Outrage, Rollout,
  // Uproar, Bide, or Hyper Beam's recharge. Whatever was chosen, that is
  // what happens (no switching either).
  actions = actions.map((action, index) => {
    const lock = rules.lockedAction(activeOf(state.sides[index]));
    return lock ? { type: 'move', slot: -1, locked: lock } : action;
  });
  rules.refreshUproar(state);

  // Encore: a Pokemon under it has to repeat its move, whatever was chosen.
  actions = actions.map((action, index) => {
    if (action.type !== 'move') return action;
    const forced = cond.encoreSlot(activeOf(state.sides[index]));
    return forced != null ? { ...action, slot: forced } : action;
  });

  cond.refreshSuppression(state);

  // What each side chose, and who has had their go, for Sucker Punch.
  const plans = state.sides.map((side, index) => {
    const action = actions[index];
    if (action.type !== 'move') return null;
    if (action.locked) return action.locked.move;
    const entry = activeOf(side).moves[action.slot];
    return entry ? entry.data : null;
  });
  const moved = [false, false];

  // Focus Punch, Shell Trap and Beak Blast announce themselves before anyone
  // moves.
  plans.forEach((plan, index) => {
    if (!plan || actions[index].locked || !rules.FIRES_BEFORE.has(plan.name)) return;
    const mon = activeOf(state.sides[index]);
    if (mon.fainted) return;
    if (plan.name === 'focus-punch') events.push({ kind: 'note', text: `${mon.name} is tightening its focus!` });
    if (plan.name === 'shell-trap') events.push({ kind: 'note', text: `${mon.name} set a shell trap!` });
    if (plan.name === 'beak-blast') {
      mon.volatiles.beakBlast = true;
      events.push({ kind: 'note', text: `${mon.name} started heating up its beak!` });
    }
  });

  // Kept on the state so a turn can pause mid-way (a player choosing who
  // comes in after their U-turn) and pick up again in continueTurn.
  state.turnContext = {
    rng,
    actions,
    plans,
    moved,
    wereOut,
    queue: order(state, actions, rng),
    choose: options.choose || null,
    waitingFor: null,
  };

  return runActions(state, events);
}

/**
 * Pick a paused turn back up once the player has chosen who comes in after
 * their U-turn, Baton Pass, Teleport or the like.
 *
 * @returns {object[]} the events from the switch to the end of the turn
 */
function continueTurn(state, teamIndex) {
  const t = state.turnContext;
  if (!t || t.waitingFor == null) return [];

  const sideIndex = t.waitingFor;
  t.waitingFor = null;
  state.awaitingSwitch = null;

  const events = [];
  sendOut(state, sideIndex, teamIndex, events);
  return runActions(state, events);
}

/**
 * Whoever used U-turn, Baton Pass, Teleport and the like goes out straight
 * away, before the other side's move: so the foe's chosen attack lands on
 * whatever came in, as in the games.
 *
 * @returns {boolean} true when the turn must pause for the player to choose
 */
function midTurnSwitch(state, index, events) {
  const side = state.sides[index];
  if (!side.pendingSwitch) return false;

  if (activeOf(side).fainted || !benchOf(side).length || wipedOut(state.sides[1 - index])) {
    side.pendingSwitch = null;
    return false;
  }

  const t = state.turnContext;
  const pick = t.choose ? t.choose(state, index) : benchOf(side)[0].index;

  if (pick == null) {
    t.waitingFor = index;
    state.awaitingSwitch = index;
    events.push({ kind: 'choose-switch', side: side.name, isPlayer: side.isPlayer });
    return true;
  }

  sendOut(state, index, pick, events);
  return false;
}

/**
 * The turns after the first of a locked-in move: the attack after Dig or
 * Solar Beam's charge, the rest of Outrage and Rollout, Uproar, Bide. No PP
 * is spent.
 */
function continueLocked(state, attacker, defender, lock, rng, events, turn) {
  const v = attacker.volatiles;
  attacker.previousMove = attacker.lastMove;

  if (lock.kind === 'charge') {
    delete v.locked;
    // Sky Drop lets go of its target as it drops it.
    if (lock.move.name === 'sky-drop' && defender.volatiles) delete defender.volatiles.skyDropped;
  }

  if (lock.kind === 'bide') {
    v.locked.turns -= 1;
    if (v.locked.turns > 0) {
      events.push({ kind: 'note', text: `${attacker.name} is storing energy!` });
      return;
    }
    v.bideRelease = v.locked.stored;
    delete v.locked;
    events.push({ kind: 'note', text: `${attacker.name} unleashed its energy!` });
  }

  performMove(attacker, defender, lock.move, { entry: null, rng, events, turn, continuing: true });
  delete v.bideRelease;
}

/** Work through the queued actions; stop early if a switch needs choosing. */
function runActions(state, events) {
  const t = state.turnContext;
  const { rng, actions, plans, moved } = t;

  while (t.queue.length) {
    const index = t.queue.shift();
    const side = state.sides[index];
    const other = state.sides[1 - index];
    const action = actions[index];

    // Whatever happens below (a switch, a flinch, a move), this side has now
    // had its turn.
    const foeMoved = moved[1 - index];
    moved[index] = true;

    // A side that has been wiped out mid-turn does not get to act.
    if (wipedOut(side) || wipedOut(other)) break;

    if (action.type === 'switch') {
      const target = side.team[action.index];
      if (!target || target.fainted || action.index === side.active) continue;

      const leaving = activeOf(side);

      // A trapped Pokemon can't switch out (replacing a fainted one is still
      // allowed): Wrap and friends, Mean Look, Ingrain, Fairy Lock. Ghosts
      // always can.
      let blocker = null;
      if (!leaving.fainted && !(leaving.types || []).some((t) => String(t).toLowerCase() === 'ghost')) {
        const held = leaving.trapped ? leaving.trapped.move : cond.switchBlocked(state, leaving);
        blocker = held && typeof held === 'object' ? held.source : held;
      }

      if (blocker) {
        events.push({ kind: 'cannot-flee', name: leaving.name, source: blocker });
        continue;
      }

      // Pursuit catches a Pokemon on its way out, at double power.
      const chaser = 1 - index;
      const chase = actions[chaser];
      if (!moved[chaser] && chase.type === 'move' && !chase.locked && plans[chaser] && plans[chaser].name === 'pursuit' &&
          !leaving.fainted) {
        const hunter = activeOf(state.sides[chaser]);
        moved[chaser] = true;
        t.queue = t.queue.filter((i) => i !== chaser);
        if (!hunter.fainted && canAct(hunter, rng, events, leaving, plans[chaser])) {
          useMove(hunter, leaving, chase.slot, rng, events, state.field, {
            state, index: chaser, foeMove: null, foeMoved: false, pursuing: true,
          });
        }
        if (wipedOut(side)) break;
      }

      swapIn(state, index, action.index, events);
      continue;
    }

    const attacker = activeOf(side);
    const defender = activeOf(other);

    if (attacker.fainted) continue;

    const turnInfo = { state, index, foeMove: plans[1 - index], foeMoved };

    if (action.locked) {
      // The lock may have ended since the turn began (knocked out of the
      // sky, dragged out by Roar): then it simply loses the turn.
      const lock = rules.lockedAction(attacker);
      if (!lock) continue;

      if (lock.kind === 'recharge') {
        delete attacker.volatiles.mustRecharge;
        events.push({ kind: 'note', text: `${attacker.name} must recharge!` });
        continue;
      }

      if (!canAct(attacker, rng, events, defender, lock.move)) {
        rules.interrupt(attacker, state);
        continue;
      }

      continueLocked(state, attacker, defender, lock, rng, events, turnInfo);
    } else {
      // Carried into the sky by a faster Sky Drop this turn.
      if (attacker.volatiles && attacker.volatiles.skyDropped) continue;

      if (!canAct(attacker, rng, events, defender, plans[index])) {
        rules.interrupt(attacker, state);
        continue;
      }

      useMove(attacker, defender, action.slot, rng, events, state.field, turnInfo);
    }

    delete attacker.volatiles.beakBlast;

    // Roar or Teleport ended a wild battle.
    if (state.fled) break;

    // Explosion, Self-Destruct, Misty Explosion, Memento and Final Gambit: the
    // user faints once the move has gone off, whether it hit, missed or was
    // blocked. useMove sets the flag only when one of them was actually used
    // (not Struggle, and not stopped by Damp).
    if (attacker.selfDestructing) {
      attacker.selfDestructing = false;
      state.selfFaintedSide = index;

      if (!attacker.fainted) {
        attacker.hp = 0;
        attacker.fainted = true;
        events.push({ kind: 'faint', name: attacker.name });
      }
    }

    // U-turn, Baton Pass and the rest: out now, before the foe moves.
    if (midTurnSwitch(state, index, events)) return events;
  }

  return endTurn(state, events);
}

/**
 * End-of-turn effects from moves: Future Sight and Doom Desire landing, Salt
 * Cure, Syrup Bomb, and letting go of a Sky Drop target whose carrier is gone.
 */
function delayedEffects(state, events, rng) {
  state.sides.forEach((side, index) => {
    const c = side.conditions || {};
    const mon = activeOf(side);

    if (c.futureSight) {
      c.futureSight.turns -= 1;
      if (c.futureSight.turns <= 0) {
        const { attacker, move } = c.futureSight;
        delete c.futureSight;
        if (!mon.fainted) {
          events.push({ kind: 'note', text: `${mon.name} took the ${move.displayName} attack!` });
          const effectiveness = cond.effectiveness(move.type, mon, state.field);
          if (effectiveness === 0) {
            events.push({ kind: 'immune', name: mon.name, effectiveness: 0 });
          } else {
            const result = damage.calculate({ attacker, defender: mon, move, roll: rng(), effectiveness });
            if (effectiveness !== 1) {
              const line = typechart.describe(effectiveness);
              if (line) events.push({ kind: 'effectiveness', text: line, effectiveness });
            }
            landHit(attacker, mon, move, result.damage, { effectiveness }, rng, events);
          }
        }
      }
    }

    if (mon.fainted) return;
    const v = mon.volatiles || {};

    if (v.saltCure) {
      const harsh = (mon.types || []).some((t) => ['water', 'steel'].includes(lowerType(t)));
      effects.chip(mon, Math.max(1, Math.floor(mon.maxHp / (harsh ? 4 : 8))), events, 'Salt Cure', 'condition-damage');
    }

    if (v.syrupBomb && !mon.fainted) {
      const foe = activeOf(state.sides[1 - index]);
      v.syrupBomb -= 1;
      applyStage(mon, 'speed', -1, events, true);
      if (v.syrupBomb <= 0 || foe.fainted) delete v.syrupBomb;
    }

    if (v.skyDropped) {
      const carrier = activeOf(state.sides[1 - index]);
      const holding = carrier && carrier.id === v.skyDropped && carrier.volatiles && carrier.volatiles.locked;
      if (!holding) delete v.skyDropped;
    }
  });

  settleEffects(events);
}

/** Everything after both sides have acted: end-of-turn effects, then the result. */
function endTurn(state, events) {
  const { rng, wereOut } = state.turnContext;
  state.turnContext = null;

  // A wild battle ended by Roar, Whirlwind or Teleport: nothing else happens.
  if (state.fled) return events;

  // Once a side has nothing left the battle is over: no weather, burn,
  // poison or Leech Seed afterwards, so the winner can't be knocked out by
  // the sandstorm after winning. Checked again between each effect below.
  const over = () => wipedOut(state.sides[0]) || wipedOut(state.sides[1]);
  if (over()) {
    for (const side of state.sides) for (const mon of side.team) mon.flinched = false;
    checkFinished(state, events);
    return events;
  }

  // A flinch only stops a Pokemon that has not moved yet this turn. One from
  // a slower attacker lands after its target has already acted, so it must
  // not carry over and cost the target its next turn.
  for (const side of state.sides) {
    for (const mon of side.team) mon.flinched = false;
  }

  // End of turn, in the games' order: item and ability effects first
  // (Leftovers, Speed Boost, Shed Skin, the orbs), then burn and poison.
  for (const side of state.sides) {
    if (over()) break;
    const mon = activeOf(side);
    if (mon.fainted) continue;

    effects.endOfTurn(mon, rng, events);
    settleEffects(events);
  }

  for (const side of state.sides) {
    if (over()) break;
    const mon = activeOf(side);
    if (!mon.fainted) residualDamage(mon, events);
  }

  // Then weather, traps and Leech Seed, in that order.
  for (const side of state.sides) {
    if (over()) break;
    const mon = activeOf(side);
    if (mon.fainted) continue;

    const bite = fieldRules.weatherChip(state.field, mon);

    // chip() handles Magic Guard and fainting.
    if (bite > 0) {
      effects.chip(mon, bite, events, fieldRules.WEATHER[state.field.weather].name, 'weather-damage');
    }
  }

  for (const side of state.sides) {
    if (over()) break;
    const mon = activeOf(side);
    if (mon.fainted || !mon.trapped) continue;

    mon.trapped.turns -= 1;

    if (mon.trapped.turns <= 0) {
      events.push({ kind: 'freed', name: mon.name, source: mon.trapped.move });
      mon.trapped = null;
      continue;
    }

    effects.chip(mon, fieldRules.trapChip(mon, null), events, mon.trapped.move, 'trap-damage');
  }

  // Future Sight and Doom Desire land, Salt Cure stings, Syrup Bomb slows.
  if (!over()) delayedEffects(state, events, rng);

  // Leech Seed heals whoever planted it.
  for (let index = 0; index < 2; index += 1) {
    if (over()) break;
    const mon = activeOf(state.sides[index]);
    const other = activeOf(state.sides[1 - index]);

    if (mon.fainted || !mon.seededBy) continue;

    const drained = effects.chip(
      mon, fieldRules.leechAmount(mon), events, 'Leech Seed', 'seed-drain'
    );

    // Heal by the amount actually drained (zero under Magic Guard).
    if (drained > 0 && !other.fainted) {
      const before = other.hp;
      other.hp = Math.min(other.maxHp, other.hp + drained);
      if (other.hp !== before) {
        events.push({ kind: 'seed-heal', name: other.name, amount: other.hp - before, hp: other.hp });
      }
    }
  }

  // Conditions: Wish, Aqua Ring, Ingrain, Grassy Terrain, Nightmare, Curse,
  // Yawn, Perish Song, then every timer (Utils/conditions.js).
  if (!over()) cond.endOfTurn(state, events, rng, {
    applyStatus: (target, status, evts, r) => applyStatus(target, status, evts, r),
    chip: effects.chip,
  });
  settleEffects(events);

  // Count the weather down last, reporting turns remaining.
  if (state.field.weather) {
    state.field.weatherTurns -= 1;

    if (state.field.weatherTurns <= 0) {
      events.push({
        kind: 'weather-end',
        weather: state.field.weather,
        text: fieldRules.WEATHER[state.field.weather].ended,
      });
      state.field.weather = null;
      state.field.setBy = null;
    }
  }

  // Protect lasts one turn; clear it at the end, along with Beak Blast's heat.
  for (const side of state.sides) {
    activeOf(side).protectedNow = false;
    if (activeOf(side).volatiles) delete activeOf(side).volatiles.beakBlast;
  }
  rules.refreshUproar(state);

  // Berries last.
  for (const side of state.sides) {
    const mon = activeOf(side);
    if (!mon.fainted) effects.healthChanged(mon, events);
  }

  settleEffects(events);

  // Advance turnsActive for Pokemon that were out at the start of the turn.
  for (const mon of wereOut) {
    if (mon) mon.turnsActive = (mon.turnsActive || 0) + 1;
  }

  // Report fainted Pokemon that need replacing, and Baton Pass, U-turn and
  // the like that are waiting to switch out; the caller picks who comes in
  // and calls sendOut.
  for (const side of state.sides) {
    if (activeOf(side).fainted && !wipedOut(side)) {
      events.push({ kind: 'must-switch', side: side.name, isPlayer: side.isPlayer });
    } else if (side.pendingSwitch && benchOf(side).length) {
      events.push({ kind: 'must-switch', side: side.name, isPlayer: side.isPlayer, voluntary: true });
    } else {
      side.pendingSwitch = null;
    }
  }

  checkFinished(state, events);
  return events;
}

/**
 * Replace a fainted Pokemon. Separate from a turn - it costs nothing.
 *
 * Returns the send-out event. Any events triggered on arrival (such as
 * Intimidate) are pushed onto `extra` if provided.
 */
function sendOut(state, sideIndex, teamIndex, extra = []) {
  const side = state.sides[sideIndex];
  const target = side.team[teamIndex];

  if (!target || target.fainted) return null;

  // A pending Baton Pass, Shed Tail or U-turn decides what carries over.
  const pending = side.pendingSwitch || null;
  side.pendingSwitch = null;

  // Everything (the withdrawal, the send-out, hazards, Intimidate) goes into
  // `extra`, in order. The return value is only a marker that it happened.
  if (!swapIn(state, sideIndex, teamIndex, extra, activeOf(side).fainted ? null : pending)) return null;
  return { kind: 'switched', name: target.name, side: side.name };
}

function checkFinished(state, events) {
  const [player, opponent] = state.sides;

  // Already over: Roar or Teleport ended a wild battle.
  if (state.fled) return;

  if (wipedOut(player) || wipedOut(opponent)) {
    state.finished = true;
    state.winner = wipedOut(player) ? (wipedOut(opponent) ? null : 1) : 0;

    // Both out, and one of them blew itself up to do it: that side loses,
    // as in the games.
    if (state.winner === null && state.selfFaintedSide != null) state.winner = 1 - state.selfFaintedSide;

    events.push({
      kind: 'end',
      winner: state.winner,
      name: state.winner === null ? null : state.sides[state.winner].name,
    });
    return;
  }

  if (state.turn >= MAX_TURNS) {
    state.finished = true;

    // Whoever has more HP left wins; equal HP is a draw.
    const remaining = state.sides.map((side) =>
      side.team.reduce((total, mon) => total + mon.hp / mon.maxHp, 0)
    );

    state.winner = remaining[0] === remaining[1] ? null : remaining[0] > remaining[1] ? 0 : 1;
    events.push({ kind: 'timeout', turn: state.turn, winner: state.winner });
    events.push({ kind: 'end', winner: state.winner, timedOut: true });
  }
}

/**
 * Simple opponent AI.
 *
 * Picks the move that does the most damage on an average roll. It does not
 * switch, plan ahead or consider status.
 */
function chooseMove(attacker, defender) {
  let best = 0;
  let bestScore = -1;

  attacker.moves.forEach((entry, slot) => {
    if (entry.pp <= 0) return;

    const effectiveness = typechart.effectiveness(entry.data.type, defender.types);

    // Moves the defender would absorb score zero.
    if (effects.absorbs(defender, entry.data, effectiveness)) return;

    const parts = effects.damageParts(attacker, defender, entry.data, effectiveness);

    const result = damage.calculate({
      attacker,
      defender,
      move: entry.data,
      roll: 0.5,
      critical: false,
      attackModifiers: parts.attackModifiers,
      defenceModifiers: parts.defenceModifiers,
      extraModifiers: parts.extraModifiers,
      stabMultiplier: parts.stabMultiplier,
      ignoreBurn: parts.ignoreBurn,
    });

    // A status move is worth something, but only when nothing hits harder.
    const score = result.damage > 0 ? result.damage : 1;

    if (score > bestScore) {
      bestScore = score;
      best = slot;
    }
  });

  return best;
}

/**
 * Apply a level gained mid-battle to a Pokemon that is still fighting.
 *
 * `row` is its stored row after the level-up (stats already recalculated).
 * As in the games, current HP rises by however much max HP did, and a
 * fainted Pokemon stays fainted. Evolution waits for the end of the battle.
 */
function applyLevelUp(mon, row) {
  if (!mon || !row) return;

  const gained = row.stat_hp - mon.maxHp;

  mon.level = row.level;
  mon.stats = {
    hp: row.stat_hp,
    attack: row.stat_attack,
    defense: row.stat_defense,
    specialAttack: row.stat_special_attack,
    specialDefense: row.stat_special_defense,
    speed: row.stat_speed,
  };
  mon.maxHp = row.stat_hp;

  if (!mon.fainted) mon.hp = Math.max(1, Math.min(mon.maxHp, mon.hp + Math.max(0, gained)));
}

module.exports = {
  TEAM_SIZE,
  MAX_TURNS,
  STATUSES,
  STRUGGLE,
  STAT_KEYS,
  rngFrom,
  hashSeed,
  combatantFrom,
  applyLevelUp,
  create,
  activeOf,
  benchOf,
  wipedOut,
  effectiveSpeed,
  order,
  applyStatus,
  applyStage,
  residualDamage,
  useMove,
  resolveTurn,
  sendOut,
  swapIn,
  checkFinished,
  continueTurn,
  performMove,
  chooseMove,
};
