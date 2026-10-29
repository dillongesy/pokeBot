'use strict';

/**
 * Damaging moves with rules of their own, as in the current games.
 *
 *   - Two-turn moves: Solar Beam and the other charging moves, and Dig, Fly,
 *     Dive, Bounce, Phantom Force, Shadow Force and Sky Drop, which take the
 *     user out of reach for a turn.
 *   - Moves that lock the user in: Hyper Beam's recharge, Outrage and the
 *     other rampages, Rollout, Uproar and Bide.
 *   - Power that depends on the battle: Hex, Brine, Knock Off, Acrobatics,
 *     Stored Power, Eruption, Fury Cutter and the rest.
 *   - Moves that use other stats or types: Psyshock, Foul Play, Body Press,
 *     Freeze-Dry, Flying Press, Weather Ball.
 *   - Moves that fail unless something is true: Dream Eater, Snore, Last
 *     Resort, Belch, Poltergeist, Burn Up, Upper Hand.
 *   - What happens after the hit: Knock Off, Thief, Bug Bite, Clear Smog, the
 *     trapping moves, Salt Cure, Ceaseless Edge, Fell Stinger.
 *   - What happens after the move: High Jump Kick's crash, Steel Beam's cost.
 *
 * Utils/battle.js calls in at each step. `ctx` carries { state, sideIndex,
 * attacker, defender, move, rng, events, engine, turn }, as for
 * Utils/statusmoves.js.
 */

const typechart = require('./typechart');
const effects = require('./battleeffects');
const cond = require('./conditions');

const { vol, abilityOf, itemOf } = cond;

const lower = (text) => String(text || '').toLowerCase();
const hasType = (mon, type) => (mon.types || []).some((t) => lower(t) === type);
const note = (events, text) => events.push({ kind: 'note', text });
const weatherOf = (ctx) => (ctx.state && ctx.state.field ? ctx.state.field.weather : null);
const terrainOf = (ctx) => (ctx.state && ctx.state.field ? ctx.state.field.terrain : null);
const STAGES = ['attack', 'defense', 'specialAttack', 'specialDefense', 'speed', 'accuracy', 'evasion'];

// ---------------------------------------------------------------------------
// Two-turn moves
// ---------------------------------------------------------------------------

/**
 * `text` is what the first turn says. `vanish` takes the user out of reach
 * until it attacks; `stat` is raised while charging; `skipIn` lists weathers
 * that let it attack at once. Power Herb skips the charge of any of them.
 */
const CHARGE = {
  'razor-wind': { text: (n) => `${n} whipped up a whirlwind!` },
  'solar-beam': { text: (n) => `${n} absorbed light!`, skipIn: ['sun'] },
  'solar-blade': { text: (n) => `${n} absorbed light!`, skipIn: ['sun'] },
  'skull-bash': { text: (n) => `${n} tucked in its head!`, stat: [['defense', 1]] },
  'sky-attack': { text: (n) => `${n} became cloaked in a harsh light!` },
  'meteor-beam': { text: (n) => `${n} is overflowing with space power!`, stat: [['specialAttack', 1]] },
  'electro-shot': { text: (n) => `${n} absorbed electricity!`, stat: [['specialAttack', 1]], skipIn: ['rain'] },
  'freeze-shock': { text: (n) => `${n} became cloaked in a freezing light!` },
  'ice-burn': { text: (n) => `${n} became cloaked in freezing air!` },
  geomancy: { text: (n) => `${n} is absorbing power!` },
  fly: { text: (n) => `${n} flew up high!`, vanish: 'sky' },
  bounce: { text: (n) => `${n} sprang up!`, vanish: 'sky' },
  'sky-drop': { text: (n, t) => `${n} took ${t} into the sky!`, vanish: 'sky' },
  dig: { text: (n) => `${n} burrowed its way under the ground!`, vanish: 'underground' },
  dive: { text: (n) => `${n} hid underwater!`, vanish: 'underwater' },
  'phantom-force': { text: (n) => `${n} vanished instantly!`, vanish: 'vanished' },
  'shadow-force': { text: (n) => `${n} vanished instantly!`, vanish: 'vanished' },
};

/** What can still reach a Pokemon that is out of reach, and which of those hit twice as hard. */
const REACHES = {
  sky: new Set(['gust', 'twister', 'thunder', 'hurricane', 'sky-uppercut', 'smack-down', 'thousand-arrows', 'bleakwind-storm']),
  underground: new Set(['earthquake', 'magnitude', 'fissure']),
  underwater: new Set(['surf', 'whirlpool']),
  vanished: new Set(),
};
const DOUBLED_AGAINST = {
  sky: new Set(['gust', 'twister']),
  underground: new Set(['earthquake', 'magnitude']),
  underwater: new Set(['surf', 'whirlpool']),
};

/**
 * Start a two-turn move.
 *
 * @returns {boolean} true when this turn is only the charge
 */
function startCharge(ctx) {
  const { attacker, defender, move, events } = ctx;
  const rule = CHARGE[move.name];
  if (!rule) return false;

  // Sky Drop can't lift something 200 kg or heavier, or a target behind a
  // Substitute. (The engine has already announced it and checked accuracy
  // and Protect.)
  if (move.name === 'sky-drop' && ((defender.weight || 0) >= 200 || defender.substitute > 0 || defender.fainted)) {
    events.push({ kind: 'failed', name: attacker.name, text: (defender.weight || 0) >= 200 ? `${defender.name} is too heavy to be lifted!` : 'But it failed!' });
    return true;
  }

  note(events, rule.text(attacker.name, defender.name));
  for (const [stat, delta] of rule.stat || []) ctx.engine.applyStage(attacker, stat, delta, events);

  if ((rule.skipIn || []).includes(weatherOf(ctx))) return false;

  if (itemOf(attacker) === 'power-herb') {
    note(events, `${attacker.name} became fully charged due to its Power Herb!`);
    effects.consumeItem(attacker, events);
    return false;
  }

  vol(attacker).locked = { kind: 'charge', move, vanish: rule.vanish || null };

  if (move.name === 'sky-drop') vol(defender).skyDropped = attacker.id;
  return true;
}

