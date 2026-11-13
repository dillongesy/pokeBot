'use strict';

/**
 * .party - everything you have caught.
 *
 * Opens on the saved `.order` sort and lets the viewer look around with:
 *
 *   Show dropdown    Everything, Shinies, Legendaries, Mythicals, Ultra
 *                    Beasts, Battle-ready, Holding an item
 *   Sort dropdown    every sort in SORTS (slot, level, IVs, each stat...)
 *   Buttons          first, back, forward, last, and the direction
 *
 * None of that is saved: it is for finding Pokemon. `.order` sets the saved
 * sort, which also picks the battle team (the first six).
 *
 * Typed arguments open straight onto a view, in any order:
 *
 *   .p iv desc                sort by IVs, highest first
 *   .p name: <mon>            every one of that species, any form
 *   .p shiny | .p s
 *   .p legendary | .p l
 *   .p mythical | .p m
 *   .p ultrabeast | .p ub | .p ultra
 *   .p holding                everything holding an item
 *   .p lvl 30                 exactly level 30
 *   .p lvl 25-35              a range
 *   .p lvl 40+  .p lvl <20    open-ended
 *   .p suggested              everything that will obey you, strongest first
 *   .p swap <a> <b>           swap two slots (same as .swap)
 *
 * Sort keys map to fixed SQL in store.SORT_COLUMNS, and filters are bound as
 * SQL parameters by store.listParty.
 */

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = require('discord.js');

const store = require('../Utils/store');
const rarity = require('../Utils/rarity');
const names = require('../Utils/names');
const pager = require('../Utils/pager');
const livebuttons = require('../Utils/livebuttons');
const obedience = require('../Utils/obedience');
const partylock = require('../Utils/partylock');
const { summaryLine, titleCase } = require('../Utils/display');

const PAGE_SIZE = 15;

/** "Nov 2, 2026". Fixed to en-US so it reads the same for everyone. */
const DATE = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

/**
 * Every sort, in dropdown order (Discord allows 25).
 *
 * `dir` is the direction it opens in, so picking Speed shows the fastest
 * first. `kind` picks the direction button's wording. `extra` adds the sorted
 * value to each line when the line doesn't already show it.
 */
const SORTS = [
  { key: 'party', label: 'Slot', dir: 'asc', kind: 'number' },
  { key: 'level', label: 'Level', dir: 'desc', kind: 'number' },
  { key: 'iv', label: 'IV %', dir: 'desc', kind: 'number' },
  { key: 'name', label: 'Name', dir: 'asc', kind: 'text' },
  { key: 'dex', label: 'Dex number', dir: 'asc', kind: 'number', extra: (r) => `Dex #${r.species_id}` },
  { key: 'bst', label: 'Base stat total', dir: 'desc', kind: 'number', extra: (r) => `BST ${r.bst}` },
  { key: 'hp', label: 'HP', dir: 'desc', kind: 'number', extra: (r) => `HP ${r.stat_hp}` },
  { key: 'attack', label: 'Attack', dir: 'desc', kind: 'number', extra: (r) => `Atk ${r.stat_attack}` },
  { key: 'defense', label: 'Defense', dir: 'desc', kind: 'number', extra: (r) => `Def ${r.stat_defense}` },
  { key: 'spatk', label: 'Special Attack', dir: 'desc', kind: 'number', extra: (r) => `SpA ${r.stat_special_attack}` },
  { key: 'spdef', label: 'Special Defense', dir: 'desc', kind: 'number', extra: (r) => `SpD ${r.stat_special_defense}` },
  { key: 'speed', label: 'Speed', dir: 'desc', kind: 'number', extra: (r) => `Spe ${r.stat_speed}` },
  { key: 'ivhp', label: 'HP IV', dir: 'desc', kind: 'number', extra: (r) => `HP IV ${r.iv_hp}/31` },
  { key: 'ivattack', label: 'Attack IV', dir: 'desc', kind: 'number', extra: (r) => `Atk IV ${r.iv_attack}/31` },
  { key: 'ivdefense', label: 'Defense IV', dir: 'desc', kind: 'number', extra: (r) => `Def IV ${r.iv_defense}/31` },
  { key: 'ivspatk', label: 'Special Attack IV', dir: 'desc', kind: 'number', extra: (r) => `SpA IV ${r.iv_special_attack}/31` },
  { key: 'ivspdef', label: 'Special Defense IV', dir: 'desc', kind: 'number', extra: (r) => `SpD IV ${r.iv_special_defense}/31` },
  { key: 'ivspeed', label: 'Speed IV', dir: 'desc', kind: 'number', extra: (r) => `Spe IV ${r.iv_speed}/31` },
  { key: 'friendship', label: 'Friendship', dir: 'desc', kind: 'number', extra: (r) => `❤️ ${r.happiness}` },
  { key: 'rarity', label: 'Rarity', dir: 'desc', kind: 'number', extra: (r) => (r.rarity !== 'normal' ? rarity.LABELS[r.rarity] : null) },
  { key: 'shiny', label: 'Shiny first', dir: 'desc', kind: 'number' },
  { key: 'gender', label: 'Gender', dir: 'asc', kind: 'text' },
  { key: 'nature', label: 'Nature', dir: 'asc', kind: 'text', extra: (r) => titleCase(r.nature) },
  { key: 'caught', label: 'Date received', dir: 'desc', kind: 'date', extra: (r) => (r.acquired_at ? DATE.format(new Date(r.acquired_at)) : null) },
  { key: 'id', label: 'Catch order (ID)', dir: 'asc', kind: 'number', extra: (r) => `ID ${r.id}` },
];

