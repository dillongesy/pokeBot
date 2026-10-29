'use strict';

/**
 * .moves <pokemon> - the four moves one of your Pokemon knows, and what it can
 * learn right now.
 *
 * Also handles `.moves <id> learn` for level-up moves; TMs are in `.tm`.
 *
 * Each Pokemon starts with the last four level-up moves it would know at its
 * level, using the newest game its form appears in (see Utils/learnset.js).
 * The card names that game.
 *
 * Every move is shown with its type, category, power, accuracy, PP and effect
 * (Utils/moveinfo.js), and learnable moves with the level they come at. Long
 * lists are paged.
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const store = require('../Utils/store');
const learnset = require('../Utils/learnset');
const versiongroups = require('../Utils/versiongroups');
const moveinfo = require('../Utils/moveinfo');
const pokemon = require('../Utils/pokemon');
const moveprompt = require('../Utils/moveprompt');
const pager = require('../Utils/pager');
const { displayName, colorFor, titleCase, clip, LIMITS } = require('../Utils/display');

/** Learnable moves per page after the first. Each is a three-line field. */
const PER_PAGE = 6;

/**
 * One known move as an embed field. Hidden Power shows the type this
 * Pokemon's IVs give it.
 */
function knownField(entry, row = null) {
  const hidden = entry.move === 'hidden-power' && entry.data ? pokemon.hiddenPowerType(row) : null;
  const data = hidden ? { ...entry.data, type: hidden } : entry.data;
  return {
    name: `${entry.slot}. ${data ? data.displayName : titleCase(entry.move)}`,
    value: clip(moveinfo.details(data, entry.ppUp), LIMITS.fieldValue),
  };
}

/** One learnable move as an embed field, with the id to type. */
function learnableField(move) {
  return {
    name: clip(`${move.displayName} (${moveinfo.learnedAt(move)})`, LIMITS.fieldName),
    value: clip(`\`${move.name}\`\n${moveinfo.details(learnset.move(move.name))}`, LIMITS.fieldValue),
  };
}

/**
 * Everything `.moves` shows, as pages.
 *
 * Page one is what it knows and where its learnset comes from. The pages after
 * it are what it can learn now.
 *
 * @returns {{ content: string } | { pages: number, render: function }}
 */
function show(userId, rawPokemonId) {
  const pokemonId = store.parsePartyNumber(rawPokemonId);

  if (!Number.isInteger(pokemonId)) {
    return { content: 'Whose moves? Try `.moves 12`, using the number from `.party`.' };
  }

  const row = store.getOwnedByNumber(userId, pokemonId);
  if (!row) return { content: store.noSuchNumber(userId, pokemonId) };

  const known = store.movesOf(row.id);
  const number = row.party_number || row.id;

  // Which game the list comes from, and the next move it will learn.
  const { versionGroup, moves } = learnset.levelUpMoves(row.species_id, row.form_folder);
  const next = moves.find((move) => move.level > row.level && !move.evolution);

  // Moves it can learn right now. Derived from the level rather than stored,
  // so a skipped move offer never expires.
  const knownNames = new Set(known.map((slot) => slot.move));
  const available = learnset
    .learnableAt(row.species_id, row.form_folder, row.level)
    .filter((move) => !knownNames.has(move.name));

  const learnPages = Math.ceil(available.length / PER_PAGE);
  const pages = 1 + learnPages;

  const howToLearn =
    `\`.moves ${number} learn <move>\`` +
    (known.length >= learnset.MAX_MOVES ? ' asks which move to forget.' : ' teaches one.');

  const render = (index) => {
    const embed = new EmbedBuilder().setColor(colorFor(row));

    if (index === 0) {
      embed.setTitle(`${displayName(row)}'s moves`);

      if (!known.length) {
        embed.setDescription(
          'It does not know any moves, which should not be possible. Please report this to the bot owner.'
        );
      } else {
        embed.addFields(known.map((entry) => knownField(entry, row)));
      }

      embed.addFields({
        name: 'Learnset',
        value:
          `Read from **${versiongroups.displayNameOf(versionGroup)}**.\n` +
          (next ? `Next up: **${next.displayName}** at level ${next.level}.` : 'Nothing left to learn by levelling.') +
          (available.length
            ? `\n**${available.length}** it can learn now, on the next page${learnPages > 1 ? 's' : ''}.`
            : ''),
      });
    } else {
      const slice = available.slice((index - 1) * PER_PAGE, index * PER_PAGE);

      embed
        .setTitle(`${displayName(row)} can learn`)
        .setDescription(howToLearn)
        .addFields(slice.map(learnableField));
    }

    return embed.setFooter({
      text:
        `${known.length}/${learnset.MAX_MOVES} slots used. Use .tm ${number} for TMs.` +
        (pages > 1 ? ` Page ${index + 1}/${pages}` : ''),
    });
  };

  return { pages, render };
}

