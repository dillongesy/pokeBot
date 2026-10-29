'use strict';

/**
 * Corrections to the imported move data.
 *
 * PokeAPI has no effect data (`meta`) for most moves added in Legends: Arceus
 * and Scarlet/Violet, so without these their secondary effects (Dire Claw's
 * status, Wave Crash's recoil, Aqua Step's Speed boost) would never happen.
 * A few older records also need adjusting where the engine applies an effect
 * itself (Skull Bash raises Defense on the charging turn, not after the hit).
 *
 * Applied by Utils/content.js whenever a move is read, so nothing needs to be
 * re-imported.
 */

/** A full meta block, with only the given fields changed. */
const meta = (fields = {}) => ({
  ailment: 'none',
  ailmentChance: 0,
  category: 'damage',
  critRate: 0,
  drain: 0,
  healing: 0,
  flinchChance: 0,
  statChance: 0,
  minHits: null,
  maxHits: null,
  minTurns: null,
  maxTurns: null,
  ...fields,
});

const raise = (chance = 100) => ({ category: 'damage-raise', statChance: chance });
const lower = (chance = 100) => ({ category: 'damage-lower', statChance: chance });
const ailment = (name, chance) => ({ category: 'damage-ailment', ailment: name, ailmentChance: chance });
const stat = (name, change) => ({ stat: name, change });

const PATCHES = {
  // ---- Legends: Arceus ----
  'dire-claw': { meta: meta(ailment('unknown', 50)) },
  'psyshield-bash': { meta: meta(raise()), statChanges: [stat('defense', 1)] },
  'stone-axe': { meta: meta({ critRate: 1 }) },
  'springtide-storm': { meta: meta(lower(30)), statChanges: [stat('attack', -1)] },
  'mystical-power': { meta: meta(raise()), statChanges: [stat('special-attack', 1)] },
  'raging-fury': { meta: meta() },
  'wave-crash': { meta: meta({ drain: -33 }) },
  chloroblast: { meta: meta() },
  'mountain-gale': { meta: meta({ flinchChance: 30 }) },
  'headlong-rush': { meta: meta(raise()), statChanges: [stat('defense', -1), stat('special-defense', -1)] },
  'barb-barrage': { meta: meta(ailment('poison', 50)) },
  'esper-wing': { meta: meta({ ...raise(), critRate: 1 }), statChanges: [stat('speed', 1)] },
  'bitter-malice': { meta: meta(lower()), statChanges: [stat('attack', -1)] },
  'triple-arrows': { meta: meta({ ...lower(50), critRate: 1, flinchChance: 30 }), statChanges: [stat('defense', -1)] },
  'infernal-parade': { meta: meta(ailment('burn', 30)) },
  'ceaseless-edge': { meta: meta({ critRate: 1 }) },
  'bleakwind-storm': { meta: meta(lower(30)), statChanges: [stat('speed', -1)] },
  'wildbolt-storm': { meta: meta(ailment('paralysis', 20)) },
  'sandsear-storm': { meta: meta(ailment('burn', 20)) },

  // ---- Scarlet and Violet ----
  // Tera Blast's drops only happen to a Stellar Terastallized user.
  'tera-blast': { meta: meta(), statChanges: [] },
  'axe-kick': { meta: meta(ailment('confusion', 30)) },
  'last-respects': { meta: meta() },
  'lumina-crash': { meta: meta(lower()) },
  'order-up': { meta: meta() },
  'jet-punch': { meta: meta() },
  'spin-out': { meta: meta(raise()) },
  'population-bomb': { meta: meta({ minHits: 10, maxHits: 10 }) },
  'ice-spinner': { meta: meta() },
  'glaive-rush': { meta: meta() },
  'salt-cure': { meta: meta() },
  'triple-dive': { meta: meta({ minHits: 3, maxHits: 3 }) },
  'mortal-spin': { meta: meta(ailment('poison', 100)) },
  'kowtow-cleave': { meta: meta() },
  'flower-trick': { meta: meta({ critRate: 6 }) },
  'torch-song': { meta: meta(raise()) },
  'aqua-step': { meta: meta(raise()) },
  'raging-bull': { meta: meta() },
  'make-it-rain': { meta: meta(raise()) },
  psyblade: { meta: meta() },
  'hydro-steam': { meta: meta() },
  ruination: { meta: meta() },
  'collision-course': { meta: meta() },
  'electro-drift': { meta: meta() },
  pounce: { meta: meta(lower()) },
  trailblaze: { meta: meta(raise()) },
  'chilling-water': { meta: meta(lower()) },
  'hyper-drill': { meta: meta() },
  'twin-beam': { meta: meta({ minHits: 2, maxHits: 2 }) },
  'rage-fist': { meta: meta() },
  'armor-cannon': { meta: meta(raise()) },
  'bitter-blade': { meta: meta({ category: 'damage-heal', drain: 50 }) },
  'double-shock': { meta: meta() },
  'gigaton-hammer': { meta: meta() },
  comeuppance: { meta: meta() },
  'aqua-cutter': { meta: meta({ critRate: 1 }) },
  'blood-moon': { meta: meta() },
  'matcha-gotcha': { meta: meta({ ...ailment('burn', 20), drain: 50 }) },
  'ivy-cudgel': { meta: meta({ critRate: 1 }) },
  // Electro Shot and Meteor Beam raise Sp. Atk while charging (Utils/moverules.js).
  'electro-shot': { meta: meta(), statChanges: [] },
  'tera-starstorm': { meta: meta() },
  'fickle-beam': { meta: meta() },
  thunderclap: { meta: meta() },
  'mighty-cleave': { meta: meta() },
  'tachyon-cutter': { meta: meta({ minHits: 2, maxHits: 2 }), accuracy: null },
  'hard-press': { meta: meta() },
  'alluring-voice': { meta: meta() },
  'temper-flare': { meta: meta() },
  'supercell-slam': { meta: meta() },
  'psychic-noise': { meta: meta() },
  'upper-hand': { meta: meta({ flinchChance: 100 }) },
  'malignant-chain': { meta: meta(ailment('poison', 50)) },

  // ---- older moves the engine handles itself ----
  'skull-bash': { meta: meta() },
  'meteor-beam': { meta: meta(), statChanges: [] },
  // Only burns a target whose stats rose this turn (Utils/moverules.js).
  'burning-jealousy': { meta: meta() },
  // Lowers Speed every turn for three turns rather than once.
  'syrup-bomb': { meta: meta(), statChanges: [] },
  // Rolled by terrain (Utils/moverules.js).
  'secret-power': { meta: meta() },
  'tri-attack': { meta: meta() },
  // The status moves that only work with their own handling.
  'burning-bulwark': { accuracy: null },
  'dragon-cheer': { accuracy: null },
};

/** A move record with any correction applied. */
function apply(move) {
  if (!move) return move;
  const patch = PATCHES[move.name];
  if (!patch) return move;
  return { ...move, ...patch };
}

module.exports = { apply, PATCHES };