/** Where a Pokemon is while out of reach, or null. Sky Drop's target is up there too. */
function vanishedTo(mon) {
  const v = vol(mon);
  if (v.locked && v.locked.kind === 'charge' && v.locked.vanish) return v.locked.vanish;
  if (v.skyDropped) return 'sky';
  return null;
}

/** Can this move reach a target that is out of reach? */
function canReach(move, defender) {
  const where = vanishedTo(defender);
  return !where || REACHES[where].has(move.name);
}

// ---------------------------------------------------------------------------
// Moves that lock the user in
// ---------------------------------------------------------------------------

const RECHARGE = new Set([
  'hyper-beam', 'giga-impact', 'blast-burn', 'frenzy-plant', 'hydro-cannon', 'rock-wrecker',
  'roar-of-time', 'prismatic-laser', 'eternabeam', 'meteor-assault',
]);
const RAMPAGE = new Set(['outrage', 'thrash', 'petal-dance', 'raging-fury']);
const ROLLING = new Set(['rollout', 'ice-ball']);

/**
 * What a locked-in Pokemon must do this turn: { kind, move } (move is null
 * for a recharge), or null when it is free to choose.
 *
 * A Sky Drop target isn't locked: as in the games it still picks a move,
 * which it uses if it's dropped before its turn comes (Utils/battle.js), and
 * it can't switch out (conditions.switchBlocked).
 */
function lockedAction(mon) {
  if (!mon || mon.fainted) return null;
  const v = vol(mon);
  if (v.mustRecharge) return { kind: 'recharge', move: null };
  if (v.locked) return { kind: v.locked.kind, move: v.locked.move };
  return null;
}

/** Sleep, a flinch or full paralysis breaks a lock (and a charge, which then never lands). */
function interrupt(mon, state) {
  const v = vol(mon);
  if (v.locked && v.locked.kind === 'charge' && v.locked.move.name === 'sky-drop' && state) {
    for (const side of state.sides) for (const other of side.team) if (vol(other).skyDropped === mon.id) delete vol(other).skyDropped;
  }
  const wasUproar = v.locked && v.locked.kind === 'uproar';
  delete v.locked;
  delete v.rollout;
  delete v.furyCutter;
  if (wasUproar) refreshUproar(state);
}

/**
 * Smack Down, Thousand Arrows and Gravity bring a Pokemon in the sky down:
 * Fly and Bounce are cancelled, and Sky Drop lets go (or falls with) its
 * target.
 *
 * @returns {boolean} whether it was up there
 */
function bringDown(mon, state, events) {
  const v = vol(mon);
  if (v.locked && v.locked.kind === 'charge' && v.locked.vanish === 'sky') {
    interrupt(mon, state);
    if (events) note(events, `${mon.name} fell straight down!`);
    return true;
  }
  if (v.skyDropped) {
    const carrier = v.skyDropped;
    delete v.skyDropped;
    for (const side of state ? state.sides : []) {
      for (const other of side.team) {
        const lock = vol(other).locked;
        if (other.id === carrier && lock && lock.kind === 'charge' && lock.move.name === 'sky-drop') delete vol(other).locked;
      }
    }
    if (events) note(events, `${mon.name} fell straight down!`);
    return true;
  }
  return false;
}

/** Uproar: nobody sleeps while it lasts. */
function refreshUproar(state) {
  if (!state) return;
  const loud = state.sides.some((side) => {
    const mon = side.team[side.active];
    return mon && !mon.fainted && vol(mon).locked && vol(mon).locked.kind === 'uproar';
  });
  for (const side of state.sides) for (const mon of side.team) mon.uproarNearby = loud;
}

/** Bide's first turn. */
function startBide(ctx) {
  vol(ctx.attacker).locked = { kind: 'bide', move: ctx.move, turns: 2, stored: 0, by: null };
  note(ctx.events, `${ctx.attacker.name} is storing energy!`);
}

// ---------------------------------------------------------------------------
// Failing outright
// ---------------------------------------------------------------------------

const STOMPS = new Set([
  'stomp', 'body-slam', 'dragon-rush', 'heat-crash', 'heavy-slam', 'flying-press', 'steamroller',
  'double-iron-bash', 'phantom-force', 'shadow-force', 'malicious-moonsault', 'supercell-slam',
]);
const NO_REPEAT = new Set(['gigaton-hammer', 'blood-moon']);
const CRASHES = new Set(['high-jump-kick', 'jump-kick', 'axe-kick', 'supercell-slam']);
const HALF_HP_COST = new Set(['mind-blown', 'steel-beam', 'chloroblast']);
const HOLDS_BACK = new Set(['false-swipe', 'hold-back']);
const FIRES_BEFORE = new Set(['focus-punch', 'shell-trap', 'beak-blast']);
const FUTURE = new Set(['future-sight', 'doom-desire']);
const TRAPS_TARGET = new Set(['spirit-shackle', 'anchor-shot', 'thousand-waves', 'jaw-lock']);

