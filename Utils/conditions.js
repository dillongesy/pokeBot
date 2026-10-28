'use strict';

/**
 * Battle conditions: everything that lasts beyond a single move.
 *
 *   side      on one side of the field: Reflect, Light Screen, Aurora Veil,
 *             Safeguard, Mist, Tailwind, Lucky Chant, Spikes, Toxic Spikes,
 *             Stealth Rock, Sticky Web, Wish and Healing Wish
 *   field     on the whole field: Trick Room, Gravity, Magic Room, Wonder Room,
 *             the four terrains, Mud Sport, Water Sport, Fairy Lock, Ion Deluge
 *   volatile  on one Pokemon, cleared when it leaves the field: confusion,
 *             Taunt, Encore, Disable, Torment, attraction, Yawn, Nightmare,
 *             Curse, Perish Song, Destiny Bond, Focus Energy, Laser Focus,
 *             Aqua Ring, Ingrain, Magnet Rise, Telekinesis, Embargo, Heal
 *             Block, Imprison, Foresight, Miracle Eye, Mean Look, Lock-On,
 *             Endure, Magic Coat, Snatch, Charge, Electrify, Powder, Grudge
 *
 * Rules follow the current games (Scarlet/Violet): confusion lasts 2-5 turns
 * and hits itself a third of the time, screens halve damage in singles,
 * Grass types ignore powder moves, Dark types ignore Prankster status moves,
 * Ghost types can't be trapped, and so on.
 *
 * This module holds the state and the rules that read it. Utils/statusmoves.js
 * sets most of it; Utils/battle.js calls in at fixed points of a turn.
 */

const typechart = require('./typechart');
const effects = require('./battleeffects');

/** How long each timed condition lasts, in turns. */
const DURATION = {
  reflect: 5,
  lightScreen: 5,
  auroraVeil: 5,
  safeguard: 5,
  mist: 5,
  tailwind: 4,
  luckyChant: 5,
  trickRoom: 5,
  gravity: 5,
  magicRoom: 5,
  wonderRoom: 5,
  terrain: 5,
  mudSport: 5,
  waterSport: 5,
  taunt: 3,
  encore: 3,
  disable: 4,
  magnetRise: 5,
  telekinesis: 3,
  embargo: 5,
  healBlock: 5,
};

/** Light Clay stretches screens to eight turns. */
const SCREEN_CLAY = 8;

/** The terrains, what they boost and what they announce. */
const TERRAINS = {
  electric: { type: 'electric', started: 'An electric current ran across the battlefield!', ended: 'The electricity disappeared from the battlefield.' },
  grassy: { type: 'grass', started: 'Grass grew to cover the battlefield!', ended: 'The grass disappeared from the battlefield.' },
  misty: { type: null, started: 'Mist swirled around the battlefield!', ended: 'The mist disappeared from the battlefield.' },
  psychic: { type: 'psychic', started: 'The battlefield got weird!', ended: 'The weirdness disappeared from the battlefield!' },
};

/** Moves that are powder, which Grass types, Overcoat and Safety Goggles ignore. */
const POWDER = new Set([
  'sleep-powder', 'stun-spore', 'poison-powder', 'spore', 'rage-powder',
  'cotton-spore', 'magic-powder', 'powder',
]);

/** Sound moves: they go through a Substitute, and Soundproof ignores them. */
const SOUND = new Set([
  'growl', 'roar', 'sing', 'supersonic', 'screech', 'snore', 'uproar', 'metal-sound',
  'grass-whistle', 'hyper-voice', 'perish-song', 'heal-bell', 'bug-buzz', 'chatter',
  'round', 'echoed-voice', 'relic-song', 'snarl', 'noble-roar', 'disarming-voice',
  'parting-shot', 'boomburst', 'confide', 'sparkling-aria', 'clanging-scales',
  'clangorous-soul', 'overdrive', 'eerie-spell', 'torch-song', 'alluring-voice',
  'psychic-noise',
]);

/** Spread moves, which Wide Guard blocks. */
const SPREAD_TARGETS = new Set(['all-opponents', 'all-other-pokemon', 'all-pokemon']);

/** Ground moves halved by Grassy Terrain. */
const QUAKES = new Set(['earthquake', 'bulldoze', 'magnitude']);