const SORT_BY_KEY = new Map(SORTS.map((sort) => [sort.key, sort]));

/** What each sort key is called when we echo it back. Also used by .order. */
const SORT_LABELS = Object.fromEntries(SORTS.map((sort) => [sort.key, sort.label]));
SORT_LABELS.custom = 'Slot';

/** Other spellings people type for a sort. */
const SORT_ALIASES = {
  slot: 'party',
  slots: 'party',
  number: 'party',
  custom: 'party',
  lvl: 'level',
  lv: 'level',
  ivs: 'iv',
  atk: 'attack',
  def: 'defense',
  spa: 'spatk',
  spattack: 'spatk',
  specialattack: 'spatk',
  spd: 'spdef',
  spdefense: 'spdef',
  specialdefense: 'spdef',
  spe: 'speed',
  happiness: 'friendship',
  friend: 'friendship',
  date: 'caught',
  recent: 'caught',
  catch: 'id',
};

/** Which sort a word means, or null. */
function parseSort(word) {
  const key = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
  if (SORT_BY_KEY.has(key)) return key;
  return SORT_ALIASES[key] || null;
}

/** How the direction button reads for a sort. */
function directionLabel(sort, direction) {
  const kind = (SORT_BY_KEY.get(sort) || {}).kind;
  if (kind === 'text') return direction === 'desc' ? '⬇️ Z to A' : '⬆️ A to Z';
  if (kind === 'date') return direction === 'desc' ? '⬇️ Newest first' : '⬆️ Oldest first';
  return direction === 'desc' ? '⬇️ Highest first' : '⬆️ Lowest first';
}

/** The Show dropdown. `filter` is what it adds to store.listParty's filter. */
const SHOWS = [
  { id: 'all', label: 'Everything', emoji: '📦', filter: {} },
  { id: 'shiny', label: 'Shinies', emoji: '✨', filter: { shiny: true }, color: 0xffd700 },
  { id: 'legendary', label: 'Legendaries', emoji: '🟢', filter: { rarity: 'legendary' }, color: rarity.COLORS.legendary },
  { id: 'mythical', label: 'Mythicals', emoji: '🩷', filter: { rarity: 'mythical' }, color: rarity.COLORS.mythical },
  { id: 'ultraBeast', label: 'Ultra Beasts', emoji: '🟣', filter: { rarity: 'ultraBeast' }, color: rarity.COLORS.ultraBeast },
  // Same green as the battle buttons.
  { id: 'battle', label: 'Battle-ready', emoji: '⚔️', filter: {}, color: 0x2ecc71 },
  { id: 'holding', label: 'Holding an item', emoji: '🎒', filter: { holding: true } },
];

const SHOW_BY_ID = new Map(SHOWS.map((show) => [show.id, show]));

const DEFAULT_COLOR = 0x4287f5;

