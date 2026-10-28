'use strict';

/**
 * Status moves with an effect of their own, as in the current games.
 *
 * Each entry has:
 *
 *   fails(ctx)  why it would fail right now, or null. The AI reads this too,
 *               so it never picks a move that would do nothing.
 *   run(ctx)    what it does.
 *
 * `ctx` is { state, sideIndex, attacker, defender, move, rng, events, engine,
 * turn }. `engine` gives access to the battle engine (stages, statuses,
 * switching, using another move) without a circular require.
 *
 * Moves with only stat changes, a major status or confusion (Swords Dance,
 * Thunder Wave, Confuse Ray, Swagger) need no entry: the engine applies those
 * from the move data. Protect, weather, Substitute and Leech Seed are in
 * Utils/field.js.
 *
 * Moves that only make sense with a partner (Helping Hand, Follow Me, Ally
 * Switch...) fail in a single battle, exactly as they do in the games.
 */

const content = require('./content');
const typechart = require('./typechart');
const effects = require('./battleeffects');
const fieldRules = require('./field');
const cond = require('./conditions');

const { vol, abilityOf, itemOf } = cond;

const lower = (text) => String(text || '').toLowerCase();
const hasType = (mon, type) => (mon.types || []).some((t) => lower(t) === type);
const sideOf = (ctx, mine = true) => ctx.state.sides[mine ? ctx.sideIndex : 1 - ctx.sideIndex];
const conditionsOf = (side) => side.conditions || (side.conditions = {});
const benchOf = (side) => side.team.filter((mon, i) => i !== side.active && !mon.fainted);
const FAIL = 'But it failed!';

/** Every type, for Conversion 2. */
const ALL_TYPES = [
  'normal', 'fire', 'water', 'electric', 'grass', 'ice', 'fighting', 'poison', 'ground',
  'flying', 'psychic', 'bug', 'rock', 'ghost', 'dragon', 'dark', 'steel', 'fairy',
];

/** The stats a swap or split works on. */
const STAGES = ['attack', 'defense', 'specialAttack', 'specialDefense', 'speed', 'accuracy', 'evasion'];

/** Moves Encore, Mimic, Sketch, Mirror Move and the move-callers won't pick up. */
const UNCOPYABLE = new Set([
  'struggle', 'transform', 'mimic', 'sketch', 'metronome', 'sleep-talk', 'copycat', 'mirror-move',
  'assist', 'me-first', 'encore', 'nature-power', 'bide', 'focus-punch', 'protect', 'detect',
  'endure', 'chatter', 'counter', 'mirror-coat', 'destiny-bond', 'thief', 'covet', 'snatch',
  'baneful-bunker', 'kings-shield', 'spiky-shield', 'instruct', 'shell-trap', 'beak-blast',
]);

/** Which move Nature Power becomes on each terrain. */
const NATURE_POWER = { electric: 'thunderbolt', grassy: 'energy-ball', misty: 'moonblast', psychic: 'psychic' };

/** Which type Camouflage gives on each terrain. */
const CAMOUFLAGE = { electric: ['electric'], grassy: ['grass'], misty: ['fairy'], psychic: ['psychic'] };

/** Abilities that can't be copied, swapped or overwritten. */
const FIXED_ABILITIES = new Set([
  'multitype', 'stance-change', 'schooling', 'comatose', 'shields-down', 'disguise', 'rks-system',
  'battle-bond', 'power-construct', 'ice-face', 'gulp-missile', 'zero-to-hero', 'commander',
  'tera-shift', 'as-one-glastrier', 'as-one-spectrier', 'wonder-guard', 'trace', 'imposter',
]);

const fail = (ctx, text = FAIL) => ctx.events.push({ kind: 'failed', name: ctx.attacker.name, text });
const say = (ctx, kind, extra = {}) => ctx.events.push({ kind, name: ctx.attacker.name, ...extra });

// ---------------------------------------------------------------------------
// Builders for the common shapes
// ---------------------------------------------------------------------------

/** A side condition on the user's side, for a few turns. */
function ownSide(key, label, turns, { requires = null } = {}) {
  return {
    fails: (ctx) => {
      if (conditionsOf(sideOf(ctx))[key]) return FAIL;
      if (requires && !requires(ctx)) return FAIL;
      return null;
    },
    run: (ctx) => {
      const clay = ['reflect', 'lightScreen', 'auroraVeil'].includes(key) && itemOf(ctx.attacker) === 'light-clay';
      conditionsOf(sideOf(ctx))[key] = clay ? cond.SCREEN_CLAY : turns;
      ctx.events.push({ kind: 'side-start', side: sideOf(ctx).name, what: key, label });
    },
  };
}

/** A hazard on the foe's side, up to `max` layers. */
function hazard(key, label, max) {
  return {
    fails: (ctx) => ((conditionsOf(sideOf(ctx, false))[key] || 0) >= max ? FAIL : null),
    run: (ctx) => {
      const c = conditionsOf(sideOf(ctx, false));
      c[key] = max === 1 ? true : (c[key] || 0) + 1;
      ctx.events.push({ kind: 'hazard-set', side: sideOf(ctx, false).name, what: label });
    },
  };
}

/** A room or field-wide condition. `toggle` ends it if it's already up (Trick Room). */
function fieldCondition(key, label, { toggle = false } = {}) {
  return {
    fails: (ctx) => (!toggle && ctx.state.field[key] ? FAIL : null),
    run: (ctx) => {
      const f = ctx.state.field;
      if (toggle && f[key]) {
        f[key] = 0;
        ctx.events.push({ kind: 'field-end', what: key });
        return;
      }
      f[key] = cond.DURATION[key] || 5;
      if (key === 'gravity') {
        // Gravity brings everything down.
        for (const side of ctx.state.sides) {
          const mon = side.team[side.active];
          delete vol(mon).magnetRise;
          delete vol(mon).telekinesis;
        }
      }
      cond.refreshSuppression(ctx.state);
      ctx.events.push({ kind: 'field-start', what: key, label });
    },
  };
}

