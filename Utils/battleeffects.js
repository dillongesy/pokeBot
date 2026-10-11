'use strict';

/**
 * Abilities and held items, in battle.
 *
 * Kept separate from the engine (Utils/battle.js) so the turn structure stays
 * readable. Effects are written against a fixed set of hooks, so adding an
 * ability or item means filling in a table entry rather than editing the
 * engine. `node Utils/battleeffects.js` prints which abilities and items are
 * implemented.
 *
 * Around eighty abilities and sixty held items are implemented. Not yet
 * supported:
 *
 *   weather/terrain abilities  Drizzle, Chlorophyll, Sand Force, Surge Surfer
 *                              and others. Weather itself is handled by
 *                              Utils/field.js.
 *   move flags                 The imported move data has no punch, bite,
 *                              sound or bullet flags, so Iron Fist, Strong
 *                              Jaw, Punk Rock, Bulletproof and Soundproof do
 *                              nothing. Contact is approximated (see
 *                              makesContact).
 *   choice locking             Choice items give their boost but don't lock
 *                              the holder into one move.
 *   copying and swapping       Trace, Imposter, Transform, Skill Swap.
 *   confusion, infatuation     Not modelled, so Own Tempo, Cute Charm and
 *                              Oblivious have nothing to block.
 *
 * Reading hooks (damage, speed, accuracy) only return numbers. Reacting hooks
 * (afterHitTaken, endOfTurn) mutate the combatant and push events, as the
 * engine does.
 */

const content = require('./content');
const typechart = require('./typechart');
const { loadSpecies } = require('./pokemon');

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** How much health is left, 0 to 1. */
const share = (mon) => (mon.maxHp > 0 ? mon.hp / mon.maxHp : 0);

/** A fraction of maximum health, floored, never less than 1. */
const chunk = (mon, denominator) => Math.max(1, Math.floor(mon.maxHp / denominator));

/** Is this Pokemon at full health? Multiscale, Sturdy and Focus Sash all ask. */
const atFullHealth = (mon) => mon.hp >= mon.maxHp;

const lower = (text) => String(text || '').toLowerCase();

/** Does this Pokemon have this type? */
const isType = (mon, type) => (mon.types || []).some((t) => lower(t) === type);

/**
 * Heal and report it. Returns whether anything was healed. All healing goes
 * through here so it never overheals or reports a heal of zero.
 */
function heal(mon, amount, events, source) {
  const before = mon.hp;
  mon.hp = Math.min(mon.maxHp, mon.hp + Math.max(0, amount));

  if (mon.hp === before) return false;

  events.push({ kind: 'item-heal', name: mon.name, amount: mon.hp - before, hp: mon.hp, source });
  return true;
}

/**
 * Take health off for something that is not a move - Rocky Helmet, Life Orb,
 * a Black Sludge held by the wrong Pokemon - and faint it if that was the
 * last of it.
 */
function chip(mon, amount, events, source, kind = 'chip') {
  if (mon.fainted) return 0;

  // Magic Guard is checked here once rather than at every caller.
  if (flag(mon, 'blocksIndirectDamage', { mon })) {
    events.push({ kind: 'shrugged-off', name: mon.name, source, by: displayAbility(mon.ability) });
    return 0;
  }

  const taken = Math.min(mon.hp, Math.max(0, amount));
  mon.hp -= taken;

  // `kind` lets weather, traps and Leech Seed describe themselves in the log.
  events.push({ kind, name: mon.name, amount: taken, hp: mon.hp, source });

  if (mon.hp === 0) {
    mon.fainted = true;
    mon.faintedBy = null;
    events.push({ kind: 'faint', name: mon.name, by: null, cause: source });
  }

  // Return the amount actually taken (Leech Seed heals by this amount).
  return taken;
}

/** Use a held item up. Berries and Focus Sashes are one-shot. */
function consumeItem(mon, events) {
  const used = mon.item;
  mon.item = null;
  mon.itemEffect = null;
  mon.consumedItem = used;
  events.push({ kind: 'item-used', name: mon.name, item: displayItem(used) });
}

const displayItem = (slug) => {
  const record = slug ? content.item(slug) : null;
  return record ? record.displayName : slug;
};

const displayAbility = (slug) => {
  const record = slug ? ability(slug) : null;
  return record ? record.displayName : slug;
};

// ---------------------------------------------------------------------------
// Contact
// ---------------------------------------------------------------------------

/**
 * Does this move make contact?
 *
 * The imported move data has no contact flag, so this is an approximation:
 * physical moves make contact unless listed below, and special moves never
 * do. That is right for the vast majority of moves. If move flags are ever
 * imported, this can read them directly.
 */
const NON_CONTACT_PHYSICAL = new Set([
  // Ground and rock, thrown rather than swung
  'earthquake', 'fissure', 'magnitude', 'bulldoze', 'bone-club', 'bonemerang',
  'bone-rush', 'rock-throw', 'rock-slide', 'rockslide', 'stone-edge',
  'rock-blast', 'rock-wrecker', 'rock-tomb', 'ancient-power', 'diamond-storm',
  'sand-tomb', 'precipice-blades', 'thousand-arrows', 'thousand-waves',
  'accelerock', 'meteor-beam', 'salt-cure', 'stone-axe',

  // Projectiles
  'pin-missile', 'poison-sting', 'spike-cannon', 'twineedle', 'barrage',
  'egg-bomb', 'seed-bomb', 'gyro-ball', 'magnet-bomb', 'aura-sphere',
  'bullet-seed', 'icicle-spear', 'icicle-crash', 'ice-shard', 'razor-leaf',
  'leaf-blade', 'sacred-fire', 'smack-down', 'gear-grind', 'rock-smash',
  'attack-order', 'fell-stinger', 'spirit-shackle', 'pyro-ball',
  'triple-arrows', 'population-bomb', 'ivy-cudgel',

  // Explosions and self-destruction
  'self-destruct', 'explosion', 'mind-blown', 'misty-explosion',

  // Wind, breath and sound made physical
  'aeroblast', 'razor-wind', 'gust', 'whirlwind', 'hyper-fang', 'bite',

  // Money, hazards and oddities
  'pay-day', 'spikes', 'toxic-spikes', 'stealth-rock', 'sticky-web',
  'present', 'natural-gift', 'beat-up', 'fling', 'metal-burst', 'counter',
  'psycho-cut', 'sacred-sword', 'secret-sword', 'aura-wheel',
]);