const CUSTOM = {
  show: 'partyShow',
  sort: 'partySort',
  first: 'partyFirst',
  prev: 'partyPrev',
  next: 'partyNext',
  last: 'partyLast',
  dir: 'partyDir',
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

/** The words that ask for everything holding an item. */
const HOLDING_WORDS = new Set(['holding', 'held', 'item', 'items']);

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
function describeLevels({ min, max }) {
  if (min === max) return `level ${min}`;
  if (min <= 1) return `level ${max} and under`;
  if (max >= TOP_LEVEL) return `level ${min} and up`;
  return `level ${min}-${max}`;
}

/**
 * Read ".party iv desc 2" into a view state.
 *
 * Arguments can appear in any order and are all optional. `defaults` is the
 * player's saved .order preference; arguments override it for this view only.
 */
function parseArgs(args = [], defaults = {}) {
  const state = {
    sort: parseSort(defaults.sort) || 'party',
    direction: defaults.direction === 'desc' ? 'desc' : 'asc',
    page: 0,
    show: 'all',
    name: null,
    levels: null,
    swap: null,
  };

  let sortGiven = false;
  let directionGiven = false;

  const words = args.filter((value) => value !== null && value !== undefined).map(String);

  for (let i = 0; i < words.length; i += 1) {
    const arg = words[i].toLowerCase().replace(/^--/, '');

    // ".p swap 1 10": takes the next two numbers; sort arguments are ignored.
    if (arg === 'swap') {
      state.swap = [parseInt(words[i + 1], 10), parseInt(words[i + 2], 10)];
      i += 2;
      continue;
    }

    // ".p name: pikachu". Bare "name" with nothing after it is the sort key.
    if (NAME_PREFIXES.has(arg) && words[i + 1]) {
      const wanted = words.slice(i + 1).join(' ');
      state.name = { label: wanted, keys: names.resolveKeys(wanted) };
      break;
    }

    // ".p lvl 25-35". Without a level expression after it, "level" is the
    // sort key.
    if (LEVEL_PREFIXES.has(arg)) {
      const attached = arg.includes(':') ? arg.slice(arg.indexOf(':') + 1) : '';
      const bounds = parseLevelRange(attached || words[i + 1]);

      if (bounds) {
        state.levels = bounds;
        if (!attached) i += 1;
        continue;
      }
    }

    // ".p lvl30": no space.
    if (/^(lvl|lv|level)\d/.test(arg)) {
      const bounds = parseLevelRange(arg.replace(/^(lvl|lv|level)/, ''));
      if (bounds) {
        state.levels = bounds;
        continue;
      }
    }

    if (SUGGESTED_WORDS.has(arg)) {
      state.show = 'battle';
      continue;
    }

    if (HOLDING_WORDS.has(arg)) {
      state.show = 'holding';
      continue;
    }

    if (arg === 'shiny' || arg === 's') {
      state.show = 'shiny';
      continue;
    }

    const bucket = rarity.parse(arg);
    if (bucket && bucket !== 'normal') {
      state.show = bucket;
      continue;
    }

    const sort = parseSort(arg.startsWith('sort=') ? arg.slice(5) : arg);

    if (arg === 'desc' || arg === 'descending') {
      state.direction = 'desc';
      directionGiven = true;
    } else if (arg === 'asc' || arg === 'ascending') {
      state.direction = 'asc';
      directionGiven = true;
    } else if (/^\d+$/.test(arg)) {
      state.page = Math.max(1, parseInt(arg, 10)) - 1;
    } else if (sort) {
      state.sort = sort;
      sortGiven = true;
    }
  }

  // Battle-ready opens strongest first.
  if (state.show === 'battle' && !sortGiven) {
    state.sort = 'level';
    if (!directionGiven) state.direction = 'desc';
  }

  // A sort named without a direction opens the useful way round: ".p speed"
  // shows the fastest first.
  if (sortGiven && !directionGiven) state.direction = SORT_BY_KEY.get(state.sort).dir;

  return state;
}

/** The store filter for a state. `cap` is the obedience cap for Battle-ready. */
function filterFor(state, cap) {
  const filter = { ...(SHOW_BY_ID.get(state.show) || SHOWS[0]).filter };

  if (state.name) filter.speciesKeys = state.name.keys;

  if (state.levels) {
    filter.minLevel = state.levels.min;
    filter.maxLevel = state.levels.max;
  }

  if (state.show === 'battle') filter.obeysAtCap = cap;

  return filter;
}

/** The title for a state: "Dillon's shiny Pokemon at level 40 and up". */
function titleFor(username, state) {
  const what = {
    shiny: 'shiny Pokemon',
    legendary: 'Legendary Pokemon',
    mythical: 'Mythical Pokemon',
    ultraBeast: 'Ultra Beasts',
    battle: 'battle-ready Pokemon',
    holding: 'Pokemon holding items',
  }[state.show];

  let title = state.name
    ? `${username}'s ${state.name.label}`
    : what
      ? `${username}'s ${what}`
      : `${username}'s party`;

  if (state.name && what) title += ` (${(SHOW_BY_ID.get(state.show) || {}).label})`;
  if (state.levels) title += ` at ${describeLevels(state.levels)}`;

  return title;
}

/** Why a view is empty. */
function emptyReason(state) {
  if (state.show === 'battle') {
    return (
      'Nothing here will obey you at your trainer level.\n' +
      'Catch something at or below your cap - `.d` - and it will listen from the start.'
    );
  }

  if (state.name || state.levels || state.show !== 'all') return 'Nothing matches. Pick something else above.';
  return 'Nothing caught yet. Type `.d` to drop one.';
}

/** One line per Pokemon, plus the sorted value when the line doesn't show it. */
function lineFor(row, sort) {
  const extra = (SORT_BY_KEY.get(sort) || {}).extra;
  const value = extra ? extra(row) : null;
  return value ? `${summaryLine(row)} · ${value}` : summaryLine(row);
}

/** The dropdowns and buttons for a state. */
function buildComponents(state, pages, disabled = false) {
  const narrowed = Boolean(state.name || state.levels);

  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(CUSTOM.show)
        .setPlaceholder('Show')
        .setDisabled(disabled)
        .addOptions(
          SHOWS.map((show) => ({
            label: show.label,
            value: show.id,
            emoji: show.emoji,
            description: show.id === 'all' && narrowed ? 'Also clears the name and level filter' : undefined,
            default: show.id === state.show,
          }))
        )
    ),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(CUSTOM.sort)
        .setPlaceholder('Sort by')
        .setDisabled(disabled)
        .addOptions(
          SORTS.map((sort) => ({ label: `Sort: ${sort.label}`, value: sort.key, default: sort.key === state.sort }))
        )
    ),
    new ActionRowBuilder().addComponents(
      ...[
        [CUSTOM.first, '⏪'],
        [CUSTOM.prev, '◀'],
        [CUSTOM.next, '▶'],
        [CUSTOM.last, '⏩'],
      ].map(([id, label]) =>
        new ButtonBuilder()
          .setCustomId(id)
          .setLabel(label)
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(disabled || pages < 2)
      ),
      new ButtonBuilder()
        .setCustomId(CUSTOM.dir)
        .setLabel(directionLabel(state.sort, state.direction))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled)
    ),
  ];
}