function terrain(type) {
  return {
    fails: (ctx) => (ctx.state.field.terrain === type ? FAIL : null),
    run: (ctx) => {
      ctx.state.field.terrain = type;
      ctx.state.field.terrainTurns = itemOf(ctx.attacker) === 'terrain-extender' ? 8 : cond.DURATION.terrain;
      ctx.events.push({ kind: 'terrain-start', text: cond.TERRAINS[type].started });
    },
  };
}

/** A volatile on the target, failing if it's already there. */
function onTarget(key, label, value, { blockedBy = [], extraFail = null } = {}) {
  return {
    fails: (ctx) => {
      if (vol(ctx.defender)[key]) return FAIL;
      if (blockedBy.includes(abilityOf(ctx.defender))) return `It doesn't affect ${ctx.defender.name}...`;
      return extraFail ? extraFail(ctx) : null;
    },
    run: (ctx) => {
      vol(ctx.defender)[key] = typeof value === 'function' ? value(ctx) : value;
      ctx.events.push({ kind: 'volatile-start', name: ctx.defender.name, what: key, label });
      cond.refreshSuppression(ctx.state);
    },
  };
}

/** A volatile on the user. */
function onSelf(key, label, value = true, { extraFail = null } = {}) {
  return {
    fails: (ctx) => (vol(ctx.attacker)[key] ? FAIL : extraFail ? extraFail(ctx) : null),
    run: (ctx) => {
      vol(ctx.attacker)[key] = typeof value === 'function' ? value(ctx) : value;
      ctx.events.push({ kind: 'volatile-start', name: ctx.attacker.name, what: key, label });
    },
  };
}

/** Fails in a single battle: there is no partner to affect. */
const needsPartner = { fails: () => FAIL, run: (ctx) => fail(ctx) };

/** Nothing happens, by design. */
const nothing = (text = 'But nothing happened!') => ({ fails: () => null, run: (ctx) => fail(ctx, text) });

/** Use another move by name, from inside this one. */
function call(ctx, name, extra = {}) {
  const data = content.move(name);
  if (!data) return fail(ctx);
  ctx.engine.performMove(ctx.attacker, ctx.defender, data, { ...extra, called: true });
}

const lastMoveOf = (mon) => (mon.lastMove ? mon.moves.find((m) => m.name === mon.lastMove) : null);

const swapStages = (a, b, keys) => {
  for (const key of keys) {
    const x = a.stages[key] || 0;
    a.stages[key] = b.stages[key] || 0;
    b.stages[key] = x;
  }
};

// ---------------------------------------------------------------------------
// The moves
// ---------------------------------------------------------------------------

