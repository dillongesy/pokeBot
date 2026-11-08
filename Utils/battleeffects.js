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
 * Every ability a Pokemon in the data can have is here, along with every
 * held item the shops sell. A few are read by name in the engine instead
 * (Mold Breaker, Disguise, Illusion, Imposter, Neutralizing Gas, the
 * weather and terrain setters, the form changes); those are listed here
 * with an empty entry and a note saying where. Abilities that only help an
 * ally (Plus, Friend Guard, Battery...) do nothing in a single battle, as in
 * the games.
 *
 * The data has no contact, sound, punch, bite, pulse, ball, slicing, wind
 * or dance flags, so those are lists below, taken from the games.
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
  const state = battleOf(mon);
  mon.item = null;
  mon.itemEffect = null;
  mon.consumedItem = used;
  // Pickup can take an item used up this turn.
  mon.consumedTurn = state ? state.turn : null;
  // Unburden doubles its Speed now it holds nothing.
  if (used) vols(mon).unburden = true;
  // Belch needs a berry eaten first; Cud Chew eats it again next turn.
  if (/-berry$/.test(used || '')) {
    mon.ateBerry = true;
    if (abilityNow(mon) === 'cud-chew' && !vols(mon).cudChew) vols(mon).cudChew = { berry: used, turn: state ? state.turn : 0 };
  }
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
  'bone-rush', 'shadow-bone', 'rock-throw', 'rock-slide', 'stone-edge',
  'rock-blast', 'rock-wrecker', 'rock-tomb', 'diamond-storm',
  'sand-tomb', 'precipice-blades', 'thousand-arrows', 'thousand-waves', 'lands-wrath',
  'salt-cure', 'gigaton-hammer',

  // Projectiles
  'pin-missile', 'poison-sting', 'spike-cannon', 'twineedle', 'barrage',
  'egg-bomb', 'seed-bomb', 'magnet-bomb', 'bullet-seed', 'icicle-spear',
  'icicle-crash', 'ice-shard', 'razor-leaf', 'sacred-fire', 'smack-down',
  'attack-order', 'spirit-shackle', 'pyro-ball', 'triple-arrows', 'ivy-cudgel',
  'scale-shot', 'dragon-darts', 'grav-apple', 'mountain-gale', 'glacial-lance',
  'aqua-cutter', 'barb-barrage', 'flower-trick', 'order-up', 'petal-blizzard',
  'drum-beating', 'sappy-seed', 'poltergeist', 'psycho-cut', 'aura-wheel',

  // Charged and launched
  'freeze-shock', 'fusion-bolt', 'sky-attack', 'beak-blast', 'secret-power',
  'feint', 'tera-blast', 'blazing-torque', 'wicked-torque', 'noxious-torque',
  'combat-torque', 'magical-torque',

  // Explosions and self-destruction
  'self-destruct', 'explosion', 'mind-blown', 'misty-explosion',

  // Money, hazards and oddities
  'pay-day', 'present', 'natural-gift', 'beat-up', 'fling', 'metal-burst',
]);

function makesContact(move) {
  // Check the damage class, not power, so variable-power moves count.
  if (!move || move.damageClass === 'status') return false;
  if (move.damageClass !== 'physical') return false;
  return !NON_CONTACT_PHYSICAL.has(move.name);
}

// The imported move data has no punch, bite, pulse or bullet flags, so the
// abilities that need them (Iron Fist, Strong Jaw, Mega Launcher,
// Bulletproof) read these lists, taken from the games.

const PUNCHING = new Set([
  'bullet-punch', 'comet-punch', 'dizzy-punch', 'double-iron-bash', 'drain-punch', 'dynamic-punch',
  'fire-punch', 'focus-punch', 'hammer-arm', 'headlong-rush', 'ice-hammer', 'ice-punch', 'jet-punch',
  'mach-punch', 'mega-punch', 'meteor-mash', 'plasma-fists', 'power-up-punch', 'rage-fist',
  'shadow-punch', 'sky-uppercut', 'surging-strikes', 'thunder-punch', 'wicked-blow',
]);

const BITING = new Set([
  'bite', 'crunch', 'fire-fang', 'fishious-rend', 'hyper-fang', 'ice-fang', 'jaw-lock',
  'poison-fang', 'psychic-fangs', 'thunder-fang',
]);

const PULSES = new Set([
  'aura-sphere', 'dark-pulse', 'dragon-pulse', 'origin-pulse', 'terrain-pulse', 'water-pulse',
]);

const BULLETS = new Set([
  'acid-spray', 'aura-sphere', 'barrage', 'beak-blast', 'bullet-seed', 'egg-bomb', 'electro-ball',
  'energy-ball', 'focus-blast', 'gyro-ball', 'ice-ball', 'magnet-bomb', 'mist-ball', 'mud-bomb',
  'octazooka', 'pollen-puff', 'pyro-ball', 'rock-blast', 'rock-wrecker', 'searing-shot',
  'seed-bomb', 'shadow-ball', 'sludge-bomb', 'syrup-bomb', 'weather-ball', 'zap-cannon',
]);

/**
 * Mold Breaker: while it attacks, the target's abilities that would stop or
 * soften the move are ignored (Levitate, Sturdy, Multiscale, Filter...).
 * Reactions to being hit (Rough Skin, Static) still happen, as in the games.
 * The engine sets `abilityBroken` on the target for the length of the move.
 */
const BREAKABLE_HOOKS = new Set([
  'absorbs', 'survives', 'damageIn', 'defenceMultiplier', 'blocksCrits', 'blocksStatus',
  'blocksStatDrop', 'blocksOneHitKo', 'evasionMultiplier',
]);

const MOLD_BREAKERS = new Set(['mold-breaker', 'teravolt', 'turboblaze']);

/** Does this attacker ignore the target's ability? */
const breaksMold = (attacker) =>
  !attacker.abilitySuppressed && MOLD_BREAKERS.has(attacker.ability);

/**
 * The weather a Pokemon is fighting in (the engine links each one to the
 * field). None while Air Lock or Cloud Nine is out.
 */
const weatherAround = (mon) => (mon && mon.arena ? require('./field').weatherNow(mon.arena) : null);

/** The terrain a Pokemon is fighting on. */
const terrainAround = (mon) => (mon && mon.arena ? mon.arena.terrain || null : null);

/** The battle a Pokemon is in: Utils/battle.js links it through the field. */
const battleOf = (mon) => (mon && mon.arena && mon.arena.battle) || null;

/** Which side a Pokemon is on, or -1 outside a battle. */
function sideIndexOf(mon) {
  const state = battleOf(mon);
  return state ? state.sides.findIndex((side) => side.team.includes(mon)) : -1;
}

/** The Pokemon facing this one, or null. */
function foeOf(mon) {
  const state = battleOf(mon);
  const index = sideIndexOf(mon);
  if (!state || index < 0) return null;
  const other = state.sides[1 - index];
  return other.team[other.active] || null;
}

/** Its ability, unless it is switched off (Gastro Acid) or ignored (Mold Breaker). */
const abilityNow = (mon) => (mon && !mon.abilitySuppressed && !mon.abilityBroken ? mon.ability : null);

/** Its volatile state (cleared when it leaves the field). */
const vols = (mon) => mon.volatiles || (mon.volatiles = {});

/** A line in the battle log. */
const note = (events, text) => events.push({ kind: 'note', text });

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
    requestStatus(attacker, status, events, { by: defender.name, source: 'ability', from: defender });
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

// ---------------------------------------------------------------------------
// Move lists the data has no flags for, taken from the games
// ---------------------------------------------------------------------------

/** Sound moves: Soundproof, Punk Rock and Liquid Voice (and a Substitute) care. */
const SOUND_MOVES = new Set([
  'growl', 'roar', 'sing', 'supersonic', 'screech', 'snore', 'uproar', 'metal-sound',
  'grass-whistle', 'hyper-voice', 'perish-song', 'heal-bell', 'bug-buzz', 'chatter',
  'round', 'echoed-voice', 'relic-song', 'snarl', 'noble-roar', 'disarming-voice',
  'parting-shot', 'boomburst', 'confide', 'sparkling-aria', 'clanging-scales',
  'clangorous-soul', 'overdrive', 'eerie-spell', 'torch-song', 'alluring-voice',
  'psychic-noise',
]);

/** Slicing moves, for Sharpness. */
const SLICING = new Set([
  'aerial-ace', 'air-cutter', 'air-slash', 'aqua-cutter', 'behemoth-blade', 'bitter-blade', 'ceaseless-edge',
  'cross-poison', 'cut', 'fury-cutter', 'kowtow-cleave', 'leaf-blade', 'night-slash', 'population-bomb',
  'psycho-cut', 'psyblade', 'razor-leaf', 'razor-shell', 'sacred-sword', 'secret-sword', 'slash',
  'solar-blade', 'stone-axe', 'x-scissor', 'tachyon-cutter', 'mighty-cleave',
]);

