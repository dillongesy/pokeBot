'use strict';

/**
 * The canon fights, in the order you would have played them.
 *
 * Every gym leader, Elite Four and champion from Kanto onward, in play order.
 * One milestone per trainer level: beating Brock unlocks trainer level 2, and
 * the full ladder is 79 battles. Utils/trainer.js handles the level itself.
 *
 * Regions with gyms are included:
 *
 *   Kanto  Johto  Hoenn  Sinnoh  Unova  Kalos  Galar  Paldea
 *
 * Alola is left out because it has island trials rather than gyms. Galar has
 * no Elite Four (the Champion Cup goes straight to Leon), so it has nine
 * milestones instead of ten. Paldea's Titans and Team Star are not gyms and
 * are skipped.
 *
 * Each Elite Four is a single six-Pokemon battle drawn from all four members'
 * teams. Comments name which member each Pokemon belongs to, and none should
 * come from the champion's team (checked at the bottom of this file).
 *
 * Levels are the real ones from the games, but they only set the shape of a
 * team (see scaleTeam()); the whole team is shifted to sit around the
 * trainer's cap.
 *
 * Moves are not listed: milestone Pokemon use the same learnset rule as
 * players (Utils/learnset.js). A `moves` array can be added to a member to
 * override that.
 *
 * To add or fix one, edit the table and run `node Utils/milestones.js`, which
 * checks every species against Data/Pokemon.
 */

const names = require('./names');

/** What kind of fight a milestone is. Only used for how it is announced. */
const GYM = 'gym';
const ELITE_FOUR = 'elite-four';
const CHAMPION = 'champion';

/**
 * A member is [species, canonLevel]. The last one listed is the ace, and is
 * expected to be the highest level - checkAll() says so if it is not.
 */