/**
 * One page of a state, with its controls. The page is clamped here, so the
 * returned state is the one shown.
 */
function render(user, state, disabled = false) {
  // Battle-ready filters by the trainer's obedience cap.
  const standing = state.show === 'battle' ? store.trainerProgress(user.id) : null;
  const filter = filterFor(state, standing ? standing.cap : null);

  const total = store.countParty(user.id, filter);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // A typed page past the end shows the last one; the buttons wrap around.
  const page = state.typedPage ? Math.min(state.page, pages - 1) : ((state.page % pages) + pages) % pages;
  const show = SHOW_BY_ID.get(state.show) || SHOWS[0];

  const embed = new EmbedBuilder()
    .setTitle(titleFor(user.username, state))
    .setColor(total ? show.color || DEFAULT_COLOR : 0x888888);

  if (!total) {
    embed.setDescription(emptyReason(state));
  } else {
    const rows = store.listParty(user.id, {
      sort: state.sort,
      direction: state.direction,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      filter,
    });

    const body = rows.map((row) => lineFor(row, state.sort)).join('\n');

    // Battle-ready also explains the cap and how the team is picked.
    const heading = standing
      ? `Obeys at trainer level **${standing.level}** - Pokemon cap is **${standing.cap}**, ` +
        `nothing over **${standing.cap + obedience.MAX_OVER_CAP}**.\n` +
        'The **first six slots** are the team. `.swap <a> <b>` to move one up.\n\n'
      : '';

    embed.setDescription(heading + body);
  }

  embed.setFooter({
    text:
      `${total.toLocaleString('en-US')} shown · ${SORT_LABELS[state.sort]}, ` +
      `${directionLabel(state.sort, state.direction).slice(3).replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase())} · Page ${page + 1}/${pages}`,
  });

  return { state: { ...state, page, typedPage: false }, payload: { embeds: [embed], components: buildComponents(state, pages, disabled) } };
}

