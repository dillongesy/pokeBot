'use strict';

/**
 * Who you are about to fight, and with what.
 *
 * Decides whether an ordinary `.battle` is wild or against a trainer, and
 * builds the opponent's team.
 *
 * Pure: everything takes plain data and an rng function. Utils/store.js reads
 * the player's Pokemon and passes the rows in.
 *
 * Early on most battles are wild; later most are trainers with a team.
 */

const rates = require('./rates');
const battle = require('./battle');
const learnset = require('./learnset');
const obedience = require('./obedience');
const evolution = require('./evolution');
const names = require('./names');
const { createPokemon, loadSpecies, loadForm } = require('./pokemon');

const WILD = 'wild';
const TRAINER = 'trainer';
const MILESTONE = 'milestone';

/**
 * Flavour names for the trainers you meet along the way.
 *
 * Generic trainer classes from the games.
 */
const TRAINER_CLASSES = [
  'Youngster', 'Lass', 'Bug Catcher', 'Hiker', 'Fisherman', 'Picnicker',
  'Camper', 'Ace Trainer', 'Black Belt', 'Beauty', 'Psychic', 'Sailor',
  'Bird Keeper', 'Swimmer', 'Cool Trainer', 'Veteran', 'Scientist', 'Ranger',
];

// ---------------------------------------------------------------------------
// What kind of fight
// ---------------------------------------------------------------------------

/**
 * The chance the next ordinary battle is wild rather than a trainer, in
 * percent, sliding from `wildAtStart` down to `wildAtEnd` across the ladder.
 *
 * Linear interpolation, so it is easy to tune from rates.js.
 */
function wildChance(cleared, total) {
  const { wildAtStart, wildAtEnd } = rates.battle;
  if (!total || total <= 0) return wildAtStart;

  const through = Math.max(0, Math.min(1, cleared / total));
  return wildAtStart + (wildAtEnd - wildAtStart) * through;
}

/** Wild or trainer. Milestones are never rolled; they are started explicitly. */
const pickKind = (cleared, total, rng) =>
  rng() * 100 < wildChance(cleared, total) ? WILD : TRAINER;

/**
 * How many Pokemon a random trainer brings.
 *
 * Grows from `minNpcTeam` at the start to `maxNpcTeam` at the end. Never
 * fewer than two, so trainer battles differ from wild ones.
 */
function npcTeamSize(cleared, total) {
  const { minNpcTeam, maxNpcTeam } = rates.battle;
  if (!total || total <= 0) return minNpcTeam;

  const through = Math.max(0, Math.min(1, cleared / total));
  const grown = minNpcTeam + Math.floor(through * (maxNpcTeam - minNpcTeam + 1));

  return Math.max(minNpcTeam, Math.min(maxNpcTeam, grown));
}

/**
 * What level an opponent shows up at.
 *
 * Close to the trainer's cap and never below 2. Based on the cap rather than
 * the team brought, so bringing weaker Pokemon doesn't make battles easier.
 */
function opponentLevel(cap, rng, spread = rates.battle.wildSpread) {
  const offset = Math.round((rng() * 2 - 1) * spread);
  return Math.max(2, cap + offset);
}

/**
 * An opponent level drawn from rates.battle.levelBands: mostly at the cap,
 * often somewhat below, sometimes well below, and later on occasionally above.
 *
 * opponentLevel is used where "at your level" is wanted, such as a trainer's
 * ace.
 */
function variedLevel(cap, rng, progress = 0) {
  const bands = rates.battle.levelBands || [];
  if (!bands.length) return opponentLevel(cap, rng);

  // A band marked `rampsWith: 'progress'` has zero weight at the start of the
  // ladder and full weight at the end.
  const through = Math.max(0, Math.min(1, progress));
  const weightOf = (band) => (band.rampsWith === 'progress' ? band.weight * through : band.weight);

  const total = bands.reduce((sum, band) => sum + weightOf(band), 0);
  if (total <= 0) return opponentLevel(cap, rng);

  let roll = rng() * total;

  let chosen = bands[0];
  for (const band of bands) {
    roll -= weightOf(band);
    if (roll < 0) {
      chosen = band;
      break;
    }
  }

  const low = chosen.offsetFrom !== undefined
    ? cap + chosen.offsetFrom
    : Math.round(cap * chosen.fractionFrom);

  const high = chosen.offsetTo !== undefined
    ? cap + chosen.offsetTo
    : Math.round(cap * chosen.fractionTo);

  const from = Math.max(2, Math.min(low, high));
  const to = Math.max(from, Math.max(low, high));

  return from + Math.floor(rng() * (to - from + 1));
}

// ---------------------------------------------------------------------------
// Building the other side
// ---------------------------------------------------------------------------

/**
 * Build a fighter from nothing but a species and a level.
 *
 * Used for every opponent (wild, trainer and milestone), with moves chosen by
 * the same rule as the player's Pokemon. IVs and nature are rolled normally.
 */