/** Wind moves, for Wind Rider and Wind Power. */
const WIND = new Set([
  'aeroblast', 'air-cutter', 'bleakwind-storm', 'blizzard', 'fairy-wind', 'gust', 'heat-wave', 'hurricane',
  'icy-wind', 'petal-blizzard', 'sandsear-storm', 'sandstorm', 'springtide-storm', 'tailwind', 'twister',
  'whirlwind', 'wildbolt-storm',
]);

/** Dance moves, which Dancer copies. */
const DANCES = new Set([
  'aqua-step', 'clangorous-soul', 'dragon-dance', 'feather-dance', 'fiery-dance', 'lunar-dance', 'petal-dance',
  'quiver-dance', 'revelation-dance', 'swords-dance', 'teeter-dance', 'victory-dance',
]);

/** Abilities that can't be overwritten or swapped (Mummy, Wandering Spirit, Entrainment). */
const UNCHANGEABLE = new Set([
  'multitype', 'stance-change', 'schooling', 'comatose', 'shields-down', 'disguise', 'rks-system',
  'battle-bond', 'power-construct', 'ice-face', 'gulp-missile', 'zero-to-hero', 'commander', 'tera-shift',
  'as-one-glastrier', 'as-one-spectrier', 'protosynthesis', 'quark-drive', 'poison-puppeteer', 'mummy',
  'lingering-aroma',
]);

/** Items that can't be taken or swapped: Mega Stones, plates, memories, drives, masks, orbs. */
const lockedItem = (item) =>
  !item || (/ite(-[xyz])?$/.test(item) && item !== 'eviolite') || /-(plate|memory|drive)$/.test(item) ||
  item.endsWith('-mask') || ['red-orb', 'blue-orb', 'griseous-core', 'adamant-crystal', 'lustrous-globe',
    'rusted-sword', 'rusted-shield', 'booster-energy'].includes(item);

const isBerry = (slug) => /-berry$/.test(slug || '');

/** What a stat stage is worth (as Utils/damage.js has it). */
const stageWorth = (stage) => {
  const s = Math.max(-6, Math.min(6, Math.round(stage || 0)));
  return s >= 0 ? (2 + s) / 2 : 2 / (2 - s);
};

/** Did this hit take it from above half health to half or below? */
function crossedHalf(mon, dealt) {
  if (!dealt || mon.fainted) return false;
  const before = mon.hp + dealt;
  return before > mon.maxHp / 2 && mon.hp <= mon.maxHp / 2;
}

/** Emergency Exit and Wimp Out: dropping to half health sends it out. */
function halfExit() {
  return {
    onHitTaken: ({ defender, attacker, dealt }) => {
      if (attacker === defender || !crossedHalf(defender, dealt)) return;
      requestAct(defender, (e) => e.switchOut(defender));
    },
  };
}

/** Mummy and Lingering Aroma: touching it passes the ability on. */
function spreadAbility(slug) {
  return {
    onHitTaken: ({ attacker, defender, contact, events }) => {
      if (!contact || attacker.fainted || attacker === defender) return;
      if (UNCHANGEABLE.has(attacker.ability) || attacker.ability === slug) return;
      setAbility(attacker, slug);
      note(events, slug === 'mummy' ? `${attacker.name}'s Ability became Mummy!` : `A lingering aroma clings to ${attacker.name}!`);
    },
  };
}

/** An entry effect that only happens once a battle (Intrepid Sword, Dauntless Shield). */
function oncePerBattle(key, fn) {
  return {
    onSendOut: ({ mon, events }) => {
      const flags = mon.flags || (mon.flags = {});
      if (flags[key]) return;
      flags[key] = true;
      fn(mon, events);
    },
  };
}

/** Protosynthesis and Quark Drive, once the engine has picked the stat (vols(mon).paradox). */
function paradoxBoost() {
  return {
    attackMultiplier: ({ attacker, move }) => {
      const stat = vols(attacker).paradox;
      return (stat === 'attack' && move.damageClass === 'physical') ||
        (stat === 'specialAttack' && move.damageClass === 'special') ? 1.3 : 1;
    },
    defenceMultiplier: ({ mon, move }) => {
      const stat = vols(mon).paradox;
      return (stat === 'defense' && move.damageClass === 'physical') ||
        (stat === 'specialDefense' && move.damageClass === 'special') ? 1.3 : 1;
    },
    speedMultiplier: ({ mon }) => (vols(mon).paradox === 'speed' ? 1.5 : 1),
  };
}

/** Darmanitan: Zen Mode at half health or below. */
function zenCheck(mon) {
  if (mon.fainted || mon.transformed || !mon.form) return;
  const galar = /^Galar/.test(mon.form);
  const zen = /Zen$/.test(mon.form);
  if (share(mon) <= 0.5 && !zen) requestAct(mon, (e) => e.changeForm(mon, galar ? 'Galar Zen' : 'Zen', 'Zen Mode triggered!'));
  else if (share(mon) > 0.5 && zen) requestAct(mon, (e) => e.changeForm(mon, galar ? 'Galar Standard' : 'Standard', 'Zen Mode ended!'));
}

/** Wishiwashi: a school above a quarter health, from level 20. */
function schoolCheck(mon) {
  if (mon.fainted || mon.transformed || mon.level < 20) return;
  if (share(mon) > 0.25 && mon.form !== 'School') requestAct(mon, (e) => e.changeForm(mon, 'School', `${mon.name} formed a school!`));
  else if (share(mon) <= 0.25 && mon.form === 'School') requestAct(mon, (e) => e.changeForm(mon, 'Solo', `${mon.name} stopped schooling!`));
}

/** Minior: its shell above half health, its core below. */
function shieldsCheck(mon) {
  if (mon.fainted || mon.transformed) return;
  if (!mon.coreForm) mon.coreForm = mon.source && mon.source.form_folder && mon.source.form_folder !== 'Meteor' ? mon.source.form_folder : 'Red';
  if (share(mon) > 0.5 && mon.form !== 'Meteor') requestAct(mon, (e) => e.changeForm(mon, 'Meteor', 'Shields Down deactivated!'));
  else if (share(mon) <= 0.5 && mon.form === 'Meteor') requestAct(mon, (e) => e.changeForm(mon, mon.coreForm, 'Shields Down activated!'));
}

/** Who Unnerve frightens, as the games say it. */
const nervousTeam = (mon) => (sideIndexOf(mon) === 1 ? 'Your team' : 'The opposing team');

/** Is this Pokemon kept from eating Berries (Unnerve, As One)? */
function unnerved(mon) {
  const foe = foeOf(mon);
  return Boolean(foe && !foe.fainted && ['unnerve', 'as-one-glastrier', 'as-one-spectrier'].includes(abilityNow(foe)));
}

// ---------------------------------------------------------------------------
// Berries
// ---------------------------------------------------------------------------

/** HP berries go off at half health; Gluttony makes the quarter ones go off at half too. */
const pinchShare = (mon) => (abilityNow(mon) === 'gluttony' ? 0.5 : 0.25);

/**
 * What each held berry does: when it is eaten, and what eating it does.
 * `x` is 2 under Ripen. Berry Juice isn't a berry but works the same way.
 */
const cureStatus = (status) => ({
  when: (mon) => mon.status === status,
  eat: (mon, events, x, slug) => {
    if (mon.status !== status) return;
    events.push({ kind: 'cured', name: mon.name, status: mon.status, source: displayItem(slug) });
    mon.status = null;
    mon.statusTurns = 0;
    mon.toxicCounter = 0;
  },
});
const pinchStat = (stat) => ({
  when: (mon) => share(mon) <= pinchShare(mon),
  eat: (mon, events, x) => requestStage(mon, stat, x, events, 'item'),
});