const MOVES = {
  // ---- screens and side conditions ----
  reflect: ownSide('reflect', 'Reflect', 5),
  'light-screen': ownSide('lightScreen', 'Light Screen', 5),
  'aurora-veil': ownSide('auroraVeil', 'Aurora Veil', 5, {
    requires: (ctx) => ['snow', 'hail'].includes(ctx.state.field.weather),
  }),
  safeguard: ownSide('safeguard', 'Safeguard', 5),
  mist: ownSide('mist', 'Mist', 5),
  tailwind: ownSide('tailwind', 'Tailwind', 4),
  'lucky-chant': ownSide('luckyChant', 'Lucky Chant', 5),

  // This turn only.
  'quick-guard': { fails: () => null, run: (ctx) => { conditionsOf(sideOf(ctx)).quickGuard = true; say(ctx, 'guard-up', { label: 'Quick Guard' }); } },
  'wide-guard': { fails: () => null, run: (ctx) => { conditionsOf(sideOf(ctx)).wideGuard = true; say(ctx, 'guard-up', { label: 'Wide Guard' }); } },
  'crafty-shield': { fails: () => null, run: (ctx) => { conditionsOf(sideOf(ctx)).craftyShield = true; say(ctx, 'guard-up', { label: 'Crafty Shield' }); } },
  'mat-block': {
    fails: (ctx) => (ctx.attacker.turnsActive ? FAIL : null),
    run: (ctx) => { conditionsOf(sideOf(ctx)).matBlock = true; say(ctx, 'guard-up', { label: 'Mat Block' }); },
  },

  // ---- entry hazards ----
  spikes: hazard('spikes', 'Spikes', 3),
  'toxic-spikes': hazard('toxicSpikes', 'Toxic Spikes', 2),
  'stealth-rock': hazard('stealthRock', 'pointed stones', 1),
  'sticky-web': hazard('stickyWeb', 'a sticky web', 1),

  'court-change': {
    fails: () => null,
    run: (ctx) => {
      const [a, b] = ctx.state.sides;
      const swap = a.conditions || {};
      a.conditions = b.conditions || {};
      b.conditions = swap;
      say(ctx, 'court-change');
    },
  },

  // ---- the field ----
  'trick-room': fieldCondition('trickRoom', 'Trick Room', { toggle: true }),
  'magic-room': fieldCondition('magicRoom', 'Magic Room', { toggle: true }),
  'wonder-room': fieldCondition('wonderRoom', 'Wonder Room', { toggle: true }),
  gravity: fieldCondition('gravity', 'Gravity'),
  'mud-sport': fieldCondition('mudSport', 'Mud Sport'),
  'water-sport': fieldCondition('waterSport', 'Water Sport'),
  'electric-terrain': terrain('electric'),
  'grassy-terrain': terrain('grassy'),
  'misty-terrain': terrain('misty'),
  'psychic-terrain': terrain('psychic'),
  'fairy-lock': {
    fails: (ctx) => (ctx.state.field.fairyLock ? FAIL : null),
    run: (ctx) => { ctx.state.field.fairyLock = 2; say(ctx, 'field-start', { what: 'fairyLock', label: 'Fairy Lock' }); },
  },
  'ion-deluge': { fails: () => null, run: (ctx) => { ctx.state.field.ionDeluge = true; say(ctx, 'field-start', { what: 'ionDeluge', label: 'Ion Deluge' }); } },

  // ---- healing over time, and wishes ----
  wish: {
    fails: (ctx) => (conditionsOf(sideOf(ctx)).wish ? FAIL : null),
    run: (ctx) => {
      conditionsOf(sideOf(ctx)).wish = { turns: 2, amount: Math.max(1, Math.floor(ctx.attacker.maxHp / 2)), from: ctx.attacker.name };
      say(ctx, 'wish-made');
    },
  },
  'healing-wish': {
    fails: (ctx) => (benchOf(sideOf(ctx)).length ? null : FAIL),
    run: (ctx) => { conditionsOf(sideOf(ctx)).healingWish = true; ctx.attacker.selfDestructing = true; },
  },
  'lunar-dance': {
    fails: (ctx) => (benchOf(sideOf(ctx)).length ? null : FAIL),
    run: (ctx) => { conditionsOf(sideOf(ctx)).healingWish = 'lunar'; ctx.attacker.selfDestructing = true; },
  },
  'aqua-ring': onSelf('aquaRing', 'Aqua Ring'),
  ingrain: onSelf('ingrain', 'Ingrain'),
  'revival-blessing': {
    fails: (ctx) => (sideOf(ctx).team.some((m) => m.fainted) ? null : FAIL),
    run: (ctx) => {
      const mon = sideOf(ctx).team.find((m) => m.fainted);
      mon.fainted = false;
      mon.hp = Math.max(1, Math.floor(mon.maxHp / 2));
      ctx.events.push({ kind: 'revived', name: mon.name, hp: mon.hp });
    },
  },
  'lunar-blessing': {
    fails: (ctx) => (ctx.attacker.hp >= ctx.attacker.maxHp && !ctx.attacker.status ? FAIL : null),
    run: (ctx) => {
      const mon = ctx.attacker;
      const before = mon.hp;
      mon.hp = Math.min(mon.maxHp, mon.hp + Math.floor(mon.maxHp / 4));
      if (mon.hp > before) ctx.events.push({ kind: 'heal', name: mon.name, amount: mon.hp - before, hp: mon.hp });
      if (mon.status) { ctx.events.push({ kind: 'cured', name: mon.name, status: mon.status }); mon.status = null; }
    },
  },

  // ---- statuses on the team ----
  refresh: {
    fails: (ctx) => (['burn', 'poison', 'paralysis'].includes(ctx.attacker.status) ? null : FAIL),
    run: (ctx) => { ctx.events.push({ kind: 'cured', name: ctx.attacker.name, status: ctx.attacker.status }); ctx.attacker.status = null; ctx.attacker.toxicCounter = 0; },
  },
  'heal-bell': teamCure(),
  aromatherapy: teamCure(),
  'take-heart': {
    fails: () => null,
    run: (ctx) => {
      if (ctx.attacker.status) {
        ctx.events.push({ kind: 'cured', name: ctx.attacker.name, status: ctx.attacker.status });
        ctx.attacker.status = null;
      }
      ctx.engine.applyStage(ctx.attacker, 'specialAttack', 1, ctx.events);
      ctx.engine.applyStage(ctx.attacker, 'specialDefense', 1, ctx.events);
    },
  },
  'psycho-shift': {
    fails: (ctx) => (!ctx.attacker.status || ctx.defender.status ? FAIL : null),
    run: (ctx) => {
      const status = ctx.attacker.status;
      if (ctx.engine.applyStatus(ctx.defender, status, ctx.events, ctx.rng, ctx.sideIndex)) {
        ctx.attacker.status = null;
        ctx.events.push({ kind: 'cured', name: ctx.attacker.name, status });
      } else fail(ctx);
    },
  },

  // ---- volatile conditions on the target ----
  taunt: onTarget('taunt', 'Taunt', (ctx) => (ctx.turn && ctx.turn.foeMoved ? 3 : 4), { blockedBy: ['oblivious', 'aroma-veil'] }),
  torment: onTarget('torment', 'Torment', true, { blockedBy: ['aroma-veil'] }),
  embargo: onTarget('embargo', 'Embargo', cond.DURATION.embargo),
  'heal-block': onTarget('healBlock', 'Heal Block', cond.DURATION.healBlock, { blockedBy: ['aroma-veil'] }),
  'gastro-acid': onTarget('gastroAcid', 'Gastro Acid', true, {
    extraFail: (ctx) => (FIXED_ABILITIES.has(ctx.defender.ability) ? FAIL : null),
  }),
  foresight: onTarget('foresight', 'Foresight', true),
  'odor-sleuth': onTarget('foresight', 'Odor Sleuth', true),
  'miracle-eye': onTarget('miracleEye', 'Miracle Eye', true),
  telekinesis: onTarget('telekinesis', 'Telekinesis', cond.DURATION.telekinesis, {
    extraFail: (ctx) => (ctx.state.field.gravity || vol(ctx.defender).ingrain ? FAIL : null),
  }),
  nightmare: onTarget('nightmare', 'Nightmare', true, {
    extraFail: (ctx) => (ctx.defender.status === 'sleep' ? null : FAIL),
  }),
  yawn: onTarget('yawn', 'Yawn', 2, {
    extraFail: (ctx) => {
      if (ctx.defender.status) return FAIL;
      if (!effects.statusAllowed(ctx.defender, 'sleep')) return FAIL;
      return cond.sideBlocksStatus(ctx.state, 1 - ctx.sideIndex, ctx.defender, 'sleep', ctx.attacker) ? FAIL : null;
    },
  }),
  'mean-look': trap('Mean Look'),
  block: trap('Block'),
  'spider-web': trap('Spider Web'),
  octolock: {
    fails: (ctx) => (vol(ctx.defender).meanLook || hasType(ctx.defender, 'ghost') ? FAIL : null),
    run: (ctx) => {
      vol(ctx.defender).meanLook = { by: ctx.attacker.id, source: 'Octolock' };
      vol(ctx.defender).octolock = ctx.attacker.id;
      ctx.events.push({ kind: 'volatile-start', name: ctx.defender.name, what: 'octolock', label: 'Octolock' });
    },
  },
  attract: {
    fails: (ctx) => {
      const [a, b] = [ctx.attacker.gender, ctx.defender.gender];
      if (vol(ctx.defender).attract) return FAIL;
      if (!['male', 'female'].includes(a) || !['male', 'female'].includes(b) || a === b) return FAIL;
      if (['oblivious', 'aroma-veil'].includes(abilityOf(ctx.defender))) return `It doesn't affect ${ctx.defender.name}...`;
      return null;
    },
    run: (ctx) => {
      // Shared with Cute Charm, so Destiny Knot works for both.
      if (!effects.infatuate(ctx.defender, ctx.attacker, ctx.events)) fail(ctx);
    },
  },
  encore: {
    fails: (ctx) => {
      const last = lastMoveOf(ctx.defender);
      if (vol(ctx.defender).encore || !last || last.pp <= 0 || UNCOPYABLE.has(last.name)) return FAIL;
      return abilityOf(ctx.defender) === 'aroma-veil' ? `It doesn't affect ${ctx.defender.name}...` : null;
    },
    run: (ctx) => {
      vol(ctx.defender).encore = { move: ctx.defender.lastMove, turns: cond.DURATION.encore };
      ctx.events.push({ kind: 'volatile-start', name: ctx.defender.name, what: 'encore', label: 'Encore' });
    },
  },
  disable: {
    fails: (ctx) => {
      const last = lastMoveOf(ctx.defender);
      if (vol(ctx.defender).disable || !last || last.pp <= 0 || last.name === 'struggle') return FAIL;
      return abilityOf(ctx.defender) === 'aroma-veil' ? `It doesn't affect ${ctx.defender.name}...` : null;
    },
    run: (ctx) => {
      vol(ctx.defender).disable = { move: ctx.defender.lastMove, turns: cond.DURATION.disable };
      ctx.events.push({ kind: 'disabled', name: ctx.defender.name, move: lastMoveOf(ctx.defender).data.displayName });
    },
  },
  spite: {
    fails: (ctx) => {
      const last = lastMoveOf(ctx.defender);
      return !last || last.pp <= 0 ? FAIL : null;
    },
    run: (ctx) => {
      const last = lastMoveOf(ctx.defender);
      const cut = Math.min(4, last.pp);
      last.pp -= cut;
      ctx.events.push({ kind: 'spite', name: ctx.defender.name, move: last.data.displayName, amount: cut });
    },
  },
  powder: onTarget('powder', 'Powder', true),
  electrify: onTarget('electrify', 'Electrify', true, {
    extraFail: (ctx) => (ctx.turn && ctx.turn.foeMoved ? FAIL : null),
  }),
  'perish-song': {
    fails: (ctx) => (ctx.state.sides.every((s) => vol(s.team[s.active]).perish !== undefined) ? FAIL : null),
    run: (ctx) => {
      for (const side of ctx.state.sides) {
        const mon = side.team[side.active];
        if (mon.fainted || vol(mon).perish !== undefined || abilityOf(mon) === 'soundproof') continue;
        vol(mon).perish = 4;
      }
      say(ctx, 'perish-song');
    },
  },

  // ---- volatile conditions on the user ----
  'focus-energy': onSelf('focusEnergy', 'Focus Energy'),
  'laser-focus': onSelf('laserFocus', 'Laser Focus', 2),
  'magnet-rise': onSelf('magnetRise', 'Magnet Rise', cond.DURATION.magnetRise, {
    extraFail: (ctx) => (ctx.state.field.gravity || vol(ctx.attacker).ingrain ? FAIL : null),
  }),
  imprison: onSelf('imprison', 'Imprison'),
  'magic-coat': onSelf('magicCoat', 'Magic Coat'),
  snatch: onSelf('snatch', 'Snatch'),
  charge: {
    fails: () => null,
    run: (ctx) => {
      vol(ctx.attacker).charged = true;
      say(ctx, 'volatile-start', { what: 'charge', label: 'Charge' });
      ctx.engine.applyStage(ctx.attacker, 'specialDefense', 1, ctx.events);
    },
  },
  'destiny-bond': {
    fails: (ctx) => (ctx.attacker.previousMove === 'destiny-bond' ? FAIL : null),
    run: (ctx) => { vol(ctx.attacker).destinyBond = true; say(ctx, 'volatile-start', { what: 'destinyBond', label: 'Destiny Bond' }); },
  },
  grudge: onSelf('grudge', 'Grudge'),
  endure: {
    fails: () => null,
    run: (ctx) => {
      const streak = ctx.attacker.protectStreak || 0;
      if (fieldRules.protectSucceeds(streak, ctx.rng())) {
        vol(ctx.attacker).endure = true;
        ctx.attacker.protectStreak = streak + 1;
        say(ctx, 'volatile-start', { what: 'endure', label: 'Endure' });
      } else {
        ctx.attacker.protectStreak = 0;
        fail(ctx);
      }
    },
  },
  'lock-on': lockOn(),
  'mind-reader': lockOn(),

  // ---- stats ----
  haze: {
    fails: () => null,
    run: (ctx) => {
      for (const side of ctx.state.sides) {
        const mon = side.team[side.active];
        for (const key of STAGES) mon.stages[key] = 0;
      }
      say(ctx, 'haze');
    },
  },
  'psych-up': {
    fails: () => null,
    run: (ctx) => {
      ctx.attacker.stages = { ...ctx.defender.stages };
      if (vol(ctx.defender).focusEnergy) vol(ctx.attacker).focusEnergy = true;
      say(ctx, 'psych-up', { target: ctx.defender.name });
    },
  },
  'heart-swap': swapper(STAGES, 'stat changes'),
  'power-swap': swapper(['attack', 'specialAttack'], 'Attack and Sp. Atk changes'),
  'guard-swap': swapper(['defense', 'specialDefense'], 'Defense and Sp. Def changes'),
  'speed-swap': {
    fails: () => null,
    run: (ctx) => {
      const s = ctx.attacker.stats.speed;
      ctx.attacker.stats = { ...ctx.attacker.stats, speed: ctx.defender.stats.speed };
      ctx.defender.stats = { ...ctx.defender.stats, speed: s };
      say(ctx, 'swapped', { target: ctx.defender.name, what: 'Speed' });
    },
  },
  'power-split': splitter(['attack', 'specialAttack'], 'power'),
  'guard-split': splitter(['defense', 'specialDefense'], 'guard'),
  'power-trick': {
    fails: () => null,
    run: (ctx) => {
      const s = ctx.attacker.stats;
      ctx.attacker.stats = { ...s, attack: s.defense, defense: s.attack };
      vol(ctx.attacker).powerTrick = !vol(ctx.attacker).powerTrick;
      say(ctx, 'power-trick');
    },
  },
  'power-shift': {
    fails: () => null,
    run: (ctx) => {
      const s = ctx.attacker.stats;
      ctx.attacker.stats = { ...s, attack: s.defense, defense: s.attack, specialAttack: s.specialDefense, specialDefense: s.specialAttack };
      say(ctx, 'power-trick');
    },
  },
  'topsy-turvy': {
    fails: (ctx) => (STAGES.some((k) => ctx.defender.stages[k]) ? null : FAIL),
    run: (ctx) => {
      for (const key of STAGES) ctx.defender.stages[key] = -(ctx.defender.stages[key] || 0);
      ctx.events.push({ kind: 'topsy-turvy', name: ctx.defender.name });
    },
  },
  acupressure: {
    fails: (ctx) => (STAGES.some((k) => (ctx.attacker.stages[k] || 0) < 6) ? null : FAIL),
    run: (ctx) => {
      const open = STAGES.filter((k) => (ctx.attacker.stages[k] || 0) < 6);
      ctx.engine.applyStage(ctx.attacker, open[Math.floor(ctx.rng() * open.length)], 2, ctx.events);
    },
  },
  'belly-drum': {
    fails: (ctx) => (ctx.attacker.hp <= Math.floor(ctx.attacker.maxHp / 2) || ctx.attacker.stages.attack >= 6 ? FAIL : null),
    run: (ctx) => {
      const cost = Math.floor(ctx.attacker.maxHp / 2);
      ctx.attacker.hp -= cost;
      ctx.attacker.stages.attack = 6;
      say(ctx, 'belly-drum', { cost, hp: ctx.attacker.hp });
    },
  },
  curse: {
    fails: (ctx) => (hasType(ctx.attacker, 'ghost') && vol(ctx.defender).cursed ? FAIL : null),
    run: (ctx) => {
      if (!hasType(ctx.attacker, 'ghost')) {
        ctx.engine.applyStage(ctx.attacker, 'speed', -1, ctx.events);
        ctx.engine.applyStage(ctx.attacker, 'attack', 1, ctx.events);
        ctx.engine.applyStage(ctx.attacker, 'defense', 1, ctx.events);
        return;
      }
      const cost = Math.floor(ctx.attacker.maxHp / 2);
      vol(ctx.defender).cursed = true;
      ctx.events.push({ kind: 'cursed', name: ctx.defender.name, by: ctx.attacker.name, cost });
      ctx.attacker.hp = Math.max(0, ctx.attacker.hp - cost);
      if (ctx.attacker.hp === 0) {
        ctx.attacker.fainted = true;
        ctx.events.push({ kind: 'faint', name: ctx.attacker.name });
      }
    },
  },
  'pain-split': {
    fails: () => null,
    run: (ctx) => {
      const average = Math.floor((ctx.attacker.hp + ctx.defender.hp) / 2);
      ctx.attacker.hp = Math.min(ctx.attacker.maxHp, average);
      ctx.defender.hp = Math.min(ctx.defender.maxHp, average);
      say(ctx, 'pain-split', { target: ctx.defender.name, hp: ctx.attacker.hp, targetHp: ctx.defender.hp });
    },
  },
  shelter: { fails: () => null, run: (ctx) => ctx.engine.applyStage(ctx.attacker, 'defense', 2, ctx.events) },
  'victory-dance': {
    fails: () => null,
    run: (ctx) => {
      for (const stat of ['attack', 'defense', 'speed']) ctx.engine.applyStage(ctx.attacker, stat, 1, ctx.events);
    },
  },

  // ---- types and abilities ----
  soak: retype((ctx) => ['water'], 'target'),
  'forests-curse': retype((ctx) => [...new Set([...ctx.defender.types.map(lower), 'grass'])], 'target'),
  'trick-or-treat': retype((ctx) => [...new Set([...ctx.defender.types.map(lower), 'ghost'])], 'target'),
  'reflect-type': retype((ctx) => ctx.defender.types.map(lower), 'self'),
  conversion: retype((ctx) => [lower(ctx.attacker.moves[0] && ctx.attacker.moves[0].data.type)], 'self'),
  camouflage: retype((ctx) => CAMOUFLAGE[ctx.state.field.terrain] || ['normal'], 'self'),
  'conversion-2': {
    fails: (ctx) => (lastMoveOf(ctx.defender) ? null : FAIL),
    run: (ctx) => {
      const attacking = lastMoveOf(ctx.defender).data.type;
      const resists = ALL_TYPES.filter((t) => typechart.effectiveness(attacking, [t]) < 1);
      if (!resists.length) return fail(ctx);
      ctx.attacker.types = [resists[Math.floor(ctx.rng() * resists.length)]];
      say(ctx, 'retyped', { types: ctx.attacker.types });
    },
  },
  'worry-seed': reability((ctx) => 'insomnia', 'target', (ctx) => {
    if (ctx.defender.status === 'sleep') {
      ctx.defender.status = null;
      ctx.events.push({ kind: 'cured', name: ctx.defender.name, status: 'sleep' });
    }
  }),
  'simple-beam': reability(() => 'simple', 'target'),
  entrainment: reability((ctx) => ctx.attacker.ability, 'target'),
  'role-play': reability((ctx) => ctx.defender.ability, 'self'),
  doodle: reability((ctx) => ctx.defender.ability, 'self'),
  'skill-swap': {
    fails: (ctx) => (FIXED_ABILITIES.has(ctx.attacker.ability) || FIXED_ABILITIES.has(ctx.defender.ability) ? FAIL : null),
    run: (ctx) => {
      const mine = ctx.attacker.ability;
      effects.setAbility(ctx.attacker, ctx.defender.ability);
      effects.setAbility(ctx.defender, mine);
      say(ctx, 'skill-swap', { target: ctx.defender.name });
    },
  },
  transform: {
    fails: (ctx) => (ctx.attacker.transformed || ctx.defender.transformed || ctx.defender.substitute ? FAIL : null),
    run: (ctx) => {
      const a = ctx.attacker;
      const d = ctx.defender;
      a.transformed = true;
      a.types = [...d.types];
      a.stats = { ...d.stats, hp: a.stats.hp };
      a.stages = { ...d.stages };
      a.weight = d.weight;
      effects.setAbility(a, d.ability);
      a.moves = d.moves.map((m) => ({ ...m, pp: Math.min(5, m.maxPp), maxPp: Math.min(5, m.maxPp) }));
      say(ctx, 'transformed', { target: d.name });
    },
  },

  // ---- items ----
  trick: itemSwap(),
  switcheroo: itemSwap(),
  bestow: {
    fails: (ctx) => (!ctx.attacker.item || ctx.defender.item ? FAIL : null),
    run: (ctx) => {
      effects.setItem(ctx.defender, ctx.attacker.item);
      effects.setItem(ctx.attacker, null);
      say(ctx, 'item-given', { target: ctx.defender.name, item: effects.displayItem(ctx.defender.item) });
    },
  },
  recycle: {
    fails: (ctx) => (ctx.attacker.item || !ctx.attacker.consumedItem ? FAIL : null),
    run: (ctx) => {
      effects.setItem(ctx.attacker, ctx.attacker.consumedItem);
      ctx.attacker.consumedItem = null;
      say(ctx, 'item-recycled', { item: effects.displayItem(ctx.attacker.item) });
    },
  },
  'corrosive-gas': {
    fails: (ctx) => (ctx.defender.item ? null : FAIL),
    run: (ctx) => {
      const item = ctx.defender.item;
      effects.setItem(ctx.defender, null);
      ctx.events.push({ kind: 'item-lost', name: ctx.defender.name, item: effects.displayItem(item) });
    },
  },
  teatime: {
    fails: (ctx) => (ctx.state.sides.some((s) => /-berry$/.test(s.team[s.active].item || '')) ? null : FAIL),
    run: (ctx) => {
      for (const side of ctx.state.sides) {
        const mon = side.team[side.active];
        if (!/-berry$/.test(mon.item || '') || mon.fainted) continue;
        if (mon.item === 'sitrus-berry' || mon.item === 'oran-berry') {
          const before = mon.hp;
          mon.hp = Math.min(mon.maxHp, mon.hp + (mon.item === 'sitrus-berry' ? Math.floor(mon.maxHp / 4) : 10));
          if (mon.hp > before) ctx.events.push({ kind: 'item-heal', name: mon.name, amount: mon.hp - before, hp: mon.hp, source: effects.displayItem(mon.item) });
        } else if (mon.status && (mon.item === 'lum-berry' || effects.itemEffectFor(mon.item))) {
          ctx.events.push({ kind: 'cured', name: mon.name, status: mon.status });
          mon.status = null;
        }
        effects.consumeItem(mon, ctx.events);
      }
    },
  },

  // ---- switching ----
  'baton-pass': selfSwitch({ pass: true }),
  teleport: {
    fails: (ctx) => (ctx.state.kind === 'wild' || benchOf(sideOf(ctx)).length ? null : FAIL),
    run: (ctx) => {
      if (ctx.state.kind === 'wild') return ctx.engine.flee(ctx.sideIndex, ctx.attacker);
      ctx.engine.pendingSwitch(ctx.sideIndex, {});
    },
  },
  'shed-tail': {
    fails: (ctx) => (ctx.attacker.hp <= Math.ceil(ctx.attacker.maxHp / 2) || !benchOf(sideOf(ctx)).length ? FAIL : null),
    run: (ctx) => {
      const cost = Math.ceil(ctx.attacker.maxHp / 2);
      ctx.attacker.hp -= cost;
      say(ctx, 'shed-tail', { cost, hp: ctx.attacker.hp });
      ctx.engine.pendingSwitch(ctx.sideIndex, { shedTail: Math.floor(ctx.attacker.maxHp / 4) });
    },
  },
  roar: phaze(),
  whirlwind: phaze(),

  // ---- moves that use other moves ----
  'sleep-talk': {
    fails: (ctx) => (ctx.attacker.status === 'sleep' && sleepTalkOptions(ctx.attacker).length ? null : FAIL),
    run: (ctx) => {
      const options = sleepTalkOptions(ctx.attacker);
      call(ctx, options[Math.floor(ctx.rng() * options.length)].name);
    },
  },
  metronome: {
    fails: () => null,
    run: (ctx) => {
      const pool = metronomePool();
      call(ctx, pool[Math.floor(ctx.rng() * pool.length)]);
    },
  },
  'mirror-move': {
    fails: (ctx) => (ctx.defender.lastMove && !UNCOPYABLE.has(ctx.defender.lastMove) ? null : FAIL),
    run: (ctx) => call(ctx, ctx.defender.lastMove),
  },
  copycat: {
    fails: (ctx) => (ctx.state.lastMoveUsed && !UNCOPYABLE.has(ctx.state.lastMoveUsed) ? null : FAIL),
    run: (ctx) => call(ctx, ctx.state.lastMoveUsed),
  },
  'me-first': {
    fails: (ctx) => {
      const coming = ctx.turn && ctx.turn.foeMove;
      return !coming || ctx.turn.foeMoved || coming.damageClass === 'status' || UNCOPYABLE.has(coming.name) ? FAIL : null;
    },
    run: (ctx) => call(ctx, ctx.turn.foeMove.name, { powerMultiplier: 1.5 }),
  },
  assist: {
    fails: (ctx) => (assistOptions(ctx).length ? null : FAIL),
    run: (ctx) => {
      const options = assistOptions(ctx);
      call(ctx, options[Math.floor(ctx.rng() * options.length)]);
    },
  },
  'nature-power': { fails: () => null, run: (ctx) => call(ctx, NATURE_POWER[ctx.state.field.terrain] || 'tri-attack') },
  instruct: {
    fails: (ctx) => {
      const last = lastMoveOf(ctx.defender);
      return !last || last.pp <= 0 || UNCOPYABLE.has(last.name) ? FAIL : null;
    },
    run: (ctx) => {
      const last = lastMoveOf(ctx.defender);
      last.pp -= 1;
      ctx.engine.performMove(ctx.defender, ctx.attacker, last.data, { called: true });
    },
  },
  mimic: copyIntoSlot('mimic'),
  sketch: copyIntoSlot('sketch'),

  // ---- turn order (single battles) ----
  'after-you': {
    fails: (ctx) => (ctx.turn && !ctx.turn.foeMoved ? null : FAIL),
    run: (ctx) => ctx.events.push({ kind: 'after-you', name: ctx.defender.name }),
  },
  quash: {
    fails: (ctx) => (ctx.turn && !ctx.turn.foeMoved ? null : FAIL),
    run: (ctx) => ctx.events.push({ kind: 'quash', name: ctx.defender.name }),
  },

  // ---- partner-only moves: they fail in a single battle ----
  'helping-hand': needsPartner,
  'ally-switch': needsPartner,
  'follow-me': needsPartner,
  'rage-powder': needsPartner,
  spotlight: needsPartner,
  'aromatic-mist': needsPartner,
  coaching: needsPartner,
  'dragon-cheer': needsPartner,
  decorate: needsPartner,
  'hold-hands': needsPartner,

  // ---- nothing happens ----
  splash: nothing(),
  celebrate: nothing('Congratulations!'),
  'happy-hour': nothing('Everyone is caught up in the happy atmosphere!'),

  // ---- hazard removal (with the stat change from the data) ----
  defog: {
    fails: () => null,
    run: (ctx) => {
      ctx.engine.applyStage(ctx.defender, 'evasion', -1, ctx.events, true, ctx.sideIndex);
      for (const side of ctx.state.sides) {
        const c = conditionsOf(side);
        delete c.spikes; delete c.toxicSpikes; delete c.stealthRock; delete c.stickyWeb;
      }
      const theirs = conditionsOf(sideOf(ctx, false));
      delete theirs.reflect; delete theirs.lightScreen; delete theirs.auroraVeil; delete theirs.safeguard; delete theirs.mist;
      ctx.state.field.terrain = null;
      say(ctx, 'defog');
    },
  },
  'tidy-up': {
    fails: () => null,
    run: (ctx) => {
      for (const side of ctx.state.sides) {
        const c = conditionsOf(side);
        delete c.spikes; delete c.toxicSpikes; delete c.stealthRock; delete c.stickyWeb;
        side.team[side.active].substitute = 0;
      }
      say(ctx, 'tidy-up');
      ctx.engine.applyStage(ctx.attacker, 'attack', 1, ctx.events);
      ctx.engine.applyStage(ctx.attacker, 'speed', 1, ctx.events);
    },
  },
  'parting-shot': {
    fails: () => null,
    run: (ctx) => {
      ctx.engine.applyStage(ctx.defender, 'attack', -1, ctx.events, true, ctx.sideIndex);
      ctx.engine.applyStage(ctx.defender, 'specialAttack', -1, ctx.events, true, ctx.sideIndex);
      if (benchOf(sideOf(ctx)).length) ctx.engine.pendingSwitch(ctx.sideIndex, {});
    },
  },
  'chilly-reception': {
    fails: () => null,
    run: (ctx) => {
      ctx.engine.setWeather('snow', ctx.attacker);
      if (benchOf(sideOf(ctx)).length) ctx.engine.pendingSwitch(ctx.sideIndex, {});
    },
  },
};