function makesContact(move) {
  // Check the damage class, not power, so variable-power moves count.
  if (!move || move.damageClass === 'status') return false;
  if (move.damageClass !== 'physical') return false;
  return !NON_CONTACT_PHYSICAL.has(move.name);
}

// ---------------------------------------------------------------------------
// Ability records
// ---------------------------------------------------------------------------

let abilityIndex = null;

/** One ability's record from Data/Abilities, or null. Same shape as a move. */
function ability(slug) {
  if (!abilityIndex) {
    abilityIndex = new Map();
    try {
      const path = require('path');
      const fs = require('fs');
      const file = path.join(__dirname, '..', 'Data', 'Abilities', 'index.json');
      const index = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const entry of index.entries) abilityIndex.set(entry.name, entry);
    } catch {
      // No ability data imported; abilities are simply inert.
      return null;
    }
  }

  return abilityIndex.get(slug) || null;
}

/** Every ability name the data knows about. Only the coverage report needs it. */
function allAbilityNames() {
  ability('stench');
  return [...abilityIndex.keys()];
}

// ---------------------------------------------------------------------------
// Ability definitions
// ---------------------------------------------------------------------------

/**
 * Overgrow, Blaze, Torrent and Swarm are one rule four times: below a third
 * health, moves of the matching type hit half again as hard.
 */
const pinch = (type) => ({
  damageOut: ({ attacker, move }) =>
    lower(move.type) === type && share(attacker) <= 1 / 3 ? 1.5 : 1,
});

/** Volt Absorb and friends: immune to a type, and healed by it instead. */
const absorbHeals = (type, fraction = 4) => ({
  absorbs: ({ move }) => (lower(move.type) === type ? { kind: 'heal', denominator: fraction } : null),
});

/** Lightning Rod and friends: immune to a type, and raised a stage by it. */
const absorbBoosts = (type, stat, delta = 1) => ({
  absorbs: ({ move }) => (lower(move.type) === type ? { kind: 'boost', stat, delta } : null),
});

/** Static, Flame Body, Poison Point: a chance to inflict something on contact. */
const contactStatus = (status, chance = 30) => ({
  onHitTaken: ({ attacker, contact, rng, events, defender }) => {
    if (!contact || attacker.fainted) return;
    if (rng() * 100 >= chance) return;
    requestStatus(attacker, status, events, { by: defender.name, source: 'ability' });
  },
});

/** Rough Skin and Iron Barbs: contact costs the attacker a slice of health. */
const contactChip = (denominator, source) => ({
  onHitTaken: ({ attacker, contact, events }) => {
    if (!contact || attacker.fainted) return;
    chip(attacker, chunk(attacker, denominator), events, source);
  },
});

/** Immunity, Limber, Water Veil: one status simply never lands. */
const statusProof = (...statuses) => ({
  blocksStatus: ({ status }) => statuses.includes(status),
});

/** Hyper Cutter, Keen Eye, Big Pecks: one stat cannot be lowered by the foe. */
const statProof = (...stats) => ({
  blocksStatDrop: ({ stat, fromFoe }) => fromFoe && stats.includes(stat),
});

/**
 * Defiant and Competitive: being lowered by the opponent is answered with two
 * stages the other way.
 */
const spiteBoost = (stat) => ({
  onStatLowered: ({ target, fromFoe, events }) => {
    if (!fromFoe) return;
    requestStage(target, stat, 2, events, 'ability');
  },
});

/** Moxie, Beast Boost, Chilling Neigh: a knockout is worth a stage. */
const killBoost = (stat) => ({
  onKnockout: ({ attacker, events }) => requestStage(attacker, stat, 1, events, 'ability'),
});

/** Justified and Rattled: being hit by certain types is worth a stage. */
const hitBoost = (stat, types) => ({
  onHitTaken: ({ move, defender, events, dealt }) => {
    if (!dealt || !types.includes(lower(move.type))) return;
    requestStage(defender, stat, 1, events, 'ability');
  },
});

/** Steelworker, Transistor, Dragon's Maw: one type, permanently harder. */
const typeBoost = (type, multiplier) => ({
  damageOut: ({ move }) => (lower(move.type) === type ? multiplier : 1),
});

/** Thick Fat and Heatproof: certain types come in softened. */
const resistTypes = (multiplier, ...types) => ({
  damageIn: ({ move }) => (types.includes(lower(move.type)) ? multiplier : 1),
});

