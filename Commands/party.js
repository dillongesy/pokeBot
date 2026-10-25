'use strict';

/**
 * .party - everything you have caught.
 *
 * Supports sorting and filtering. Sort keys are looked up in
 * store.SORT_COLUMNS (unknown keys fall back to id) and filters are bound as
 * SQL parameters by store.listParty.
 *
 *   .p                        everything
 *   .p name: <mon>            every one of that species, any form
 *   .p shiny | .p s
 *   .p legendary | .p l
 *   .p mythical | .p m
 *   .p ultrabeast | .p ub | .p ultra
 *   .p swap <a> <b>           reorder by hand, by party number
 *   .p lvl 30                 exactly level 30
 *   .p lvl 25-35              a range
 *   .p lvl 40+  .p lvl <20    open-ended
 *   .p suggested              everything that will obey you, strongest first
 *
 * Sort arguments can be combined with any filter. The first six Pokemon in the
 * party are the battle team (see store.battleTeam).
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const store = require('../Utils/store');
const rarity = require('../Utils/rarity');
const names = require('../Utils/names');
const pager = require('../Utils/pager');
const obedience = require('../Utils/obedience');
const partylock = require('../Utils/partylock');
const { summaryLine } = require('../Utils/display');

const PAGE_SIZE = 15;

/** What each sort key is called when we echo it back. */
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

/** The words that introduce a species filter. */
const NAME_PREFIXES = new Set(['name', 'name:', 'n', 'n:']);

/**
 * The words that introduce a level filter.
 *
 * "level" is also a sort key. It only acts as a filter when a level expression
 * follows it, so `.p level desc` still sorts.
 */
const LEVEL_PREFIXES = new Set(['lvl', 'lvl:', 'lv', 'lv:', 'level', 'level:']);

/** The words that ask for everything that will obey. */
const SUGGESTED_WORDS = new Set(['suggested', 'suggest', 'sug', 'usable', 'obedient', 'battle']);

/** Upper bound for open-ended ranges like "40+". */
const TOP_LEVEL = 100;

/**
 * Read a level expression into bounds, or null if it is not one.
 *
 *   30      exactly 30          { min: 30, max: 30 }
 *   25-35   a range             { min: 25, max: 35 }
 *   40+     that and up         { min: 40, max: 100 }
 *   <20     under 20            { min: 1,  max: 19 }
 *   >40     over 40             { min: 41, max: 100 }
 *
 * Returns null for anything else, so the caller can treat "level" as a sort
 * key instead.
 */
function parseLevelRange(token) {
  const raw = String(token || '').trim();
  if (!raw) return null;

  const range = /^(\d{1,3})\s*-\s*(\d{1,3})$/.exec(raw);
  if (range) {
    const [a, b] = [Number(range[1]), Number(range[2])].sort((x, y) => x - y);
    return clampRange(a, b);
  }

  const from = /^(\d{1,3})\s*\+$/.exec(raw);
  if (from) return clampRange(Number(from[1]), TOP_LEVEL);

  const under = /^<\s*(\d{1,3})$/.exec(raw);
  if (under) return clampRange(1, Number(under[1]) - 1);

  const over = /^>\s*(\d{1,3})$/.exec(raw);
  if (over) return clampRange(Number(over[1]) + 1, TOP_LEVEL);

  if (/^\d{1,3}$/.test(raw)) return clampRange(Number(raw), Number(raw));

  return null;
}

/** Keep both ends inside 1..100, and never let them cross. */
function clampRange(min, max) {
  const low = Math.max(1, Math.min(TOP_LEVEL, min));
  const high = Math.max(1, Math.min(TOP_LEVEL, max));
  return high < low ? null : { min: low, max: high };
}

/** How a level filter reads back. */
function describeLevels({ minLevel, maxLevel }) {
  if (minLevel === maxLevel) return `level ${minLevel}`;
  if (minLevel <= 1) return `level ${maxLevel} and under`;
  if (maxLevel >= TOP_LEVEL) return `level ${minLevel} and up`;
  return `level ${minLevel}-${maxLevel}`;
}

/** Embed colour for each filter. */
const FILTER_COLORS = {
  shiny: 0xffd700,
  legendary: rarity.COLORS.legendary,
  mythical: rarity.COLORS.mythical,
  ultraBeast: rarity.COLORS.ultraBeast,

  // Same green as the battle buttons.
  suggested: 0x2ecc71,
};

const DEFAULT_COLOR = 0x4287f5;

/**
 * Read ".party iv desc 2" into options.
 *
 * Arguments can appear in any order and are all optional.
 *
 * `defaults` is the player's saved .order preference. Arguments override it
 * for this call only.
 */