function wildCombatant(speciesId, level, { formFolder = null, rng = Math.random } = {}) {
  const species = loadSpecies(speciesId);
  if (!species) return null;

  const forms = species.forms || [];
  const chosen =
    (formFolder && forms.find((f) => f.folder === formFolder)) ||
    forms.find((f) => f.percentage > 0) ||
    forms[0];

  if (!chosen) return null;

  const form = loadForm(speciesId, chosen.folder);
  if (!form) return null;

  const mon = createPokemon(species, form, { level, ivs: rolledIvs(rng) });

  const row = {
    // Negative ids so opponents can never collide with stored Pokemon.
    id: -Math.abs(speciesId * 1000 + level),
    species_id: species.id,
    species_name: species.name,
    display_name: mon.displayName,
    form_folder: chosen.folder,
    form_slug: chosen.slug,
    level: mon.level,
    types: mon.types.join(','),
    stat_hp: mon.stats.hp,
    stat_attack: mon.stats.attack,
    stat_defense: mon.stats.defense,
    stat_special_attack: mon.stats.specialAttack,
    stat_special_defense: mon.stats.specialDefense,
    stat_speed: mon.stats.speed,
    ability: mon.ability ? mon.ability.name : null,
    shiny: 0,
  };

  const moves = learnset
    .movesAtLevel(species.id, chosen.folder, mon.level)
    .map((entry) => ({ move: entry.name, data: learnset.move(entry.name), ppUp: 0 }));

  const combatant = battle.combatantFrom(row, moves);

  // Base experience for knocking it out, so rewards don't need the form data.
  combatant.baseExperience = (form.physical && form.physical.baseExperience) || 64;
  combatant.effortYield = (form.stats && form.stats.effortYield) || {};

  return combatant;
}

/** Six random IVs, from whichever generator the caller is using. */
const rolledIvs = (rng) => ({
  hp: Math.floor(rng() * 32),
  attack: Math.floor(rng() * 32),
  defense: Math.floor(rng() * 32),
  specialAttack: Math.floor(rng() * 32),
  specialDefense: Math.floor(rng() * 32),
  speed: Math.floor(rng() * 32),
});

/** One wild Pokemon, at the trainer's level. */
function wildTeam(speciesId, cap, rng, progress = 0) {
  const level = variedLevel(cap, rng, progress);
  const mon = wildCombatant(ageAppropriate(speciesId, level), level, { rng });
  return mon ? [mon] : [];
}

/**
 * The species that should actually turn up at this level.
 *
 * Species come from the drop roller and levels from the cap, so this walks
 * the evolution chain down to a stage that fits the level (no level 11
 * Venusaur). Uses Utils/evolution.js.
 *
 * Milestone rosters skip this, since their species are fixed.
 */
const ageAppropriate = (speciesId, level) => evolution.speciesAtLevel(speciesId, level);

/**
 * A random trainer's team.
 *
 * The ace goes last and is the highest level.
 */
function npcTeam(speciesIds, cap, rng, progress = 0) {
  const team = [];

  speciesIds.forEach((speciesId, index) => {
    const isAce = index === speciesIds.length - 1;

    // The ace is at the cap plus one (higher later in the ladder); the rest
    // of the team uses the varied level bands.
    const level = isAce
      ? Math.max(2, Math.max(opponentLevel(cap, rng) + 1, variedLevel(cap, rng, progress)))
      : variedLevel(cap, rng, progress);

    const mon = wildCombatant(ageAppropriate(speciesId, level), level, { rng });
    if (mon) team.push(mon);
  });

  // Sort weakest first so the ace is last.
  team.sort((a, b) => a.level - b.level);

  return team;
}

/**
 * A milestone's canon roster, scaled to where it sits on the ladder.
 *
 * Utils/milestones.js decides the levels. A species that fails to resolve is
 * skipped rather than crashing the battle (milestones.js validates the table).
 */
function milestoneTeam(fight, cap, rng = Math.random) {
  const milestones = require('./milestones');
  const team = [];

  for (const member of milestones.scaleTeam(fight, cap)) {
    const found = names.resolveSpecies(member.species);
    if (!found || !found.length) continue;

    const mon = wildCombatant(found[0].id, member.level, { rng });
    if (mon) team.push(mon);
  }

  return team;
}

// ---------------------------------------------------------------------------
// The player's side
// ---------------------------------------------------------------------------

/**
 * Turn a player's Pokemon into a team, dropping the ones that will not listen.
 *
 * Returns both the team and the refusals, so the battle can explain who
 * didn't obey (Utils/obedience.js provides the wording).
 *
 * Does not look for replacements; store.battleTeam passes exactly the first
 * six of the party. The TEAM_SIZE check is only a safeguard.
 *
 * @param {Array} rows   pokemon rows, in the order the player wants them
 * @param {Function} movesFor  id -> the rows from store.movesOf
 * @param {number} cap
 */