const ABILITIES = {
  // -------------------------------------------------------------------------
  // Offence
  // -------------------------------------------------------------------------
  overgrow: pinch('grass'),
  blaze: pinch('fire'),
  torrent: pinch('water'),
  swarm: pinch('bug'),

  'huge-power': {
    attackMultiplier: ({ move }) => (move.damageClass === 'physical' ? 2 : 1),
  },
  'pure-power': {
    attackMultiplier: ({ move }) => (move.damageClass === 'physical' ? 2 : 1),
  },

  hustle: {
    attackMultiplier: ({ move }) => (move.damageClass === 'physical' ? 1.5 : 1),
    accuracyMultiplier: ({ move }) => (move.damageClass === 'physical' ? 0.8 : 1),
  },

  // Guts boosts Attack under a status and also ignores burn's halving.
  guts: {
    attackMultiplier: ({ attacker, move }) =>
      attacker.status && move.damageClass === 'physical' ? 1.5 : 1,
    ignoresBurn: true,
  },
  'toxic-boost': {
    attackMultiplier: ({ attacker, move }) =>
      attacker.status === 'poison' && move.damageClass === 'physical' ? 1.5 : 1,
  },
  'flare-boost': {
    attackMultiplier: ({ attacker, move }) =>
      attacker.status === 'burn' && move.damageClass === 'special' ? 1.5 : 1,
  },
  'quick-feet': {
    speedMultiplier: ({ mon }) => (mon.status ? 1.5 : 1),
    ignoresParalysisSpeed: true,
  },

  adaptability: { stabMultiplier: 2 },

  technician: {
    // The resolved power, which for variable-power moves comes from
    // Utils/movepower.js.
    damageOut: ({ power }) => (power && power <= 60 ? 1.5 : 1),
  },

  'tinted-lens': {
    damageOut: ({ effectiveness }) => (effectiveness < 1 ? 2 : 1),
  },

  reckless: {
    // Recoil moves have negative drain.
    damageOut: ({ move }) => (move.meta && move.meta.drain < 0 ? 1.2 : 1),
  },

  // Sheer Force: the boost is here; secondary effects are removed via
  // suppressesSecondaries.
  'sheer-force': {
    damageOut: ({ move }) => (hasSecondary(move) ? 1.3 : 1),
    suppressesSecondaries: true,
  },

  'serene-grace': { secondaryChance: 2 },
  'skill-link': { multiHitAlwaysMax: true },
  sniper: { critDamage: 1.5 },
  'super-luck': { critStage: 1 },
  'no-guard': { neverMisses: true },
  'compound-eyes': { accuracyMultiplier: () => 1.3 },

  steelworker: typeBoost('steel', 1.5),
  'steely-spirit': typeBoost('steel', 1.5),
  transistor: typeBoost('electric', 1.3),
  'dragons-maw': typeBoost('dragon', 1.5),
  'rocky-payload': typeBoost('rock', 1.5),

  'water-bubble': {
    damageOut: ({ move }) => (lower(move.type) === 'water' ? 2 : 1),
    damageIn: ({ move }) => (lower(move.type) === 'fire' ? 0.5 : 1),
    blocksStatus: ({ status }) => status === 'burn',
  },

  stench: { flinchChance: 10 },

  // -------------------------------------------------------------------------
  // Defence
  // -------------------------------------------------------------------------
  'thick-fat': resistTypes(0.5, 'fire', 'ice'),
  heatproof: resistTypes(0.5, 'fire'),
  'purifying-salt': {
    damageIn: ({ move }) => (lower(move.type) === 'ghost' ? 0.5 : 1),
    blocksStatus: () => true,
  },

  filter: { damageIn: ({ effectiveness }) => (effectiveness > 1 ? 0.75 : 1) },
  'solid-rock': { damageIn: ({ effectiveness }) => (effectiveness > 1 ? 0.75 : 1) },
  'prism-armor': { damageIn: ({ effectiveness }) => (effectiveness > 1 ? 0.75 : 1) },

  multiscale: { damageIn: ({ defender }) => (atFullHealth(defender) ? 0.5 : 1) },
  'shadow-shield': { damageIn: ({ defender }) => (atFullHealth(defender) ? 0.5 : 1) },

  'marvel-scale': {
    defenceMultiplier: ({ defender, move }) =>
      defender.status && move.damageClass === 'physical' ? 1.5 : 1,
  },
  'fur-coat': {
    defenceMultiplier: ({ move }) => (move.damageClass === 'physical' ? 2 : 1),
  },
  'ice-scales': {
    defenceMultiplier: ({ move }) => (move.damageClass === 'special' ? 2 : 1),
  },
  fluffy: {
    damageIn: ({ move, contact }) => (lower(move.type) === 'fire' ? 2 : contact ? 0.5 : 1),
  },

  'battle-armor': { blocksCrits: true },
  'shell-armor': { blocksCrits: true },

  // Wonder Guard: only super-effective moves hit.
  'wonder-guard': {
    absorbs: ({ effectiveness, move }) =>
      move.damageClass !== 'status' && effectiveness <= 1 ? { kind: 'blocked' } : null,
  },

  sturdy: {
    survives: ({ defender }) => (atFullHealth(defender) ? { hp: 1, consume: false } : null),
    blocksOneHitKo: true,
  },

  // Magic Guard: only direct move damage can hurt it (no poison, burn,
  // recoil, Life Orb, Rocky Helmet).
  'magic-guard': { blocksIndirectDamage: true },

  levitate: {
    absorbs: ({ move }) => (lower(move.type) === 'ground' ? { kind: 'blocked' } : null),
  },

  'volt-absorb': absorbHeals('electric'),
  'water-absorb': absorbHeals('water'),
  'earth-eater': absorbHeals('ground'),
  'well-baked-body': absorbBoosts('fire', 'defense', 2),
  'sap-sipper': absorbBoosts('grass', 'attack'),
  'motor-drive': absorbBoosts('electric', 'speed'),
  'lightning-rod': absorbBoosts('electric', 'specialAttack'),
  'storm-drain': absorbBoosts('water', 'specialAttack'),

  'flash-fire': {
    absorbs: ({ move }) => (lower(move.type) === 'fire' ? { kind: 'flag', flag: 'flashFire' } : null),
    damageOut: ({ attacker, move }) =>
      attacker.flags && attacker.flags.flashFire && lower(move.type) === 'fire' ? 1.5 : 1,
  },

  'dry-skin': {
    absorbs: ({ move }) => (lower(move.type) === 'water' ? { kind: 'heal', denominator: 4 } : null),
    damageIn: ({ move }) => (lower(move.type) === 'fire' ? 1.25 : 1),
  },

  // -------------------------------------------------------------------------
  // Reactions
  // -------------------------------------------------------------------------
  'rough-skin': contactChip(8, 'Rough Skin'),
  'iron-barbs': contactChip(8, 'Iron Barbs'),

  static: contactStatus('paralysis'),
  'flame-body': contactStatus('burn'),
  'poison-point': contactStatus('poison'),

  'effect-spore': {
    onHitTaken: ({ attacker, contact, rng, events, defender }) => {
      if (!contact || attacker.fainted) return;
      const roll = rng() * 100;
      if (roll >= 30) return;
      const status = roll < 10 ? 'sleep' : roll < 20 ? 'paralysis' : 'poison';
      requestStatus(attacker, status, events, { by: defender.name, source: 'ability' });
    },
  },

  gooey: {
    onHitTaken: ({ attacker, contact, events }) => {
      if (!contact || attacker.fainted) return;
      requestStage(attacker, 'speed', -1, events, 'ability');
    },
  },
  'tangling-hair': {
    onHitTaken: ({ attacker, contact, events }) => {
      if (!contact || attacker.fainted) return;
      requestStage(attacker, 'speed', -1, events, 'ability');
    },
  },

  aftermath: {
    onHitTaken: ({ attacker, contact, defender, events }) => {
      if (!contact || !defender.fainted || attacker.fainted) return;
      chip(attacker, chunk(attacker, 4), events, 'Aftermath');
    },
  },

  'weak-armor': {
    onHitTaken: ({ move, defender, events, dealt }) => {
      if (!dealt || move.damageClass !== 'physical') return;
      requestStage(defender, 'defense', -1, events, 'ability');
      requestStage(defender, 'speed', 2, events, 'ability');
    },
  },

  'anger-point': {
    onHitTaken: ({ critical, defender, events, dealt }) => {
      if (!dealt || !critical) return;
      requestStage(defender, 'attack', 12, events, 'ability');
    },
  },

  justified: hitBoost('attack', ['dark']),
  rattled: hitBoost('speed', ['bug', 'ghost', 'dark']),

  steadfast: {
    onFlinch: ({ mon, events }) => requestStage(mon, 'speed', 1, events, 'ability'),
  },

  moxie: killBoost('attack'),
  'chilling-neigh': killBoost('attack'),
  'grim-neigh': killBoost('specialAttack'),
  'as-one-glastrier': killBoost('attack'),
  'as-one-spectrier': killBoost('specialAttack'),
  'beast-boost': {
    // Raises the highest stat; ties go to Speed, as in the games.
    onKnockout: ({ attacker, events }) => {
      const order = ['attack', 'defense', 'specialAttack', 'specialDefense', 'speed'];
      const best = order.reduce((top, stat) =>
        attacker.stats[stat] > attacker.stats[top] ? stat : top
      );
      requestStage(attacker, best, 1, events, 'ability');
    },
  },

  intimidate: {
    onSendOut: ({ foe, events }) => {
      if (!foe || foe.fainted) return;
      requestStage(foe, 'attack', -1, events, 'ability', true);
    },
  },

  // -------------------------------------------------------------------------
  // Status and stages
  // -------------------------------------------------------------------------
  immunity: statusProof('poison'),
  limber: statusProof('paralysis'),
  'water-veil': statusProof('burn'),
  'thermal-exchange': statusProof('burn'),
  insomnia: statusProof('sleep'),
  'vital-spirit': statusProof('sleep'),
  'sweet-veil': statusProof('sleep'),
  'magma-armor': statusProof('freeze'),
  comatose: statusProof('burn', 'poison', 'paralysis', 'sleep', 'freeze'),

  'inner-focus': { blocksFlinch: true },

  'poison-heal': {
    // Poison heals instead of hurting. The status stays, which also blocks
    // other statuses.
    residual: ({ mon, events }) => {
      if (mon.status !== 'poison') return 'normal';
      heal(mon, chunk(mon, 8), events, 'Poison Heal');
      return 'handled';
    },
  },

  'shed-skin': {
    endOfTurn: ({ mon, rng, events }) => {
      if (!mon.status || rng() >= 1 / 3) return;
      events.push({ kind: 'cured', name: mon.name, status: mon.status, source: 'Shed Skin' });
      mon.status = null;
      mon.statusTurns = 0;
    },
  },

  'natural-cure': {
    onWithdraw: ({ mon, events }) => {
      if (!mon.status) return;
      events.push({ kind: 'cured', name: mon.name, status: mon.status, source: 'Natural Cure' });
      mon.status = null;
      mon.statusTurns = 0;
    },
  },

  regenerator: {
    onWithdraw: ({ mon, events }) => heal(mon, chunk(mon, 3), events, 'Regenerator'),
  },

  'speed-boost': {
    endOfTurn: ({ mon, events }) => requestStage(mon, 'speed', 1, events, 'ability'),
  },

  'clear-body': statProof('attack', 'defense', 'specialAttack', 'specialDefense', 'speed', 'accuracy', 'evasion'),
  'white-smoke': statProof('attack', 'defense', 'specialAttack', 'specialDefense', 'speed', 'accuracy', 'evasion'),
  'full-metal-body': statProof('attack', 'defense', 'specialAttack', 'specialDefense', 'speed', 'accuracy', 'evasion'),
  'hyper-cutter': statProof('attack'),
  'keen-eye': statProof('accuracy'),
  'big-pecks': statProof('defense'),

  contrary: { invertsStatChanges: true },
  simple: { doublesStatChanges: true },

  defiant: spiteBoost('attack'),
  competitive: spiteBoost('specialAttack'),

  'rock-head': { blocksRecoil: true },
};