/** Post `.moves`, paged when there is more than one page. */
async function sendShow({ send, userId, rawPokemonId }) {
  const shown = show(userId, rawPokemonId);
  if (shown.content) return send({ content: shown.content });

  return pager.sendPaged({ send, pages: shown.pages, render: shown.render, userId });
}

/**
 * Teach a move the Pokemon has already grown into.
 *
 * `.moves 12 learn slash` or `.moves 12 learn slash 2`
 *
 * Only moves from the Pokemon's own level-up list at or below its current
 * level, including evolution moves. TMs are handled by `.tm`. With four moves
 * and no slot given, the result carries `offered` and the caller asks which
 * move to forget (Utils/moveprompt.js).
 */
function learn(userId, rawPokemonId, rawMove, rawSlot) {
  const pokemonId = store.parsePartyNumber(rawPokemonId);

  if (!Number.isInteger(pokemonId)) {
    return { content: 'Which Pokemon? Try `.moves 12 learn slash`.' };
  }

  const row = store.getOwnedByNumber(userId, pokemonId);
  if (!row) return { content: store.noSuchNumber(userId, pokemonId) };

  if (!rawMove) {
    return { content: `Learn what? \`.moves ${pokemonId} learn <move>\`. \`.moves ${pokemonId}\` lists what it can.` };
  }

  const wanted = String(rawMove).toLowerCase().replace(/[^a-z0-9]+/g, '-');

  const known = store.movesOf(row.id);
  const knownNames = new Set(known.map((slot) => slot.move));

  const available = learnset
    .learnableAt(row.species_id, row.form_folder, row.level)
    .filter((move) => !knownNames.has(move.name));

  const match =
    available.find((move) => move.name === wanted) ||
    available.find((move) => move.name.replace(/-/g, '') === wanted.replace(/-/g, ''));

  if (!match) {
    if (knownNames.has(wanted)) {
      return { content: `${displayName(row)} already knows that one.` };
    }

    // Distinguish "not on its list" from "not at this level yet".
    const later = learnset
      .levelUpMoves(row.species_id, row.form_folder)
      .moves.find((move) => move.name === wanted);

    if (later) {
      return {
        content:
          `${displayName(row)} does not learn **${later.displayName}** until level ${later.level}. ` +
          `It is level ${row.level}.`,
      };
    }

    return {
      content:
        `${displayName(row)} does not learn that by levelling up. ` +
        `\`.moves ${pokemonId}\` lists what it can, and \`.tm\` is for everything else.`,
    };
  }

  const slot = rawSlot === undefined || rawSlot === null || rawSlot === '' ? null : parseInt(rawSlot, 10);

  if (slot !== null && (!Number.isInteger(slot) || slot < 1 || slot > learnset.MAX_MOVES)) {
    return { content: `A move slot is 1 to ${learnset.MAX_MOVES}.` };
  }

  // Full and no slot named: ask with buttons.
  if (known.length >= learnset.MAX_MOVES && slot === null) {
    return { offered: { pokemonId: row.id, moves: [match] } };
  }

  const taught = store.teachMove(row.id, match.name, slot);
  if (!taught.ok) return { content: taught.message };

  const forgotten = taught.replaced && learnset.move(taught.replaced);

  return {
    content:
      `**${displayName(row)}** learned **${match.displayName}**!` +
      (taught.replaced
        ? ` It forgot ${forgotten ? forgotten.displayName : titleCase(taught.replaced)}.`
        : ''),
  };
}

module.exports = {
  aliases: ['moves', 'move', 'moveset'],

  data: new SlashCommandBuilder()
    .setName('moves')
    .setDescription('Shows the moves one of your Pokemon knows, and what it can learn.')
    .addIntegerOption((option) =>
      option.setName('pokemon').setDescription('Its number, from /party.').setRequired(true)
    ),

  async execute(interaction) {
    store.ensureUser(interaction.user.id);
    await sendShow({
      send: pager.interactionSender(interaction),
      userId: interaction.user.id,
      rawPokemonId: interaction.options.getInteger('pokemon'),
    });
  },

  async run(message, args) {
    const userId = message.author.id;
    const send = (payload) => message.channel.send(payload);
    store.ensureUser(userId);

    // `.moves 12 learn slash 2`: the verb is the second argument.
    if (String(args[1] || '').toLowerCase() === 'learn') {
      const result = learn(userId, args[0], args[2], args[3]);

      if (result.offered) await moveprompt.askAll({ send, userId, ...result.offered });
      else await send(result);
      return;
    }

    await sendShow({ send, userId, rawPokemonId: args[0] });
  },

  show,
  learn,
  knownField,
  learnableField,
};