// ---------------------------------------------------------------------------
// Builders used above (hoisted)
// ---------------------------------------------------------------------------

function teamCure() {
  return {
    fails: (ctx) => (sideOf(ctx).team.some((m) => m.status && !m.fainted) ? null : FAIL),
    run: (ctx) => {
      for (const mon of sideOf(ctx).team) {
        if (!mon.status || mon.fainted) continue;
        ctx.events.push({ kind: 'cured', name: mon.name, status: mon.status });
        mon.status = null;
        mon.toxicCounter = 0;
      }
    },
  };
}

function trap(label) {
  return {
    fails: (ctx) => (vol(ctx.defender).meanLook ? FAIL : hasType(ctx.defender, 'ghost') ? `It doesn't affect ${ctx.defender.name}...` : null),
    run: (ctx) => {
      vol(ctx.defender).meanLook = { by: ctx.attacker.id, source: label };
      ctx.events.push({ kind: 'cant-escape', name: ctx.defender.name });
    },
  };
}

function lockOn() {
  return {
    fails: () => null,
    run: (ctx) => {
      vol(ctx.attacker).lockOn = { target: ctx.defender.id, turns: 2 };
      say(ctx, 'lock-on', { target: ctx.defender.name });
    },
  };
}

function swapper(keys, label) {
  return {
    fails: () => null,
    run: (ctx) => {
      swapStages(ctx.attacker, ctx.defender, keys);
      say(ctx, 'swapped', { target: ctx.defender.name, what: label });
    },
  };
}