// ---------------------------------------------------------------------------
// Held item definitions
// ---------------------------------------------------------------------------

/** Cheri, Chesto, Pecha, Rawst and Aspear: one status each, eaten on sight. */
const cureBerry = (status) => ({
  onHealthChanged: ({ mon, events }) => {
    if (mon.status !== status) return;
    events.push({ kind: 'cured', name: mon.name, status: mon.status, source: displayItem(mon.item) });
    mon.status = null;
    mon.statusTurns = 0;
    consumeItem(mon, events);
  },
});

/** Liechi, Ganlon, Salac and the rest: a stage when the health runs low. */
const pinchBerry = (stat) => ({
  onHealthChanged: ({ mon, events }) => {
    if (share(mon) > 0.25 || mon.fainted) return;
    requestStage(mon, stat, 1, events, 'item');
    consumeItem(mon, events);
  },
});

const HELD_ITEMS = {
  leftovers: {
    endOfTurn: ({ mon, events }) => heal(mon, chunk(mon, 16), events, 'Leftovers'),
  },

  // Heals Poison types; poisons everything else.
  'black-sludge': {
    endOfTurn: ({ mon, events }) => {
      if (isType(mon, 'poison')) heal(mon, chunk(mon, 16), events, 'Black Sludge');
      else chip(mon, chunk(mon, 8), events, 'Black Sludge');
    },
    indirect: true,
  },

  'shell-bell': {
    onDealtDamage: ({ attacker, dealt, events }) => {
      if (dealt > 0) heal(attacker, Math.max(1, Math.floor(dealt / 8)), events, 'Shell Bell');
    },
  },

  'life-orb': {
    damageOut: () => 1.3,
    onDealtDamage: ({ attacker, dealt, events }) => {
      if (dealt > 0) chip(attacker, chunk(attacker, 10), events, 'Life Orb');
    },
    indirect: true,
  },

  // Choice items give their boost only; there is no move lock (see the top
  // of the file).
  'choice-band': {
    attackMultiplier: ({ move }) => (move.damageClass === 'physical' ? 1.5 : 1),
  },
  'choice-specs': {
    attackMultiplier: ({ move }) => (move.damageClass === 'special' ? 1.5 : 1),
  },
  'choice-scarf': { speedMultiplier: () => 1.5 },

  'assault-vest': {
    defenceMultiplier: ({ move }) => (move.damageClass === 'special' ? 1.5 : 1),
  },

  eviolite: {
    defenceMultiplier: ({ defender }) => (canStillEvolve(defender) ? 1.5 : 1),
  },

  'expert-belt': { damageOut: ({ effectiveness }) => (effectiveness > 1 ? 1.2 : 1) },
  'muscle-band': { damageOut: ({ move }) => (move.damageClass === 'physical' ? 1.1 : 1) },
  'wise-glasses': { damageOut: ({ move }) => (move.damageClass === 'special' ? 1.1 : 1) },

  'focus-sash': {
    survives: ({ defender }) => (atFullHealth(defender) ? { hp: 1, consume: true } : null),
  },
  'focus-band': {
    survives: ({ rng }) => (rng() < 0.1 ? { hp: 1, consume: false } : null),
  },

  'rocky-helmet': {
    onHitTaken: ({ attacker, contact, events }) => {
      if (!contact || attacker.fainted) return;
      chip(attacker, chunk(attacker, 6), events, 'Rocky Helmet');
    },
  },

  'kings-rock': { flinchChance: 10 },
  'razor-fang': { flinchChance: 10 },
  'scope-lens': { critStage: 1 },
  'razor-claw': { critStage: 1 },

  'lucky-punch': { critStage: ({ mon }) => (mon.species === 'Chansey' ? 2 : 0) },
  // Stick and its Gen 8 rename (PokeAPI slug "large-leek").
  stick: { critStage: ({ mon }) => (/farfetch/i.test(mon.species || '') ? 2 : 0) },
  'large-leek': { critStage: ({ mon }) => (/farfetch|sirfetch/i.test(mon.species || '') ? 2 : 0) },

  'light-ball': {
    attackMultiplier: ({ attacker }) => (/pikachu/i.test(attacker.species || '') ? 2 : 1),
  },
  'thick-club': {
    attackMultiplier: ({ attacker, move }) =>
      /cubone|marowak/i.test(attacker.species || '') && move.damageClass === 'physical' ? 2 : 1,
  },
  'metal-powder': {
    defenceMultiplier: ({ defender }) => (/ditto/i.test(defender.species || '') ? 2 : 1),
  },
  'quick-powder': {
    speedMultiplier: ({ mon }) => (/ditto/i.test(mon.species || '') ? 2 : 1),
  },
  'soul-dew': {
    damageOut: ({ attacker, move }) =>
      /latias|latios/i.test(attacker.species || '') &&
      ['psychic', 'dragon'].includes(lower(move.type))
        ? 1.2
        : 1,
  },

  'iron-ball': { speedMultiplier: () => 0.5 },

  'air-balloon': {
    absorbs: ({ move }) => (lower(move.type) === 'ground' ? { kind: 'blocked' } : null),
    // Any hit pops it, removing the Ground immunity.
    onHitTaken: ({ defender, dealt, events }) => {
      if (dealt > 0) consumeItem(defender, events);
    },
  },

  'weakness-policy': {
    onHitTaken: ({ defender, effectiveness, dealt, events }) => {
      if (!dealt || effectiveness <= 1 || defender.fainted) return;
      requestStage(defender, 'attack', 2, events, 'item');
      requestStage(defender, 'specialAttack', 2, events, 'item');
      consumeItem(defender, events);
    },
  },

  // Flame Orb and Toxic Orb inflict their status on the holder (for Guts,
  // Poison Heal and similar).
  'flame-orb': {
    endOfTurn: ({ mon, events }) => {
      if (mon.status) return;
      requestStatus(mon, 'burn', events, { source: 'item' });
    },
  },
  'toxic-orb': {
    endOfTurn: ({ mon, events }) => {
      if (mon.status) return;
      requestStatus(mon, 'poison', events, { source: 'item' });
    },
  },

  'sitrus-berry': {
    onHealthChanged: ({ mon, events }) => {
      if (share(mon) > 0.5 || mon.fainted) return;
      heal(mon, chunk(mon, 4), events, 'Sitrus Berry');
      consumeItem(mon, events);
    },
  },
  'oran-berry': {
    onHealthChanged: ({ mon, events }) => {
      if (share(mon) > 0.5 || mon.fainted) return;
      heal(mon, 10, events, 'Oran Berry');
      consumeItem(mon, events);
    },
  },
  'berry-juice': {
    onHealthChanged: ({ mon, events }) => {
      if (share(mon) > 0.5 || mon.fainted) return;
      heal(mon, 20, events, 'Berry Juice');
      consumeItem(mon, events);
    },
  },

  'lum-berry': {
    onHealthChanged: ({ mon, events }) => {
      if (!mon.status) return;
      events.push({ kind: 'cured', name: mon.name, status: mon.status, source: 'Lum Berry' });
      mon.status = null;
      mon.statusTurns = 0;
      consumeItem(mon, events);
    },
  },

  'cheri-berry': cureBerry('paralysis'),
  'chesto-berry': cureBerry('sleep'),
  'pecha-berry': cureBerry('poison'),
  'rawst-berry': cureBerry('burn'),
  'aspear-berry': cureBerry('freeze'),

  'liechi-berry': pinchBerry('attack'),
  'ganlon-berry': pinchBerry('defense'),
  'petaya-berry': pinchBerry('specialAttack'),
  'apicot-berry': pinchBerry('specialDefense'),
  'salac-berry': pinchBerry('speed'),
};

