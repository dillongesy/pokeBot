'use strict';

/**
 * .team @user - someone else's first six.
 *
 *   .team @someone          their first six
 *   .team @someone v 3      their third, in full
 *   .team                   your own, same view
 *
 * "First six" follows the owner's .order, and is exactly the team that
 * store.battleTeam sends into battle.
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const store = require('../Utils/store');
const view = require('./view');
const obedience = require('../Utils/obedience');
const { displayName, ivPercent, colorFor, typeList, capitalize, GENDER_SYMBOLS } = require('../Utils/display');

const TEAM_SIZE = 6;

/** The words that introduce a slot. */
const VIEW_WORDS = new Set(['v', 'view', 'show', 'slot']);

/** Their first six, in their own order. */
function teamOf(userId) {
  const account = store.getUser(userId);

  return store.listParty(userId, {
    sort: account ? account.party_sort : 'id',
    direction: account ? account.party_direction : 'asc',
    limit: TEAM_SIZE,
    offset: 0,
  });
}

/** ".team @user v 3" - pull the slot number out, if there is one. */
function parseArgs(args = []) {
  const words = args
    .filter((w) => w !== null && w !== undefined)
    .map(String)
    .filter((w) => !/^<@!?\d+>$/.test(w)); // the mention itself is not an argument

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i].toLowerCase();

    if (VIEW_WORDS.has(word) && words[i + 1]) return { slot: parseInt(words[i + 1], 10) };

    // ".team @user 3" - a bare number means the same thing.
    if (/^\d+$/.test(word)) return { slot: parseInt(word, 10) };
  }

  return { slot: null };
}

function buildTeam(owner, mine) {
  const rows = teamOf(owner.id);
  const total = store.countParty(owner.id);

  const embed = new EmbedBuilder()
    .setTitle(`${owner.username}'s team`)
    .setColor(rows.length ? colorFor(rows[0]) : 0x888888);

  if (owner.displayAvatarURL) embed.setThumbnail(owner.displayAvatarURL());

  if (!rows.length) {
    embed.setDescription(
      mine ? 'You have not caught anything yet. Type `.d` to drop one.' : `${owner.username} has not caught anything yet.`
    );
    return { embeds: [embed] };
  }

  // These six are the battle team (store.battleTeam reads the same list), so
  // mark any that will disobey.
  const cap = store.trainerCap(owner.id);
  const refusing = rows.filter((row) => !obedience.obeys(row, cap));

  embed.setDescription(
    rows
      .map((row, i) => {
        const gender = GENDER_SYMBOLS[row.gender] || '';
        const types = typeList(row).map(capitalize).join(' / ') || 'Unknown';
        const obeys = obedience.obeys(row, cap);

        return (
          `\`${i + 1}\` ${obeys ? '' : '⚠️ '}**${displayName(row)}**${gender ? ' ' + gender : ''}` +
          ` · Lv.${row.level} · IV ${ivPercent(row)}% · ${types}` +
          (obeys ? '' : ' · **will not obey**')
        );
      })
      .join('\n')
  );

  if (refusing.length) {
    embed.addFields({
      name: `${refusing.length} of these will stay behind`,
      value:
        `Trainer level commands up to **level ${cap}**.\n` +
        (mine
          ? '`.party suggested` shows who will fight; `.p swap <a> <b>` moves them up here.'
          : 'They would go into a battle short-handed.'),
    });
  }

  embed.setFooter({
    text:
      `${Math.min(TEAM_SIZE, total)} of ${total.toLocaleString('en-US')}` +
      ` · this is the battle team` +
      ` · .team ${mine ? '' : '@' + owner.username + ' '}v <1-${rows.length}> for one in full`,
  });

  return { embeds: [embed] };
}

/**
 * The whole command, given an already-resolved owner.
 *
 * Shared by both entry points.
 */
function team(owner, viewer, args = []) {
  store.ensureUser(owner.id);

  const { slot } = parseArgs(args);
  const mine = owner.id === viewer.id;

  if (slot === null) return buildTeam(owner, mine);

  const rows = teamOf(owner.id);

  if (!rows.length) {
    return {
      content: mine
        ? 'You have not caught anything yet.'
        : `${owner.username} has not caught anything yet.`,
    };
  }

  if (!Number.isInteger(slot) || slot < 1 || slot > rows.length) {
    return {
      content: `Pick a slot between 1 and ${rows.length}. \`.team ${mine ? '' : '@' + owner.username + ' '}v 1\`.`,
    };
  }

  // Reuse the .view card, which works for any owner.
  return view.buildView(rows[slot - 1]);
}

module.exports = {
  aliases: ['team'],

  data: new SlashCommandBuilder()
    .setName('team')
    .setDescription("Shows someone's first six Pokemon.")
    .addUserOption((option) =>
      option.setName('user').setDescription('Whose team. Defaults to yours.')
    )
    .addIntegerOption((option) =>
      option
        .setName('slot')
        .setDescription('Show one of the six in full.')
        .setMinValue(1)
        .setMaxValue(TEAM_SIZE)
    ),

  async execute(interaction) {
    store.ensureUser(interaction.user.id);

    const owner = interaction.options.getUser('user') || interaction.user;
    const slot = interaction.options.getInteger('slot');

    await interaction.reply(team(owner, interaction.user, slot ? [String(slot)] : []));
  },

  async run(message, args) {
    store.ensureUser(message.author.id);

    const owner = message.mentions.users.first() || message.author;
    await message.channel.send(team(owner, message.author, args));
  },

  team,
  buildTeam,
  teamOf,
  parseArgs,
  TEAM_SIZE,
};