function splitter(keys, label) {
  return {
    fails: () => null,
    run: (ctx) => {
      const a = { ...ctx.attacker.stats };
      const d = { ...ctx.defender.stats };
      for (const key of keys) {
        const average = Math.floor((a[key] + d[key]) / 2);
        a[key] = average;
        d[key] = average;
      }
      ctx.attacker.stats = a;
      ctx.defender.stats = d;
      say(ctx, 'split', { target: ctx.defender.name, what: label });
    },
  };
}

function retype(typesFor, who) {
  return {
    fails: (ctx) => {
      const mon = who === 'self' ? ctx.attacker : ctx.defender;
      const types = typesFor(ctx).filter(Boolean);
      if (!types.length) return FAIL;
      return types.join() === mon.types.map(lower).join() ? FAIL : null;
    },
    run: (ctx) => {
      const mon = who === 'self' ? ctx.attacker : ctx.defender;
      mon.types = typesFor(ctx);
      ctx.events.push({ kind: 'retyped', name: mon.name, types: mon.types });
    },
  };
}

function reability(abilityFor, who, after = null) {
  return {
    fails: (ctx) => {
      const mon = who === 'self' ? ctx.attacker : ctx.defender;
      const wanted = abilityFor(ctx);
      if (!wanted || wanted === mon.ability) return FAIL;
      return FIXED_ABILITIES.has(mon.ability) || (who === 'self' && FIXED_ABILITIES.has(wanted)) ? FAIL : null;
    },
    run: (ctx) => {
      const mon = who === 'self' ? ctx.attacker : ctx.defender;
      effects.setAbility(mon, abilityFor(ctx));
      ctx.events.push({ kind: 'ability-changed', name: mon.name, ability: effects.displayAbility(mon.ability) });
      if (after) after(ctx);
    },
  };
}