/** The user thaws itself out to use these. */
const THAWS_USER = new Set([
  'flame-wheel', 'sacred-fire', 'flare-blitz', 'fusion-flare', 'scald', 'steam-eruption',
  'burn-up', 'pyro-ball', 'scorching-sands', 'matcha-gotcha',
]);
/** And these thaw a frozen target, as Fire moves do. */
const THAWS_TARGET = new Set(['scald', 'steam-eruption', 'scorching-sands', 'matcha-gotcha']);

/** Items that can't be knocked off, stolen or burned. */
const fixedItem = (item) => !item || /ite(-[xyz])?$/.test(item) && item !== 'eviolite' || /-(plate|memory|drive)$/.test(item) || item.endsWith('-mask');
const isBerry = (item) => /-berry$/.test(item || '');

/**
 * Why this damaging move fails right now, or null. Checked before accuracy;
 * the AI reads it too.
 */
function failReason(ctx) {
  const { attacker, defender, move, turn = {} } = ctx;
  const v = vol(attacker);

  switch (move.name) {
    case 'dream-eater':
      return defender.status === 'sleep' || abilityOf(defender) === 'comatose' ? null : `${defender.name} wasn't affected.`;
    case 'snore':
      return attacker.status === 'sleep' || abilityOf(attacker) === 'comatose' ? null : 'But it failed!';
    case 'last-resort': {
      const others = attacker.moves.filter((m) => m.name !== 'last-resort');
      const used = v.usedMoves || [];
      return others.length && others.every((m) => used.includes(m.name)) ? null : 'But it failed!';
    }
    case 'belch':
      return attacker.ateBerry ? null : `${attacker.name} hasn't eaten a berry.`;
    case 'poltergeist':
      return itemOf(defender) ? null : 'But it failed!';
    case 'burn-up':
      return hasType(attacker, 'fire') ? null : 'But it failed!';
    case 'double-shock':
      return hasType(attacker, 'electric') ? null : 'But it failed!';
    case 'synchronoise':
      return (attacker.types || []).some((t) => hasType(defender, lower(t))) ? null : `${defender.name} wasn't affected.`;
    case 'steel-roller':
      return terrainOf(ctx) ? null : 'But it failed!';
    case 'upper-hand': {
      const foeMove = turn.foeMove;
      const priority = foeMove ? (foeMove.priority || 0) + effects.priorityBonus(defender, foeMove) : 0;
      return foeMove && !turn.foeMoved && priority > 0 && foeMove.damageClass !== 'status' ? null : 'But it failed!';
    }
    case 'focus-punch':
      return (attacker.damageTakenThisTurn || {}).total > 0 ? `${attacker.name} lost its focus and couldn't move!` : null;
    case 'shell-trap':
      return (attacker.damageTakenThisTurn || {}).physical > 0 ? null : `${attacker.name}'s shell trap didn't work!`;
    case 'future-sight':
    case 'doom-desire':
      return ctx.state && (ctx.state.sides[1 - ctx.sideIndex].conditions || {}).futureSight ? 'But it failed!' : null;
    default:
      break;
  }

  if (NO_REPEAT.has(move.name) && attacker.previousMove === move.name) {
    return `${attacker.name} can't use ${move.displayName} twice in a row!`;
  }
  return null;
}

/** Sure to hit: Glaive Rush's user, and a Minimized target for the stomping moves. */
function sureHit(ctx) {
  const dv = vol(ctx.defender);
  return Boolean(dv.glaiveRush || (dv.minimized && STOMPS.has(ctx.move.name)));
}

/**
 * Weather accuracy: Thunder and Hurricane never miss in rain and are 50% in
 * sun; Blizzard never misses in hail or snow.
 *
 * @returns {number|null} the accuracy to use, or null to keep the move's own
 */
function weatherAccuracy(ctx) {
  const weather = weatherOf(ctx);
  const name = ctx.move.name;
  if (['thunder', 'hurricane', 'bleakwind-storm', 'wildbolt-storm', 'sandsear-storm'].includes(name) && weather === 'rain') return Infinity;
  if (['thunder', 'hurricane'].includes(name) && weather === 'sun') return 50;
  if (name === 'blizzard' && (weather === 'hail' || weather === 'snow')) return Infinity;
  return null;
}

// ---------------------------------------------------------------------------
// Type, effectiveness and the stats used
// ---------------------------------------------------------------------------

const WEATHER_BALL = { sun: 'fire', rain: 'water', sandstorm: 'rock', hail: 'ice', snow: 'ice' };
const TERRAIN_PULSE = { electric: 'electric', grassy: 'grass', misty: 'fairy', psychic: 'psychic' };
const DRIVES = { 'burn-drive': 'fire', 'chill-drive': 'ice', 'douse-drive': 'water', 'shock-drive': 'electric' };

/** The move's type in this battle, or null to keep its own. */
function typeFor(ctx) {
  const { attacker, move } = ctx;
  switch (move.name) {
    case 'weather-ball': return WEATHER_BALL[weatherOf(ctx)] || null;
    case 'terrain-pulse': return cond.grounded(attacker, ctx.state ? ctx.state.field : {}) ? TERRAIN_PULSE[terrainOf(ctx)] || null : null;
    case 'revelation-dance': return lower((attacker.types || [])[0]) || null;
    // Arceus and Silvally take their plate's or memory's type, which their form already has.
    case 'judgment':
    case 'multi-attack':
      return /-(plate|memory)$/.test(itemOf(attacker) || '') ? lower((attacker.types || [])[0]) || null : null;
    case 'techno-blast': return DRIVES[itemOf(attacker)] || null;
    // Set by the user's IVs (Utils/pokemon.js hiddenPowerType).
    case 'hidden-power': return attacker.hiddenPowerType || null;
    // Ogerpon's mask and the Paldean Tauros breeds: the form's second type.
    case 'ivy-cudgel':
    case 'raging-bull':
      return (attacker.types || []).length > 1 ? lower(attacker.types[1]) : null;
    default: return null;
  }
}

