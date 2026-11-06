'use strict';

/**
 * .leaderboard [board] - who is winning.
 *
 * Opens on a board and lets the viewer move around with:
 *
 *   Category dropdown   Catches, Battles, Rarities, Best Pokemon, Servers,
 *                       Wealth
 *   Sort dropdown       the boards in that category (Wins, Win rate,
 *                       Trainer levels...)
 *   Buttons             page back and forward, highest or lowest first, and
 *                       everyone or just this server's players
 *
 * A board name or a Pokemon name still opens straight onto it:
 *
 *   .lb                     Pokemon caught
 *   .lb shiny | wins | winrate | trainer | coins | dex ...
 *   .lb <pokemonName>       who owns the most of one species
 *
 * Ranks are computed in SQL. Board names map to fixed queries and species keys
 * are bound as parameters, so user input never reaches the SQL text.
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
const names = require('../Utils/names');
const rarity = require('../Utils/rarity');
const pager = require('../Utils/pager');
const livebuttons = require('../Utils/livebuttons');

/** Rows per page. */
const TOP = 10;

/** The most rows a board loads, for paging and the viewer's own rank. */
const MAX_ROWS = 1000;

const MEDALS = ['🥇', '🥈', '🥉'];

/**
 * Accepted spellings for each board. Anything else is tried as a Pokemon name.
 */
const ALIASES = {
  caught: ['caught', 'catches', 'total'],
  coins: ['coins', 'currency', 'c', 'money', 'bal'],
  shinies: ['shinies', 'shiny', 's'],
  legendary: ['legendary', 'legendaries', 'l', 'legend'],
  mythical: ['mythical', 'mythicals', 'm', 'mythic'],
  ultrabeast: ['ultrabeast', 'ultrabeasts', 'ultra', 'ub'],
  pokedex: ['pokedex', 'dex', 'species', 'completion'],
  server: ['server', 'servers', 'guild', 'guilds'],
  iv: ['iv', 'ivs', 'best'],
  wins: ['wins', 'win', 'victories', 'battles', 'battle', 'b'],
  winRate: ['winrate', 'wr', 'win%', 'ratio'],
  trainerLevels: ['trainer', 'trainerlevel', 'trainerlevels', 'tl', 'levels', 'prestige', 'prestiges', 'p'],
};

/** The category dropdown, and the boards each one sorts between. */
const CATEGORIES = [
  { id: 'catches', label: 'Catches', emoji: '📦', boards: ['caught', 'pokedex'] },
  // Trainer levels counts prestiges too, and each row shows the split.
  { id: 'battles', label: 'Battles', emoji: '⚔️', boards: ['wins', 'winRate', 'trainerLevels'] },
  { id: 'rarities', label: 'Rarities', emoji: '✨', boards: ['shinies', 'legendary', 'mythical', 'ultrabeast'] },
  { id: 'pokemon', label: 'Best Pokemon', emoji: '⭐', boards: ['iv'] },
  { id: 'servers', label: 'Servers', emoji: '🌐', boards: ['server'] },
  { id: 'wealth', label: 'Wealth', emoji: '💰', boards: ['coins'] },
];

const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

/** A won-lost record: "125W - 75L". */
const record = (row) => `${(row.won || 0).toLocaleString('en-US')}W - ${(row.lost || 0).toLocaleString('en-US')}L`;

/** How each board's score reads, given its row. */
const FORMATTERS = {
  caught: (n) => `${n.toLocaleString('en-US')} caught`,
  party: (n) => `${n.toLocaleString('en-US')} owned`,
  shinies: (n) => `${n.toLocaleString('en-US')} shiny`,
  coins: (n) => `${n.toLocaleString('en-US')} coins`,
  gold: (n) => `${n.toLocaleString('en-US')} gold`,
  level: (n) => `Lv.${n}`,
  iv: (n) => `${Math.round((n / 186) * 1000) / 10}%`,
  legendary: (n) => `${n.toLocaleString('en-US')} legendary`,
  mythical: (n) => `${n.toLocaleString('en-US')} mythical`,
  ultrabeast: (n) => `${n.toLocaleString('en-US')} ultra beast`,
  pokedex: (n) => `${n.toLocaleString('en-US')} species`,
  server: (n) => `${n.toLocaleString('en-US')} caught here`,
  prestige: (n, row) => `${plural(n, 'prestige')}, now Lv.${row.trainer_level}`,
  trainerLevels: (n, row) =>
    `${plural(n, 'level')}` + (row.prestige ? ` (${plural(row.prestige, 'prestige')} + Lv.${row.trainer_level})` : ''),
};