const BERRIES = {
  'sitrus-berry': { when: (mon) => share(mon) <= 0.5, eat: (mon, events, x) => heal(mon, chunk(mon, 4) * x, events, 'Sitrus Berry') },
  'oran-berry': { when: (mon) => share(mon) <= 0.5, eat: (mon, events, x) => heal(mon, 10 * x, events, 'Oran Berry') },
  'berry-juice': { when: (mon) => share(mon) <= 0.5, eat: (mon, events) => heal(mon, 20, events, 'Berry Juice') },
  'lum-berry': {
    when: (mon) => Boolean(mon.status) || Boolean(vols(mon).confusion),
    eat: (mon, events) => {
      if (mon.status) {
        events.push({ kind: 'cured', name: mon.name, status: mon.status, source: 'Lum Berry' });
        mon.status = null;
        mon.statusTurns = 0;
        mon.toxicCounter = 0;
      }
      if (vols(mon).confusion) {
        delete vols(mon).confusion;
        events.push({ kind: 'confusion-cured', name: mon.name, source: 'Lum Berry' });
      }
    },
  },
  'persim-berry': {
    when: (mon) => Boolean(vols(mon).confusion),
    eat: (mon, events) => {
      if (!vols(mon).confusion) return;
      delete vols(mon).confusion;
      events.push({ kind: 'confusion-cured', name: mon.name, source: 'Persim Berry' });
    },
  },
  'cheri-berry': cureStatus('paralysis'),
  'chesto-berry': cureStatus('sleep'),
  'pecha-berry': cureStatus('poison'),
  'rawst-berry': cureStatus('burn'),
  'aspear-berry': cureStatus('freeze'),
  'liechi-berry': pinchStat('attack'),
  'ganlon-berry': pinchStat('defense'),
  'petaya-berry': pinchStat('specialAttack'),
  'apicot-berry': pinchStat('specialDefense'),
  'salac-berry': pinchStat('speed'),
};

/**
 * Eat a berry: its effect, doubled by Ripen, and Cheek Pouch's heal.
 * `forced` eats it whatever the situation (Cud Chew, Bug Bite).
 *
 * @returns {boolean} whether it is a berry this knows
 */