/** Effectiveness after Freeze-Dry, Flying Press and Thousand Arrows. */
function adjustEffectiveness(ctx, effectiveness, typeOf) {
  const { move, defender } = ctx;
  // Sky Drop lifts a Flying type but can't hurt it.
  if (move.name === 'sky-drop' && hasType(defender, 'flying')) return 0;
  if (move.name === 'freeze-dry' && hasType(defender, 'water')) {
    return effectiveness * 4;
  }
  if (move.name === 'flying-press') {
    return effectiveness * typeOf('flying');
  }
  if (move.name === 'thousand-arrows' && effectiveness === 0 && hasType(defender, 'flying')) {
    const rest = (defender.types || []).filter((t) => lower(t) !== 'flying');
    return rest.length ? typechart.effectiveness('ground', rest) : 1;
  }
  return effectiveness;
}

/**
 * Which stats the damage formula uses. Returns stand-ins for the attacker,
 * the defender and the move: Psyshock hits Defense, Foul Play uses the
 * target's Attack, Body Press the user's Defense, Photon Geyser whichever
 * attacking stat is higher, Sacred Sword ignores the target's stat changes.
 */
function statSources(ctx, attacker, defender, move) {
  const swap = (mon, stats, stages) => ({ ...mon, stats: { ...mon.stats, ...stats }, stages: { ...mon.stages, ...stages } });

  switch (move.name) {
    case 'psyshock':
    case 'psystrike':
    case 'secret-sword':
      return { attacker, defender: swap(defender, { specialDefense: defender.stats.defense }, { specialDefense: defender.stages.defense || 0 }), move };
    case 'foul-play':
      return { attacker: swap(attacker, { attack: defender.stats.attack }, { attack: defender.stages.attack || 0 }), defender, move };
    case 'body-press':
      return { attacker: swap(attacker, { attack: attacker.stats.defense }, { attack: attacker.stages.defense || 0 }), defender, move };
    case 'photon-geyser':
    case 'shell-side-arm':
    case 'tera-blast': {
      const physical = attacker.stats.attack * stageValue(attacker.stages.attack) >
        attacker.stats.specialAttack * stageValue(attacker.stages.specialAttack);
      return { attacker, defender, move: physical ? { ...move, damageClass: 'physical' } : move };
    }
    case 'chip-away':
    case 'sacred-sword':
    case 'darkest-lariat':
      return { attacker, defender: swap(defender, {}, { defense: 0, specialDefense: 0 }), move };
    default:
      return { attacker, defender, move };
  }
}

const stageValue = (stage) => {
  const s = Math.max(-6, Math.min(6, stage || 0));
  return s >= 0 ? (2 + s) / 2 : 2 / (2 - s);
};

// ---------------------------------------------------------------------------
// Power
// ---------------------------------------------------------------------------

/** Escalating multi-hit moves: the power of each hit. Every hit checks accuracy. */
const ESCALATING = { 'triple-kick': [10, 20, 30], 'triple-axel': [20, 40, 60] };
const EACH_HIT_CHECKS_ACCURACY = new Set(['triple-kick', 'triple-axel', 'population-bomb']);

const positiveStages = (mon) => STAGES.reduce((total, key) => total + Math.max(0, mon.stages[key] || 0), 0);
const hasStatus = (mon) => Boolean(mon.status) || abilityOf(mon) === 'comatose';

/**
 * The power of one hit, from the base power the engine worked out.
 *
 * @param {number} hit  which hit of a multi-hit move, from 0
 */
