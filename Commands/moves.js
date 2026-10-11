'use strict';

/**
 * .moves <pokemon> - the four moves one of your Pokemon knows.
 *
 * Also handles `.moves <id> learn` for level-up moves; TMs are in `.tm`.
 *
 * Each Pokemon starts with the last four level-up moves it would know at its
 * level, using the newest game its form appears in (see Utils/learnset.js).
 * The card names that game.
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const store = require('../Utils/store');
const learnset = require('../Utils/learnset');
const versiongroups = require('../Utils/versiongroups');
const movepower = require('../Utils/movepower');
const { displayName, colorFor, titleCase } = require('../Utils/display');

/** Damage class labels. */
const CLASS_LABEL = { physical: 'Physical', special: 'Special', status: 'Status' };

/** One move as a table row. Power and accuracy are dashes when they do not apply. */
function line(entry) {
  const data = entry.data;

  if (!data) return `\`${entry.slot}\`  **${titleCase(entry.move)}** - unknown move`;

  // A tilde marks variable power, calculated at the time of the hit
  // (see Utils/movepower.js).
  const nominal = movepower.nominalPower(data);
  const power = data.power ? String(data.power) : nominal ? `~${nominal}` : '-';
  const accuracy = data.accuracy ? `${data.accuracy}%` : '-';
  const pp = data.pp ? String(data.pp + entry.ppUp * Math.floor(data.pp / 5)) : '-';

  return (
    `\`${entry.slot}\`  **${data.displayName}**\n` +
    `　${titleCase(data.type)} · ${CLASS_LABEL[data.damageClass] || titleCase(data.damageClass || '?')}` +
    ` · ${power} power · ${accuracy} acc · ${pp} PP`
  );
}

function show(userId, rawPokemonId) {
  const pokemonId = store.parsePartyNumber(rawPokemonId);

  if (!Number.isInteger(pokemonId)) {
    return { content: 'Whose moves? Try `.moves 12`, using the number from `.party`.' };
  }

  const row = store.getOwnedByNumber(userId, pokemonId);
  if (!row) return { content: store.noSuchNumber(userId, pokemonId) };

  const known = store.movesOf(row.id);

  const embed = new EmbedBuilder()
    .setTitle(`${displayName(row)} - moves`)
    .setColor(colorFor(row));

  if (!known.length) {
    embed.setDescription('It does not know any moves, which should not be possible. Please report this to the bot owner.');
    return { embeds: [embed] };
  }

  embed.setDescription(known.map(line).join('\n\n'));

  // Which game the list comes from, and the next moves it will learn.
  const { versionGroup, moves } = learnset.levelUpMoves(row.species_id, row.form_folder);
  const next = moves.find((move) => move.level > row.level);

  // Moves it can learn right now. Derived from the level rather than stored,
  // so a skipped move offer never expires.
  const knownNames = new Set(known.map((slot) => slot.move));
  const available = learnset
    .learnableAt(row.species_id, row.form_folder, row.level)
    .filter((move) => !knownNames.has(move.name));

  embed.addFields({
    name: 'Learnset',
    value:
      `Read from **${versiongroups.displayNameOf(versionGroup)}**` +
      (next ? `\nNext up: **${next.displayName}** at level ${next.level}` : `\nNothing left to learn`),
  });

  if (available.length) {
    const list = available
      .slice(0, 12)
      .map((move) => `\`${move.name}\` - ${move.displayName} (lv ${move.level})`)
      .join('\n');

    embed.addFields({
      name: `Can learn now (${available.length})`,
      value:
        `${list}${available.length > 12 ? `\n…and ${available.length - 12} more` : ''}\n\n` +
        `\`.moves ${row.party_number || row.id} learn <move>\`` +
        (known.length >= learnset.MAX_MOVES ? ' `<slot 1-4>`' : ''),
    });
  }

  embed.setFooter({
    text: `${known.length}/${learnset.MAX_MOVES} slots used · .tm ${row.party_number || row.id} to change them`,
  });

  return { embeds: [embed] };
}

/**
 * Teach a move the Pokemon has already grown into.
 *
 * `.moves 12 learn slash 2`
 *
 * Only moves from the Pokemon's own level-up list at or below its current
 * level. TMs are handled by `.tm`.
 */
function learn(userId, rawPokemonId, rawMove, rawSlot) {
  const pokemonId = store.parsePartyNumber(rawPokemonId);

  if (!Number.isInteger(pokemonId)) {
    return { content: 'Which Pokemon? Try `.moves 12 learn slash`.' };
  }

  const row = store.getOwnedByNumber(userId, pokemonId);
  if (!row) return { content: store.noSuchNumber(userId, pokemonId) };

  if (!rawMove) {
    return { content: `Learn what? \`.moves ${pokemonId} learn <move>\` - \`.moves ${pokemonId}\` lists what it can.` };
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

  if (known.length >= learnset.MAX_MOVES && slot === null) {
    const list = known
      .map((entry) => `\`${entry.slot}\` ${entry.data ? entry.data.displayName : titleCase(entry.move)}`)
      .join('\n');

    return {
      content:
        `**${displayName(row)}** already knows four moves. Which one goes?\n\n${list}\n\n` +
        `\`.moves ${pokemonId} learn ${match.name} <slot>\``,
    };
  }

  const taught = store.teachMove(row.id, match.name, slot);
  if (!taught.ok) return { content: taught.message };

  return {
    content:
      `**${displayName(row)}** learned **${match.displayName}**!` +
      (taught.replaced ? ` It forgot ${titleCase(taught.replaced)}.` : ''),
  };
}

module.exports = {
  aliases: ['moves', 'move', 'moveset'],

  data: new SlashCommandBuilder()
    .setName('moves')
    .setDescription('Shows the moves one of your Pokemon knows.')
    .addIntegerOption((option) =>
      option.setName('pokemon').setDescription('Its number, from /party.').setRequired(true)
    ),

  async execute(interaction) {
    store.ensureUser(interaction.user.id);
    await interaction.reply(show(interaction.user.id, interaction.options.getInteger('pokemon')));
  },

  async run(message, args) {
    store.ensureUser(message.author.id);

    // `.moves 12 learn slash 2`: the verb is the second argument.
    if (String(args[1] || '').toLowerCase() === 'learn') {
      await message.channel.send(learn(message.author.id, args[0], args[2], args[3]));
      return;
    }

    await message.channel.send(show(message.author.id, args[0]));
  },

  show,
  learn,
  line,
};