for (const board of Object.keys(store.LEADERBOARDS)) {
  if (board.startsWith('winRate')) FORMATTERS[board] = (n, row) => `${n}% (${record(row)})`;
  else if (board.startsWith('wins')) FORMATTERS[board] = (n, row) => `${plural(n, 'win')} (${record(row)})`;
}

/** The colour each board takes, so a rarity board looks like its rarity. */
const COLORS = {
  shinies: 0xffd700,
  legendary: rarity.COLORS.legendary,
  mythical: rarity.COLORS.mythical,
  ultrabeast: rarity.COLORS.ultraBeast,
};

const DEFAULT_COLOR = 0xffd700;

const CUSTOM = {
  category: 'lbCategory',
  sort: 'lbSort',
  prev: 'lbPrev',
  next: 'lbNext',
  dir: 'lbDir',
  scope: 'lbScope',
};

/** Which board a word means, or null if it is not a board at all. */
function parseBoard(word) {
  const wanted = String(word || '').toLowerCase();
  if (!wanted) return 'caught';

  for (const [board, spellings] of Object.entries(ALIASES)) {
    if (spellings.includes(wanted)) return board;
  }

  return null;
}

const categoryOf = (board) => CATEGORIES.find((c) => c.boards.includes(board)) || null;

/**
 * Turn user ids into names.
 *
 * Members who have left, or who the bot has never seen, fall back to their id
 * rather than disappearing from the board.
 */
async function resolveNames(client, ids) {
  const resolved = new Map();

  for (const id of ids) {
    let name = null;
    try {
      const user = client && (client.users.cache.get(id) || (await client.users.fetch(id)));
      if (user) name = user.username;
    } catch {
      name = null;
    }
    resolved.set(id, name || `Trainer ${String(id).slice(-4)}`);
  }

  return resolved;
}

/** The same, for the one board whose rows are servers. */
async function resolveGuilds(client, ids) {
  const resolved = new Map();

  for (const id of ids) {
    let name = null;
    try {
      const guild = client && (client.guilds.cache.get(id) || (await client.guilds.fetch(id)));
      if (guild) name = guild.name;
    } catch {
      name = null;
    }
    resolved.set(id, name || `Server ${String(id).slice(-4)}`);
  }

  return resolved;
}

/**
 * The medal or the padded number, and a marker if it is the viewer. Medals
 * only go to the top, not to the bottom when sorted lowest first.
 */
function placeLine(line, index, label, mine, medals = true) {
  const place = (medals && MEDALS[index]) || `\`${String(index + 1).padStart(2, ' ')}\``;
  return `${place} **${label}** - ${line}${mine ? ' ←' : ''}`;
}

/**
 * Where to start: a board name, a Pokemon name, or nothing (Pokemon caught).
 *
 * @returns {object|null} the opening state, or null if the text is neither
 */
function initialState(query, guildId) {
  const text = String(query || '').trim();
  const base = { dir: 'desc', scope: 'everyone', page: 0, guildId: guildId || null };

  const board = parseBoard(text);
  if (board) return { ...base, board };

  // Not a board name, so try it as a species (".lb pikachu").
  const species = names.resolveOne(text);
  if (!species) return null;

  return { ...base, board: 'species', species: { name: species.displayName, keys: names.resolveKeys(text) } };
}