function powerFor(ctx, base, hit = 0) {
  const { attacker, defender, move, turn = {}, state } = ctx;
  const field = state ? state.field : {};
  const v = vol(attacker);
  const dv = vol(defender);
  let power = base;

  if (ESCALATING[move.name]) power = ESCALATING[move.name][Math.min(hit, 2)];

  switch (move.name) {
    case 'hex':
    case 'infernal-parade':
      if (hasStatus(defender)) power *= 2;
      break;
    case 'venoshock':
    case 'barb-barrage':
      if (defender.status === 'poison') power *= 2;
      break;
    case 'brine':
      if (defender.hp * 2 <= defender.maxHp) power *= 2;
      break;
    case 'acrobatics':
      if (!attacker.item) power *= 2;
      break;
    case 'weather-ball':
      if (WEATHER_BALL[weatherOf(ctx)]) power *= 2;
      break;
    case 'terrain-pulse':
      if (TERRAIN_PULSE[terrainOf(ctx)] && cond.grounded(attacker, field)) power *= 2;
      break;
    case 'knock-off':
      if (defender.item && !fixedItem(defender.item)) power = Math.floor(power * 1.5);
      break;
    case 'payback':
      if (turn.foeMoved) power *= 2;
      break;
    case 'avalanche':
    case 'revenge':
      if ((attacker.damageTakenThisTurn || {}).total > 0) power *= 2;
      break;
    case 'assurance':
      if ((defender.damageTakenThisTurn || {}).total > 0) power *= 2;
      break;
    case 'retaliate':
      if (state && state.sides[ctx.sideIndex].faintedLastTurn) power *= 2;
      break;
    case 'stored-power':
    case 'power-trip':
      power = 20 + 20 * positiveStages(attacker);
      break;
    case 'smelling-salts':
      if (defender.status === 'paralysis') power *= 2;
      break;
    case 'wake-up-slap':
      if (defender.status === 'sleep') power *= 2;
      break;
    case 'stomping-tantrum':
    case 'temper-flare':
      if (attacker.lastMoveFailed) power *= 2;
      break;
    case 'lash-out':
      if (attacker.statsDroppedThisTurn) power *= 2;
      break;
    case 'rage-fist':
      power = Math.min(350, 50 + 50 * (attacker.timesHit || 0));
      break;
    case 'last-respects':
      power = 50 + 50 * (attacker.allies || []).filter((mon) => mon !== attacker && mon.fainted).length;
      break;
    case 'bolt-beak':
    case 'fishious-rend':
      if (!turn.foeMoved || defender.turnsActive === 0) power *= 2;
      break;
    case 'eruption':
    case 'water-spout':
    case 'dragon-energy':
      power = Math.max(1, Math.floor((150 * attacker.hp) / attacker.maxHp));
      break;
    case 'fickle-beam':
      if (v.fickleRoll) power *= 2;
      break;
    case 'collision-course':
    case 'electro-drift':
      if (ctx.effectiveness > 1) power = Math.floor((power * 5461) / 4096);
      break;
    case 'psyblade':
      if (terrainOf(ctx) === 'electric') power = Math.floor(power * 1.5);
      break;
    case 'expanding-force':
      if (terrainOf(ctx) === 'psychic' && cond.grounded(attacker, field)) power = Math.floor(power * 1.5);
      break;
    case 'rising-voltage':
      if (terrainOf(ctx) === 'electric' && cond.grounded(defender, field)) power *= 2;
      break;
    case 'misty-explosion':
      if (terrainOf(ctx) === 'misty' && cond.grounded(attacker, field)) power = Math.floor(power * 1.5);
      break;
    case 'grav-apple':
      if (state && state.field.gravity) power = Math.floor(power * 1.5);
      break;
    case 'solar-beam':
    case 'solar-blade':
      if (['rain', 'sandstorm', 'hail', 'snow'].includes(weatherOf(ctx))) power = Math.floor(power / 2);
      break;
    case 'hydro-steam':
      // Strengthened rather than weakened by sun: undoes the weather's halving, then 1.5x.
      if (weatherOf(ctx) === 'sun') power *= 3;
      break;
    case 'pursuit':
      if (turn.pursuing) power *= 2;
      break;
    case 'fury-cutter':
      power = Math.min(160, power * 2 ** (v.furyCutter || 0));
      break;
    case 'echoed-voice':
      power = Math.min(200, power * echoStreak(state));
      break;
    case 'rollout':
    case 'ice-ball':
      power = power * 2 ** (v.rollout || 0) * (v.defenseCurl ? 2 : 1);
      break;
    case 'fusion-flare':
    case 'fusion-bolt': {
      const partner = move.name === 'fusion-flare' ? 'fusion-bolt' : 'fusion-flare';
      if (state && state.movesThisTurn && state.movesThisTurn.includes(partner)) power *= 2;
      break;
    }
    // Round doubles when it follows another Round that turn, the foe's included.
    case 'round':
      if (state && state.movesThisTurn && state.movesThisTurn.includes('round')) power *= 2;
      break;
    default:
      break;
  }

  // Charging out of reach: the moves that can still reach it hit twice as hard.
  const where = vanishedTo(defender);
  if (where && DOUBLED_AGAINST[where] && DOUBLED_AGAINST[where].has(move.name)) power *= 2;

  // A Minimized target takes double from the stomping moves.
  if (dv.minimized && STOMPS.has(move.name)) power *= 2;

  // Glaive Rush leaves its user wide open.
  if (dv.glaiveRush) power *= 2;

  return power;
}

/** How many turns in a row Echoed Voice has been used, counting this one (at most 5). */
function echoStreak(state) {
  const echo = state && state.echoedVoice;
  if (!echo) return 1;
  if (echo.turn === state.turn) return echo.count;
  return echo.turn === state.turn - 1 ? Math.min(5, echo.count + 1) : 1;
}

/** Roll anything random about the move once, before its hits (Fickle Beam). */
function rollBeforeHits(ctx) {
  const v = vol(ctx.attacker);
  if (ctx.move.name === 'fickle-beam') {
    v.fickleRoll = ctx.rng() < 0.3;
    if (v.fickleRoll) note(ctx.events, `${ctx.attacker.name} is going all out for this attack!`);
  }
}

/** False Swipe and Hold Back always leave the target at least 1 HP. */
function capDamage(ctx, amount) {
  if (!HOLDS_BACK.has(ctx.move.name) || ctx.defender.substitute > 0) return amount;
  return Math.max(0, Math.min(amount, ctx.defender.hp - 1));
}

// ---------------------------------------------------------------------------
// Before and after the hit
// ---------------------------------------------------------------------------

/** Spectral Thief takes the target's boosts before it hits. */
function beforeHit(ctx) {
  const { attacker, defender, move, events } = ctx;
  if (move.name !== 'spectral-thief') return;
  let stole = false;
  for (const key of STAGES) {
    const up = defender.stages[key] || 0;
    if (up > 0) {
      attacker.stages[key] = Math.min(6, (attacker.stages[key] || 0) + up);
      defender.stages[key] = 0;
      stole = true;
    }
  }
  if (stole) note(events, `${attacker.name} stole the target's boosted stats!`);
}