/** What a press or a pick does to the state. Returns a new one. */
function applyPress(state, customId, values = []) {
  switch (customId) {
    case CUSTOM.show: {
      const show = SHOW_BY_ID.get(values[0]);
      if (!show) return state;

      // "Everything" means everything, so it drops the typed filters too.
      const cleared = show.id === 'all' ? { name: null, levels: null } : {};
      return { ...state, ...cleared, show: show.id, page: 0 };
    }
    case CUSTOM.sort: {
      const sort = SORT_BY_KEY.get(values[0]);
      return sort ? { ...state, sort: sort.key, direction: sort.dir, page: 0 } : state;
    }
    case CUSTOM.first:
      return { ...state, page: 0 };
    case CUSTOM.prev:
      return { ...state, page: state.page - 1 };
    case CUSTOM.next:
      return { ...state, page: state.page + 1 };
    case CUSTOM.last:
      // render() wraps -1 round to the last page.
      return { ...state, page: -1 };
    case CUSTOM.dir:
      return { ...state, direction: state.direction === 'desc' ? 'asc' : 'desc', page: 0 };
    default:
      return state;
  }
}

/** The opening state for a user and their arguments. */
function initialState(userId, args) {
  const account = store.ensureUser(userId);
  return { ...parseArgs(args, { sort: account.party_sort, direction: account.party_direction }), typedPage: true };
}

/**
 * Post the party and keep its controls live for its owner.
 *
 * @param {function} send  posts a payload, returns the Message
 */
async function show({ send, user, args }) {
  let { state, payload } = render(user, initialState(user.id, args));

  const message = await send(payload);
  if (!message || typeof message.createMessageComponentCollector !== 'function') return;

  livebuttons.track(message, user.id);

  const collector = message.createMessageComponentCollector({
    filter: (i) => i.user.id === user.id,
    idle: pager.IDLE_MS,
    time: pager.MAX_MS,
  });

  collector.on('collect', async (press) => {
    // Answered first, so Discord never gives up on it (Utils/livebuttons.js).
    const interaction = await livebuttons.answered(press);
    ({ state, payload } = render(user, applyPress(state, interaction.customId, interaction.values || [])));
    try {
      await interaction.update(payload);
    } catch (err) {
      if (err.code !== 10008) console.error('Party update failed:', err);
    }
  });

  collector.on('end', async () => {
    livebuttons.release(message);
    try {
      await message.edit(render(user, state, true).payload);
    } catch (err) {
      if (err.code !== 10008) console.error('Party cleanup failed:', err);
    }
  });
}

/**
 * ".p swap 1 10" (and ".swap 1 10") - swap two slots, then say what moved.
 *
 * Also switches the saved sort back to slot order, otherwise the swap would
 * be hidden by the next sort (and the battle team, the first six, follows the
 * saved sort).
 */
function runSwap(userId, [a, b]) {
  // Not allowed during a battle or trade (see Utils/partylock.js).
  const busy = partylock.refusalFor(userId, 'reorder your party');
  if (busy) return busy;

  if (!Number.isInteger(a) || !Number.isInteger(b)) {
    return 'Which two? Try `.swap 1 10`, using the numbers from `.party`.';
  }

  const result = store.swapPartyNumbers(userId, a, b);
  if (!result.ok) return result.message;

  store.setPartyOrder(userId, 'party', 'asc');

  const [first, second] = result.moved;
  return (
    `Moved **${first.nickname || first.display_name}** to slot ${b} and ` +
    `**${second.nickname || second.display_name}** to slot ${a}.`
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
        .addChoices(...SHOWS.map((s) => ({ name: s.label, value: s.id === 'battle' ? 'suggested' : s.id })))
    )
    .addStringOption((option) => option.setName('name').setDescription('Only this species.'))
    .addStringOption((option) =>
      option
        .setName('sort')
        .setDescription('What to order by.')
        .addChoices(...SORTS.map((sort) => ({ name: sort.label, value: sort.key })))
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

    const showChoice = interaction.options.getString('show');
    const name = interaction.options.getString('name');

    const args = [
      showChoice && showChoice !== 'all' ? showChoice : null,
      interaction.options.getString('sort'),
      interaction.options.getString('direction'),
      interaction.options.getInteger('page'),
    ].filter((value) => value !== null && value !== undefined);

    // A name filter consumes everything after it, so it has to go last.
    if (name) args.push('name:', name);

    await show({ send: pager.interactionSender(interaction), user: interaction.user, args: args.map(String) });
  },

  async run(message, args) {
    store.ensureUser(message.author.id);

    const state = parseArgs(args, {});
    if (state.swap) {
      await message.channel.send(runSwap(message.author.id, state.swap));
      return;
    }

    await show({ send: (payload) => message.channel.send(payload), user: message.author, args });
  },

  parseArgs,
  parseSort,
  render,
  applyPress,
  initialState,
  runSwap,
  SORTS,
  SORT_LABELS,
  SHOWS,
  PAGE_SIZE,
};