/**
 * The type-boosting items, read out of the data rather than listed.
 *
 * Items in the "type-enhancement" and "plates" categories share the same
 * short effect ("Fire-Type moves from holder do 20% more damage"), so the
 * type is parsed from that text.
 *
 * Plates also change Arceus's form (handled by Utils/formitems.js).
 */
let typeBoostCache = null;

function typeBoostItems() {
  if (typeBoostCache) return typeBoostCache;

  typeBoostCache = new Map();

  // importedItem, not item: the plates are overridden by shop `define`
  // blocks, which have no category or effect text.
  for (const [slug] of content.items()) {
    const record = content.importedItem(slug);
    if (!record) continue;
    if (record.category !== 'type-enhancement' && record.category !== 'plates') continue;

    const match = /^Held: ([A-Za-z]+)-Type moves from holder do (\d+)% more damage/i.exec(
      record.shortEffect || ''
    );
    if (!match) continue;

    typeBoostCache.set(slug, {
      type: match[1].toLowerCase(),
      multiplier: 1 + Number(match[2]) / 100,
    });
  }

  return typeBoostCache;
}

/** Can this Pokemon still evolve? (for Eviolite) */
function canStillEvolve(mon) {
  const species = loadSpecies(mon.speciesId);
  const chain = (species && species.evolution && species.evolution.chain) || [];
  const self = species ? species.name : null;
  return chain.some((entry) => entry.evolvesFrom === self);
}