const RANDOM_STATUS = {
  'tri-attack': { chance: 20, pick: ['burn', 'paralysis', 'freeze'] },
  'dire-claw': { chance: 50, pick: ['poison', 'paralysis', 'sleep'] },
};
const SECRET_POWER = { electric: 'paralysis', grassy: 'sleep', misty: ['specialAttack', -1], psychic: ['speed', -1] };

/**
 * Everything a damaging move does once it has landed. `standing` is false
 * when the target fainted; most of these then do nothing.
 */
function afterHit(ctx, { dealt, standing }) {
  const { attacker, defender, move, events, rng, engine, state, sideIndex } = ctx;
  const v = vol(attacker);
  const dv = vol(defender);
  const suppressed = effects.suppressesSecondaries(attacker, move);
  const foeSide = state ? state.sides[1 - sideIndex] : null;

  // Fell Stinger: +3 Attack for a knockout.
  if (move.name === 'fell-stinger' && !standing && defender.faintedBy === attacker.id) {
    engine.applyStage(attacker, 'attack', 3, events);
  }

  // Ceaseless Edge and Stone Axe leave hazards behind, even after a knockout.
  if (foeSide && move.name === 'ceaseless-edge') {
    const c = foeSide.conditions || (foeSide.conditions = {});
    if ((c.spikes || 0) < 3) {
      c.spikes = (c.spikes || 0) + 1;
      events.push({ kind: 'hazard-set', side: foeSide.name, what: 'Spikes' });
    }
  }
  if (foeSide && move.name === 'stone-axe') {
    const c = foeSide.conditions || (foeSide.conditions = {});
    if (!c.stealthRock) {
      c.stealthRock = true;
      events.push({ kind: 'hazard-set', side: foeSide.name, what: 'pointed stones' });
    }
  }

  // Burn Up and Double Shock use up the user's type.
  if (move.name === 'burn-up' || move.name === 'double-shock') {
    const gone = move.name === 'burn-up' ? 'fire' : 'electric';
    attacker.types = (attacker.types || []).filter((t) => lower(t) !== gone);
    note(events, move.name === 'burn-up' ? `${attacker.name} burned itself out!` : `${attacker.name} used up all its electricity!`);
  }

  // Ice Spinner and Steel Roller flatten the terrain.
  if ((move.name === 'ice-spinner' || move.name === 'steel-roller') && state && state.field.terrain) {
    note(events, 'The terrain returned to normal.');
    state.field.terrain = null;
    state.field.terrainTurns = 0;
  }

  // Plasma Fists turns Normal moves Electric for the rest of the turn.
  if (move.name === 'plasma-fists' && state && !state.field.ionDeluge) {
    state.field.ionDeluge = true;
    note(events, 'A deluge of ions showers the battlefield!');
  }

  if (move.name === 'pay-day') note(events, 'Coins were scattered everywhere!');

  if (!standing || attacker.fainted) return;

  // ---- items ----
  if (move.name === 'knock-off' && defender.item && !fixedItem(defender.item) && abilityOf(defender) !== 'sticky-hold') {
    const item = effects.displayItem(defender.item);
    effects.setItem(defender, null);
    note(events, `${attacker.name} knocked off ${defender.name}'s ${item}!`);
  }

  if ((move.name === 'thief' || move.name === 'covet') && !attacker.item && defender.item && !fixedItem(defender.item) &&
      abilityOf(defender) !== 'sticky-hold') {
    const item = defender.item;
    effects.setItem(defender, null);
    effects.setItem(attacker, item);
    note(events, `${attacker.name} stole ${defender.name}'s ${effects.displayItem(item)}!`);
  }

  if ((move.name === 'bug-bite' || move.name === 'pluck') && isBerry(defender.item) && abilityOf(defender) !== 'sticky-hold') {
    const berry = defender.item;
    effects.setItem(defender, null);
    note(events, `${attacker.name} stole and ate ${defender.name}'s ${effects.displayItem(berry)}!`);
    eatBerry(attacker, berry, events);
  }

  if (move.name === 'incinerate' && (isBerry(defender.item) || /-gem$/.test(defender.item || ''))) {
    const item = effects.displayItem(defender.item);
    effects.setItem(defender, null);
    note(events, `${defender.name}'s ${item} was burned up!`);
  }

  // ---- the target's condition ----
  if (move.name === 'clear-smog') {
    for (const key of STAGES) defender.stages[key] = 0;
    note(events, `${defender.name}'s stat changes were removed!`);
  }

  if (move.name === 'smelling-salts' && defender.status === 'paralysis') {
    defender.status = null;
    events.push({ kind: 'cured', name: defender.name, status: 'paralysis' });
  }
  if (move.name === 'wake-up-slap' && defender.status === 'sleep') {
    defender.status = null;
    events.push({ kind: 'cured', name: defender.name, status: 'sleep' });
  }
  if (move.name === 'sparkling-aria' && defender.status === 'burn') {
    defender.status = null;
    events.push({ kind: 'cured', name: defender.name, status: 'burn' });
  }

  if (TRAPS_TARGET.has(move.name) && !dv.meanLook && !hasType(defender, 'ghost')) {
    dv.meanLook = { by: attacker.id, source: move.displayName };
    events.push({ kind: 'cant-escape', name: defender.name });
    if (move.name === 'jaw-lock' && !v.meanLook && !hasType(attacker, 'ghost')) {
      v.meanLook = { by: defender.id, source: move.displayName };
      events.push({ kind: 'cant-escape', name: attacker.name });
    }
  }

  if (move.name === 'salt-cure' && !dv.saltCure) {
    dv.saltCure = true;
    note(events, `${defender.name} is being salt cured!`);
  }

  if (move.name === 'throat-chop' && !suppressed) {
    dv.throatChop = 2;
  }

  if (move.name === 'psychic-noise' && !suppressed && !dv.healBlock) {
    dv.healBlock = 2;
    events.push({ kind: 'volatile-start', name: defender.name, what: 'healBlock', label: 'Heal Block' });
  }

  if (move.name === 'syrup-bomb' && !dv.syrupBomb) {
    dv.syrupBomb = 3;
    note(events, `${defender.name} got covered in sticky candy syrup!`);
  }

  // Core Enforcer: the target's ability stops working if it has already moved.
  if (move.name === 'core-enforcer' && ctx.turn && ctx.turn.foeMoved && !dv.gastroAcid) {
    dv.gastroAcid = true;
    if (state) cond.refreshSuppression(state);
    note(events, `${defender.name}'s Ability was suppressed!`);
  }

  // A Fire move, or Scald and its kind, thaws a frozen target.
  if (defender.status === 'freeze' && dealt > 0 && (lower(ctx.movedType) === 'fire' || THAWS_TARGET.has(move.name))) {
    defender.status = null;
    events.push({ kind: 'cured', name: defender.name, status: 'freeze' });
  }

  // ---- secondary statuses the move data can't describe ----
  if (suppressed) return;

  const roll = (chance) => rng() * 100 < effects.secondaryChance(attacker, chance);

  if (RANDOM_STATUS[move.name] && roll(RANDOM_STATUS[move.name].chance)) {
    const options = RANDOM_STATUS[move.name].pick;
    engine.applyStatus(defender, options[Math.floor(rng() * options.length)], events, rng, sideIndex);
  }

  if (move.name === 'secret-power' && roll(30)) {
    const effect = SECRET_POWER[terrainOf(ctx)] || 'paralysis';
    if (Array.isArray(effect)) engine.applyStage(defender, effect[0], effect[1], events, true, sideIndex);
    else engine.applyStatus(defender, effect, events, rng, sideIndex);
  }

  if (move.name === 'burning-jealousy' && defender.statsRoseThisTurn) {
    engine.applyStatus(defender, 'burn', events, rng, sideIndex);
  }

  if (move.name === 'alluring-voice' && defender.statsRoseThisTurn && state) {
    cond.confuse(state, 1 - sideIndex, defender, events, rng, { attacker });
  }

  // Scale Shot: faster but more fragile once all its hits are in.
  if (move.name === 'scale-shot') {
    engine.applyStage(attacker, 'speed', 1, events);
    engine.applyStage(attacker, 'defense', -1, events);
  }
}