function itemSwap() {
  return {
    fails: (ctx) => {
      if (!ctx.attacker.item && !ctx.defender.item) return FAIL;
      if (abilityOf(ctx.defender) === 'sticky-hold') return FAIL;
      // Mega Stones and the like can't be moved.
      return [ctx.attacker.item, ctx.defender.item].some((i) => /ite(-[xyz])?$/.test(i || '') && i !== 'eviolite') ? FAIL : null;
    },
    run: (ctx) => {
      const mine = ctx.attacker.item;
      effects.setItem(ctx.attacker, ctx.defender.item);
      effects.setItem(ctx.defender, mine);
      say(ctx, 'item-swap', { target: ctx.defender.name });
    },
  };
}

function selfSwitch(options) {
  return {
    fails: (ctx) => (benchOf(sideOf(ctx)).length ? null : FAIL),
    run: (ctx) => ctx.engine.pendingSwitch(ctx.sideIndex, options),
  };
}

function phaze() {
  return {
    fails: (ctx) => {
      if (vol(ctx.defender).ingrain) return `${ctx.defender.name} anchored itself with its roots!`;
      if (abilityOf(ctx.defender) === 'suction-cups') return `${ctx.defender.name} anchors itself!`;
      if (ctx.state.kind !== 'wild' && !benchOf(sideOf(ctx, false)).length) return FAIL;
      return null;
    },
    run: (ctx) => ctx.engine.phaze(1 - ctx.sideIndex),
  };
}