// ---------------------------------------------------------------------------
// Deferred requests
// ---------------------------------------------------------------------------

/**
 * Stat changes and statuses requested by hooks are queued rather than applied
 * directly, and the engine applies them through its own applyStage and
 * applyStatus. That way blocking abilities, Contrary, Simple and type
 * immunities are only implemented once.
 */
const queue = [];

function requestStage(target, stat, delta, events, source, fromFoe = false) {
  queue.push({ what: 'stage', target, stat, delta, source, fromFoe });
}

function requestStatus(target, status, events, options = {}) {
  queue.push({ what: 'status', target, status, ...options });
}

/** Take everything queued. The engine calls this and acts on what comes back. */
function drain() {
  if (!queue.length) return [];
  return queue.splice(0, queue.length);
}

// ---------------------------------------------------------------------------
// Resolving what a combatant actually has
// ---------------------------------------------------------------------------

/**
 * Look up a Pokemon's ability and held item definitions once, and hang them on
 * the combatant.
 *
 * Called by Utils/battle.js's combatantFrom, once per battle.
 */
function attach(combatant) {
  combatant.abilityEffect = ABILITIES[combatant.ability] || null;
  combatant.itemEffect = itemEffectFor(combatant.item);
  combatant.flags = {};
  combatant.consumedItem = null;
  return combatant;
}

/**
 * What a held item does, including the derived type-boosters.
 *
 * A hand-written entry takes priority over a derived one.
 */
function itemEffectFor(slug) {
  if (!slug) return null;
  if (HELD_ITEMS[slug]) return HELD_ITEMS[slug];

  const boost = typeBoostItems().get(slug);
  if (boost) {
    return {
      derived: true,
      damageOut: ({ move }) => (lower(move.type) === boost.type ? boost.multiplier : 1),
    };
  }

  return null;
}

/** The two definitions a combatant is carrying, ability first. */
const definitionsOf = (mon) =>
  [mon.abilityEffect, mon.itemEffect].filter(Boolean);

/**
 * Multiply one hook across both definitions.
 *
 * A hook that is missing contributes 1, so a Pokemon with no ability and no
 * item comes out of every calculation unchanged.
 */
function product(mon, hook, context) {
  let total = 1;

  for (const definition of definitionsOf(mon)) {
    const fn = definition[hook];
    if (typeof fn === 'function') total *= fn(context);
    else if (typeof fn === 'number') total *= fn;
  }

  return total;
}

/** Is this hook switched on for either of them? */
function flag(mon, hook, context) {
  for (const definition of definitionsOf(mon)) {
    const value = definition[hook];
    if (typeof value === 'function' ? value(context) : value) return true;
  }
  return false;
}

/** The highest a hook returns across both, for things that add rather than multiply. */
function highest(mon, hook, context) {
  let best = 0;

  for (const definition of definitionsOf(mon)) {
    const value = definition[hook];
    const got = typeof value === 'function' ? value(context) : value || 0;
    if (got > best) best = got;
  }

  return best;
}

/** Run a reacting hook on both definitions, in order. */
function run(mon, hook, context) {
  for (const definition of definitionsOf(mon)) {
    if (typeof definition[hook] === 'function') definition[hook](context);
  }
}

// ---------------------------------------------------------------------------
// The hooks the engine calls
// ---------------------------------------------------------------------------

/** Speed, after Choice Scarf, Quick Feet and Iron Ball. */
const speedMultiplier = (mon) => product(mon, 'speedMultiplier', { mon });

/** Does anything stop paralysis halving this Pokemon's speed? Quick Feet does. */
const ignoresParalysisSpeed = (mon) => flag(mon, 'ignoresParalysisSpeed', { mon });

/** Accuracy, after Compound Eyes and Hustle. */
function accuracy(attacker, defender, move) {
  return {
    multiplier: product(attacker, 'accuracyMultiplier', { attacker, defender, move, mon: attacker }),
    never:
      flag(attacker, 'neverMisses', { attacker, move }) ||
      flag(defender, 'neverMisses', { attacker, move }),
  };
}

/** Extra crit stages from Super Luck, Scope Lens and the species-locked items. */
const critStage = (attacker, move) =>
  highest(attacker, 'critStage', { attacker, move, mon: attacker });

/** Battle Armor and Shell Armor. */
const critAllowed = (defender) => !flag(defender, 'blocksCrits', { defender });

/**
 * Everything that changes a damage number, gathered in one call.
 *
 * Returned as separate lists because Utils/damage.js applies each kind at a
 * different step of the formula.
 */