const REGIONS = [
  {
    region: 'Kanto',
    generation: 1,
    fights: [
      { name: 'Brock', kind: GYM, type: 'rock', team: [['geodude', 12], ['onix', 14]] },
      { name: 'Misty', kind: GYM, type: 'water', team: [['staryu', 18], ['starmie', 21]] },
      { name: 'Lt. Surge', kind: GYM, type: 'electric', team: [['voltorb', 21], ['pikachu', 18], ['raichu', 24]] },
      { name: 'Erika', kind: GYM, type: 'grass', team: [['tangela', 24], ['victreebel', 29], ['vileplume', 29]] },
      { name: 'Koga', kind: GYM, type: 'poison', team: [['koffing', 37], ['muk', 39], ['koffing', 37], ['weezing', 43]] },
      { name: 'Sabrina', kind: GYM, type: 'psychic', team: [['kadabra', 38], ['mr-mime', 37], ['venomoth', 38], ['alakazam', 43]] },
      { name: 'Blaine', kind: GYM, type: 'fire', team: [['growlithe', 42], ['ponyta', 40], ['rapidash', 42], ['arcanine', 47]] },
      { name: 'Giovanni', kind: GYM, type: 'ground', team: [['rhyhorn', 45], ['dugtrio', 42], ['nidoqueen', 44], ['nidoking', 45], ['rhydon', 50]] },
      // Lorelei, Bruno, Agatha, Lance.
      { name: 'The Elite Four', kind: ELITE_FOUR, team: [['machamp', 53], ['dewgong', 54], ['gengar', 54], ['cloyster', 56], ['lapras', 56], ['dragonite', 62]] },
      { name: 'Champion Blue', kind: CHAMPION, team: [['pidgeot', 61], ['alakazam', 59], ['rhydon', 61], ['arcanine', 59], ['exeggutor', 61], ['charizard', 63]] },
    ],
  },

  {
    region: 'Johto',
    generation: 2,
    fights: [
      { name: 'Falkner', kind: GYM, type: 'flying', team: [['pidgey', 7], ['pidgeotto', 9]] },
      { name: 'Bugsy', kind: GYM, type: 'bug', team: [['metapod', 14], ['kakuna', 14], ['scyther', 16]] },
      { name: 'Whitney', kind: GYM, type: 'normal', team: [['clefairy', 18], ['miltank', 20]] },
      { name: 'Morty', kind: GYM, type: 'ghost', team: [['gastly', 21], ['haunter', 21], ['haunter', 23], ['gengar', 25]] },
      { name: 'Chuck', kind: GYM, type: 'fighting', team: [['primeape', 29], ['poliwrath', 31]] },
      { name: 'Jasmine', kind: GYM, type: 'steel', team: [['magnemite', 30], ['magnemite', 30], ['steelix', 35]] },
      { name: 'Pryce', kind: GYM, type: 'ice', team: [['seel', 27], ['dewgong', 29], ['piloswine', 31]] },
      { name: 'Clair', kind: GYM, type: 'dragon', team: [['dragonair', 37], ['dragonair', 37], ['dragonair', 37], ['kingdra', 40]] },
      // Will, Koga, Bruno, Karen.
      { name: 'The Elite Four', kind: ELITE_FOUR, team: [['xatu', 42], ['exeggutor', 42], ['crobat', 44], ['umbreon', 45], ['machamp', 46], ['houndoom', 47]] },
      { name: 'Champion Lance', kind: CHAMPION, team: [['gyarados', 44], ['dragonite', 47], ['dragonite', 47], ['aerodactyl', 46], ['charizard', 46], ['dragonite', 50]] },
    ],
  },

  {
    region: 'Hoenn',
    generation: 3,
    fights: [
      { name: 'Roxanne', kind: GYM, type: 'rock', team: [['geodude', 14], ['geodude', 14], ['nosepass', 15]] },
      { name: 'Brawly', kind: GYM, type: 'fighting', team: [['machop', 16], ['meditite', 16], ['makuhita', 19]] },
      { name: 'Wattson', kind: GYM, type: 'electric', team: [['voltorb', 20], ['electrike', 20], ['magneton', 22], ['manectric', 24]] },
      { name: 'Flannery', kind: GYM, type: 'fire', team: [['numel', 24], ['slugma', 24], ['camerupt', 26], ['torkoal', 29]] },
      { name: 'Norman', kind: GYM, type: 'normal', team: [['spinda', 27], ['vigoroth', 27], ['linoone', 29], ['slaking', 31]] },
      { name: 'Winona', kind: GYM, type: 'flying', team: [['swablu', 29], ['tropius', 29], ['pelipper', 30], ['skarmory', 31], ['altaria', 33]] },
      { name: 'Tate and Liza', kind: GYM, type: 'psychic', team: [['claydol', 41], ['xatu', 41], ['lunatone', 42], ['solrock', 42]] },
      { name: 'Wallace', kind: GYM, type: 'water', team: [['luvdisc', 40], ['whiscash', 42], ['sealeo', 40], ['seaking', 42], ['milotic', 43]] },
      // Sidney, Phoebe, Glacia, Drake.
      { name: 'The Elite Four', kind: ELITE_FOUR, team: [['mightyena', 49], ['absol', 49], ['banette', 49], ['dusclops', 51], ['walrein', 53], ['salamence', 55]] },
      { name: 'Champion Steven', kind: CHAMPION, team: [['skarmory', 57], ['claydol', 55], ['aggron', 56], ['cradily', 56], ['armaldo', 56], ['metagross', 58]] },
    ],
  },

  {
    region: 'Sinnoh',
    generation: 4,
    fights: [
      { name: 'Roark', kind: GYM, type: 'rock', team: [['geodude', 12], ['onix', 12], ['cranidos', 14]] },
      { name: 'Gardenia', kind: GYM, type: 'grass', team: [['cherubi', 19], ['turtwig', 19], ['roserade', 22]] },
      { name: 'Maylene', kind: GYM, type: 'fighting', team: [['meditite', 27], ['machoke', 27], ['lucario', 30]] },
      { name: 'Crasher Wake', kind: GYM, type: 'water', team: [['gyarados', 27], ['quagsire', 27], ['floatzel', 30]] },
      { name: 'Fantina', kind: GYM, type: 'ghost', team: [['duskull', 24], ['haunter', 24], ['mismagius', 26]] },
      { name: 'Byron', kind: GYM, type: 'steel', team: [['magneton', 37], ['steelix', 38], ['bastiodon', 41]] },
      { name: 'Candice', kind: GYM, type: 'ice', team: [['snover', 38], ['sneasel', 38], ['medicham', 40], ['abomasnow', 42]] },
      { name: 'Volkner', kind: GYM, type: 'electric', team: [['jolteon', 46], ['raichu', 46], ['luxray', 48], ['electivire', 50]] },
      // Aaron, Bertha, Flint, Lucian (Platinum teams).
      { name: 'The Elite Four', kind: ELITE_FOUR, team: [['drapion', 57], ['gliscor', 59], ['rhyperior', 59], ['alakazam', 61], ['magmortar', 61], ['gallade', 63]] },
      { name: 'Champion Cynthia', kind: CHAMPION, team: [['spiritomb', 61], ['roserade', 60], ['togekiss', 60], ['lucario', 63], ['milotic', 63], ['garchomp', 66]] },
    ],
  },

  {
    region: 'Unova',
    generation: 5,
    fights: [
      { name: 'Cilan, Chili and Cress', kind: GYM, type: 'grass', team: [['lillipup', 12], ['pansage', 14], ['pansear', 14], ['panpour', 14]] },
      { name: 'Lenora', kind: GYM, type: 'normal', team: [['herdier', 18], ['watchog', 20]] },
      { name: 'Burgh', kind: GYM, type: 'bug', team: [['whirlipede', 21], ['dwebble', 21], ['leavanny', 23]] },
      { name: 'Elesa', kind: GYM, type: 'electric', team: [['emolga', 25], ['emolga', 25], ['zebstrika', 27]] },
      { name: 'Clay', kind: GYM, type: 'ground', team: [['krokorok', 29], ['palpitoad', 29], ['excadrill', 31]] },
      { name: 'Skyla', kind: GYM, type: 'flying', team: [['swoobat', 33], ['unfezant', 33], ['swanna', 35]] },
      { name: 'Brycen', kind: GYM, type: 'ice', team: [['vanillish', 37], ['cryogonal', 37], ['beartic', 39]] },
      { name: 'Drayden', kind: GYM, type: 'dragon', team: [['fraxure', 41], ['druddigon', 41], ['haxorus', 43]] },
      // Shauntal, Grimsley, Caitlin, Marshal. All four aces are level 50 in
      // the games, so the last one listed is not the highest level.
      { name: 'The Elite Four', kind: ELITE_FOUR, team: [['cofagrigus', 48], ['krookodile', 48], ['gothitelle', 50], ['mienshao', 50], ['bisharp', 50], ['chandelure', 50]] },
      { name: 'Champion Alder', kind: CHAMPION, team: [['accelgor', 75], ['bouffalant', 75], ['druddigon', 75], ['vanilluxe', 75], ['escavalier', 75], ['volcarona', 77]] },
    ],
  },

  {
    region: 'Kalos',
    generation: 6,
    fights: [
      { name: 'Viola', kind: GYM, type: 'bug', team: [['surskit', 10], ['vivillon', 12]] },
      { name: 'Grant', kind: GYM, type: 'rock', team: [['amaura', 25], ['tyrunt', 25]] },
      { name: 'Korrina', kind: GYM, type: 'fighting', team: [['mienfoo', 29], ['machoke', 28], ['hawlucha', 32]] },
      { name: 'Ramos', kind: GYM, type: 'grass', team: [['jumpluff', 30], ['weepinbell', 31], ['gogoat', 34]] },
      { name: 'Clemont', kind: GYM, type: 'electric', team: [['emolga', 35], ['magneton', 35], ['heliolisk', 37]] },
      { name: 'Valerie', kind: GYM, type: 'fairy', team: [['mawile', 38], ['mr-mime', 39], ['sylveon', 42]] },
      { name: 'Olympia', kind: GYM, type: 'psychic', team: [['sigilyph', 44], ['slowking', 45], ['meowstic', 48]] },
      { name: 'Wulfric', kind: GYM, type: 'ice', team: [['abomasnow', 56], ['cryogonal', 55], ['avalugg', 59]] },
      // Malva, Siebold, Wikstrom, Drasna.
      { name: 'The Elite Four', kind: ELITE_FOUR, team: [['gyarados', 63], ['clawitzer', 63], ['dragalge', 63], ['talonflame', 65], ['noivern', 65], ['aegislash', 65]] },
      { name: 'Champion Diantha', kind: CHAMPION, team: [['hawlucha', 64], ['tyrantrum', 65], ['aurorus', 65], ['gourgeist', 65], ['goodra', 66], ['gardevoir', 68]] },
    ],
  },

  {
    region: 'Galar',
    generation: 8,

    // No Elite Four: the Champion Cup goes straight from the eighth badge to
    // Leon.
    fights: [
      { name: 'Milo', kind: GYM, type: 'grass', team: [['gossifleur', 19], ['eldegoss', 20]] },
      { name: 'Nessa', kind: GYM, type: 'water', team: [['goldeen', 22], ['arrokuda', 23], ['drednaw', 24]] },
      { name: 'Kabu', kind: GYM, type: 'fire', team: [['ninetales', 25], ['arcanine', 25], ['centiskorch', 27]] },
      { name: 'Bea', kind: GYM, type: 'fighting', team: [['hitmontop', 34], ['pangoro', 34], ['sirfetchd', 35], ['machamp', 36]] },
      { name: 'Opal', kind: GYM, type: 'fairy', team: [['weezing', 36], ['mawile', 36], ['togekiss', 37], ['alcremie', 38]] },
      { name: 'Gordie', kind: GYM, type: 'rock', team: [['barbaracle', 40], ['shuckle', 40], ['stonjourner', 41], ['coalossal', 42]] },
      { name: 'Piers', kind: GYM, type: 'dark', team: [['scrafty', 44], ['malamar', 45], ['skuntank', 45], ['obstagoon', 46]] },
      { name: 'Raihan', kind: GYM, type: 'dragon', team: [['torkoal', 46], ['flygon', 47], ['sandaconda', 46], ['duraludon', 48]] },
      { name: 'Champion Leon', kind: CHAMPION, team: [['aegislash', 62], ['dragapult', 62], ['haxorus', 63], ['seismitoad', 62], ['rhyperior', 64], ['charizard', 65]] },
    ],
  },

  {
    region: 'Paldea',
    generation: 9,

    // The eight gyms only; Titans and Team Star are not gyms.
    fights: [
      { name: 'Katy', kind: GYM, type: 'bug', team: [['nymble', 14], ['tarountula', 14], ['teddiursa', 15]] },
      { name: 'Brassius', kind: GYM, type: 'grass', team: [['petilil', 16], ['smoliv', 16], ['sudowoodo', 17]] },
      { name: 'Iono', kind: GYM, type: 'electric', team: [['wattrel', 23], ['luxio', 23], ['mismagius', 24], ['bellibolt', 24]] },
      { name: 'Kofu', kind: GYM, type: 'water', team: [['veluza', 29], ['wugtrio', 29], ['crabominable', 30]] },
      { name: 'Larry', kind: GYM, type: 'normal', team: [['komala', 35], ['dudunsparce', 36], ['staraptor', 36]] },
      { name: 'Ryme', kind: GYM, type: 'ghost', team: [['mimikyu', 41], ['banette', 41], ['houndstone', 41], ['toxtricity', 42]] },
      { name: 'Tulip', kind: GYM, type: 'psychic', team: [['farigiraf', 44], ['gardevoir', 44], ['espathra', 45], ['florges', 45]] },
      { name: 'Grusha', kind: GYM, type: 'ice', team: [['frosmoth', 47], ['beartic', 47], ['altaria', 47], ['cetitan', 48]] },
      // Rika, Poppy, Larry, Hassel.
      { name: 'The Elite Four', kind: ELITE_FOUR, team: [['donphan', 57], ['clodsire', 58], ['corviknight', 58], ['tinkaton', 59], ['flamigo', 60], ['baxcalibur', 61]] },
      { name: 'Champion Geeta', kind: CHAMPION, team: [['espathra', 61], ['avalugg', 61], ['kingambit', 61], ['veluza', 61], ['gogoat', 61], ['glimmora', 62]] },
    ],
  },
];