function copyIntoSlot(self) {
  return {
    fails: (ctx) => {
      const last = ctx.defender.lastMove;
      if (!last || UNCOPYABLE.has(last)) return FAIL;
      return ctx.attacker.moves.some((m) => m.name === last) ? FAIL : null;
    },
    run: (ctx) => {
      const slot = ctx.attacker.moves.findIndex((m) => m.name === self);
      const data = content.move(ctx.defender.lastMove);
      if (slot < 0 || !data) return fail(ctx);
      const pp = self === 'sketch' ? data.pp : 5;
      ctx.attacker.moves[slot] = { name: data.name, data, pp, maxPp: pp };
      say(ctx, 'learned-move', { move: data.displayName });
    },
  };
}

function sleepTalkOptions(mon) {
  return mon.moves.filter((m) => m.name !== 'sleep-talk' && !UNCOPYABLE.has(m.name) && !['uproar', 'razor-wind', 'sky-attack', 'skull-bash', 'solar-beam', 'fly', 'dig', 'dive', 'bounce'].includes(m.name));
}

let metronomeCache = null;
function metronomePool() {
  if (metronomeCache) return metronomeCache;
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'Data', 'Moves');
  const pool = [];
  for (const id of fs.readdirSync(dir)) {
    try {
      const move = JSON.parse(fs.readFileSync(path.join(dir, id, 'data.json'), 'utf8'));
      if (!move || UNCOPYABLE.has(move.name) || /^(shadow-|max-|g-max-)/.test(move.name)) continue;
      if (!(move.learnedByPokemon || []).length) continue;
      pool.push(move.name);
    } catch {
      // Skip unreadable entries.
    }
  }
  metronomeCache = pool;
  return pool;
}

function assistOptions(ctx) {
  const options = [];
  for (const mon of sideOf(ctx).team) {
    if (mon === ctx.attacker) continue;
    for (const m of mon.moves) if (!UNCOPYABLE.has(m.name) && m.name !== 'assist') options.push(m.name);
  }
  return options;
}

// ---------------------------------------------------------------------------

/** Does this module handle the move? */
const has = (name) => Object.prototype.hasOwnProperty.call(MOVES, name);

/** Why the move would fail right now, or null. */
function wouldFail(ctx) {
  const entry = MOVES[ctx.move.name];
  return entry ? entry.fails(ctx) : null;
}

/** Use it: report a failure, or carry it out. */
function run(ctx) {
  const entry = MOVES[ctx.move.name];
  const why = entry.fails(ctx);
  if (why) return fail(ctx, why);
  entry.run(ctx);
}

module.exports = { has, wouldFail, run, MOVES, UNCOPYABLE };