function parseArgs(args = [], defaults = {}) {
  const options = {
    sort: defaults.sort || 'id',
    direction: defaults.direction || 'asc',
    page: 1,
    filter: {},
    filterName: null,
    swap: null,
    suggested: false,

    // Track whether a sort was given explicitly, so `.p suggested` only
    // applies its default sort when none was.
    sortGiven: false,
  };

  const words = args.filter((value) => value !== null && value !== undefined).map(String);

  for (let i = 0; i < words.length; i += 1) {
    const arg = words[i].toLowerCase().replace(/^--/, '');

    // ".p swap 1 10": takes the next two numbers; sort arguments are ignored.
    if (arg === 'swap') {
      const a = parseInt(words[i + 1], 10);
      const b = parseInt(words[i + 2], 10);
      options.swap = [a, b];
      i += 2;
      continue;
    }

    // ".p name: pikachu". Bare "name" with nothing after it is the sort key.
    if (NAME_PREFIXES.has(arg) && words[i + 1]) {
      const wanted = words.slice(i + 1).join(' ');
      options.filterName = wanted;
      options.filter.speciesKeys = names.resolveKeys(wanted);
      break;
    }

    // ".p lvl 25-35". Without a level expression after it, "level" is the
    // sort key.
    if (LEVEL_PREFIXES.has(arg)) {
      const attached = arg.includes(':') ? arg.slice(arg.indexOf(':') + 1) : '';
      const bounds = parseLevelRange(attached || words[i + 1]);

      if (bounds) {
        options.filter.minLevel = bounds.min;
        options.filter.maxLevel = bounds.max;
        if (!attached) i += 1;
        continue;
      }
    }

    // ".p lvl30" and ".p 25-35": no space, or no keyword.
    if (/^(lvl|lv|level)\d/.test(arg)) {
      const bounds = parseLevelRange(arg.replace(/^(lvl|lv|level)/, ''));
      if (bounds) {
        options.filter.minLevel = bounds.min;
        options.filter.maxLevel = bounds.max;
        continue;
      }
    }

    if (SUGGESTED_WORDS.has(arg)) {
      options.suggested = true;
      continue;
    }

    if (arg === 'shiny' || arg === 's') {
      options.filter.shiny = true;
      continue;
    }

    const bucket = rarity.parse(arg);
    if (bucket && bucket !== 'normal') {
      options.filter.rarity = bucket;
      continue;
    }

    if (arg === 'desc' || arg === 'descending') options.direction = 'desc';
    else if (arg === 'asc' || arg === 'ascending') options.direction = 'asc';
    else if (/^\d+$/.test(arg)) options.page = Math.max(1, parseInt(arg, 10));
    else if (arg.startsWith('sort=')) {
      options.sort = arg.slice(5);
      options.sortGiven = true;
    } else if (store.SORT_COLUMNS[arg]) {
      options.sort = arg;
      options.sortGiven = true;
    }
  }

  // Strongest first.
  if (options.suggested && !options.sortGiven) {
    options.sort = 'level';
    options.direction = 'desc';
  }

  return options;
}

/** The colour and heading a filter implies. */
function describeFilter(user, options) {
  if (options.suggested) {
    return { color: FILTER_COLORS.suggested, title: `${user.username}'s battle-ready Pokemon` };
  }

  if (options.filter.minLevel !== undefined) {
    return {
      color: DEFAULT_COLOR,
      title: `${user.username}'s Pokemon at ${describeLevels(options.filter)}`,
    };
  }

  if (options.filter.shiny) {
    return { color: FILTER_COLORS.shiny, title: `${user.username}'s shiny Pokemon` };
  }

  if (options.filter.rarity) {
    return {
      color: FILTER_COLORS[options.filter.rarity] || DEFAULT_COLOR,
      title: `${user.username}'s ${rarity.LABELS[options.filter.rarity]} Pokemon`,
    };
  }

  if (options.filterName) {
    return { color: DEFAULT_COLOR, title: `All ${options.filterName} in ${user.username}'s party` };
  }

  return { color: DEFAULT_COLOR, title: `${user.username}'s party` };
}

/** One embed of "you have nothing to show" for whatever was asked for. */
function emptyEmbed(user, options) {
  const { title } = describeFilter(user, options);

  const reason = options.suggested
    ? 'Nothing you own will obey you at your trainer level.\n' +
      'Catch something at or below your cap - `.d` - and it will listen from the start.'
    : options.filter.minLevel !== undefined
      ? `Nothing at ${describeLevels(options.filter)}.`
      : options.filterName
        ? `No ${options.filterName} in your party.`
        : options.filter.shiny
          ? 'No shinies yet.'
          : options.filter.rarity
            ? `No ${rarity.LABELS[options.filter.rarity]} Pokemon yet.`
            : 'Nothing caught yet. Type `.d` to drop one.';

  return new EmbedBuilder().setTitle(title).setDescription(reason).setColor(0x888888);
}

/**
 * Build the paged party view.
 *
 * Returns either { empty } or { pages, page, render } for the pager. Shared by
 * the slash and prefix handlers.
 */