function eatBerry(mon, slug, events, { forced = false } = {}) {
  const berry = BERRIES[slug];
  if (!berry || mon.fainted) return false;
  if (!forced && !berry.when(mon)) return false;

  const x = isBerry(slug) && abilityNow(mon) === 'ripen' ? 2 : 1;
  berry.eat(mon, events, x, slug);

  if (isBerry(slug)) {
    mon.ateBerry = true;
    if (abilityNow(mon) === 'cheek-pouch' && !vols(mon).healBlock) heal(mon, chunk(mon, 3), events, 'Cheek Pouch');
  }
  return true;
}

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

  // Priority boosts, read by the engine's turn order.
  prankster: { priorityBonus: ({ move }) => (move && move.damageClass === 'status' ? 1 : 0) },
  'gale-wings': {
    priorityBonus: ({ mon, move }) => (move && lower(move.type) === 'flying' && atFullHealth(mon) ? 1 : 0),
  },
  // Healing and draining moves (Recover, Drain Punch, Giga Drain).
  triage: {
    priorityBonus: ({ move }) => {
      const meta = (move && move.meta) || {};
      return meta.healing > 0 || meta.drain > 0 ? 3 : 0;
    },
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
    // Rain heals an eighth; sun takes an eighth.
    weatherEndOfTurn: ({ mon, events }) => {
      const weather = weatherAround(mon);
      if (weather === 'rain') heal(mon, chunk(mon, 8), events, 'Dry Skin');
      else if (weather === 'sun') chip(mon, chunk(mon, 8), events, 'Dry Skin');
    },
    absorbs: ({ move }) => (lower(move.type) === 'water' ? { kind: 'heal', denominator: 4 } : null),
    damageIn: ({ move }) => (lower(move.type) === 'fire' ? 1.25 : 1),
  },

  // -------------------------------------------------------------------------
  // Reactions
  // -------------------------------------------------------------------------
  'rough-skin': contactChip(8, 'Rough Skin'),
  'iron-barbs': contactChip(8, 'Iron Barbs'),

  // A third of contact hits leave the attacker infatuated, if the genders
  // are opposite.
  'cute-charm': {
    onHitTaken: ({ attacker, contact, rng, events, defender }) => {
      if (!contact || attacker.fainted || rng() >= 0.3) return;
      infatuate(attacker, defender, events, 'Cute Charm');
    },
  },

  static: contactStatus('paralysis'),
  'flame-body': contactStatus('burn'),
  'poison-point': contactStatus('poison'),

  'effect-spore': {
    onHitTaken: ({ attacker, contact, rng, events, defender }) => {
      if (!contact || attacker.fainted) return;
      const roll = rng() * 100;
      if (roll >= 30) return;
      const status = roll < 10 ? 'sleep' : roll < 20 ? 'paralysis' : 'poison';
      requestStatus(attacker, status, events, { by: defender.name, source: 'ability', from: defender });
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
      // Damp stops it going off.
      if (abilityNow(attacker) === 'damp') return;
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
    onSendOut: ({ mon, foe, events }) => {
      if (!foe || foe.fainted) return;
      events.push({ kind: 'note', text: `**${mon.name}**'s Intimidate!` });
      // Guard Dog turns it round.
      if (!foe.abilitySuppressed && foe.ability === 'guard-dog') {
        requestStage(foe, 'attack', 1, events, 'ability');
        return;
      }
      // Since Gen 8 these shrug it off.
      if (!foe.abilitySuppressed && INTIMIDATE_PROOF.has(foe.ability)) {
        events.push({ kind: 'note', text: `${foe.name}'s Attack was not lowered!` });
        return;
      }
      requestStage(foe, 'attack', -1, events, 'ability', true);
    },
  },

  // Eelevate (Mega Eelektross): floats like Levitate, and a knockout raises
  // its highest stat like Beast Boost. Hazards are handled with Levitate in
  // Utils/conditions.js.
  eelevate: {
    absorbs: ({ move }) => (lower(move.type) === 'ground' ? { kind: 'blocked' } : null),
    onKnockout: ({ attacker, events }) => {
      const order = ['attack', 'defense', 'specialAttack', 'specialDefense', 'speed'];
      const best = order.reduce((top, stat) => (attacker.stats[stat] > attacker.stats[top] ? stat : top));
      requestStage(attacker, best, 1, events, 'ability');
    },
  },

  // -------------------------------------------------------------------------
  // Mega abilities and the rest of their kind
  // -------------------------------------------------------------------------

  // Contact moves hit 30% harder.
  'tough-claws': { damageOut: ({ contact }) => (contact ? 1.3 : 1) },
  'iron-fist': { damageOut: ({ move }) => (PUNCHING.has(move.name) ? 1.2 : 1) },
  'strong-jaw': { damageOut: ({ move }) => (BITING.has(move.name) ? 1.5 : 1) },
  'mega-launcher': { damageOut: ({ move }) => (PULSES.has(move.name) ? 1.5 : 1) },
  'fire-mane': typeBoost('fire', 1.5),

  // Aerilate, Pixilate, Refrigerate and Dragonize turn Normal moves into
  // their type (done by the engine, which marks the move) and boost them.
  aerilate: { damageOut: ({ move }) => (move.ateBoosted ? 1.2 : 1) },
  pixilate: { damageOut: ({ move }) => (move.ateBoosted ? 1.2 : 1) },
  refrigerate: { damageOut: ({ move }) => (move.ateBoosted ? 1.2 : 1) },
  dragonize: { damageOut: ({ move }) => (move.ateBoosted ? 1.2 : 1) },

  // Ball and bomb moves don't touch it.
  bulletproof: {
    absorbs: ({ move }) => (BULLETS.has(move.name) ? { kind: 'blocked' } : null),
  },

  // Fairy and Dark moves from either side hit a third harder (worked out in
  // damageParts, with Aura Break turning them round).
  'fairy-aura': {},
  'dark-aura': {},
  'aura-break': {},
  // The Ruin abilities lower everyone else's stat (also in damageParts).
  'beads-of-ruin': {},
  'sword-of-ruin': {},
  'tablets-of-ruin': {},
  'vessel-of-ruin': {},

  // Sand Force: Rock, Ground and Steel moves 30% harder in a sandstorm.
  // Like Sand Veil and Sand Rush, it is never hurt by the sand
  // (Utils/battle.js checks SAND_PROOF).
  'sand-force': {
    damageOut: ({ attacker, move }) =>
      weatherAround(attacker) === 'sandstorm' && ['rock', 'ground', 'steel'].includes(lower(move.type)) ? 1.3 : 1,
  },

  // Solar Power: Special Attack x1.5 in sun, at 1/8 of its health a turn.
  'solar-power': {
    attackMultiplier: ({ attacker, move }) =>
      weatherAround(attacker) === 'sun' && move.damageClass === 'special' ? 1.5 : 1,
    weatherEndOfTurn: ({ mon, events }) => {
      if (weatherAround(mon) === 'sun') chip(mon, chunk(mon, 8), events, 'Solar Power');
    },
  },

  // Swift Swim: Speed doubles in rain.
  'swift-swim': { speedMultiplier: ({ mon }) => (weatherAround(mon) === 'rain' ? 2 : 1) },

  // Mega Sol (Mega Meganium): its moves act as if the sun were harsh, unless
  // it already is (then the weather has done it).
  'mega-sol': {
    damageOut: ({ attacker, move }) => {
      if (weatherAround(attacker) === 'sun') return 1;
      const type = lower(move.type);
      return type === 'fire' ? 1.5 : type === 'water' ? 0.5 : 1;
    },
  },

  // Berserk: dropping below half health from a hit raises Special Attack.
  berserk: {
    onHitTaken: ({ defender, dealt, events }) => {
      if (!dealt || defender.fainted) return;
      const before = defender.hp + dealt;
      if (before > defender.maxHp / 2 && defender.hp <= defender.maxHp / 2) {
        requestStage(defender, 'specialAttack', 1, events, 'ability');
      }
    },
  },

  // Spicy Spray (Mega Scovillain): taking damage burns the attacker.
  'spicy-spray': {
    onHitTaken: ({ attacker, defender, dealt, events }) => {
      if (!dealt || attacker.fainted || attacker === defender) return;
      requestStatus(attacker, 'burn', events, { by: defender.name, source: 'ability', from: defender });
    },
  },

  // Innards Out: fainting to a hit deals the attacker the health it had left.
  'innards-out': {
    onHitTaken: ({ attacker, defender, dealt, events }) => {
      if (!dealt || !defender.fainted || attacker.fainted || attacker === defender) return;
      chip(attacker, dealt, events, 'Innards Out');
    },
  },

  // Read by name elsewhere: Mold Breaker (the engine), Magic Bounce, Shadow
  // Tag, Scrappy, Infiltrator, Protean, Parental Bond, Unseen Fist and
  // Piercing Drill (Utils/battle.js and Utils/conditions.js), and the weather
  // and terrain setters (Utils/battle.js's entry abilities). Listed so the
  // coverage report counts them.
  trace: {},
  'mold-breaker': {},
  teravolt: {},
  turboblaze: {},
  'magic-bounce': {},
  'shadow-tag': {},
  scrappy: {},
  infiltrator: {},
  protean: {},
  libero: {},
  'parental-bond': {},
  'unseen-fist': {},
  'piercing-drill': {},
  drought: {},
  drizzle: {},
  'sand-stream': {},
  'snow-warning': {},
  'electric-surge': {},
  'psychic-surge': {},
  'grassy-surge': {},
  'misty-surge': {},
  'desolate-land': {},
  'primordial-sea': {},
  'delta-stream': {},
  'sand-rush': { speedMultiplier: ({ mon }) => (weatherAround(mon) === 'sandstorm' ? 2 : 1) },
  chlorophyll: { speedMultiplier: ({ mon }) => (weatherAround(mon) === 'sun' ? 2 : 1) },
  'slush-rush': { speedMultiplier: ({ mon }) => (['hail', 'snow'].includes(weatherAround(mon)) ? 2 : 1) },

  // Doubles only (they work on an ally); nothing to do in a single battle.
  stalwart: {},
  healer: {},

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

  // Not on the turn it was switched in.
  'speed-boost': {
    lateEndOfTurn: ({ mon, events }) => {
      const state = battleOf(mon);
      if (state && mon.switchedInTurn === state.turn) return;
      requestStage(mon, 'speed', 1, events, 'ability');
    },
  },

  'clear-body': statProof('attack', 'defense', 'specialAttack', 'specialDefense', 'speed', 'accuracy', 'evasion'),
  'white-smoke': statProof('attack', 'defense', 'specialAttack', 'specialDefense', 'speed', 'accuracy', 'evasion'),
  'full-metal-body': statProof('attack', 'defense', 'specialAttack', 'specialDefense', 'speed', 'accuracy', 'evasion'),
  'hyper-cutter': statProof('attack'),
  'keen-eye': { ...statProof('accuracy'), ignoresEvasion: true },
  'big-pecks': statProof('defense'),

  contrary: { invertsStatChanges: true },
  simple: { doublesStatChanges: true },

  defiant: spiteBoost('attack'),
  competitive: spiteBoost('specialAttack'),

  'rock-head': { blocksRecoil: true },

  // -------------------------------------------------------------------------
  // Weather and terrain
  // -------------------------------------------------------------------------
  'rain-dish': {
    weatherEndOfTurn: ({ mon, events }) => {
      if (weatherAround(mon) === 'rain') heal(mon, chunk(mon, 16), events, 'Rain Dish');
    },
  },
  'ice-body': {
    weatherEndOfTurn: ({ mon, events }) => {
      if (['hail', 'snow'].includes(weatherAround(mon))) heal(mon, chunk(mon, 16), events, 'Ice Body');
    },
  },
  hydration: {
    endOfTurn: ({ mon, events }) => {
      if (!mon.status || weatherAround(mon) !== 'rain') return;
      events.push({ kind: 'cured', name: mon.name, status: mon.status, source: 'Hydration' });
      mon.status = null;
      mon.statusTurns = 0;
      mon.toxicCounter = 0;
    },
  },
  'leaf-guard': { blocksStatus: ({ mon }) => weatherAround(mon) === 'sun' },
  'sand-veil': { evasionMultiplier: ({ mon }) => (weatherAround(mon) === 'sandstorm' ? 0.8 : 1) },
  'snow-cloak': { evasionMultiplier: ({ mon }) => (['hail', 'snow'].includes(weatherAround(mon)) ? 0.8 : 1) },
  'surge-surfer': { speedMultiplier: ({ mon }) => (terrainAround(mon) === 'electric' ? 2 : 1) },
  'grass-pelt': {
    defenceMultiplier: ({ mon, move }) => (terrainAround(mon) === 'grassy' && move.damageClass === 'physical' ? 1.5 : 1),
  },
  // Miraidon and Koraidon: they lay their field as they come out (the
  // engine), and fight a third harder on it.
  'hadron-engine': {
    attackMultiplier: ({ attacker, move }) =>
      terrainAround(attacker) === 'electric' && move.damageClass === 'special' ? 5461 / 4096 : 1,
  },
  'orichalcum-pulse': {
    attackMultiplier: ({ attacker, move }) =>
      weatherAround(attacker) === 'sun' && move.damageClass === 'physical' ? 5461 / 4096 : 1,
  },
  // Protosynthesis and Quark Drive: the highest stat goes up while the sun
  // shines (or the terrain is electric), or once for a Booster Energy. The
  // engine works out which stat (see fieldAbilities in Utils/battle.js).
  protosynthesis: paradoxBoost(),
  'quark-drive': paradoxBoost(),
  'flower-gift': {
    attackMultiplier: ({ attacker, move }) => (weatherAround(attacker) === 'sun' && move.damageClass === 'physical' ? 1.5 : 1),
    defenceMultiplier: ({ mon, move }) => (weatherAround(mon) === 'sun' && move.damageClass === 'special' ? 1.5 : 1),
  },
  // Air Lock and Cloud Nine are read by Utils/field.js (weatherNow).
  'air-lock': { onSendOut: ({ events }) => note(events, 'The effects of the weather disappeared.') },
  'cloud-nine': { onSendOut: ({ events }) => note(events, 'The effects of the weather disappeared.') },
  // Mimicry and Forecast are worked out by the engine (fieldAbilities).
  mimicry: {},
  forecast: {},

  // Being hit sets a field.
  'seed-sower': {
    onHitTaken: ({ defender, dealt }) => {
      if (dealt > 0) requestAct(defender, (e) => e.setTerrain('grassy', defender), true);
    },
  },
  'sand-spit': {
    onHitTaken: ({ defender, dealt }) => {
      if (dealt > 0) requestAct(defender, (e) => e.setWeather('sandstorm', defender), true);
    },
  },
  'toxic-debris': {
    onHitTaken: ({ defender, attacker, move, dealt, events }) => {
      if (!dealt || move.damageClass !== 'physical') return;
      requestAct(defender, (e) => {
        const side = e.state.sides[e.sideOf(attacker)];
        if (!side) return;
        const c = side.conditions || (side.conditions = {});
        if ((c.toxicSpikes || 0) >= 2) return;
        c.toxicSpikes = (c.toxicSpikes || 0) + 1;
        note(events, `Poison spikes were scattered on the ground all around ${side.name}'s team!`);
      }, true);
    },
  },

  // -------------------------------------------------------------------------
  // Reactions to being hit
  // -------------------------------------------------------------------------
  'wind-power': {
    onHitTaken: ({ defender, move, dealt, events }) => {
      if (!dealt || defender.fainted || !WIND.has(move.name)) return;
      vols(defender).charged = true;
      note(events, `Being hit by ${move.displayName} charged ${defender.name} with power!`);
    },
  },
  electromorphosis: {
    onHitTaken: ({ defender, move, dealt, events }) => {
      if (!dealt || defender.fainted) return;
      vols(defender).charged = true;
      note(events, `Being hit by ${move.displayName} charged ${defender.name} with power!`);
    },
  },
  'wind-rider': {
    absorbs: ({ move }) => (WIND.has(move.name) && move.damageClass !== 'status' ? { kind: 'boost', stat: 'attack', delta: 1 } : null),
  },
  'steam-engine': {
    onHitTaken: ({ defender, move, dealt, events }) => {
      if (dealt && ['fire', 'water'].includes(lower(move.type))) requestStage(defender, 'speed', 6, events, 'ability');
    },
  },
  'water-compaction': {
    onHitTaken: ({ defender, move, dealt, events }) => {
      if (dealt && lower(move.type) === 'water') requestStage(defender, 'defense', 2, events, 'ability');
    },
  },
  stamina: {
    onHitTaken: ({ defender, dealt, events }) => {
      if (dealt) requestStage(defender, 'defense', 1, events, 'ability');
    },
  },
  'cotton-down': {
    onHitTaken: ({ defender, attacker, dealt, events }) => {
      if (!dealt || attacker.fainted || attacker === defender) return;
      note(events, `${defender.name}'s Cotton Down!`);
      requestStage(attacker, 'speed', -1, events, 'ability', true);
    },
  },
  'anger-shell': {
    onHitTaken: ({ defender, dealt, events }) => {
      if (!crossedHalf(defender, dealt)) return;
      for (const stat of ['attack', 'specialAttack', 'speed']) requestStage(defender, stat, 1, events, 'ability');
      for (const stat of ['defense', 'specialDefense']) requestStage(defender, stat, -1, events, 'ability');
    },
  },
  'emergency-exit': halfExit(),
  'wimp-out': halfExit(),
  'cursed-body': {
    onHitTaken: ({ defender, attacker, move, dealt, rng, events }) => {
      if (!dealt || attacker.fainted || attacker === defender || move.name === 'struggle') return;
      const av = vols(attacker);
      if (av.disable || rng() >= 0.3) return;
      if (!attacker.moves.some((m) => m.name === move.name)) return;
      av.disable = { move: move.name, turns: 4 };
      note(events, `${attacker.name}'s ${move.displayName} was disabled by ${defender.name}'s Cursed Body!`);
    },
  },
  'color-change': {
    onHitTaken: ({ defender, move, dealt, events }) => {
      const type = lower(move.type);
      if (!dealt || defender.fainted || !type || (defender.types.length === 1 && lower(defender.types[0]) === type)) return;
      defender.types = [type];
      events.push({ kind: 'retyped', name: defender.name, types: defender.types });
    },
  },
  // Contact passes the ability on.
  mummy: spreadAbility('mummy'),
  'lingering-aroma': spreadAbility('lingering-aroma'),
  'wandering-spirit': {
    onHitTaken: ({ defender, attacker, contact, events }) => {
      if (!contact || attacker.fainted || defender.fainted) return;
      if (UNCHANGEABLE.has(attacker.ability) || attacker.ability === 'wandering-spirit') return;
      const theirs = attacker.ability;
      setAbility(attacker, 'wandering-spirit');
      setAbility(defender, theirs);
      note(events, `${defender.name} swapped Abilities with ${attacker.name}!`);
    },
  },
  'perish-body': {
    onHitTaken: ({ defender, attacker, contact, events }) => {
      if (!contact || attacker.fainted) return;
      const dv = vols(defender);
      const av = vols(attacker);
      if (dv.perish !== undefined && av.perish !== undefined) return;
      if (dv.perish === undefined && !defender.fainted) dv.perish = 4;
      if (av.perish === undefined) av.perish = 4;
      note(events, 'Both Pokemon will faint in three turns!');
    },
  },
  pickpocket: {
    onHitTaken: ({ defender, attacker, contact, events }) => {
      if (!contact || defender.fainted || defender.item || !attacker.item) return;
      if (lockedItem(attacker.item) || abilityNow(attacker) === 'sticky-hold') return;
      const item = attacker.item;
      setItem(attacker, null);
      setItem(defender, item);
      note(events, `${defender.name} stole ${attacker.name}'s ${displayItem(item)}!`);
    },
  },
  // Gulp Missile: a caught Arrokuda or Pikachu is spat at whoever hits it.
  'gulp-missile': {
    onHitTaken: ({ defender, attacker, dealt, events }) => {
      if (!dealt || !['Gulping', 'Gorging'].includes(defender.form)) return;
      const gorging = defender.form === 'Gorging';
      requestAct(defender, (e) => {
        e.changeForm(defender, 'Default', '');
        if (attacker.fainted) return;
        chip(attacker, chunk(attacker, 4), events, 'Gulp Missile');
        if (attacker.fainted) return;
        if (gorging) e.applyStatus(attacker, 'paralysis', defender);
        else e.applyStage(attacker, 'defense', -1, true);
      }, true);
    },
  },
  // Illusion is broken by any damaging hit (the engine checks).
  illusion: {},
  // Disguise and Ice Face take the first hit (the engine, in landHit).
  disguise: {},
  'ice-face': {
    lateEndOfTurn: ({ mon }) => {
      if (mon.form !== 'Noice' || !['hail', 'snow'].includes(weatherAround(mon))) return;
      requestAct(mon, (e) => e.changeForm(mon, 'Ice', `${mon.name} transformed!`));
    },
  },

  // -------------------------------------------------------------------------
  // Attacking
  // -------------------------------------------------------------------------
  'poison-touch': {
    onDealtDamage: ({ attacker, defender, contact, rng, events }) => {
      if (!contact || defender.fainted || rng() >= 0.3) return;
      requestStatus(defender, 'poison', events, { by: attacker.name, source: 'ability', from: attacker });
    },
  },
  'toxic-chain': {
    onDealtDamage: ({ attacker, defender, rng, events }) => {
      if (defender.fainted || rng() >= 0.3) return;
      requestStatus(defender, 'poison', events, { by: attacker.name, source: 'ability', badly: true, from: attacker });
    },
  },
  magician: {
    onDealtDamage: ({ attacker, defender, events }) => {
      if (attacker.item || !defender.item || lockedItem(defender.item) || abilityNow(defender) === 'sticky-hold') return;
      const item = defender.item;
      setItem(defender, null);
      setItem(attacker, item);
      note(events, `${attacker.name} stole ${defender.name}'s ${displayItem(item)}!`);
    },
  },
  merciless: { forcesCrit: ({ defender }) => defender.status === 'poison' },
  'gorilla-tactics': {
    attackMultiplier: ({ move }) => (move.damageClass === 'physical' ? 1.5 : 1),
  },
  sharpness: { damageOut: ({ move }) => (SLICING.has(move.name) ? 1.5 : 1) },
  'punk-rock': {
    damageOut: ({ move }) => (SOUND_MOVES.has(move.name) ? 1.3 : 1),
    damageIn: ({ move }) => (SOUND_MOVES.has(move.name) ? 0.5 : 1),
  },
  // Liquid Voice and Normalize change the move's type (the engine);
  // Normalize and Galvanize also hit 20% harder.
  'liquid-voice': {},
  normalize: { damageOut: ({ move }) => (move.normalized ? 1.2 : 1) },
  galvanize: { damageOut: ({ move }) => (move.ateBoosted ? 1.2 : 1) },
  'long-reach': { noContact: true },
  neuroforce: { damageOut: ({ effectiveness }) => (effectiveness > 1 ? 1.25 : 1) },
  'victory-star': { accuracyMultiplier: () => 1.1 },
  defeatist: {
    attackMultiplier: ({ attacker }) => (share(attacker) <= 0.5 ? 0.5 : 1),
  },
  rivalry: {
    damageOut: ({ attacker, defender }) => {
      const genders = [attacker.gender, defender.gender];
      if (!genders.every((g) => g === 'male' || g === 'female')) return 1;
      return genders[0] === genders[1] ? 1.25 : 0.75;
    },
  },
  // Analytic: moving after the target.
  analytic: { damageOut: ({ attacker }) => (vols(attacker).movingLast ? 1.3 : 1) },
  // Stakeout: the target switched in this turn.
  stakeout: {
    damageOut: ({ defender }) => {
      const state = battleOf(defender);
      return state && defender.switchedInTurn === state.turn ? 2 : 1;
    },
  },
  'supreme-overlord': {
    damageOut: ({ attacker }) => {
      const fallen = (attacker.allies || []).filter((ally) => ally !== attacker && ally.fainted).length;
      return 1 + 0.1 * Math.min(5, fallen);
    },
  },
  // Mind's Eye: Normal and Fighting hit Ghosts (Utils/conditions.js), and
  // evasion and accuracy drops are ignored.
  'minds-eye': { ...statProof('accuracy'), ignoresEvasion: true },
  illuminate: { ...statProof('accuracy'), ignoresEvasion: true },
  // Battle Bond (Gen 9): a knockout raises Attack, Sp. Atk and Speed, once.
  'battle-bond': {
    onKnockout: ({ attacker, events }) => {
      const v = attacker.flags || (attacker.flags = {});
      if (v.battleBond) return;
      v.battleBond = true;
      note(events, `${attacker.name} became fully charged due to its bond with its Trainer!`);
      for (const stat of ['attack', 'specialAttack', 'speed']) requestStage(attacker, stat, 1, events, 'ability');
    },
  },
  'soul-heart': {
    onKnockout: ({ attacker, events }) => requestStage(attacker, 'specialAttack', 1, events, 'ability'),
  },

  // -------------------------------------------------------------------------
  // Defending
  // -------------------------------------------------------------------------
  'tera-shell': {},
  'good-as-gold': {},
  'armor-tail': {},
  dazzling: {},
  'queenly-majesty': {},
  'shield-dust': {},
  'pastel-veil': statusProof('poison'),
  'flower-veil': {
    blocksStatus: ({ mon }) => isType(mon, 'grass'),
    blocksStatDrop: ({ mon, fromFoe }) => fromFoe && isType(mon, 'grass'),
  },
  // Wonder Skin and Tangled Feet make the Pokemon harder to hit (the engine
  // reads Wonder Skin for status moves).
  'wonder-skin': {},
  'tangled-feet': { evasionMultiplier: ({ mon }) => (vols(mon).confusion ? 0.5 : 1) },
  unaware: {},
  'heavy-metal': {},
  'light-metal': {},
  synchronize: {},
  'liquid-ooze': {},
  'magnet-pull': {},
  'arena-trap': {},
  'guard-dog': {},
  'poison-puppeteer': {},
  corrosion: {},

  // -------------------------------------------------------------------------
  // Turns, items and berries
  // -------------------------------------------------------------------------
  truant: {},
  'early-bird': {},
  pressure: { onSendOut: ({ mon, events }) => note(events, `${mon.name} is exerting its pressure!`) },
  unnerve: { onSendOut: ({ mon, events }) => note(events, `${nervousTeam(mon)} is too nervous to eat Berries!`) },
  'as-one-glastrier': {
    onSendOut: ({ mon, events }) => note(events, `${mon.name} has two Abilities! ${nervousTeam(mon)} is too nervous to eat Berries!`),
    ...killBoost('attack'),
  },
  'as-one-spectrier': {
    onSendOut: ({ mon, events }) => note(events, `${mon.name} has two Abilities! ${nervousTeam(mon)} is too nervous to eat Berries!`),
    ...killBoost('specialAttack'),
  },
  unburden: { speedMultiplier: ({ mon }) => (vols(mon).unburden && !mon.item ? 2 : 1) },
  klutz: {},
  gluttony: {},
  ripen: {},
  'cheek-pouch': {},
  'cud-chew': {
    lateEndOfTurn: ({ mon, events }) => {
      const v = vols(mon);
      const state = battleOf(mon);
      if (!v.cudChew || (state && v.cudChew.turn >= state.turn)) return;
      const berry = v.cudChew.berry;
      delete v.cudChew;
      note(events, `${mon.name} ate its ${displayItem(berry)} again!`);
      eatBerry(mon, berry, events, { forced: true });
    },
  },
  harvest: {
    lateEndOfTurn: ({ mon, rng, events }) => {
      if (mon.item || !isBerry(mon.consumedItem)) return;
      if (weatherAround(mon) !== 'sun' && rng() >= 0.5) return;
      const berry = mon.consumedItem;
      mon.consumedItem = null;
      setItem(mon, berry);
      note(events, `${mon.name} harvested one ${displayItem(berry)}!`);
      healthChanged(mon, events);
    },
  },
  pickup: {
    lateEndOfTurn: ({ mon, events }) => {
      const foe = foeOf(mon);
      const state = battleOf(mon);
      if (mon.item || !foe || !foe.consumedItem || !state || foe.consumedTurn !== state.turn) return;
      const item = foe.consumedItem;
      foe.consumedItem = null;
      setItem(mon, item);
      note(events, `${mon.name} found one ${displayItem(item)}!`);
      healthChanged(mon, events);
    },
  },
  moody: {
    lateEndOfTurn: ({ mon, rng, events }) => {
      const stats = ['attack', 'defense', 'specialAttack', 'specialDefense', 'speed'];
      const up = stats.filter((s) => (mon.stages[s] || 0) < 6);
      const raised = up.length ? up[Math.floor(rng() * up.length)] : null;
      const down = stats.filter((s) => s !== raised && (mon.stages[s] || 0) > -6);
      const lowered = down.length ? down[Math.floor(rng() * down.length)] : null;
      if (raised) requestStage(mon, raised, 2, events, 'ability');
      if (lowered) requestStage(mon, lowered, -1, events, 'ability');
    },
  },
  'bad-dreams': {
    lateEndOfTurn: ({ mon, events }) => {
      const foe = foeOf(mon);
      if (!foe || foe.fainted || foe.status !== 'sleep') return;
      chip(foe, chunk(foe, 8), events, `${foe.name} is tormented!`, 'hurt');
    },
  },
  'slow-start': {
    onSendOut: ({ mon, events }) => {
      vols(mon).slowStart = 5;
      note(events, `${mon.name} can't get it going!`);
    },
    attackMultiplier: ({ attacker, move }) => (vols(attacker).slowStart && move.damageClass === 'physical' ? 0.5 : 1),
    speedMultiplier: ({ mon }) => (vols(mon).slowStart ? 0.5 : 1),
    lateEndOfTurn: ({ mon, events }) => {
      const v = vols(mon);
      if (!v.slowStart) return;
      v.slowStart -= 1;
      if (v.slowStart <= 0) {
        delete v.slowStart;
        note(events, `${mon.name} finally got its act together!`);
      }
    },
  },
  'quick-draw': {
    bracketShift: ({ rng, move }) => (move && move.damageClass !== 'status' && rng() < 0.3 ? 1 : 0),
  },
  stall: { bracketShift: () => -1 },
  'mycelium-might': { bracketShift: ({ move }) => (move && move.damageClass === 'status' ? -1 : 0) },
  opportunist: {},
  dancer: {},

  // -------------------------------------------------------------------------
  // Coming out
  // -------------------------------------------------------------------------
  download: {
    onSendOut: ({ mon, foe, events }) => {
      if (!foe || foe.fainted) return;
      const def = foe.stats.defense * stageWorth(foe.stages.defense);
      const spd = foe.stats.specialDefense * stageWorth(foe.stages.specialDefense);
      requestStage(mon, def < spd ? 'attack' : 'specialAttack', 1, events, 'ability');
    },
  },
  // Once per battle, in Gen 9.
  'intrepid-sword': oncePerBattle('intrepidSword', (mon, events) => requestStage(mon, 'attack', 1, events, 'ability')),
  'dauntless-shield': oncePerBattle('dauntlessShield', (mon, events) => requestStage(mon, 'defense', 1, events, 'ability')),
  'supersweet-syrup': {
    onSendOut: ({ mon, foe, events }) => {
      const v = mon.flags || (mon.flags = {});
      if (v.syrup || !foe || foe.fainted) return;
      v.syrup = true;
      note(events, `A supersweet aroma is wafting from the syrup covering ${mon.name}!`);
      requestStage(foe, 'evasion', -1, events, 'ability', true);
    },
  },
  anticipation: {
    onSendOut: ({ mon, foe, events }) => {
      if (!foe || foe.fainted) return;
      const scary = (foe.moves || []).some(({ data }) => data && data.damageClass !== 'status' &&
        ((data.meta && data.meta.category === 'ohko') || typechart.effectiveness(data.type, mon.types) > 1));
      if (scary) note(events, `${mon.name} shuddered!`);
    },
  },
  forewarn: {
    onSendOut: ({ mon, foe, events }) => {
      if (!foe || foe.fainted || !(foe.moves || []).length) return;
      const power = (data) => (data.meta && data.meta.category === 'ohko' ? 150 : data.power || (data.damageClass === 'status' ? 0 : 80));
      const best = foe.moves.reduce((top, entry) => (power(entry.data) > power(top.data) ? entry : top));
      note(events, `${mon.name}'s Forewarn alerted it to ${best.data.displayName}!`);
    },
  },
  frisk: {
    onSendOut: ({ mon, foe, events }) => {
      if (foe && !foe.fainted && foe.item) note(events, `${mon.name} frisked ${foe.name} and found its ${displayItem(foe.item)}!`);
    },
  },
  'screen-cleaner': {
    onSendOut: ({ mon, events }) => {
      const state = battleOf(mon);
      if (!state) return;
      let cleared = false;
      for (const side of state.sides) {
        const c = side.conditions || {};
        for (const key of ['reflect', 'lightScreen', 'auroraVeil']) {
          if (c[key]) {
            delete c[key];
            cleared = true;
          }
        }
      }
      if (cleared) note(events, 'The effects of protective barriers disappeared!');
    },
  },
  'teraform-zero': {
    onSendOut: ({ mon, events }) => {
      const field = mon.arena;
      if (!field || (!field.weather && !field.terrain)) return;
      field.weather = null;
      field.strongWeather = null;
      field.weatherTurns = 0;
      field.terrain = null;
      field.terrainTurns = 0;
      note(events, `${mon.name}'s Teraform Zero calmed the weather and terrain!`);
    },
  },
  // Imposter, Neutralizing Gas, Tera Shift and the form abilities are
  // handled by the engine as the Pokemon comes out.
  imposter: {},
  'neutralizing-gas': {},
  'tera-shift': {},
  'stance-change': {},
  'zen-mode': {
    lateEndOfTurn: ({ mon }) => zenCheck(mon),
    onSendOut: ({ mon }) => zenCheck(mon),
  },
  schooling: {
    lateEndOfTurn: ({ mon }) => schoolCheck(mon),
    onSendOut: ({ mon }) => schoolCheck(mon),
  },
  'shields-down': {
    blocksStatus: ({ mon }) => mon.form === 'Meteor',
    lateEndOfTurn: ({ mon }) => shieldsCheck(mon),
    onSendOut: ({ mon }) => shieldsCheck(mon),
  },
  'power-construct': {
    lateEndOfTurn: ({ mon, events }) => {
      if (share(mon) > 0.5 || !/Power Construct$/.test(mon.form || '')) return;
      note(events, 'You sense the presence of many!');
      requestAct(mon, (e) => e.changeForm(mon, 'Complete', `${mon.name} transformed into its Complete Forme!`));
    },
  },
  'hunger-switch': {
    lateEndOfTurn: ({ mon }) => {
      if (mon.transformed) return;
      const next = mon.form === 'Hangry' ? 'Full Belly' : 'Hangry';
      requestAct(mon, (e) => e.changeForm(mon, next, ''));
    },
  },
  'zero-to-hero': {},

  // Doubles only: these help or copy an ally, so they do nothing in a single
  // battle, as in the games.
  battery: {},
  'power-spot': {},
  plus: {},
  minus: {},
  'friend-guard': {},
  telepathy: {},
  symbiosis: {},
  costar: {},
  'curious-medicine': {},
  hospitality: {},
  commander: {},
  receiver: {},
  'power-of-alchemy': {},
  // Outside battle only.
  'ball-fetch': {},
  'honey-gather': {},
  'run-away': {},
  // Their form comes from the held plate or memory (Utils/formitems.js).
  multitype: {},
  'rks-system': {},
  // Redirection, which a single battle doesn't have.
  'propeller-tail': {},
  // Mirror Armor bounces stat drops back (Utils/battle.js, applyStage).
  'mirror-armor': {},
  // Read by name in Utils/conditions.js, Utils/statusmoves.js and
  // Utils/moverules.js: Soundproof (sound moves), Sticky Hold (Knock Off,
  // Thief, Trick), Own Tempo (confusion, Intimidate), Oblivious (Attract,
  // Taunt, Intimidate), Damp (explosions, Aftermath), Overcoat (powder,
  // weather), Suction Cups (Roar, Dragon Tail), Aroma Veil (Taunt, Encore...).
  soundproof: {},
  'sticky-hold': {},
  'own-tempo': {},
  oblivious: {},
  damp: {},
  overcoat: {},
  'suction-cups': {},
  'aroma-veil': {},
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

  // The boost; the move lock is in Utils/conditions.js (choiceLock).
  'choice-band': {
    attackMultiplier: ({ move }) => (move.damageClass === 'physical' ? 1.5 : 1),
  },
  'choice-specs': {
    attackMultiplier: ({ move }) => (move.damageClass === 'special' ? 1.5 : 1),
  },
  'choice-scarf': { speedMultiplier: () => 1.5 },

  // Order within the same priority: Quick Claw sometimes jumps ahead; these
  // two always go last.
  'quick-claw': { bracketShift: ({ rng }) => (rng() < 0.2 ? 1 : 0) },
  'lagging-tail': { bracketShift: () => -1 },
  'full-incense': { bracketShift: () => -1 },

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

  // Species names can be any case ("Chansey" stored, "chansey" wild).
  'lucky-punch': { critStage: ({ mon }) => (/chansey/i.test(mon.species || '') ? 2 : 0) },
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
  // Only for an untransformed Ditto, as in the games. Since Gen 3 it
  // doubles Defense alone, so only physical moves are softened.
  'metal-powder': {
    defenceMultiplier: ({ defender, move }) =>
      /ditto/i.test(defender.species || '') && !defender.transformed && move.damageClass === 'physical' ? 2 : 1,
  },
  'deep-sea-tooth': {
    attackMultiplier: ({ attacker, move }) =>
      /clamperl/i.test(attacker.species || '') && move.damageClass === 'special' ? 2 : 1,
  },
  'deep-sea-scale': {
    defenceMultiplier: ({ defender, move }) =>
      /clamperl/i.test(defender.species || '') && move.damageClass === 'special' ? 2 : 1,
  },
  'quick-powder': {
    speedMultiplier: ({ mon }) => (/ditto/i.test(mon.species || '') && !mon.transformed ? 2 : 1),
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
    lateEndOfTurn: ({ mon, events }) => {
      if (mon.status) return;
      requestStatus(mon, 'burn', events, { source: 'item' });
    },
  },
  'toxic-orb': {
    lateEndOfTurn: ({ mon, events }) => {
      if (mon.status) return;
      requestStatus(mon, 'poison', events, { source: 'item', badly: true });
    },
  },

};