/**
 * The whole ladder, flattened and numbered.
 *
 * Index 0 is Brock. Each entry's `order` is 1-based and equals the trainer
 * level at which it is fought.
 */
let ladderCache = null;

function ladder() {
  if (ladderCache) return ladderCache;

  const all = [];

  for (const region of REGIONS) {
    for (const fight of region.fights) {
      all.push({
        order: all.length + 1,
        region: region.region,
        generation: region.generation,
        name: fight.name,
        kind: fight.kind,
        type: fight.type || null,
        team: fight.team.map(([species, level]) => ({ species, level })),
        moves: fight.moves || null,
      });
    }
  }

  ladderCache = all;
  return all;
}

/** How many fights the ladder holds. What Utils/trainer.js checks for prestige. */
const total = () => ladder().length;

/** The fight standing in front of a trainer who has cleared this many. */
function next(cleared) {
  const all = ladder();
  return cleared >= 0 && cleared < all.length ? all[cleared] : null;
}

/** One fight by its 1-based order, for looking up something already beaten. */
const byOrder = (order) => ladder()[order - 1] || null;

/**
 * A milestone's team, moved to sit at a trainer's cap.
 *
 * The canon levels define the team's shape (Brock's Geodude stays two levels
 * below his Onix). The whole team is shifted so the ace sits `aceBonus` above
 * the cap, and the others keep their relative distance below it.
 *
 * Without this, canon levels would be impossible or trivial depending on
 * where each milestone falls on the ladder.
 *
 * @param {object} fight    from ladder()
 * @param {number} cap      the trainer's obedience cap
 * @param {number} aceBonus how far over the cap the ace sits
 */