function damageParts(attacker, defender, move, effectiveness, power = null) {
  const context = {
    attacker,
    defender,
    move,
    effectiveness,

    // The power for this hit: move.power, or the value from
    // Utils/movepower.js for variable-power moves (matters for Technician).
    power: power || move.power || null,

    contact: makesContact(move),
    mon: attacker,
  };

  const stabOverrides = definitionsOf(attacker)
    .map((definition) => definition.stabMultiplier)
    .filter((value) => typeof value === 'number');

  // Facade doubles under burn, poison or paralysis - not sleep or freeze - and
  // since Gen 6 the burn no longer halves it, so a burned Facade hits for 140.
  const facade =
    move.name === 'facade' && ['burn', 'poison', 'paralysis'].includes(attacker.status);

  return {
    attackModifiers: [product(attacker, 'attackMultiplier', context)],
    defenceModifiers: [product(defender, 'defenceMultiplier', { ...context, mon: defender })],
    extraModifiers: [
      product(attacker, 'damageOut', context),
      product(defender, 'damageIn', { ...context, mon: defender }),
      facade ? 2 : 1,
    ],
    stabMultiplier: stabOverrides.length ? Math.max(...stabOverrides) : null,
    ignoreBurn: facade || flag(attacker, 'ignoresBurn', context),
    critDamage: highest(attacker, 'critDamage', context) || 1,
  };
}

/**
 * Does the defender simply not take this move?
 *
 * Levitate, the absorbing abilities, Wonder Guard and an intact Air Balloon.
 * Returns what to do about it, or null if the move lands normally.
 */
function absorbs(defender, move, effectiveness) {
  if (move.damageClass === 'status') return null;

  for (const definition of definitionsOf(defender)) {
    if (typeof definition.absorbs !== 'function') continue;
    const answer = definition.absorbs({ defender, move, effectiveness, mon: defender });
    if (answer) return answer;
  }

  return null;
}

/**
 * Carry out an absorb. Returns an event describing it.
 *
 * Separate from absorbs() so the engine controls the log order.
 */
function applyAbsorb(defender, absorb, move, events) {
  const source = defender.abilityEffect && ABILITIES[defender.ability] === defender.abilityEffect
    ? displayAbility(defender.ability)
    : displayItem(defender.item);

  if (absorb.kind === 'heal') {
    const healed = heal(defender, chunk(defender, absorb.denominator), events, source);
    events.push({
      kind: 'absorb',
      name: defender.name,
      source,
      move: move.displayName,
      healed,
    });
    return;
  }

  if (absorb.kind === 'boost') {
    requestStage(defender, absorb.stat, absorb.delta, events, 'ability');
    events.push({ kind: 'absorb', name: defender.name, source, move: move.displayName });
    return;
  }

  if (absorb.kind === 'flag') {
    defender.flags[absorb.flag] = true;
    events.push({ kind: 'absorb', name: defender.name, source, move: move.displayName });
    return;
  }

  events.push({ kind: 'absorb', name: defender.name, source, move: move.displayName });
}

/**
 * Would this hit knock the Pokemon out, and does something stop it?
 *
 * Sturdy and Focus Sash. Returns the health to be left on instead, or null.
 */
function survives(defender, incoming, rng) {
  if (defender.hp - incoming > 0) return null;

  for (const definition of definitionsOf(defender)) {
    if (typeof definition.survives !== 'function') continue;

    const answer = definition.survives({ defender, incoming, rng, mon: defender });
    if (answer) {
      return {
        ...answer,
        source:
          definition === defender.abilityEffect
            ? displayAbility(defender.ability)
            : displayItem(defender.item),
      };
    }
  }

  return null;
}

/**
 * The defender's reaction to one hit landing.
 *
 * Runs per hit (Rocky Helmet triggers on every hit of Bullet Seed), and still
 * runs if the defender just fainted (for Aftermath).
 */
function afterHitTaken(context) {
  run(context.defender, 'onHitTaken', {
    ...context,
    contact: makesContact(context.move),
    mon: context.defender,
  });
}

/**
 * The attacker's reaction to a move it just landed.
 *
 * Runs once per move, not per hit (Life Orb recoil and Shell Bell healing
 * apply once, based on the total).
 */
function afterDealtDamage(context) {
  run(context.attacker, 'onDealtDamage', {
    ...context,
    contact: makesContact(context.move),
    mon: context.attacker,
  });
}

/** Moxie and Beast Boost. */
const afterKnockout = (attacker, defender, events) =>
  run(attacker, 'onKnockout', { attacker, defender, events, mon: attacker });

/** Immunity, Limber and the rest. True means the status may land. */
const statusAllowed = (target, status) => !flag(target, 'blocksStatus', { target, status, mon: target });

/** Inner Focus. */
const flinchAllowed = (target) => !flag(target, 'blocksFlinch', { target, mon: target });

/** Steadfast, when a flinch does land. */
const afterFlinch = (mon, events) => run(mon, 'onFlinch', { mon, events });

/**
 * The final stat change after Contrary, Simple, Clear Body and similar.
 * Zero means it is blocked.
 */
function stageDelta(target, stat, delta, fromFoe) {
  const context = { target, stat, delta, fromFoe, mon: target };

  let value = delta;

  if (flag(target, 'invertsStatChanges', context)) value = -value;
  if (flag(target, 'doublesStatChanges', context)) value *= 2;

  // Only drops caused by the opponent can be blocked; self-inflicted drops
  // (Close Combat) always apply.
  if (value < 0 && flag(target, 'blocksStatDrop', { ...context, delta: value })) return 0;

  return value;
}

/** Defiant and Competitive, once a drop has actually landed. */
const afterStatLowered = (target, stat, fromFoe, events) =>
  run(target, 'onStatLowered', { target, stat, fromFoe, events, mon: target });

/** Leftovers, Speed Boost, Shed Skin, the orbs. */
const endOfTurn = (mon, rng, events) => {
  if (mon.fainted) return;
  run(mon, 'endOfTurn', { mon, rng, events });
};

/**
 * What burn and poison should do to this Pokemon.
 *
 *   'normal'   the usual chip damage
 *   'handled'  something already dealt with it - Poison Heal
 *   'none'     it takes nothing - Magic Guard
 */
function residual(mon, events) {
  if (flag(mon, 'blocksIndirectDamage', { mon })) return 'none';

  for (const definition of definitionsOf(mon)) {
    if (typeof definition.residual !== 'function') continue;
    const answer = definition.residual({ mon, events });
    if (answer && answer !== 'normal') return answer;
  }

  return 'normal';
}

