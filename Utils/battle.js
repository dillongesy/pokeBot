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
 * Not yet implemented: terrain, screens, entry hazards, and Mega Evolution or
 * Gigantamax during battle.
 */

const content = require('./content');
const typechart = require('./typechart');
const damage = require('./damage');
const effects = require('./battleeffects');
const movepower = require('./movepower');
const fieldRules = require('./field');
const { loadForm } = require('./pokemon');

/** How many Pokemon a side may bring. The games' number. */
const TEAM_SIZE = 6;

/** Safety limit on the number of turns. */
const MAX_TURNS = 300;

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
    { name: player.name, team: player.team.slice(0, TEAM_SIZE), active: 0, isPlayer: true },
    { name: opponent.name, team: opponent.team.slice(0, TEAM_SIZE), active: 0, isPlayer: false },
  ];

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

    // Field state (weather), see Utils/field.js. Null means clear.
    field: { weather: null, weatherTurns: 0, setBy: null },

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
  mon.trapped = null;
  mon.seededBy = null;
  mon.substitute = 0;
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
 */
function order(state, actions, rng) {
  const entries = state.sides.map((side, index) => {
    const action = actions[index];
    const mon = activeOf(side);

    // A switch resolves before any attack, whatever the speeds.
    if (action.type === 'switch') return { index, priority: 6, speed: Infinity };

    const move = mon.moves[action.slot];
    return {
      index,
      priority: (move && move.data.priority) || 0,
      speed: effectiveSpeed(mon),
    };
  });

  return entries
    .map((entry) => ({ ...entry, tiebreak: rng() }))
    .sort(
      (a, b) => b.priority - a.priority || b.speed - a.speed || a.tiebreak - b.tiebreak
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
function canAct(mon, rng, events) {
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
    return false;
  }

  if (mon.status === 'freeze') {
    // 20% to thaw each turn, as in the games.
    if (rng() < 0.2) {
      mon.status = null;
      events.push({ kind: 'cured', name: mon.name, status: 'freeze' });
      return true;
    }
    events.push({ kind: 'frozen', name: mon.name });
    return false;
  }

  if (mon.status === 'paralysis' && rng() < 0.25) {
    events.push({ kind: 'paralysed', name: mon.name });
    return false;
  }

  return true;
}

/** Burn and poison, applied at the end of a turn. */
function residualDamage(mon, events) {
  if (mon.fainted || !mon.status) return;
  if (mon.status !== 'burn' && mon.status !== 'poison') return;

  // Poison Heal heals instead; Magic Guard prevents it.
  const verdict = effects.residual(mon, events);
  if (verdict !== 'normal') return;

  const hurt = Math.max(1, Math.floor(mon.maxHp / 16));
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
  const saved = effects.survives(defender, landed, rng);

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

  if (saved && saved.consume) effects.consumeItem(defender, events);

  if (defender.hp === 0) {
    defender.fainted = true;

    // Record who scored the knockout, for experience.
    defender.faintedBy = attacker.id;

    events.push({ kind: 'faint', name: defender.name, by: attacker.id });
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
 * One Pokemon attacks another.
 *
 * Steps, in the games' order: PP, resolving the move's power, accuracy,
 * absorption/immunity, per-hit damage, then secondary effects (which don't
 * apply to a fainted target).
 *
 * Ability and item hooks are called at the matching points;
 * Utils/battleeffects.js decides what they do.
 */
function useMove(attacker, defender, slot, rng, events, arena = null) {
  const entry = attacker.moves[slot];
  const anyPpLeft = attacker.moves.some((option) => option.pp > 0);

  // No usable moves: use Struggle.
  let move;

  if (!attacker.moves.length || !anyPpLeft) {
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
    entry.pp -= 1;
    move = entry.data;
  }

  events.push({
    kind: 'move',
    name: attacker.name,
    move: move.displayName,
    type: move.type,
    damageClass: move.damageClass,
  });

  // Resolve the move's power (Utils/movepower.js handles variable-power
  // moves). Done before accuracy, since some moves fail rather than miss
  // (Fling with no item, Counter with nothing to counter). PP is still spent.
  const verdict = movepower.resolve(move, {
    attacker,
    defender,
    rng,
    entry: move === STRUGGLE ? null : entry,
    allies: attacker.allies,
    speedOf: effectiveSpeed,
  });

  if (verdict.kind === 'fail') {
    events.push({
      kind: 'failed',
      name: attacker.name,
      text: movepower.reasonText(verdict.reason, attacker.name),
    });
    return;
  }

  // ------------------------------------------------------------------
  // Field moves: Protect, weather, Substitute and Leech Seed resolve here
  // (see Utils/field.js).
  // ------------------------------------------------------------------

  // Any other move resets the Protect chain.
  if (!fieldRules.isProtect(move)) attacker.protectStreak = 0;

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

  const weather = fieldRules.weatherFor(move);

  if (weather) {
    if (!arena) return;

    if (arena.weather === weather) {
      events.push({ kind: 'failed', name: attacker.name, text: 'But it failed!' });
      return;
    }

    arena.weather = weather;
    arena.weatherTurns = fieldRules.weatherDuration(weather, attacker);
    arena.setBy = attacker.id;

    events.push({
      kind: 'weather-start',
      weather,
      text: fieldRules.WEATHER[weather].started,
      turns: arena.weatherTurns,
    });
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

  const aim = effects.accuracy(attacker, defender, move);

  // One-hit KO moves use their own accuracy rule.
  if (
    verdict.kind !== 'ohko' &&
    !aim.never &&
    !damage.hits(move, rng(), attacker.stages.accuracy, defender.stages.evasion, aim.multiplier)
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

  // Natural Gift takes the berry's type, which everything below must use.
  const movedType = verdict.type || move.type;
  const effectiveness = typechart.effectiveness(movedType, defender.types);

  // Absorbing abilities and items (Levitate, Volt Absorb, Flash Fire, Wonder
  // Guard, Air Balloon) stop the move entirely.
  const absorb = effects.absorbs(defender, { ...move, type: movedType }, effectiveness);

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
    dealt = landHit(attacker, defender, move, verdict.damage, { effectiveness: 1 }, rng, events);
    hitsLanded = 1;

    // Final Gambit: the user faints regardless, and the opponent isn't
    // credited with the knockout.
    if (verdict.selfFaint && !attacker.fainted) {
      attacker.hp = 0;
      attacker.fainted = true;
      events.push({ kind: 'faint', name: attacker.name });
    }
  } else {
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
    const critBonus = effects.critStage(attacker, move);

    // Effectiveness is announced once per move, not per hit.
    let saidEffectiveness = false;

    for (let hit = 0; hit < hitCount && !defender.fainted; hit += 1) {
      const critical = critsAllowed && damage.crits(move, rng(), critBonus);

      // Ability and item modifiers, grouped for Utils/damage.js.
      const thisPower = powers ? powers[hit] : verdict.power || move.power;
      const parts = effects.damageParts(attacker, defender, move, effectiveness, thisPower);

      // Weather: rain boosts Water and weakens Fire, sun the reverse;
      // sandstorm boosts Rock Special Defence and snow Ice Defence.
      const weatherOut = fieldRules.weatherDamageMultiplier(arena, { ...move, type: movedType });
      const weatherIn = fieldRules.weatherDefenceMultiplier(arena, defender, move);

      if (weatherOut !== 1) parts.extraModifiers.push(weatherOut);
      if (weatherIn !== 1) parts.defenceModifiers.push(weatherIn);

      const result = damage.calculate({
        attacker,
        defender,
        move,
        roll: rng(),
        critical,
        power: thisPower,
        type: verdict.type || null,
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
        result.damage,
        { critical, effectiveness: result.effectiveness },
        rng,
        events
      );

      hitsLanded += 1;
    }

    if (hitCount > 1 && hitsLanded > 0) {
      events.push({ kind: 'multi-hit', name: attacker.name, hits: hitsLanded });
    }
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
  // negative hurts them.
  //
  // Struggle's recoil is a quarter of the user's max HP rather than based on
  // damage dealt.
  if (meta.drain && dealt > 0) {
    const change =
      move === STRUGGLE
        ? Math.max(1, Math.floor(attacker.maxHp / 4))
        : Math.max(1, Math.floor((dealt * Math.abs(meta.drain)) / 100));

    if (meta.drain > 0) {
      attacker.hp = Math.min(attacker.maxHp, attacker.hp + change);
      events.push({ kind: 'drain', name: attacker.name, amount: change, hp: attacker.hp });
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
  // three) and empties it.
  if (meta.healing > 0) {
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

    const healed = Math.max(1, Math.floor((attacker.maxHp * percent) / 100));
    const before = attacker.hp;
    attacker.hp = Math.min(attacker.maxHp, attacker.hp + healed);
    if (attacker.hp !== before) {
      events.push({ kind: 'heal', name: attacker.name, amount: attacker.hp - before, hp: attacker.hp });
    }
  }

  // Everything below only lands on something still standing.
  if (defender.fainted || attacker.fainted) return;

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

  // Sheer Force removes secondary effects (ailment, flinch and stat changes).
  const suppressed = effects.suppressesSecondaries(attacker, move);

  if (
    !suppressed &&
    meta.ailment &&
    meta.ailment !== 'none' &&
    STATUSES.includes(normaliseAilment(meta.ailment))
  ) {
    // A status move with no listed chance always works; a damaging move with a
    // secondary ailment rolls for it. Serene Grace doubles the roll.
    const base = meta.ailmentChance || (move.damageClass === 'status' ? 100 : 0);
    const chance = move.damageClass === 'status' ? base : effects.secondaryChance(attacker, base);

    if (chance > 0 && rng() * 100 < chance) {
      applyStatus(defender, normaliseAilment(meta.ailment), events, rng);
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

  for (const change of move.statChanges || []) {
    // For damaging moves the stat change is a secondary effect (removed by
    // Sheer Force); for status moves it is the move itself. Uses the resolved
    // power so variable-power moves are handled.
    if (suppressed && move.damageClass !== 'status') continue;

    const base = meta.statChance || (move.damageClass === 'status' ? 100 : 0);
    const chance = move.damageClass === 'status' ? base : effects.secondaryChance(attacker, base);

    if (chance > 0 && rng() * 100 >= chance) continue;

    // Negative changes target the defender, positive ones the user.
    const target = change.change < 0 ? defender : attacker;
    applyStage(target, change.stat, change.change, events, target === defender);
  }

  settleEffects(events);
}

/** PokeAPI spells a couple of these differently from the rest of the bot. */
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
function resolveTurn(state, actions) {
  if (state.finished) return [];

  const rng = rngFrom(`${state.seed}:${state.turn}`);
  const events = [];

  state.turn += 1;
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

  for (const index of order(state, actions, rng)) {
    const side = state.sides[index];
    const other = state.sides[1 - index];
    const action = actions[index];

    // A side that has been wiped out mid-turn does not get to act.
    if (wipedOut(side) || wipedOut(other)) break;

    if (action.type === 'switch') {
      const target = side.team[action.index];
      if (!target || target.fainted || action.index === side.active) continue;

      const leaving = activeOf(side);

      // A trapped Pokemon can't switch out (replacing a fainted one is still
      // allowed).
      if (leaving.trapped && !leaving.fainted) {
        events.push({
          kind: 'cannot-flee',
          name: leaving.name,
          source: leaving.trapped.move,
        });
        continue;
      }

      events.push({ kind: 'withdraw', name: leaving.name, side: side.name });

      // Switch-out effects (Natural Cure, Regenerator), skipped for a fainted
      // Pokemon.
      if (!leaving.fainted) effects.onWithdraw(leaving, events);

      // Stat stages reset on switching; status does not.
      leaving.stages = freshStages();

      // Volatiles (Leech Seed, Substitute, Protect chain) are cleared too.
      clearVolatiles(leaving);

      side.active = action.index;
      target.participated = true;

      // Reset the first-turn counter. The incoming Pokemon first acts next
      // turn.
      target.turnsActive = 0;

      events.push({ kind: 'send-out', name: target.name, side: side.name });

      // Intimidate, on the way in.
      effects.onSendOut(target, activeOf(other), events);
      settleEffects(events);
      continue;
    }

    const attacker = activeOf(side);
    const defender = activeOf(other);

    if (attacker.fainted) continue;
    if (!canAct(attacker, rng, events)) continue;

    useMove(attacker, defender, action.slot, rng, events, state.field);
  }

  // End of turn, in the games' order: item and ability effects first
  // (Leftovers, Speed Boost, Shed Skin, the orbs), then burn and poison.
  for (const side of state.sides) {
    const mon = activeOf(side);
    if (mon.fainted) continue;

    effects.endOfTurn(mon, rng, events);
    settleEffects(events);
  }

  for (const side of state.sides) {
    const mon = activeOf(side);
    if (!mon.fainted) residualDamage(mon, events);
  }

  // Then weather, traps and Leech Seed, in that order.
  for (const side of state.sides) {
    const mon = activeOf(side);
    if (mon.fainted) continue;

    const bite = fieldRules.weatherChip(state.field, mon);

    // chip() handles Magic Guard and fainting.
    if (bite > 0) {
      effects.chip(mon, bite, events, fieldRules.WEATHER[state.field.weather].name, 'weather-damage');
    }
  }

  for (const side of state.sides) {
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

  // Leech Seed heals whoever planted it.
  for (let index = 0; index < 2; index += 1) {
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

  // Protect lasts one turn; clear it at the end.
  for (const side of state.sides) activeOf(side).protectedNow = false;

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

  // Report fainted Pokemon that need replacing; the caller handles it.
  for (const side of state.sides) {
    if (activeOf(side).fainted && !wipedOut(side)) {
      events.push({ kind: 'must-switch', side: side.name, isPlayer: side.isPlayer });
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

  side.active = teamIndex;
  target.participated = true;

  // Reset the first-turn counter and volatiles for the replacement.
  target.turnsActive = 0;
  clearVolatiles(target);

  effects.onSendOut(target, activeOf(state.sides[1 - sideIndex]), extra);
  settleEffects(extra);

  return { kind: 'send-out', name: target.name, side: side.name };
}

function checkFinished(state, events) {
  const [player, opponent] = state.sides;

  if (wipedOut(player) || wipedOut(opponent)) {
    state.finished = true;
    state.winner = wipedOut(player) ? (wipedOut(opponent) ? null : 1) : 0;

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

module.exports = {
  TEAM_SIZE,
  MAX_TURNS,
  STATUSES,
  STRUGGLE,
  STAT_KEYS,
  rngFrom,
  hashSeed,
  combatantFrom,
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
  chooseMove,
};