/** What Brick Break and friends break before hitting. */
const SCREEN_BREAKERS = new Set(['brick-break', 'psychic-fangs', 'raging-bull']);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const lower = (text) => String(text || '').toLowerCase();
const hasType = (mon, type) => (mon.types || []).some((t) => lower(t) === type);
const abilityOf = (mon) => (mon.abilitySuppressed ? null : mon.ability);
const itemOf = (mon) => (mon.itemsSuppressed ? null : mon.item);
const vol = (mon) => {
  if (!mon.volatiles) mon.volatiles = {};
  return mon.volatiles;
};

/** Fresh state for a side and for the field, used by battle.create. */
const freshSide = () => ({});
const freshField = () => ({
  trickRoom: 0,
  gravity: 0,
  magicRoom: 0,
  wonderRoom: 0,
  terrain: null,
  terrainTurns: 0,
  mudSport: 0,
  waterSport: 0,
  fairyLock: 0,
  ionDeluge: false,
});

/**
 * Is this Pokemon on the ground? Flying types, Levitate, an Air Balloon,
 * Magnet Rise and Telekinesis lift it; Gravity, Ingrain, Smack Down and an
 * Iron Ball bring it back down.
 */
function grounded(mon, field = {}) {
  if (field.gravity || itemOf(mon) === 'iron-ball') return true;
  const v = vol(mon);
  if (v.ingrain || v.smackedDown) return true;
  if (v.magnetRise || v.telekinesis) return false;
  if (hasType(mon, 'flying')) return false;
  if (abilityOf(mon) === 'levitate') return false;
  if (itemOf(mon) === 'air-balloon') return false;
  return true;
}

/**
 * Keep item and ability suppression up to date: Magic Room and Embargo turn
 * items off, Gastro Acid abilities. Utils/battleeffects.js reads these flags.
 */
function refreshSuppression(state) {
  for (const side of state.sides) {
    for (const mon of side.team) {
      const v = vol(mon);
      mon.itemsSuppressed = Boolean(state.field.magicRoom || v.embargo);
      mon.abilitySuppressed = Boolean(v.gastroAcid);
    }
  }
}

// ---------------------------------------------------------------------------
// Type effectiveness, with Foresight, Miracle Eye, Gravity and the lifts
// ---------------------------------------------------------------------------

/**
 * Effectiveness of a move type against a Pokemon, after the conditions that
 * change it:
 *
 *   Foresight / Odor Sleuth   Normal and Fighting hit Ghost types
 *   Miracle Eye               Psychic hits Dark types
 *   grounded Flying types     Ground moves hit them (Gravity, Smack Down...)
 *   Magnet Rise, Telekinesis  Ground moves miss
 */
function effectiveness(type, defender, field = {}) {
  const t = lower(type);
  const v = vol(defender);
  let types = (defender.types || []).map(lower);

  if ((t === 'normal' || t === 'fighting') && v.foresight) types = types.filter((x) => x !== 'ghost');
  if (t === 'psychic' && v.miracleEye) types = types.filter((x) => x !== 'dark');

  if (t === 'ground') {
    if (!grounded(defender, field)) {
      // Lifted by a move or item rather than its type: still immune.
      if (!hasType(defender, 'flying')) return 0;
    } else {
      types = types.filter((x) => x !== 'flying');
    }
  }

  if (!types.length) return 1;
  return typechart.effectiveness(type, types);
}

// ---------------------------------------------------------------------------
// Immunities to status moves
// ---------------------------------------------------------------------------

/**
 * Why a move can't affect its target, before anything else is checked, or
 * null. Covers the current games' type and ability immunities to status
 * moves:
 *
 *   powder moves      Grass types, Overcoat, Safety Goggles
 *   Prankster         a Dark type ignores a status move Prankster sped up
 *   sound moves       Soundproof
 */
function immuneTo(attacker, defender, move) {
  const targetsFoe = move.target && !['user', 'user-and-allies', 'users-field', 'user-or-ally', 'entire-field', 'opponents-field'].includes(move.target);
  if (!targetsFoe) return null;

  if (POWDER.has(move.name)) {
    if (hasType(defender, 'grass')) return 'immune';
    if (abilityOf(defender) === 'overcoat') return 'Overcoat';
    if (itemOf(defender) === 'safety-goggles') return 'Safety Goggles';
  }

  if (move.damageClass === 'status' && abilityOf(attacker) === 'prankster' && hasType(defender, 'dark')) {
    return 'immune';
  }

  if (SOUND.has(move.name) && abilityOf(defender) === 'soundproof') return 'Soundproof';

  return null;
}