function buildParty(user, args) {
  const account = store.ensureUser(user.id);
  const options = parseArgs(args, {
    sort: account.party_sort,
    direction: account.party_direction,
  });

  // ".p suggested" filters by the trainer's obedience cap.
  const standing = options.suggested ? store.trainerProgress(user.id) : null;
  if (standing) options.filter.obeysAtCap = standing.cap;

  const total = store.countParty(user.id, options.filter);
  if (!total) return { empty: emptyEmbed(user, options), options };

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(options.page, pages) - 1;
  const known = store.SORT_COLUMNS[options.sort] ? options.sort : 'id';
  const { color, title } = describeFilter(user, options);

  // Also show the current battle team (the first six).
  const heading = standing
    ? `Obeys at trainer level **${standing.level}** - Pokemon cap is **${standing.cap}**, ` +
      `nothing over **${standing.cap + obedience.MAX_OVER_CAP}**.\n` +
      'The **first six of `.party`** are the team. `.p swap <a> <b>` to move one up.'
    : null;

  const render = (index) => {
    const rows = store.listParty(user.id, {
      sort: known,
      direction: options.direction,
      limit: PAGE_SIZE,
      offset: index * PAGE_SIZE,
      filter: options.filter,
    });

    const body = rows.map(summaryLine).join('\n') || '-';

    return new EmbedBuilder()
      .setTitle(title)
      .setDescription(heading ? `${heading}\n\n${body}` : body)
      .setColor(color)
      .setFooter({
        text:
          `${total} shown, sorted by ${SORT_LABELS[known]} ${options.direction}.` +
          ` Page ${index + 1}/${pages}`,
      });
  };

  return { pages, page, render, options, total };
}

/**
 * ".p swap 1 10" - reorder, then say what moved.
 *
 * Swapping also switches the saved sort to "custom", otherwise the swap would
 * be hidden by the next sort.
 */
function runSwap(userId, [a, b]) {
  // Not allowed during a battle or trade (see Utils/partylock.js).
  const busy = partylock.refusalFor(userId, 'reorder your party');
  if (busy) return busy;

  if (!Number.isInteger(a) || !Number.isInteger(b)) {
    return 'Which two? Try `.p swap 1 10`, using the numbers from `.party`.';
  }

  const result = store.swapPartyPositions(userId, a, b);
  if (!result.ok) return result.message;

  store.setPartyOrder(userId, 'custom', 'asc');

  // Party numbers don't change, only positions, so the reply names the
  // Pokemon that moved.
  const [first, second] = result.moved;
  return (
    `Swapped **#${first.party_number} ${first.display_name}** and ` +
    `**#${second.party_number} ${second.display_name}**.`
  );
}

module.exports = {
  aliases: ['party', 'p'],

  data: new SlashCommandBuilder()
    .setName('party')
    .setDescription('Shows the Pokemon you have caught.')
    .addStringOption((option) =>
      option
        .setName('show')
        .setDescription('Narrow it down.')
        .addChoices(
          { name: 'everything', value: 'all' },
          { name: 'shiny', value: 'shiny' },
          { name: 'legendary', value: 'legendary' },
          { name: 'mythical', value: 'mythical' },
          { name: 'ultra beast', value: 'ultrabeast' }
        )
    )
    .addStringOption((option) =>
      option.setName('name').setDescription('Only this species.')
    )
    .addStringOption((option) =>
      option
        .setName('sort')
        .setDescription('What to order by.')
        .addChoices(
          ...Object.keys(SORT_LABELS).map((key) => ({ name: SORT_LABELS[key], value: key }))
        )
    )
    .addStringOption((option) =>
      option
        .setName('direction')
        .setDescription('Ascending or descending.')
        .addChoices({ name: 'ascending', value: 'asc' }, { name: 'descending', value: 'desc' })
    )
    .addIntegerOption((option) =>
      option.setName('page').setDescription('Which page to show.').setMinValue(1)
    ),

  async execute(interaction) {
    store.ensureUser(interaction.user.id);

    const show = interaction.options.getString('show');
    const name = interaction.options.getString('name');

    const args = [
      show && show !== 'all' ? show : null,
      interaction.options.getString('sort'),
      interaction.options.getString('direction'),
      interaction.options.getInteger('page'),
    ].filter((value) => value !== null && value !== undefined);

    // A name filter consumes everything after it, so it has to go last.
    if (name) args.push('name:', name);

    const built = buildParty(interaction.user, args.map(String));

    if (built.empty) {
      await interaction.reply({ embeds: [built.empty] });
      return;
    }

    await pager.sendPaged({
      send: pager.interactionSender(interaction),
      pages: built.pages,
      page: built.page,
      render: built.render,
      userId: interaction.user.id,
    });
  },

  async run(message, args) {
    store.ensureUser(message.author.id);

    const options = parseArgs(args, {});
    if (options.swap) {
      await message.channel.send(runSwap(message.author.id, options.swap));
      return;
    }

    const built = buildParty(message.author, args);

    if (built.empty) {
      await message.channel.send({ embeds: [built.empty] });
      return;
    }

    await pager.sendPaged({
      send: (payload) => message.channel.send(payload),
      pages: built.pages,
      page: built.page,
      render: built.render,
      userId: message.author.id,
    });
  },

  parseArgs,
  buildParty,
  runSwap,
  describeFilter,
  PAGE_SIZE,
};
