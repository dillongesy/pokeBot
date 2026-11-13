'use strict';

/**
 * .tm - teach a move.
 *
 *   .tm 12                  TMs you own that #12 can learn
 *   .tm 12 all              every TM #12 can learn
 *   .tm 12 flamethrower     teach it; with four moves, buttons ask which to forget
 *   .tm 12 flamethrower 2   teach it over slot 2
 *
 * TMs are reusable and stay in the bag.
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const store = require('../Utils/store');
const partylock = require('../Utils/partylock');
const content = require('../Utils/content');
const machines = require('../Utils/machines');
const learnset = require('../Utils/learnset');
const happiness = require('../Utils/happiness');
const moveprompt = require('../Utils/moveprompt');
const pager = require('../Utils/pager');
const versiongroups = require('../Utils/versiongroups');
const { displayName, colorFor, titleCase } = require('../Utils/display');

/** Maximum TMs to list. */
const PER_TYPE = 14;

const CLASS_LABEL = { physical: 'Physical', special: 'Special', status: 'Status' };

/** "Flamethrower `90`" */
function brief(tm) {
  const power = tm.power ? `${tm.power}` : tm.nominalPower ? `~${tm.nominalPower}` : '-';
  return `${tm.moveDisplayName} \`${power}\``;
}

/**
 * What a Pokemon can be taught, grouped by type.
 *
 * `owned` limits it to TMs in the bag (the default); `.tm <id> all` shows
 * everything.
 */
function listFor(userId, row, showAll) {
  const options = machines.learnableFor(row.species_id, row.form_folder);

  const usable = showAll
    ? options
    : options.filter((tm) => store.itemQuantity(userId, tm.slug) > 0);

  const embed = new EmbedBuilder()
    .setTitle(`${displayName(row)} - TMs`)
    .setColor(colorFor(row));

  if (!options.length) {
    embed.setDescription('There is no TM it can learn at all.');
    return { embeds: [embed] };
  }

  if (!usable.length) {
    embed.setDescription(
      `You own none of the ${options.length} TMs it can learn.\n` +
        'Buy them with `.shop TMs`, or see the full list with ' +
        `\`.tm ${row.party_number || row.id} all\`.`
    );
    return { embeds: [embed] };
  }

  const byType = new Map();
  for (const tm of usable) {
    if (!byType.has(tm.type)) byType.set(tm.type, []);
    byType.get(tm.type).push(tm);
  }

  for (const [type, list] of [...byType].sort((a, b) => a[0].localeCompare(b[0]))) {
    const shown = list.slice(0, PER_TYPE).map(brief).join(', ');
    const rest = list.length > PER_TYPE ? ` … and ${list.length - PER_TYPE} more` : '';
    embed.addFields({ name: titleCase(type), value: shown + rest });
  }

  embed.setDescription(
    showAll
      ? `**${usable.length}** of the 340 TMs work on it. You own the ones in \`.bag\`.`
      : `**${usable.length}** TMs you own work on it, of **${options.length}** it can learn.`
  );

  embed.setFooter({
    text: `.tm ${row.party_number || row.id} <move> to teach one.`,
  });

  return { embeds: [embed] };
}

/**
 * Teach one move. Each refusal explains the specific problem (can't learn it,
 * TM not owned, or no free slot).
 */
/**
 * Why `row` can't be taught `move` from a TM right now, or null if it can.
 * Asked again when the forget-a-move buttons are answered.
 */
function refusal(userId, row, move, tm) {
  // Not during a battle or trade (see Utils/partylock.js).
  const busy = partylock.refusalFor(userId, 'teach your Pokemon moves');
  if (busy) return busy;

  if (!machines.canLearn(row.species_id, row.form_folder, move)) {
    return (
      `${displayName(row)} cannot learn **${tm.moveDisplayName}**. ` +
      `\`.tm ${row.party_number || row.id}\` shows what it can.`
    );
  }

  if (store.itemQuantity(userId, tm.slug) <= 0) {
    return (
      `You do not own **${tm.displayName}**. It is ${tm.price.toLocaleString()} coins ` +
      'in `.shop TMs`, and it never runs out once you have it.'
    );
  }

  return null;
}

/** Being taught a TM raises friendship a little, as in the games. */
function befriend(row) {
  const friendship = happiness.after(row, 'learnTm');
  if (friendship !== row.happiness) store.updatePokemon(row.id, { happiness: friendship });
}