/** Does a Substitute stop this move? Status moves aimed at the foe, except sound moves. */
function blockedBySubstitute(move) {
  if (SOUND.has(move.name)) return false;
  if (move.damageClass !== 'status') return false;
  if (['roar', 'whirlwind', 'transform', 'curse', 'spite', 'sketch', 'role-play', 'psych-up'].includes(move.name)) {
    return false;
  }
  return Boolean(move.target) && ['selected-pokemon', 'all-opponents', 'all-other-pokemon', 'random-opponent'].includes(move.target);
}

/**
 * Can a status (or confusion) be inflicted on this Pokemon from the other
 * side? Safeguard and Misty Terrain block both; Electric Terrain blocks sleep.
 */
function sideBlocksStatus(state, sideIndex, mon, status, attacker = null) {
  const side = state.sides[sideIndex];
  if (side.conditions && side.conditions.safeguard && (!attacker || abilityOf(attacker) !== 'infiltrator')) {
    return 'Safeguard';
  }
  if (state.field.terrain === 'misty' && grounded(mon, state.field)) return 'Misty Terrain';
  if (status === 'sleep' && state.field.terrain === 'electric' && grounded(mon, state.field)) {
    return 'Electric Terrain';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Confusion
// ---------------------------------------------------------------------------

/**
 * Try to confuse a Pokemon. Own Tempo, Safeguard, Misty Terrain and a
 * Substitute (for status moves) stop it.
 *
 * @returns {boolean} whether it is now confused
 */
function confuse(state, sideIndex, mon, events, rng, { attacker = null, viaStatusMove = false } = {}) {
  if (mon.fainted) return false;
  const v = vol(mon);

  if (v.confusion) {
    if (viaStatusMove) events.push({ kind: 'already', name: mon.name, what: 'confused' });
    return false;
  }
  if (abilityOf(mon) === 'own-tempo') {
    events.push({ kind: 'status-blocked', name: mon.name, status: 'confus', by: 'Own Tempo' });
    return false;
  }
  if (viaStatusMove && mon.substitute > 0) {
    events.push({ kind: 'failed', name: mon.name, text: 'But it failed!' });
    return false;
  }

  const blocked = sideBlocksStatus(state, sideIndex, mon, 'confusion', attacker);
  if (blocked) {
    events.push({ kind: 'protected-by', name: mon.name, by: blocked });
    return false;
  }

  // 2-5 turns, counted down each time it tries to move.
  v.confusion = 2 + Math.floor(rng() * 4);
  events.push({ kind: 'confused', name: mon.name });

  // Persim and Lum Berries cure it straight away.
  const item = itemOf(mon);
  if (item === 'persim-berry' || item === 'lum-berry') {
    delete v.confusion;
    events.push({ kind: 'confusion-cured', name: mon.name, source: item === 'lum-berry' ? 'Lum Berry' : 'Persim Berry' });
    effects.consumeItem(mon, events);
  }
  return true;
}

/**
 * The confusion check when a confused Pokemon tries to move. A third of the
 * time it hits itself with a 40-power typeless physical attack instead.
 *
 * @param {function} selfHit  (mon) => damage, from the engine's formula
 * @returns {boolean} whether it may go ahead and move
 */
function confusionCheck(mon, events, rng, selfHit) {
  const v = vol(mon);
  if (!v.confusion) return true;

  v.confusion -= 1;
  if (v.confusion <= 0) {
    delete v.confusion;
    events.push({ kind: 'confusion-end', name: mon.name });
    return true;
  }

  events.push({ kind: 'confusion-turn', name: mon.name });
  if (rng() >= 1 / 3) return true;

  const hurt = Math.min(mon.hp, Math.max(1, selfHit(mon)));
  mon.hp -= hurt;
  events.push({ kind: 'confusion-hit', name: mon.name, damage: hurt, hp: mon.hp });

  if (mon.hp <= 0) {
    mon.hp = 0;
    mon.fainted = true;
    mon.faintedBy = null;
    events.push({ kind: 'faint', name: mon.name });
  }
  return false;
}

// ---------------------------------------------------------------------------
// Can this move be used?
// ---------------------------------------------------------------------------

/** Moves that can't be chosen under Gravity. */
const GRAVITY_BANNED = new Set([
  'fly', 'bounce', 'jump-kick', 'high-jump-kick', 'magnet-rise', 'telekinesis',
  'sky-drop', 'splash', 'flying-press', 'floaty-fall',
]);

/** Healing moves, which Heal Block stops. */
const isHealingMove = (move) =>
  move.damageClass === 'status' &&
  ((move.meta && move.meta.healing > 0) || ['rest', 'wish', 'aqua-ring', 'ingrain', 'healing-wish', 'lunar-dance', 'roost', 'swallow'].includes(move.name));

/**
 * Whether a Pokemon may use one of its moves right now, and why not.
 *
 * @returns {null | string} null if it may; otherwise the reason, for the log
 */
function restriction(state, sideIndex, mon, slot) {
  const entry = mon.moves[slot];
  if (!entry) return null;
  const move = entry.data;
  const v = vol(mon);
  const foe = state.sides[1 - sideIndex].team[state.sides[1 - sideIndex].active];

  if (v.taunt && move.damageClass === 'status') return 'taunt';
  if (v.disable && v.disable.move === move.name) return 'disable';
  if (v.torment && mon.lastMove === move.name && move.name !== 'struggle') return 'torment';
  if (v.healBlock && isHealingMove(move)) return 'heal-block';
  if (state.field.gravity && GRAVITY_BANNED.has(move.name)) return 'gravity';
  if (foe && !foe.fainted && vol(foe).imprison && foe.moves.some((m) => m.name === move.name)) return 'imprison';
  return null;
}

/** The move slot an Encore forces, or null. */
function encoreSlot(mon) {
  const v = vol(mon);
  if (!v.encore) return null;
  const slot = mon.moves.findIndex((m) => m.name === v.encore.move);
  return slot >= 0 && mon.moves[slot].pp > 0 ? slot : null;
}

/** Can this Pokemon switch out? Ingrain, Mean Look and Fairy Lock stop it; Ghosts always can. */
function switchBlocked(state, mon) {
  if (hasType(mon, 'ghost') || itemOf(mon) === 'shed-shell') return null;
  const v = vol(mon);
  if (v.ingrain) return 'Ingrain';
  if (v.meanLook) return v.meanLook;
  if (state.field.fairyLock) return 'Fairy Lock';
  return null;
}

// ---------------------------------------------------------------------------
// Damage, accuracy, crits and speed
// ---------------------------------------------------------------------------

/**
 * Extra damage multipliers from conditions, for one hit.
 *
 * Screens halve damage of their category (Aurora Veil both) unless it is a
 * critical hit or the attacker has Infiltrator. Terrains boost their type
 * for a grounded attacker by 1.3x; Grassy halves Earthquake and Misty halves
 * Dragon against a grounded target. Mud Sport and Water Sport cut Electric
 * and Fire to a third. Charge doubles the next Electric move.
 */
function damageModifiers(state, attackerSide, attacker, defender, move, type, critical) {
  const out = [];
  const t = lower(type);
  const field = state.field;
  const defSide = state.sides[1 - attackerSide].conditions || {};

  if (!critical && abilityOf(attacker) !== 'infiltrator') {
    const physical = move.damageClass === 'physical';
    if (defSide.auroraVeil || (physical ? defSide.reflect : defSide.lightScreen)) out.push(0.5);
  }

  if (field.terrain && grounded(attacker, field)) {
    const boosted = TERRAINS[field.terrain].type;
    if (boosted && t === boosted) out.push(1.3);
  }
  if (field.terrain === 'grassy' && QUAKES.has(move.name) && grounded(defender, field)) out.push(0.5);
  if (field.terrain === 'misty' && t === 'dragon' && grounded(defender, field)) out.push(0.5);

  if (field.mudSport && t === 'electric') out.push(1 / 3);
  if (field.waterSport && t === 'fire') out.push(1 / 3);

  if (t === 'electric' && vol(attacker).charged) out.push(2);

  return out;
}

/** Extra crit stages: Focus Energy and Dragon Cheer +2. Laser Focus and Lucky Chant decide outright. */
function critStageBonus(attacker) {
  return vol(attacker).focusEnergy ? 2 : 0;
}

/** Is this hit forced to crit (Laser Focus) or forbidden from it (Lucky Chant)? */
function critOverride(state, attackerSide, attacker) {
  const foeSide = state.sides[1 - attackerSide].conditions || {};
  if (foeSide.luckyChant) return false;
  if (vol(attacker).laserFocus) return true;
  return null;
}

/**
 * Accuracy changes: Gravity makes everything 5/3 as accurate; Lock-On and
 * Mind Reader make the next move sure to hit; Foresight and Miracle Eye
 * ignore the target's evasion; Telekinesis makes the target easy to hit.
 *
 * @returns {{ multiplier: number, sure: boolean, ignoreEvasion: boolean }}
 */
function accuracyModifiers(state, attacker, defender) {
  const v = vol(attacker);
  const dv = vol(defender);
  return {
    multiplier: state.field.gravity ? 5 / 3 : 1,
    sure: Boolean(v.lockOn && v.lockOn.target === defender.id) || Boolean(dv.telekinesis),
    ignoreEvasion: Boolean(dv.foresight || dv.miracleEye),
  };
}

/** Speed after Tailwind. */
function speedMultiplier(state, sideIndex) {
  const conditions = state.sides[sideIndex].conditions || {};
  return conditions.tailwind ? 2 : 1;
}

/**
 * Psychic Terrain protects a grounded target from priority moves, and Quick
 * Guard, Wide Guard, Crafty Shield and Mat Block protect a side this turn.
 *
 * @returns {string|null} what blocked it
 */
function guardBlocks(state, attackerSide, defender, move, priority) {
  const side = state.sides[1 - attackerSide].conditions || {};
  const aimedAtFoe = !['user', 'user-and-allies', 'users-field', 'user-or-ally', 'entire-field'].includes(move.target);
  if (!aimedAtFoe) return null;

  if (priority > 0 && state.field.terrain === 'psychic' && grounded(defender, state.field)) return 'Psychic Terrain';
  if (side.quickGuard && priority > 0) return 'Quick Guard';
  if (side.wideGuard && SPREAD_TARGETS.has(move.target)) return 'Wide Guard';
  if (side.craftyShield && move.damageClass === 'status' && move.target !== 'opponents-field') return 'Crafty Shield';
  if (side.matBlock && move.damageClass !== 'status') return 'Mat Block';
  return null;
}

/** Break the target's screens before Brick Break lands. */
function breakScreens(state, attackerSide, move, events) {
  if (!SCREEN_BREAKERS.has(move.name)) return;
  const side = state.sides[1 - attackerSide];
  const c = side.conditions || {};
  if (c.reflect || c.lightScreen || c.auroraVeil) {
    delete c.reflect;
    delete c.lightScreen;
    delete c.auroraVeil;
    events.push({ kind: 'screens-broken', side: side.name });
  }
}

// ---------------------------------------------------------------------------
// Switching in: hazards, Healing Wish, Baton Pass
// ---------------------------------------------------------------------------

/** Hazards, Healing Wish and the like for a Pokemon arriving on this side. */
function onArrive(state, sideIndex, mon, events) {
  const side = state.sides[sideIndex];
  const c = side.conditions || (side.conditions = {});

  if (c.healingWish) {
    const lunar = c.healingWish === 'lunar';
    delete c.healingWish;
    if (mon.hp < mon.maxHp || mon.status || lunar) {
      mon.hp = mon.maxHp;
      mon.status = null;
      mon.statusTurns = 0;
      mon.toxicCounter = 0;
      if (lunar) for (const m of mon.moves) m.pp = m.maxPp;
      events.push({ kind: 'healing-wish', name: mon.name, lunar });
    }
  }

  if (itemOf(mon) === 'heavy-duty-boots') return;

  const isGrounded = grounded(mon, state.field);

  if (c.stealthRock) {
    const eff = typechart.effectiveness('rock', mon.types);
    const amount = Math.max(1, Math.floor((mon.maxHp * eff) / 8));
    effects.chip(mon, amount, events, 'Stealth Rock', 'hazard-damage');
  }

  if (c.spikes && isGrounded && !mon.fainted) {
    const amount = Math.max(1, Math.floor(mon.maxHp / [0, 8, 6, 4][c.spikes]));
    effects.chip(mon, amount, events, 'Spikes', 'hazard-damage');
  }

  if (c.toxicSpikes && isGrounded && !mon.fainted) {
    // A grounded Poison type soaks them up.
    if (hasType(mon, 'poison')) {
      delete c.toxicSpikes;
      events.push({ kind: 'hazard-cleared', name: mon.name, what: 'Toxic Spikes' });
    } else if (!mon.status && !hasType(mon, 'steel') && !c.safeguard && effects.statusAllowed(mon, 'poison')) {
      mon.status = 'poison';
      mon.toxicCounter = c.toxicSpikes >= 2 ? 1 : 0;
      events.push({ kind: 'status', name: mon.name, status: c.toxicSpikes >= 2 ? 'badly poison' : 'poison' });
    }
  }

  if (c.stickyWeb && isGrounded && !mon.fainted) {
    effects.requestStage(mon, 'speed', -1, events, 'Sticky Web', true);
    events.push({ kind: 'sticky-web', name: mon.name });
  }
}

/** What Baton Pass hands over: stat stages and the volatiles it carries. */
const PASSED = ['confusion', 'focusEnergy', 'cursed', 'ingrain', 'aquaRing', 'magnetRise', 'perish', 'meanLook', 'embargo', 'healBlock', 'gastroAcid', 'telekinesis', 'lockOn', 'powerTrick'];

function batonPass(from, to) {
  to.stages = { ...from.stages };
  const fv = vol(from);
  const tv = vol(to);
  for (const key of PASSED) if (fv[key] !== undefined) tv[key] = fv[key];
  to.substitute = from.substitute || 0;
  to.seededBy = from.seededBy || null;
}

/** Clear a Pokemon's volatiles as it leaves the field. Toxic's counter resets. */
function clearVolatiles(mon) {
  mon.volatiles = {};
  mon.lastMove = null;
  mon.moveStreak = 0;
  if (mon.toxicCounter) mon.toxicCounter = 1;
  mon.abilitySuppressed = false;
}

// ---------------------------------------------------------------------------
// End of turn
// ---------------------------------------------------------------------------

/**
 * Everything conditions do at the end of a turn, in the games' order:
 * Wish, Aqua Ring and Ingrain, Grassy Terrain, Nightmare and Curse, Yawn,
 * Perish Song, then every timer counts down.
 *
 * @param {object} engine  { applyStatus, chip } from Utils/battle.js
 */
function endOfTurn(state, events, rng, engine) {
  const active = state.sides.map((side) => side.team[side.active]);

  // Wish heals whoever is out a turn later.
  state.sides.forEach((side, i) => {
    const c = side.conditions || {};
    if (!c.wish) return;
    c.wish.turns -= 1;
    if (c.wish.turns > 0) return;
    const mon = active[i];
    if (!mon.fainted && mon.hp < mon.maxHp && !vol(mon).healBlock) {
      const before = mon.hp;
      mon.hp = Math.min(mon.maxHp, mon.hp + c.wish.amount);
      events.push({ kind: 'wish', name: mon.name, from: c.wish.from, amount: mon.hp - before, hp: mon.hp });
    }
    delete c.wish;
  });

  for (const mon of active) {
    if (mon.fainted) continue;
    const v = vol(mon);
    const heals = [];
    if (v.aquaRing) heals.push('Aqua Ring');
    if (v.ingrain) heals.push('Ingrain');
    if (state.field.terrain === 'grassy' && grounded(mon, state.field)) heals.push('Grassy Terrain');

    for (const source of heals) {
      if (mon.hp >= mon.maxHp || v.healBlock) break;
      const before = mon.hp;
      const amount = Math.max(1, Math.floor(mon.maxHp / 16) * (source === 'Aqua Ring' && itemOf(mon) === 'big-root' ? 1.3 : 1));
      mon.hp = Math.min(mon.maxHp, mon.hp + Math.floor(amount));
      events.push({ kind: 'condition-heal', name: mon.name, source, amount: mon.hp - before, hp: mon.hp });
    }
  }

  for (const mon of active) {
    if (mon.fainted) continue;
    const v = vol(mon);
    if (v.nightmare && mon.status === 'sleep') {
      engine.chip(mon, Math.max(1, Math.floor(mon.maxHp / 4)), events, 'Nightmare', 'condition-damage');
    } else if (v.nightmare) {
      delete v.nightmare;
    }
    if (v.cursed && !mon.fainted) {
      engine.chip(mon, Math.max(1, Math.floor(mon.maxHp / 4)), events, 'Curse', 'condition-damage');
    }
    if (v.octolock && !mon.fainted) {
      effects.requestStage(mon, 'defense', -1, events, 'Octolock', true);
      effects.requestStage(mon, 'specialDefense', -1, events, 'Octolock', true);
    }
  }

  // Yawn: asleep at the end of the next turn.
  state.sides.forEach((side, i) => {
    const mon = active[i];
    const v = vol(mon);
    if (mon.fainted || !v.yawn) return;
    v.yawn -= 1;
    if (v.yawn > 0) return;
    delete v.yawn;
    if (!mon.status && !sideBlocksStatus(state, i, mon, 'sleep')) engine.applyStatus(mon, 'sleep', events, rng);
  });

  // Perish Song counts down, and takes them at zero.
  for (const mon of active) {
    const v = vol(mon);
    if (mon.fainted || v.perish === undefined) continue;
    v.perish -= 1;
    events.push({ kind: 'perish', name: mon.name, count: v.perish });
    if (v.perish <= 0) {
      mon.hp = 0;
      mon.fainted = true;
      mon.faintedBy = null;
      events.push({ kind: 'faint', name: mon.name });
    }
  }

  // Timers.
  for (const mon of active) {
    const v = vol(mon);
    for (const key of ['taunt', 'magnetRise', 'telekinesis', 'embargo', 'healBlock']) {
      if (v[key]) {
        v[key] -= 1;
        if (v[key] <= 0) {
          delete v[key];
          events.push({ kind: 'condition-end', name: mon.name, what: key });
        }
      }
    }
    for (const key of ['encore', 'disable']) {
      if (v[key]) {
        v[key].turns -= 1;
        if (v[key].turns <= 0) {
          delete v[key];
          events.push({ kind: 'condition-end', name: mon.name, what: key });
        }
      }
    }
    // One-turn effects.
    delete v.endure;
    delete v.magicCoat;
    delete v.snatch;
    delete v.electrify;
    delete v.powder;
    if (v.laserFocus) {
      v.laserFocus -= 1;
      if (v.laserFocus <= 0) delete v.laserFocus;
    }
    if (v.lockOn) {
      v.lockOn.turns -= 1;
      if (v.lockOn.turns <= 0) delete v.lockOn;
    }
  }

  state.sides.forEach((side) => {
    const c = side.conditions || {};
    delete c.quickGuard;
    delete c.wideGuard;
    delete c.craftyShield;
    delete c.matBlock;
    for (const key of ['reflect', 'lightScreen', 'auroraVeil', 'safeguard', 'mist', 'tailwind', 'luckyChant']) {
      if (c[key]) {
        c[key] -= 1;
        if (c[key] <= 0) {
          delete c[key];
          events.push({ kind: 'side-end', side: side.name, what: key });
        }
      }
    }
  });

  const f = state.field;
  f.ionDeluge = false;
  if (f.fairyLock) f.fairyLock -= 1;
  for (const key of ['trickRoom', 'gravity', 'magicRoom', 'wonderRoom', 'mudSport', 'waterSport']) {
    if (f[key]) {
      f[key] -= 1;
      if (f[key] <= 0) events.push({ kind: 'field-end', what: key });
    }
  }
  if (f.terrain) {
    f.terrainTurns -= 1;
    if (f.terrainTurns <= 0) {
      events.push({ kind: 'terrain-end', text: TERRAINS[f.terrain].ended });
      f.terrain = null;
    }
  }

  refreshSuppression(state);
}

module.exports = {
  DURATION,
  SCREEN_CLAY,
  TERRAINS,
  POWDER,
  SOUND,
  SPREAD_TARGETS,
  GRAVITY_BANNED,
  freshSide,
  freshField,
  grounded,
  refreshSuppression,
  effectiveness,
  immuneTo,
  blockedBySubstitute,
  sideBlocksStatus,
  confuse,
  confusionCheck,
  isHealingMove,
  restriction,
  encoreSlot,
  switchBlocked,
  damageModifiers,
  critStageBonus,
  critOverride,
  accuracyModifiers,
  speedMultiplier,
  guardBlocks,
  breakScreens,
  onArrive,
  batonPass,
  clearVolatiles,
  endOfTurn,
  vol,
  abilityOf,
  itemOf,
};