/** Eat a berry taken with Bug Bite or Pluck: its healing or cure applies to the eater. */
function eatBerry(mon, berry, events) {
  mon.ateBerry = true;
  const heal = (amount) => {
    const before = mon.hp;
    mon.hp = Math.min(mon.maxHp, mon.hp + amount);
    if (mon.hp > before) events.push({ kind: 'heal', name: mon.name, amount: mon.hp - before, hp: mon.hp });
  };
  const cures = {
    'cheri-berry': ['paralysis'], 'chesto-berry': ['sleep'], 'pecha-berry': ['poison'], 'rawst-berry': ['burn'],
    'aspear-berry': ['freeze'], 'lum-berry': ['burn', 'poison', 'paralysis', 'sleep', 'freeze'],
  };
  if (berry === 'oran-berry') heal(10);
  else if (berry === 'sitrus-berry') heal(Math.floor(mon.maxHp / 4));
  else if (['figy-berry', 'wiki-berry', 'mago-berry', 'aguav-berry', 'iapapa-berry'].includes(berry)) heal(Math.floor(mon.maxHp / 3));
  if (cures[berry] && cures[berry].includes(mon.status)) {
    events.push({ kind: 'cured', name: mon.name, status: mon.status });
    mon.status = null;
  }
  if ((berry === 'persim-berry' || berry === 'lum-berry') && vol(mon).confusion) {
    delete vol(mon).confusion;
    events.push({ kind: 'confusion-end', name: mon.name });
  }
}

// ---------------------------------------------------------------------------
// After the move, whatever happened
// ---------------------------------------------------------------------------

/** Event kinds that mean the move didn't do its job. */
const FAILURES = new Set(['miss', 'failed', 'immune', 'protected', 'guarded', 'shrugged-off', 'absorb', 'no-pp', 'restricted']);

/**
 * Bookkeeping once a move is over: whether it failed (Stomping Tantrum),
 * crash damage, Steel Beam's cost, the recharge, the rampage, Rollout and the
 * consecutive-use counters.
 *
 * @param {object} outcome  { started, hits, continuing } from the engine
 */