function teach(userId, row, query, rawSlot) {
  const busy = partylock.refusalFor(userId, 'teach your Pokemon moves');
  if (busy) return { content: busy };

  const move = resolveMove(query);

  if (!move) {
    return { content: `There is no TM for "${query}". Try \`.tm ${row.party_number || row.id}\`.` };
  }

  const tm = machines.forMove(move);

  const refused = refusal(userId, row, move, tm);
  if (refused) return { content: refused };

  const known = store.movesOf(row.id);

  if (known.some((entry) => entry.move === move)) {
    return { content: `${displayName(row)} already knows **${tm.moveDisplayName}**.` };
  }

  // Four moves and no slot given: buttons ask which to forget (Utils/moveprompt.js).
  const slot = rawSlot === undefined || rawSlot === null || rawSlot === '' ? null : Number(rawSlot);

  if (slot === null && known.length >= learnset.MAX_MOVES) {
    return {
      offered: {
        pokemonId: row.id,
        moves: [
          {
            name: move,
            displayName: tm.moveDisplayName,
            via: tm.number || tm.displayName,
            laterHint: `.tm ${row.party_number || row.id} ${move}`,
            check: (now) => refusal(userId, now, move, tm),
            onTaught: befriend,
          },
        ],
      },
    };
  }

  if (slot !== null && (!Number.isInteger(slot) || slot < 1 || slot > learnset.MAX_MOVES)) {
    return { content: `A move slot is 1 to ${learnset.MAX_MOVES}.` };
  }

  const result = store.teachMove(row.id, move, slot);
  if (!result.ok) return { content: result.message };

  befriend(row);

  const replaced = result.replaced ? content.move(result.replaced) : null;

  const embed = new EmbedBuilder()
    .setTitle(`${displayName(row)} learned ${tm.moveDisplayName}!`)
    .setColor(colorFor(row))
    .setDescription(
      replaced
        ? `It forgot **${replaced.displayName}** and learned **${tm.moveDisplayName}**.`
        : `**${tm.moveDisplayName}** went into slot ${result.slot}.`
    );

  const data = tm.data || {};

  embed.addFields(
    {
      name: tm.moveDisplayName,
      value:
        `${titleCase(data.type || '?')}, ` +
        `${CLASS_LABEL[data.damageClass] || titleCase(data.damageClass || '?')}\n` +
        `Power ${data.power || '-'}, accuracy ${data.accuracy ? `${data.accuracy}%` : '-'}, ` +
        `${data.pp || '-'} PP`,
    },
    {
      name: 'Your TM',
      value: `**${tm.displayName}** is still in your bag.`,
    }
  );

  return { embeds: [embed] };
}

/**
 * Turn what somebody typed into a move name.
 *
 * Accepts the move ("flamethrower", "Flame thrower"), the slug
 * ("tm-flamethrower") or the TM number ("TM125"). TM numbers differ between
 * games, so when several match, the newest game wins.
 */
function resolveMove(query) {
  const raw = String(query || '').trim().toLowerCase();
  if (!raw) return null;

  const slug = raw.replace(/[\s_]+/g, '-');

  if (machines.isTm(slug)) return machines.moveOf(slug);
  if (machines.forMove(slug)) return slug;

  // Try spaces both as hyphens and removed ("Flame thrower" -> "flamethrower").
  const squashed = raw.replace(/[\s_-]+/g, '');
  const squashedMatch = machines.all().find((tm) => tm.move.replace(/-/g, '') === squashed);
  if (squashedMatch) return squashedMatch.move;

  // "TM43" or "HM03". Numbers are reused across games, so the newest match wins.
  if (/^(tm|hm)\d+$/.test(raw)) {
    const wanted = raw.toUpperCase();
    const matching = machines.all().filter((tm) => tm.number === wanted);

    if (matching.length) {
      const newest = versiongroups.newest(matching.map((tm) => tm.versionGroup));
      return (matching.find((tm) => tm.versionGroup === newest) || matching[0]).move;
    }
  }

  // Last resort: a unique prefix. "flame" is ambiguous, "flamethro" is not.
  const matches = machines.all().filter((tm) => tm.move.startsWith(slug));
  return matches.length === 1 ? matches[0].move : null;
}

function run(userId, args) {
  const pokemonId = store.parsePartyNumber(args[0]);

  if (!Number.isInteger(pokemonId)) {
    return {
      content:
        'Which Pokemon? `.tm 12` lists what number 12 can be taught, ' +
        '`.tm 12 flamethrower` teaches it.',
    };
  }

  const row = store.getOwnedByNumber(userId, pokemonId);
  if (!row) return { content: store.noSuchNumber(userId, pokemonId) };

  const what = (args[1] || '').trim();

  if (!what) return listFor(userId, row, false);
  if (/^(all|every|list)$/i.test(what)) return listFor(userId, row, true);

  return teach(userId, row, what, args[2]);
}

/** Send the result, or ask which move to forget. */
async function answer(send, userId, args) {
  const result = run(userId, args);
  if (result.offered) await moveprompt.askAll({ send, userId, ...result.offered });
  else await send(result);
}

module.exports = {
  aliases: ['tm', 'teach', 'hm'],

  data: new SlashCommandBuilder()
    .setName('tm')
    .setDescription('Teach one of your Pokemon a move from a TM.')
    .addIntegerOption((option) =>
      option.setName('pokemon').setDescription('Its number, from /party.').setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName('move')
        .setDescription('The move to teach, or "all" to see every option.')
    )
    .addIntegerOption((option) =>
      option
        .setName('slot')
        .setDescription('Which of its four moves to replace, 1 to 4.')
        .setMinValue(1)
        .setMaxValue(4)
    ),

  async execute(interaction) {
    store.ensureUser(interaction.user.id);

    const args = [
      interaction.options.getInteger('pokemon'),
      interaction.options.getString('move') || '',
      interaction.options.getInteger('slot'),
    ];

    await answer(pager.interactionSender(interaction), interaction.user.id, args);
  },

  async run(message, args) {
    store.ensureUser(message.author.id);
    await answer((payload) => message.channel.send(payload), message.author.id, args);
  },

  listFor,
  teach,
  resolveMove,
};
