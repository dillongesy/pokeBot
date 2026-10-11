'use strict';

/**
 * .order - how your party is arranged.
 *
 * This command does two things.
 *
 * Arrangements (flexdex, dex, countLow, countHigh, alphabetical, battle)
 * rewrite the stored position of every Pokemon once. The result can then be
 * adjusted with `.p swap`. An optional ignoreNum leaves the first N slots
 * untouched.
 *
 * Preferences (level, iv, bst, ...) only set the default `.party` sort; no
 * positions change.
 *
 * flexdex puts shinies first, then mythicals, Ultra Beasts and legendaries,
 * with the species you own fewest of first within each group. `.order battle`
 * puts the strongest obedient Pokemon in the first six slots, which form the
 * battle team.
 */

const { SlashCommandBuilder } = require('discord.js');

const store = require('../Utils/store');
const partylock = require('../Utils/partylock');
const obedience = require('../Utils/obedience');

/** Saved sort preferences - the same names .party accepts. */
const SORT_LABELS = {
  party: 'party number',
  id: 'catch order',
  custom: 'your order',
  dex: 'dex number',
  name: 'name',
  level: 'level',
  iv: 'IV total',
  bst: 'base stat total',
  hp: 'HP',
  attack: 'Attack',
  defense: 'Defense',
  speed: 'Speed',
  shiny: 'shiny',
  caught: 'date caught',
};

/** How rare a bucket is, lowest first. Drives flexdex. */
const RARITY_RANK = { mythical: 0, ultraBeast: 1, legendary: 2, normal: 3 };

/** What to call each arrangement when confirming it. */
const ARRANGEMENTS = {
  flexdex: 'flexdex - your rarest and best first',
  dex: 'dex number',
  countlow: 'fewest owned first',
  counthigh: 'most owned first',
  alphabetical: 'alphabetically',
  battle: 'battle-ready - everything that will obey you, strongest first',
};

/** Case-insensitive lookup for arrangement names. */
const ARRANGEMENT_ALIASES = {
  flexdex: 'flexdex',
  flex: 'flexdex',
  dex: 'dex',
  pokedex: 'dex',
  countlow: 'countlow',
  countslow: 'countlow',
  lowcount: 'countlow',
  counthigh: 'counthigh',
  countshigh: 'counthigh',
  highcount: 'counthigh',
  alphabetical: 'alphabetical',
  alphabetic: 'alphabetical',
  abc: 'alphabetical',
  battle: 'battle',
  battleready: 'battle',
  suggested: 'battle',
  ready: 'battle',
};

/** The name a Pokemon sorts under. Nicknames deliberately do not count. */
const sortName = (row) => String(row.display_name || row.species_name || '').toLowerCase();

/**
 * Build the comparator for an arrangement.
 *
 * `counts` maps species id to how many are in the part being sorted, so
 * Pokemon pinned above ignoreNum do not affect it.
 */
function comparatorFor(arrangement, counts, cap = null) {
  const count = (row) => counts.get(row.species_id) || 0;
  const byName = (a, b) => sortName(a).localeCompare(sortName(b));
  const byDex = (a, b) => a.species_id - b.species_id || byName(a, b);

  // Shared tail for every rarity group in flexdex: rarest-for-you, then dex.
  const byScarcity = (a, b) => count(a) - count(b) || byDex(a, b);

  switch (arrangement) {
    case 'dex':
      return byDex;

    // Obedient Pokemon first, then by level, base stat total and IVs, so the
    // first six form the strongest team that will obey.
    case 'battle':
      return (a, b) => {
        const aObeys = obedience.obeys(a, cap);
        const bObeys = obedience.obeys(b, cap);

        if (aObeys !== bObeys) return aObeys ? -1 : 1;

        return b.level - a.level || b.bst - a.bst || b.iv_total - a.iv_total || byDex(a, b);
      };

    case 'alphabetical':
      return (a, b) => byName(a, b) || a.species_id - b.species_id;

    case 'countlow':
      return (a, b) => count(a) - count(b) || byDex(a, b);

    case 'counthigh':
      return (a, b) => count(b) - count(a) || byDex(a, b);

    case 'flexdex':
    default:
      return (a, b) => {
        // Shinies come first, whatever they are.
        if (!!a.shiny !== !!b.shiny) return a.shiny ? -1 : 1;

        const rankA = RARITY_RANK[a.rarity] ?? 3;
        const rankB = RARITY_RANK[b.rarity] ?? 3;

        // Among shinies, rarity decides before anything else.
        if (a.shiny && b.shiny) return rankA - rankB || byScarcity(a, b);

        // Otherwise each rarity group in turn, rarest group first.
        if (rankA !== rankB) return rankA - rankB;

        // Within a rare group, fewest owned first. Ordinary Pokemon just
        // follow dex order.
        return rankA === RARITY_RANK.normal ? byDex(a, b) : byScarcity(a, b);
      };
  }
}

/**
 * Rearrange a party and save the new positions.
 *
 * @returns {{ content: string }}
 */