function scaleTeam(fight, cap, aceBonus = 2) {
  const canonAce = Math.max(...fight.team.map((member) => member.level));
  const target = cap + aceBonus;
  const shift = target - canonAce;

  return fight.team.map((member) => ({
    species: member.species,
    // Never below 2.
    level: Math.max(2, member.level + shift),
    canonLevel: member.level,
  }));
}

module.exports = {
  GYM,
  ELITE_FOUR,
  CHAMPION,
  REGIONS,
  ladder,
  total,
  next,
  byOrder,
  scaleTeam,
};

// ---------------------------------------------------------------------------
// `node Utils/milestones.js` - check every name against the real data.
// ---------------------------------------------------------------------------

/**
 * Every problem with the table, as a list.
 *
 * Mainly catches misspelled species names in the hand-typed table.
 */
function checkAll() {
  const problems = [];
  const all = ladder();

  for (const fight of all) {
    if (!fight.team.length) problems.push(`${fight.name}: no team`);
    if (fight.team.length > 6) problems.push(`${fight.name}: ${fight.team.length} Pokemon`);

    for (const member of fight.team) {
      const found = names.resolveSpecies(member.species);
      if (!found || !found.length) {
        problems.push(`${fight.name}: no species called "${member.species}"`);
      }
      if (!(member.level > 0)) {
        problems.push(`${fight.name}: ${member.species} has no level`);
      }
    }

    // The ace is listed last by convention; the announcement relies on it.
    const highest = Math.max(...fight.team.map((m) => m.level));
    if (fight.team[fight.team.length - 1].level !== highest) {
      problems.push(`${fight.name}: the ace is not listed last`);
    }
  }

  // Flag an Elite Four team that shares three or more species with the
  // region's champion, which suggests the wrong roster was copied. One or
  // two shared species can be legitimate.
  for (const region of REGIONS) {
    const gauntlet = region.fights.find((f) => f.kind === ELITE_FOUR);
    const champion = region.fights.find((f) => f.kind === CHAMPION);
    if (!gauntlet || !champion) continue;

    const theirs = new Set(champion.team.map(([species]) => species));
    const shared = gauntlet.team.filter(([species]) => theirs.has(species));

    if (shared.length > 2) {
      problems.push(
        `${region.region}: the Elite Four shares ${shared.length} Pokemon with ` +
          `${champion.name} (${shared.map(([s]) => s).join(', ')}) - is it the champion's team?`
      );
    }
  }

  return problems;
}