/** Everything a board shows, before any Discord call, so it can be tested. */
function resolveBoard(state) {
  const options = {
    limit: MAX_ROWS,
    dir: state.dir,
    guildId: state.scope === 'server' ? state.guildId : null,
  };

  if (state.board === 'species') {
    return {
      kind: 'users',
      title: `Most ${state.species.name}`,
      rows: store.speciesLeaderboard(state.species.keys, options),
      format: (n) => n.toLocaleString('en-US'),
      color: DEFAULT_COLOR,
      rank: null,
    };
  }

  const entry = store.LEADERBOARDS[state.board];
  return {
    kind: entry.guilds ? 'guilds' : 'users',
    title: entry.label,
    minBattles: entry.minBattles || 0,
    rows: store.leaderboard(state.board, options),
    format: FORMATTERS[state.board] || ((n) => String(n)),
    color: COLORS[state.board] || DEFAULT_COLOR,
  };
}

/** The dropdowns and buttons for a state. */
function buildComponents(state, resolved, pages, disabled = false) {
  const category = state.board === 'species' ? null : categoryOf(state.board);

  const rows = [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(CUSTOM.category)
        .setPlaceholder(state.board === 'species' ? `Most ${state.species.name} - pick a board` : 'Category')
        .setDisabled(disabled)
        .addOptions(
          CATEGORIES.map((c) => ({
            label: c.label,
            value: c.id,
            emoji: c.emoji,
            default: Boolean(category && c.id === category.id),
          }))
        )
    ),
  ];

  if (category && category.boards.length > 1) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(CUSTOM.sort)
          .setPlaceholder('Sort by')
          .setDisabled(disabled)
          .addOptions(
            category.boards.map((board) => ({
              label: store.LEADERBOARDS[board].label,
              value: board,
              default: board === state.board,
            }))
          )
      )
    );
  }

  const guildsOnly = resolved.kind === 'guilds';

  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(CUSTOM.prev)
        .setLabel('◀')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || pages < 2),
      new ButtonBuilder()
        .setCustomId(CUSTOM.next)
        .setLabel('▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || pages < 2),
      new ButtonBuilder()
        .setCustomId(CUSTOM.dir)
        .setLabel(state.dir === 'desc' ? '⬇️ Highest first' : '⬆️ Lowest first')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(CUSTOM.scope)
        .setLabel(state.scope === 'server' ? '🏠 This server' : '🌐 Everyone')
        .setStyle(state.scope === 'server' ? ButtonStyle.Primary : ButtonStyle.Secondary)
        // Servers are ranked against each other, and a DM has no server.
        .setDisabled(disabled || guildsOnly || !state.guildId)
    )
  );

  return rows;
}

/** One page of a board, with its controls. */
async function render(client, viewerId, state, disabled = false) {
  const resolved = resolveBoard(state);
  const { rows, format, title, color, kind } = resolved;

  const pages = Math.max(1, Math.ceil(rows.length / TOP));
  const page = Math.min(Math.max(0, state.page), pages - 1);
  const shown = rows.slice(page * TOP, page * TOP + TOP);

  const embed = new EmbedBuilder().setTitle(`Leaderboard - ${title}`).setColor(color);

  if (!shown.length) {
    embed.setDescription(
      resolved.minBattles
        ? `Nobody here has fought ${resolved.minBattles} battles of this kind yet.`
        : 'Nobody is on this board yet.'
    );
  } else {
    const labels = kind === 'guilds'
      ? await resolveGuilds(client, shown.map((r) => r.id))
      : await resolveNames(client, shown.map((r) => r.id));

    embed.setDescription(
      shown
        .map((row, i) =>
          placeLine(
            format(row.score, row),
            page * TOP + i,
            labels.get(row.id),
            kind === 'users' && row.id === viewerId,
            state.dir === 'desc'
          )
        )
        .join('\n')
    );
  }

  // The viewer's own rank when they are not on this page.
  if (kind === 'users') {
    const at = rows.findIndex((row) => row.id === viewerId);
    const onPage = at >= page * TOP && at < page * TOP + TOP;
    if (at >= 0 && !onPage) {
      embed.addFields({ name: 'You', value: `#${at + 1} of ${rows.length} - ${format(rows[at].score, rows[at])}` });
    }
  }

  const footer = [`Page ${page + 1} of ${pages}`];
  if (resolved.minBattles) footer.push(`${resolved.minBattles} battles minimum`);
  embed.setFooter({ text: footer.join(' - ') });

  return { embeds: [embed], components: buildComponents({ ...state, page }, resolved, pages, disabled) };
}