/** Rock Head, and Magic Guard. */
const recoilAllowed = (mon) =>
  !flag(mon, 'blocksRecoil', { mon }) && !flag(mon, 'blocksIndirectDamage', { mon });

/** Whether Life Orb, Black Sludge and Rocky Helmet can touch this Pokemon. */
const indirectAllowed = (mon) => !flag(mon, 'blocksIndirectDamage', { mon });

/** Berries. Called every time something's health or status moves. */
const healthChanged = (mon, events) => {
  if (mon.fainted) return;
  run(mon, 'onHealthChanged', { mon, events });
};

/** Intimidate, on the way in; Natural Cure and Regenerator, on the way out. */
const onSendOut = (mon, foe, events) => run(mon, 'onSendOut', { mon, foe, events });
const onWithdraw = (mon, events) => run(mon, 'onWithdraw', { mon, events });

/** Serene Grace doubles a secondary's chance; Sheer Force removes it. */
const secondaryChance = (attacker, base) => {
  if (flag(attacker, 'suppressesSecondaries', { attacker, mon: attacker })) return 0;
  return base * (highest(attacker, 'secondaryChance', { attacker, mon: attacker }) || 1);
};

/** Sheer Force also cancels the user's own stat boosts from a damaging move. */
const suppressesSecondaries = (attacker, move) =>
  move.damageClass !== 'status' &&
  flag(attacker, 'suppressesSecondaries', { attacker, move, mon: attacker });

/** Stench and King's Rock: a flinch chance on a move that had none. */
const addedFlinchChance = (attacker) =>
  highest(attacker, 'flinchChance', { attacker, mon: attacker });

/** Skill Link. */
const multiHitAlwaysMax = (attacker) =>
  flag(attacker, 'multiHitAlwaysMax', { attacker, mon: attacker });

/** Does a move that always knocks out get stopped? Sturdy stops it. */
const blocksOneHitKo = (defender) => flag(defender, 'blocksOneHitKo', { defender, mon: defender });

/**
 * Does this item do something when held?
 *
 * Utils/items.js uses this as a fallback for "is this holdable", since
 * PokeAPI's `attributes` are missing for many held items (Eviolite, Rocky
 * Helmet, Assault Vest, Air Balloon).
 */
const isHeldEffect = (slug) => Boolean(itemEffectFor(slug));

/** Has this Pokemon's ability got a definition? For .view and the reports. */
const isImplementedAbility = (slug) => Boolean(ABILITIES[slug]);

module.exports = {
  ABILITIES,
  HELD_ITEMS,
  ability,
  attach,
  itemEffectFor,
  typeBoostItems,
  makesContact,
  canStillEvolve,
  isHeldEffect,
  isImplementedAbility,

  // hooks
  speedMultiplier,
  ignoresParalysisSpeed,
  accuracy,
  critStage,
  critAllowed,
  damageParts,
  absorbs,
  applyAbsorb,
  survives,
  afterHitTaken,
  afterDealtDamage,
  afterKnockout,
  statusAllowed,
  flinchAllowed,
  afterFlinch,
  stageDelta,
  afterStatLowered,
  endOfTurn,
  residual,
  recoilAllowed,
  indirectAllowed,
  healthChanged,
  onSendOut,
  onWithdraw,
  secondaryChance,
  suppressesSecondaries,
  addedFlinchChance,
  multiHitAlwaysMax,
  blocksOneHitKo,

  // the deferred queue
  drain,
  requestStage,
  requestStatus,

  // shared with the engine so both hurt and heal the same way
  heal,
  chip,
  consumeItem,
  displayItem,
  displayAbility,
};

/** Does this move have a secondary effect at all? Sheer Force needs to know. */
function hasSecondary(move) {
  const meta = move.meta || {};
  if (meta.flinchChance > 0) return true;
  if (meta.ailmentChance > 0) return true;
  if (meta.statChance > 0) return true;
  return false;
}

// ---------------------------------------------------------------------------
// `node Utils/battleeffects.js` - what works and what does not.
// ---------------------------------------------------------------------------

if (require.main === module) {
  const implemented = Object.keys(ABILITIES);
  const known = allAbilityNames();
  const missing = known.filter((name) => !ABILITIES[name]);

  console.log(`abilities: ${implemented.length} of ${known.length} do something\n`);

  const unknown = implemented.filter((name) => !known.includes(name));
  if (unknown.length) {
    console.log(`  ${unknown.length} NAMED HERE BUT NOT IN Data/Abilities - typos?`);
    for (const name of unknown) console.log(`    ${name}`);
    console.log('');
  }

  const byHook = new Map();
  for (const [name, definition] of Object.entries(ABILITIES)) {
    for (const hook of Object.keys(definition)) {
      if (!byHook.has(hook)) byHook.set(hook, []);
      byHook.get(hook).push(name);
    }
  }

  console.log('which moment each one hooks:');
  for (const [hook, names] of [...byHook].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${String(names.length).padStart(3)}  ${hook}`);
  }

  const boosters = typeBoostItems();
  const handWritten = Object.keys(HELD_ITEMS);

  console.log(`\nheld items: ${handWritten.length} written out, ${boosters.size} derived`);

  const byType = new Map();
  for (const [, boost] of boosters) byType.set(boost.type, (byType.get(boost.type) || 0) + 1);
  console.log(
    `  the derived ones cover ${byType.size} types` +
      (byType.size === 18 ? ' - all of them' : ` - MISSING ${18 - byType.size}`)
  );

  console.log('\ncontact:');
  const samples = ['tackle', 'earthquake', 'flamethrower', 'close-combat', 'rock-slide', 'swords-dance'];
  for (const name of samples) {
    const move = content.move(name);
    if (!move) continue;
    console.log(`  ${name.padEnd(16)} ${makesContact(move) ? 'contact' : 'no contact'}`);
  }

  console.log(`\n${missing.length} abilities are still inert. The first twenty:`);
  for (const name of missing.slice(0, 20)) {
    const record = ability(name);
    console.log(`  ${record ? record.displayName : name}`);
  }
}