// Every berry (and Berry Juice) is eaten the same way: when its moment comes
// (see BERRIES), unless an Unnerve on the other side stops it.
for (const slug of Object.keys(BERRIES)) {
  HELD_ITEMS[slug] = {
    onHealthChanged: ({ mon, events }) => {
      if (mon.fainted || !BERRIES[slug].when(mon)) return;
      if (isBerry(slug) && unnerved(mon)) return;
      eatBerry(mon, slug, events);
      consumeItem(mon, events);
    },
  };
}

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

/**
 * Anything else a hook needs the engine for: setting a weather or terrain,
 * changing form, switching out. `fn` is called with the engine's helpers
 * (see hookEngine in Utils/battle.js). Runs even if `target` has fainted
 * when `evenFainted` is set.
 */
function requestAct(target, fn, evenFainted = false) {
  queue.push({ what: 'act', target, fn, evenFainted });
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
// Gastro Acid switches the ability off; Embargo and Magic Room the item
// (Utils/conditions.js keeps the flags up to date).
// Klutz switches its own item off (except an Iron Ball's slowness).
const klutzed = (mon) => !mon.abilitySuppressed && mon.ability === 'klutz' && mon.item !== 'iron-ball';
const definitionsOf = (mon, hook = null) =>
  [
    mon.abilitySuppressed || (mon.abilityBroken && BREAKABLE_HOOKS.has(hook)) ? null : mon.abilityEffect,
    mon.itemsSuppressed || klutzed(mon) ? null : mon.itemEffect,
  ].filter(Boolean);

/**
 * Make `target` fall for `source` (Attract, Cute Charm).
 *
 * Only between a male and a female, and not through Oblivious or Aroma Veil.
 * A Destiny Knot held by the one falling in love makes the source fall too.
 *
 * @returns {boolean} whether it worked
 */
function infatuate(target, source, events, cause = null) {
  const genders = [target.gender, source.gender];
  if (!genders.every((g) => g === 'male' || g === 'female') || genders[0] === genders[1]) return false;

  const v = target.volatiles || (target.volatiles = {});
  if (v.attract) return false;

  const ability = target.abilitySuppressed ? null : target.ability;
  if (ability === 'oblivious' || ability === 'aroma-veil') return false;

  v.attract = source.id;
  events.push({ kind: 'volatile-start', name: target.name, what: 'attract', label: 'love', source: cause });

  const knot = target.itemsSuppressed ? null : target.item;
  if (knot === 'destiny-knot') infatuate(source, target, events, 'Destiny Knot');
  return true;
}

/** Change a Pokemon's ability mid-battle (Skill Swap, Worry Seed, Entrainment...). */
function setAbility(mon, slug) {
  mon.ability = slug || null;
  mon.abilityEffect = ABILITIES[slug] || null;
}

/** Change a Pokemon's held item mid-battle (Trick, Bestow, Recycle...). */
function setItem(mon, slug) {
  // Losing an item (Knock Off, Thief, Trick for nothing) wakes Unburden.
  if (mon.item && !slug && mon.volatiles) mon.volatiles.unburden = true;
  if (slug && mon.volatiles) delete mon.volatiles.unburden;
  mon.item = slug || null;
  mon.itemEffect = itemEffectFor(slug);
}

/**
 * Multiply one hook across both definitions.
 *
 * A hook that is missing contributes 1, so a Pokemon with no ability and no
 * item comes out of every calculation unchanged.
 */
function product(mon, hook, context) {
  let total = 1;

  for (const definition of definitionsOf(mon, hook)) {
    const fn = definition[hook];
    if (typeof fn === 'function') total *= fn(context);
    else if (typeof fn === 'number') total *= fn;
  }

  return total;
}

/** Is this hook switched on for either of them? */
function flag(mon, hook, context) {
  for (const definition of definitionsOf(mon, hook)) {
    const value = definition[hook];
    if (typeof value === 'function' ? value(context) : value) return true;
  }
  return false;
}

/** The highest a hook returns across both, for things that add rather than multiply. */
function highest(mon, hook, context) {
  let best = 0;

  for (const definition of definitionsOf(mon, hook)) {
    const value = definition[hook];
    const got = typeof value === 'function' ? value(context) : value || 0;
    if (got > best) best = got;
  }

  return best;
}

/** Run a reacting hook on both definitions, in order. */
function run(mon, hook, context) {
  for (const definition of definitionsOf(mon, hook)) {
    if (typeof definition[hook] === 'function') definition[hook](context);
  }
}

// ---------------------------------------------------------------------------
// The hooks the engine calls
// ---------------------------------------------------------------------------

/** Speed, after Choice Scarf, Quick Feet and Iron Ball. */
const speedMultiplier = (mon) => product(mon, 'speedMultiplier', { mon });

/** Extra move priority from an ability (Prankster, Gale Wings, Triage). */
const priorityBonus = (mon, move) => highest(mon, 'priorityBonus', { mon, move });

/**
 * Where this Pokemon sits among others of the same priority: 1 to go first
 * (Quick Claw), -1 to go last (Lagging Tail, Full Incense), 0 otherwise.
 */
function bracketShift(mon, rng = Math.random, move = null) {
  let shift = 0;

  for (const definition of definitionsOf(mon)) {
    if (typeof definition.bracketShift === 'function') shift += definition.bracketShift({ mon, rng, move });
  }

  return Math.max(-1, Math.min(1, shift));
}

/** Does anything stop paralysis halving this Pokemon's speed? Quick Feet does. */
const ignoresParalysisSpeed = (mon) => flag(mon, 'ignoresParalysisSpeed', { mon });

/** Accuracy, after Compound Eyes and Hustle. */
function accuracy(attacker, defender, move) {
  const unaware = (mon) => abilityNow(mon) === 'unaware';
  return {
    multiplier:
      product(attacker, 'accuracyMultiplier', { attacker, defender, move, mon: attacker }) *
      product(defender, 'evasionMultiplier', { attacker, defender, move, mon: defender }),
    never:
      flag(attacker, 'neverMisses', { attacker, move }) ||
      flag(defender, 'neverMisses', { attacker, move }),
    // Keen Eye, Mind's Eye, Illuminate and Unaware look past evasion boosts;
    // Unaware on the target also looks past the attacker's accuracy boosts.
    ignoreEvasion: flag(attacker, 'ignoresEvasion', { attacker, move }) || unaware(attacker),
    ignoreAccuracy: unaware(defender),
  };
}

/** Merciless: a poisoned target always takes a critical hit. */
const forcesCrit = (attacker, defender) => flag(attacker, 'forcesCrit', { attacker, defender, mon: attacker });

/** Does this move make contact, from this attacker? Long Reach never does. */
const contactBy = (attacker, move) => makesContact(move) && !flag(attacker, 'noContact', { mon: attacker });

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

    contact: contactBy(attacker, move),
    mon: attacker,
  };

  const stabOverrides = definitionsOf(attacker)
    .map((definition) => definition.stabMultiplier)
    .filter((value) => typeof value === 'number');

  // Facade doubles under burn, poison or paralysis - not sleep or freeze - and
  // since Gen 6 the burn no longer halves it, so a burned Facade hits for 140.
  const facade =
    move.name === 'facade' && ['burn', 'poison', 'paralysis'].includes(attacker.status);

  // Fairy Aura and Dark Aura, from whoever has them; Aura Break turns them
  // round. The Ruin abilities lower everyone else's stat.
  const state = battleOf(attacker);
  const out = state
    ? state.sides.map((side) => side.team[side.active]).filter((mon) => mon && !mon.fainted)
    : [attacker, defender];
  const present = (name) => out.some((mon) => !mon.abilitySuppressed && mon.ability === name);
  const owns = (mon, name) => mon && !mon.abilitySuppressed && mon.ability === name;
  const type = lower(move.type);
  let aura = 1;
  if ((type === 'fairy' && present('fairy-aura')) || (type === 'dark' && present('dark-aura'))) {
    aura = present('aura-break') ? 0.75 : 4 / 3;
  }
  const physical = move.damageClass === 'physical';
  const special = move.damageClass === 'special';
  const ruinedAttack =
    (physical && owns(defender, 'tablets-of-ruin') && !owns(attacker, 'tablets-of-ruin')) ||
    (special && owns(defender, 'vessel-of-ruin') && !owns(attacker, 'vessel-of-ruin'));
  const ruinedDefence =
    (physical && owns(attacker, 'sword-of-ruin') && !owns(defender, 'sword-of-ruin')) ||
    (special && owns(attacker, 'beads-of-ruin') && !owns(defender, 'beads-of-ruin'));

  return {
    attackModifiers: [product(attacker, 'attackMultiplier', context), ruinedAttack ? 0.75 : 1],
    defenceModifiers: [product(defender, 'defenceMultiplier', { ...context, mon: defender }), ruinedDefence ? 0.75 : 1],
    extraModifiers: [
      product(attacker, 'damageOut', context),
      product(defender, 'damageIn', { ...context, mon: defender }),
      facade ? 2 : 1,
      aura,
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

  for (const definition of definitionsOf(defender, 'absorbs')) {
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

  for (const definition of definitionsOf(defender, 'survives')) {
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
    contact: contactBy(context.attacker, context.move),
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
    contact: contactBy(context.attacker, context.move),
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

/**
 * The end of a turn, in three moments (Utils/battle.js's endTurn calls them
 * in the games' order):
 *
 *   weatherEndOfTurn  with the weather: Rain Dish, Dry Skin, Ice Body, Solar Power
 *   endOfTurn         Shed Skin, Hydration, Leftovers, Black Sludge
 *   lateEndOfTurn     after burn, poison and the timers: Speed Boost, Moody,
 *                     Harvest, Bad Dreams, the Orbs, the form changes
 */
const weatherEndOfTurn = (mon, rng, events) => {
  if (!mon.fainted) run(mon, 'weatherEndOfTurn', { mon, rng, events });
};
const endOfTurn = (mon, rng, events) => {
  if (!mon.fainted) run(mon, 'endOfTurn', { mon, rng, events });
};
const lateEndOfTurn = (mon, rng, events) => {
  if (!mon.fainted) run(mon, 'lateEndOfTurn', { mon, rng, events });
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

/** Abilities that Intimidate doesn't work on (Gen 8 onward). */
const INTIMIDATE_PROOF = new Set(['scrappy', 'inner-focus', 'oblivious', 'own-tempo']);

module.exports = {
  PUNCHING,
  BITING,
  PULSES,
  BULLETS,
  MOLD_BREAKERS,
  breaksMold,
  priorityBonus,
  bracketShift,
  setAbility,
  infatuate,
  setItem,
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

  SOUND_MOVES,
  SLICING,
  WIND,
  DANCES,
  UNCHANGEABLE,
  BERRIES,
  lockedItem,
  isBerry,
  eatBerry,
  unnerved,
  contactBy,
  forcesCrit,

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
  weatherEndOfTurn,
  endOfTurn,
  lateEndOfTurn,
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
  requestAct,

  // where a Pokemon is
  battleOf,
  sideIndexOf,
  foeOf,
  abilityNow,
  weatherAround,
  terrainAround,

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

  // A drop on the user (Draco Meteor, Close Combat) is a drawback, not a
  // secondary effect, so Sheer Force doesn't boost those moves.
  const selfDropOnly =
    meta.category === 'damage-raise' && (move.statChanges || []).every((change) => change.change < 0);
  if (meta.statChance > 0 && !selfDropOnly) return true;
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
