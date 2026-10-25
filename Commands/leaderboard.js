'use strict';

/**
 * .leaderboard [board] - who is winning.
 *
 *   .lb                     Pokemon caught
 *   .lb currency | c        coins        .lb gold
 *   .lb shiny | s           shinies
 *   .lb legendary | l       .lb mythical | m      .lb ultrabeast | ub
 *   .lb pokedex | dex       distinct species owned
 *   .lb server              which server has caught the most
 *   .lb <pokemonName>       who owns the most of one species
 *   .lb party | level | iv
 *
 * Ranks are computed in SQL. Board names map to fixed queries and species keys
 * are bound as parameters, so user input never reaches the SQL text.
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const store = require('../Utils/store');
const names = require('../Utils/names');
const rarity = require('../Utils/rarity');

const TOP = 10;

const MEDALS = ['🥇', '🥈', '🥉'];

/**
 * Accepted spellings for each board. Anything else is tried as a Pokemon name.
 */
const ALIASES = {
  caught: ['caught', 'catches', 'total'],
  coins: ['coins', 'currency', 'c', 'money', 'bal'],
  gold: ['gold', 'g'],
  shinies: ['shinies', 'shiny', 's'],
  legendary: ['legendary', 'legendaries', 'l', 'legend'],
  mythical: ['mythical', 'mythicals', 'm', 'mythic'],
  ultrabeast: ['ultrabeast', 'ultrabeasts', 'ultra', 'ub'],
  pokedex: ['pokedex', 'dex', 'species', 'completion'],
  server: ['server', 'servers', 'guild', 'guilds'],
  party: ['party', 'owned', 'size'],
  level: ['level', 'lv', 'highest'],
  iv: ['iv', 'ivs', 'best'],
};

/** How each board's score should read. */
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
};

/** The colour each board takes, so a rarity board looks like its rarity. */
const COLORS = {
  shinies: 0xffd700,
  legendary: rarity.COLORS.legendary,
  mythical: rarity.COLORS.mythical,
  ultrabeast: rarity.COLORS.ultraBeast,
};

const DEFAULT_COLOR = 0xffd700;

/** Which board a word means, or null if it is not a board at all. */
function parseBoard(word) {
  const wanted = String(word || '').toLowerCase();
  if (!wanted) return 'caught';

  for (const [board, spellings] of Object.entries(ALIASES)) {
    if (spellings.includes(wanted)) return board;
  }

  return null;
}

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

/** The medal or the padded number, and a marker if it is the viewer. */
function placeLine(row, index, label, mine) {
  const place = MEDALS[index] || `\`${String(index + 1).padStart(2, ' ')}\``;
  return `${place} **${label}** - ${row.line}${mine ? ' ←' : ''}`;
}

/**
 * Everything a board needs, computed before any Discord call so it can be
 * tested without a client.
 */
function resolveBoard(query) {
  const text = String(query || '').trim();
  const board = parseBoard(text);

  if (board) {
    return {
      kind: board === 'server' ? 'guilds' : 'users',
      board,
      title: store.LEADERBOARDS[board].label,
      rows: store.leaderboard(board, TOP),
      format: FORMATTERS[board] || ((n) => String(n)),
      color: COLORS[board] || DEFAULT_COLOR,
    };
  }

  // Not a board name, so try it as a species (".lb pikachu").
  const species = names.resolveOne(text);
  if (!species) return null;

  const keys = names.resolveKeys(text);

  return {
    kind: 'users',
    board: 'species',
    species,
    title: `Most ${species.displayName}`,
    rows: store.speciesLeaderboard(keys, TOP),
    format: (n) => `${n.toLocaleString('en-US')}`,
    color: DEFAULT_COLOR,
  };
}

async function buildLeaderboard(client, viewerId, rawBoard) {
  const resolved = resolveBoard(rawBoard);

  if (!resolved) {
    const boards = Object.keys(ALIASES).join(', ');
    return {
      content:
        `"${rawBoard}" is not a board or a Pokemon. There is: ${boards}. ` +
        'Or name any Pokemon to see who owns the most.',
    };
  }

  const { rows, format, title, color, kind } = resolved;

  const embed = new EmbedBuilder().setTitle(`Leaderboard - ${title}`).setColor(color);

  if (!rows.length) {
    embed.setDescription('Nobody is on this board yet.');
  } else {
    const labels =
      kind === 'guilds'
        ? await resolveGuilds(client, rows.map((r) => r.id))
        : await resolveNames(client, rows.map((r) => r.id));

    embed.setDescription(
      rows
        .map((row, i) =>
          placeLine(
            { line: format(row.score) },
            i,
            labels.get(row.id),
            kind === 'users' && row.id === viewerId
          )
        )
        .join('\n')
    );
  }

  // The viewer's own rank if they are off the visible page (not for the
  // server board).
  if (kind === 'users' && resolved.board !== 'species') {
    const mine = store.leaderboardRank(resolved.board, viewerId);
    if (mine && mine.rank > TOP) {
      embed.addFields({ name: 'You', value: `#${mine.rank} of ${mine.of} - ${format(mine.score)}` });
    }
  }

  if (resolved.board === 'species' || resolved.board === 'server') {
    embed.setFooter({ text: 'Any Pokemon name works. Use .lb dex for overall completion.' });
  } else {
    const others = Object.keys(ALIASES)
      .filter((b) => b !== resolved.board)
      .join(', ');
    embed.setFooter({ text: `Other boards: ${others}` });
  }

  return { embeds: [embed] };
}

module.exports = {
  aliases: ['leaderboard', 'lb', 'top'],

  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Shows who is winning.')
    .addStringOption((option) =>
      option
        .setName('board')
        .setDescription('Which ranking, or a Pokemon name.')
        .setAutocomplete(false)
    ),

  async execute(interaction) {
    store.ensureUser(interaction.user.id);
    await interaction.reply(
      await buildLeaderboard(
        interaction.client,
        interaction.user.id,
        interaction.options.getString('board')
      )
    );
  },

  async run(message, args) {
    store.ensureUser(message.author.id);
    await message.channel.send(await buildLeaderboard(message.client, message.author.id, args.join(' ')));
  },

  buildLeaderboard,
  resolveBoard,
  parseBoard,
  FORMATTERS,
  ALIASES,
};