function arrange(userId, arrangement, rawIgnore) {
  // Not allowed during a battle or trade (see Utils/partylock.js).
  const busy = partylock.refusalFor(userId, 'rearrange your party');
  if (busy) return { content: busy };

  const all = store.listParty(userId, { sort: 'custom', limit: -1 });

  if (all.length < 2) {
    return { content: 'You need at least two Pokemon before ordering means anything.' };
  }

  let ignore = 0;
  if (rawIgnore !== undefined && rawIgnore !== null && String(rawIgnore) !== '') {
    ignore = parseInt(rawIgnore, 10);

    if (!Number.isInteger(ignore) || ignore < 0 || ignore > all.length) {
      return {
        content: `That ignore count is not valid. You have ${all.length} Pokemon, so it has to be between 0 and ${all.length}.`,
      };
    }
  }

  const pinned = all.slice(0, ignore);
  const sortable = all.slice(ignore);

  if (!sortable.length) {
    return { content: 'That would pin every Pokemon, leaving nothing to sort.' };
  }

  // Count only the part being sorted, so pinned Pokemon don't skew it.
  const counts = new Map();
  for (const row of sortable) counts.set(row.species_id, (counts.get(row.species_id) || 0) + 1);

  // Read the obedience cap once rather than per comparison.
  const cap = arrangement === 'battle' ? store.trainerCap(userId) : null;

  sortable.sort(comparatorFor(arrangement, counts, cap));

  store.assignPartyPositions(userId, [...pinned, ...sortable].map((row) => row.id));
  store.setPartyOrder(userId, 'custom', 'asc');

  const tail =
    arrangement === 'battle'
      ? `\nYour first six are now the best team you own at trainer cap **${cap}**.` +
        ' `.team` shows them.'
      : '';

  return {
    content:
      `Your party is now ordered by **${ARRANGEMENTS[arrangement]}**` +
      (ignore ? `, leaving the first ${ignore} where ${ignore === 1 ? 'it was' : 'they were'}.` : '.') +
      tail,
  };
}

/**
 * Save a sort preference without moving anything.
 *
 * Also locked during a battle or trade, because store.battleTeam uses the
 * saved sort to pick the team.
 */
function setPreference(userId, field, rawDirection) {
  const busy = partylock.refusalFor(userId, 'change how your party is sorted');
  if (busy) return { content: busy };

  const direction = String(rawDirection ?? '').toLowerCase().startsWith('desc') ? 'desc' : 'asc';
  store.setPartyOrder(userId, field, direction);

  return {
    content: `Your party will sort by **${SORT_LABELS[field]}**, ${direction === 'desc' ? 'highest' : 'lowest'} first.`,
  };
}

function setOrder(userId, rawField, rawSecond) {
  const user = store.ensureUser(userId);

  const field = String(rawField ?? '')
    .toLowerCase()
    .replace(/^--/, '');

  if (!field) {
    return {
      content:
        `Your party is sorted by **${SORT_LABELS[user.party_sort] || user.party_sort}** ` +
        `(${user.party_direction}).\n` +
        `Rearrange it with \`.order <order> [ignoreNum]\` - ${Object.keys(ARRANGEMENTS).join(', ')}.\n` +
        `Or set a default sort with \`.order <field>\` - ${Object.keys(SORT_LABELS).join(', ')}.`,
    };
  }

  const arrangement = ARRANGEMENT_ALIASES[field.replace(/[^a-z]/g, '')];
  if (arrangement) return arrange(userId, arrangement, rawSecond);

  if (!store.SORT_COLUMNS[field]) {
    return {
      content:
        `Cannot order by "${field}".\n` +
        `Arrangements: ${Object.keys(ARRANGEMENTS).join(', ')}.\n` +
        `Sort fields: ${Object.keys(SORT_LABELS).join(', ')}.`,
    };
  }

  return setPreference(userId, field, rawSecond);
}

module.exports = {
  aliases: ['order', 'sort', 'o'],

  data: new SlashCommandBuilder()
    .setName('order')
    .setDescription('Rearranges your party, or sets how it sorts by default.')
    .addStringOption((option) =>
      option
        .setName('field')
        .setDescription('An arrangement, or a field to sort by.')
        .setRequired(true)
        // Discord rejects duplicate choice values, and "dex" is both an
        // arrangement and a sort key. The arrangement wins.
        .addChoices(
          ...Object.keys(ARRANGEMENTS).map((key) => ({ name: ARRANGEMENTS[key], value: key })),
          ...Object.keys(SORT_LABELS)
            .filter((key) => !(key in ARRANGEMENTS))
            .map((key) => ({ name: `sort by ${SORT_LABELS[key]}`, value: key }))
        )
    )
    .addStringOption((option) =>
      option
        .setName('direction')
        .setDescription('Ascending or descending. Ignored by an arrangement.')
        .addChoices({ name: 'ascending', value: 'asc' }, { name: 'descending', value: 'desc' })
    )
    .addIntegerOption((option) =>
      option
        .setName('ignore')
        .setDescription('Leave this many slots at the top untouched.')
        .setMinValue(0)
    ),

  async execute(interaction) {
    const field = interaction.options.getString('field');
    const ignore = interaction.options.getInteger('ignore');
    const direction = interaction.options.getString('direction');

    // An arrangement takes the ignore count where a preference takes direction.
    const second = ARRANGEMENT_ALIASES[String(field).replace(/[^a-z]/g, '')] ? ignore : direction;

    await interaction.reply(setOrder(interaction.user.id, field, second));
  },

  async run(message, args) {
    await message.channel.send(setOrder(message.author.id, args[0], args[1]));
  },

  setOrder,
  arrange,
  comparatorFor,
  ARRANGEMENTS,
  ARRANGEMENT_ALIASES,
  SORT_LABELS,
  RARITY_RANK,
};