/** What a press or a pick does to the state. Returns a new one. */
function applyPress(state, customId, values = []) {
  switch (customId) {
    case CUSTOM.category: {
      const category = CATEGORIES.find((c) => c.id === values[0]);
      return category ? { ...state, board: category.boards[0], species: null, page: 0 } : state;
    }
    case CUSTOM.sort:
      return store.LEADERBOARDS[values[0]] ? { ...state, board: values[0], page: 0 } : state;
    case CUSTOM.prev:
      return { ...state, page: state.page - 1 };
    case CUSTOM.next:
      return { ...state, page: state.page + 1 };
    case CUSTOM.dir:
      return { ...state, dir: state.dir === 'desc' ? 'asc' : 'desc', page: 0 };
    case CUSTOM.scope:
      return { ...state, scope: state.scope === 'server' ? 'everyone' : 'server', page: 0 };
    default:
      return state;
  }
}

/** Wrap a page number around both ends, once the page count is known. */
function wrapPage(state) {
  const rows = resolveBoard(state).rows.length;
  const pages = Math.max(1, Math.ceil(rows / TOP));
  return { ...state, page: ((state.page % pages) + pages) % pages };
}

/**
 * Post the leaderboard and keep its controls live for the viewer.
 *
 * @param {function} send  posts a payload, returns the Message
 */
async function show({ send, client, viewerId, guildId, query }) {
  let state = initialState(query, guildId);

  if (!state) {
    const boards = Object.keys(ALIASES).join(', ');
    await send({
      content:
        `"${query}" is not a board or a Pokemon. There is: ${boards}. ` +
        'Or name any Pokemon to see who owns the most.',
    });
    return;
  }

  const message = await send(await render(client, viewerId, state));
  if (!message || typeof message.createMessageComponentCollector !== 'function') return;

  livebuttons.track(message, viewerId);

  const collector = message.createMessageComponentCollector({
    filter: (i) => i.user.id === viewerId,
    idle: pager.IDLE_MS,
    time: pager.MAX_MS,
  });

  collector.on('collect', async (interaction) => {
    state = wrapPage(applyPress(state, interaction.customId, interaction.values || []));
    try {
      await interaction.update(await render(client, viewerId, state));
    } catch (err) {
      if (err.code !== 10008) console.error('Leaderboard update failed:', err);
    }
  });

  collector.on('end', async () => {
    livebuttons.release(message);
    try {
      await message.edit(await render(client, viewerId, state, true));
    } catch (err) {
      if (err.code !== 10008) console.error('Leaderboard cleanup failed:', err);
    }
  });
}

module.exports = {
  aliases: ['leaderboard', 'lb', 'top'],

  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Shows who is winning.')
    .addStringOption((option) =>
      option
        .setName('board')
        .setDescription('Which ranking to open on, or a Pokemon name.')
        .setAutocomplete(false)
    ),

  async execute(interaction) {
    store.ensureUser(interaction.user.id);
    await show({
      send: pager.interactionSender(interaction),
      client: interaction.client,
      viewerId: interaction.user.id,
      guildId: interaction.guildId,
      query: interaction.options.getString('board'),
    });
  },

  async run(message, args) {
    store.ensureUser(message.author.id);
    await show({
      send: (payload) => message.channel.send(payload),
      client: message.client,
      viewerId: message.author.id,
      guildId: message.guildId,
      query: args.join(' '),
    });
  },

  render,
  resolveBoard,
  initialState,
  applyPress,
  parseBoard,
  FORMATTERS,
  ALIASES,
  CATEGORIES,
};
