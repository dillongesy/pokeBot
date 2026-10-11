'use strict';

/**
 * Every Pokemon game, newest first.
 *
 * PokeAPI records learnsets and TM numbers per version group, and they differ
 * between games. This bot uses the newest game a Pokemon appears in, falling
 * back to older games for Pokemon cut from the latest ones.
 *
 * Release order is written out by hand because PokeAPI's `order` field is not
 * release order. A new game means one new line at the top.
 *
 * Two games are listed but never win, because they have no level-up moves or
 * TMs in the data:
 *
 *   champions        every entry uses the "train" method.
 *   legends-arceus   uses its own mastery system rather than TMs.
 *
 * Four are listed only so their TM numbers rank correctly: legends-za,
 * mega-dimension, the-teal-mask and the-indigo-disk. No Pokemon has learnset
 * entries for them, but Data/Machines does, and an unranked group would sort
 * last.
 */

/**
 * Release order, newest first. Index 0 is the most recent game.
 *
 * The Japan-only Gen 1 releases sit together at the bottom.
 */
const NEWEST_FIRST = [
  'champions',
  'mega-dimension',
  'legends-za',
  'the-indigo-disk',
  'the-teal-mask',
  'scarlet-violet',
  'legends-arceus',
  'brilliant-diamond-shining-pearl',
  'sword-shield',
  'lets-go-pikachu-lets-go-eevee',
  'ultra-sun-ultra-moon',
  'sun-moon',
  'omega-ruby-alpha-sapphire',
  'x-y',
  'black-2-white-2',
  'black-white',
  'heartgold-soulsilver',
  'platinum',
  'diamond-pearl',
  'xd',
  'emerald',
  'firered-leafgreen',
  'colosseum',
  'ruby-sapphire',
  'crystal',
  'gold-silver',
  'yellow',
  'red-blue',
  'red-green-japan',
  'blue-japan',
];

/** versionGroup -> how recent it is. 0 is newest; unknown groups sort last. */
const RANK = new Map(NEWEST_FIRST.map((name, index) => [name, index]));

/**
 * Display names, since title-casing the slugs gives poor results
 * ("Lets go pikachu lets go eevee").
 */
const DISPLAY = {
  champions: 'Champions',
  'mega-dimension': 'Legends Z-A: Mega Dimension',
  'legends-za': 'Legends: Z-A',
  'the-indigo-disk': 'The Indigo Disk',
  'the-teal-mask': 'The Teal Mask',
  'scarlet-violet': 'Scarlet/Violet',
  'legends-arceus': 'Legends: Arceus',
  'brilliant-diamond-shining-pearl': 'Brilliant Diamond/Shining Pearl',
  'sword-shield': 'Sword/Shield',
  'lets-go-pikachu-lets-go-eevee': "Let's Go Pikachu/Eevee",
  'ultra-sun-ultra-moon': 'Ultra Sun/Ultra Moon',
  'sun-moon': 'Sun/Moon',
  'omega-ruby-alpha-sapphire': 'Omega Ruby/Alpha Sapphire',
  'x-y': 'X/Y',
  'black-2-white-2': 'Black 2/White 2',
  'black-white': 'Black/White',
  'heartgold-soulsilver': 'HeartGold/SoulSilver',
  platinum: 'Platinum',
  'diamond-pearl': 'Diamond/Pearl',
  xd: 'XD: Gale of Darkness',
  emerald: 'Emerald',
  'firered-leafgreen': 'FireRed/LeafGreen',
  colosseum: 'Colosseum',
  'ruby-sapphire': 'Ruby/Sapphire',
  crystal: 'Crystal',
  'gold-silver': 'Gold/Silver',
  yellow: 'Yellow',
  'red-blue': 'Red/Blue',
  'red-green-japan': 'Red/Green',
  'blue-japan': 'Blue',
};

/** A game's name as a person would write it. Falls back to the slug. */
const displayNameOf = (versionGroup) => DISPLAY[versionGroup] || versionGroup || 'an unknown game';

/** Lower is newer. An unknown group ranks below every known one. */
const rankOf = (versionGroup) =>
  RANK.has(versionGroup) ? RANK.get(versionGroup) : Number.MAX_SAFE_INTEGER;

/** Is `a` from a newer game than `b`? */
const isNewer = (a, b) => rankOf(a) < rankOf(b);

/**
 * The newest version group in a list.
 *
 * @param {Iterable<string>} groups
 * @returns {string|null}
 */
function newest(groups) {
  let best = null;

  for (const group of groups) {
    if (best === null || isNewer(group, best)) best = group;
  }

  return best;
}

module.exports = { NEWEST_FIRST, RANK, DISPLAY, displayNameOf, rankOf, isNewer, newest };

// `node Utils/versiongroups.js` - check the list against what is imported.
if (require.main === module) {
  const fs = require('fs');
  const path = require('path');

  const DATA = path.join(__dirname, '..', 'Data', 'Pokemon');
  const index = JSON.parse(fs.readFileSync(path.join(DATA, 'index.json'), 'utf8'));

  const seen = new Map();

  for (const form of index.forms) {
    const file = path.join(DATA, String(form.speciesId), form.folder, 'data.json');
    if (!fs.existsSync(file)) continue;

    for (const move of JSON.parse(fs.readFileSync(file, 'utf8')).moves || []) {
      for (const learn of move.learn || []) {
        if (!seen.has(learn.versionGroup)) seen.set(learn.versionGroup, new Set());
        seen.get(learn.versionGroup).add(learn.method);
      }
    }
  }

  console.log(`${seen.size} version groups in Data/Pokemon, newest first:\n`);

  for (const group of NEWEST_FIRST) {
    const methods = seen.get(group);
    const levels = methods && methods.has('level-up');
    const tms = methods && methods.has('machine');

    console.log(
      `  ${String(rankOf(group)).padStart(2)}  ${group.padEnd(34)}` +
        (methods ? `${levels ? 'level-up ' : '         '}${tms ? 'TMs' : ''}` : 'NOT IMPORTED')
    );
  }

  const unranked = [...seen.keys()].filter((group) => !RANK.has(group));

  if (unranked.length) {
    console.log(`\nUNRANKED (they will sort last, which is probably wrong):`);
    for (const group of unranked) console.log(`  ${group}`);
    process.exit(1);
  }

  console.log('\nEvery imported version group is ranked.');
}