if (require.main === module) {
  const all = ladder();
  const problems = checkAll();

  console.log(`${all.length} milestones across ${REGIONS.length} regions\n`);

  for (const region of REGIONS) {
    const kinds = region.fights.reduce((acc, f) => ({ ...acc, [f.kind]: (acc[f.kind] || 0) + 1 }), {});
    console.log(
      `  gen ${region.generation}  ${region.region.padEnd(8)} ${String(region.fights.length).padStart(2)} fights` +
        `   ${kinds[GYM] || 0} gyms` +
        `${kinds[ELITE_FOUR] ? ', an Elite Four' : ', NO Elite Four'}` +
        `${kinds[CHAMPION] ? ', a champion' : ''}`
    );
  }

  const trainer = require('./trainer');

  console.log('\nwhere each one lands on the ladder:');
  for (const fight of all) {
    if (fight.order % 10 !== 1 && fight.order !== all.length) continue;

    const cap = trainer.capFor(fight.order);
    const scaled = scaleTeam(fight, cap);

    console.log(
      `  ${String(fight.order).padStart(3)}  ${fight.name.padEnd(22)} cap ${String(cap).padStart(3)}  ` +
        `canon ${scaled.map((m) => m.canonLevel).join('/')}  ->  ${scaled.map((m) => m.level).join('/')}`
    );
  }

  console.log(
    `\nthe last milestone is number ${all.length}, at cap ${trainer.capFor(all.length)}`
  );

  if (problems.length) {
    console.log(`\n${problems.length} PROBLEM(S):`);
    for (const line of problems) console.log(`  ${line}`);
    process.exit(1);
  }

  console.log('\nEvery species and level checks out.');
}

module.exports.checkAll = checkAll;