function playerTeam(rows, movesFor, cap) {
  const willing = [];
  const refused = [];

  for (const row of rows) {
    const verdict = obedience.check(row, cap);

    if (!verdict.obeys) {
      refused.push({
        row,
        reason: verdict.reason,
        why: obedience.explain(row, cap, row.nickname || row.display_name),
      });
      continue;
    }

    if (willing.length >= battle.TEAM_SIZE) continue;

    const mon = battle.combatantFrom(row, movesFor(row.id));

    // A Pokemon with no moves can't take a turn. This shouldn't happen
    // (store.js assigns moves on creation), but guard against it anyway.
    if (!mon.moves.length) {
      refused.push({ row, reason: 'no-moves', why: `${mon.name} does not know any moves.` });
      continue;
    }

    willing.push(mon);
  }

  return { team: willing, refused };
}

// ---------------------------------------------------------------------------
// Putting it together
// ---------------------------------------------------------------------------

/**
 * Everything about the fight that is about to happen, except the player's side.
 *
 * @returns {{ kind, name, team, level }}
 */
function opponentFor({ kind, cap, cleared, total, speciesIds, fight, rng }) {
  if (kind === MILESTONE) {
    const team = milestoneTeam(fight, cap, rng);
    return {
      kind: MILESTONE,
      name: fight.name,
      region: fight.region,
      team,
      level: Math.max(...team.map((mon) => mon.level), cap),
    };
  }

  // Ladder progress from 0 to 1. Affects trainer team size and how often
  // opponents appear above the cap.
  const progress = total > 0 ? Math.max(0, Math.min(1, cleared / total)) : 0;

  if (kind === TRAINER) {
    const size = npcTeamSize(cleared, total);
    const team = npcTeam(speciesIds.slice(0, size), cap, rng, progress);
    const title = TRAINER_CLASSES[Math.floor(rng() * TRAINER_CLASSES.length)];

    return {
      kind: TRAINER,
      name: title,
      team,
      level: team.length ? Math.max(...team.map((mon) => mon.level)) : cap,
    };
  }

  const team = wildTeam(speciesIds[0], cap, rng, progress);
  return {
    kind: WILD,
    name: team.length ? `Wild ${team[0].name}` : 'Wild Pokemon',
    team,
    level: team.length ? team[0].level : cap,
  };
}

module.exports = {
  WILD,
  TRAINER,
  MILESTONE,
  TRAINER_CLASSES,
  wildChance,
  pickKind,
  npcTeamSize,
  opponentLevel,
  variedLevel,
  wildCombatant,
  wildTeam,
  npcTeam,
  milestoneTeam,
  TEAM_SIZE: battle.TEAM_SIZE,
  playerTeam,
  opponentFor,
};

// `node Utils/encounter.js` - how the mix shifts across the ladder.
if (require.main === module) {
  const milestones = require('./milestones');
  const trainer = require('./trainer');

  const total = milestones.total();

  console.log(`the mix, across ${total} milestones:\n`);
  console.log('  cleared  cap   wild%   trainer%   npc team');

  for (let cleared = 0; cleared <= total; cleared += 10) {
    const cap = trainer.capFor(cleared + 1);
    const wild = wildChance(cleared, total);
    console.log(
      `  ${String(cleared).padStart(7)}  ${String(cap).padStart(3)}   ` +
        `${wild.toFixed(0).padStart(5)}   ${(100 - wild).toFixed(0).padStart(8)}   ` +
        `${String(npcTeamSize(cleared, total)).padStart(8)}`
    );
  }

  const rng = battle.rngFrom(1);

  console.log('\nrolling 10,000 encounters at each end:');
  for (const cleared of [0, Math.floor(total / 2), total]) {
    const counts = { wild: 0, trainer: 0 };
    for (let i = 0; i < 10000; i += 1) counts[pickKind(cleared, total, rng)] += 1;
    console.log(
      `  ${String(cleared).padStart(3)} cleared:  ${counts.wild} wild, ${counts.trainer} trainer`
    );
  }

  console.log('\na wild Pokemon at cap 30:');
  const wild = wildCombatant(25, 30, { rng });
  console.log(
    `  ${wild.name} Lv.${wild.level} (${wild.types.join('/')})  ` +
      `${wild.stats.hp} HP, base exp ${wild.baseExperience}`
  );
  console.log(`  ${wild.moves.map((m) => m.data.displayName).join(', ')}`);
  console.log(`  yields ${JSON.stringify(wild.effortYield)}`);

  console.log('\nBrock, built for real:');
  for (const mon of milestoneTeam(milestones.byOrder(1), trainer.capFor(1), rng)) {
    console.log(
      `  ${mon.name} Lv.${mon.level} (${mon.types.join('/')})  ${mon.stats.hp} HP  ` +
        `[${mon.moves.map((m) => m.data.displayName).join(', ')}]`
    );
  }

  console.log('\nthe Kanto champion, at his place on the ladder:');
  for (const mon of milestoneTeam(milestones.byOrder(10), trainer.capFor(10), rng)) {
    console.log(`  ${mon.name} Lv.${mon.level}  ${mon.stats.hp} HP`);
  }
}