function afterMove(ctx, outcome, start) {
  const { attacker, move, events, state, rng } = ctx;
  if (!move) return;
  const v = vol(attacker);
  const said = events.slice(start).filter((e) => e.name === attacker.name || e.name === ctx.defender.name || e.kind === 'miss');
  const failed = !outcome.hits && said.some((e) => FAILURES.has(e.kind));
  const missed = !outcome.hits && said.some((e) => ['miss', 'protected', 'immune', 'guarded', 'absorb'].includes(e.kind));

  attacker.lastMoveFailed = failed;
  if (!outcome.charging) {
    v.usedMoves = [...new Set([...(v.usedMoves || []), move.name])];
  }
  if (state && !outcome.charging) (state.movesThisTurn || (state.movesThisTurn = [])).push(move.name);

  if (attacker.fainted) {
    delete v.locked;
    return;
  }

  // High Jump Kick and friends: half the user's HP if it doesn't connect.
  if (CRASHES.has(move.name) && missed) {
    effects.chip(attacker, Math.floor(attacker.maxHp / 2), events, `${attacker.name} kept going and crashed!`, 'hurt');
  }

  // Steel Beam, Mind Blown and Chloroblast cost half the user's HP, hit or miss.
  if (HALF_HP_COST.has(move.name) && outcome.started && !attacker.fainted) {
    effects.chip(attacker, Math.ceil(attacker.maxHp / 2), events, `${attacker.name} paid with its own health!`, 'hurt');
  }

  if (attacker.fainted) {
    delete v.locked;
    return;
  }

  // Hyper Beam and the rest: a turn off afterwards, if it landed.
  if (RECHARGE.has(move.name) && outcome.hits) v.mustRecharge = true;

  // Outrage and the rampages: 2-3 turns, then confusion from fatigue. A miss
  // or a block ends it early, without the confusion.
  if (RAMPAGE.has(move.name)) {
    if (!outcome.continuing) {
      if (outcome.hits) v.locked = { kind: 'rampage', move, turns: 1 + Math.floor(rng() * 2) };
    } else if (!outcome.hits) {
      delete v.locked;
    } else if (v.locked) {
      v.locked.turns -= 1;
      if (v.locked.turns <= 0) {
        delete v.locked;
        if (!v.confusion && abilityOf(attacker) !== 'own-tempo') {
          v.confusion = 2 + Math.floor(rng() * 4);
          events.push({ kind: 'confused', name: attacker.name });
          note(events, `${attacker.name} became confused due to fatigue!`);
        }
      }
    }
  }

  // Uproar: three turns, and nobody can sleep through it.
  if (move.name === 'uproar') {
    if (!outcome.continuing && !failed) {
      v.locked = { kind: 'uproar', move, turns: 2 };
      note(events, `${attacker.name} caused an uproar!`);
      if (state) {
        for (const side of state.sides) {
          const mon = side.team[side.active];
          if (mon && !mon.fainted && mon.status === 'sleep') {
            mon.status = null;
            events.push({ kind: 'cured', name: mon.name, status: 'sleep' });
          }
        }
      }
    } else if (outcome.continuing && v.locked) {
      v.locked.turns -= 1;
      if (v.locked.turns <= 0) {
        delete v.locked;
        note(events, `${attacker.name} calmed down.`);
      }
    }
    refreshUproar(state);
  }

  // Rollout and Ice Ball: five turns, doubling each hit; a miss ends it.
  if (ROLLING.has(move.name)) {
    if (!outcome.hits) {
      delete v.locked;
      delete v.rollout;
    } else {
      v.rollout = (v.rollout || 0) + 1;
      if (v.rollout >= 5) {
        delete v.locked;
        delete v.rollout;
      } else {
        v.locked = { kind: 'rolling', move };
      }
    }
  } else {
    delete v.rollout;
  }

  // Fury Cutter doubles with each consecutive hit.
  if (move.name === 'fury-cutter') v.furyCutter = outcome.hits ? Math.min(4, (v.furyCutter || 0) + 1) : 0;
  else delete v.furyCutter;

  // Echoed Voice grows each turn anyone uses it.
  if (move.name === 'echoed-voice' && state && outcome.hits) {
    state.echoedVoice = { turn: state.turn, count: echoStreak(state) };
  }

  // Rage: its Attack rises whenever it is hit, until it uses another move.
  if (move.name === 'rage' && outcome.hits) v.rage = true;
  else if (move.name !== 'rage') delete v.rage;

  // Glaive Rush: easy to hit and hit hard, until it moves again.
  if (move.name === 'glaive-rush' && outcome.hits) v.glaiveRush = true;

  // Minimize makes it a target for the stomping moves.
  if (move.name === 'minimize' && !failed) v.minimized = true;
  if (move.name === 'defense-curl' && !failed) v.defenseCurl = true;
}

// ---------------------------------------------------------------------------
// Delayed attacks: Future Sight and Doom Desire
// ---------------------------------------------------------------------------

/** Foresee the attack: it lands two turns from now on whoever is out. */
function startFutureSight(ctx) {
  const side = ctx.state.sides[1 - ctx.sideIndex];
  const c = side.conditions || (side.conditions = {});
  c.futureSight = { turns: 3, attacker: ctx.attacker, move: ctx.move };
  note(ctx.events, ctx.move.name === 'doom-desire'
    ? `${ctx.attacker.name} chose Doom Desire as its destiny!`
    : `${ctx.attacker.name} foresaw an attack!`);
}

module.exports = {
  CHARGE,
  RECHARGE,
  RAMPAGE,
  ROLLING,
  STOMPS,
  NO_REPEAT,
  CRASHES,
  HALF_HP_COST,
  HOLDS_BACK,
  FIRES_BEFORE,
  FUTURE,
  THAWS_USER,
  ESCALATING,
  EACH_HIT_CHECKS_ACCURACY,
  startCharge,
  startBide,
  startFutureSight,
  vanishedTo,
  canReach,
  lockedAction,
  interrupt,
  bringDown,
  refreshUproar,
  failReason,
  sureHit,
  weatherAccuracy,
  typeFor,
  adjustEffectiveness,
  statSources,
  powerFor,
  rollBeforeHits,
  capDamage,
  beforeHit,
  afterHit,
  afterMove,
  eatBerry,
  fixedItem,
};
