'use strict';

/**
 * Asking which way to evolve.
 *
 * Some evolutions depend on the time of day (Eevee becomes Espeon by day and
 * Umbreon by night; Rockruff's Lycanroc is Midday, Midnight or Dusk). There is
 * no clock here, so when a Pokemon qualifies the player picks: one button per
 * evolution, plus one to stay as it is. Only the owner can answer.
 *
 * Nothing is lost by waiting: it is asked again at its next level-up, as the
 * games check evolution on every level-up.
 */

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} = require('discord.js');

const store = require('./store');
const evolution = require('./evolution');
const learnset = require('./learnset');
const questengine = require('./questengine');
const livebuttons = require('./livebuttons');
const moveprompt = require('./moveprompt');
const partylock = require('./partylock');
const { displayName, colorFor, clip } = require('./display');

/** How long the buttons stay live, as for the move prompt. */
const ANSWER_MS = 15 * 60_000;

const STAY = 'evolve:stay';

/** Discord's limit on an embed title. */
const TITLE_LIMIT = 256;

function card(row, options) {
  return new EmbedBuilder()
    .setTitle(clip(`${displayName(row)} is ready to evolve!`, TITLE_LIMIT))
    .setColor(colorFor(row))
    .setDescription(
      `It can become ${options.map((o) => `**${o.target.name}** (${o.label.toLowerCase()})`).join(' or ')}.\n` +
        'Which will it be?'
    )
    .setFooter({ text: 'Not now keeps it as it is; it will ask again at its next level-up.' });
}

function buttons(options) {
  return [
    new ActionRowBuilder().addComponents(
      ...options.map((option) =>
        new ButtonBuilder()
          .setCustomId(`evolve:${option.timeOfDay}`)
          .setLabel(clip(`${option.target.name} (${option.label})`, 80))
          .setStyle(ButtonStyle.Primary)
      ),
      new ButtonBuilder().setCustomId(STAY).setLabel('Not now').setStyle(ButtonStyle.Secondary)
    ),
  ];
}

function settled(row, text) {
  return new EmbedBuilder().setTitle(clip(displayName(row), TITLE_LIMIT)).setColor(colorFor(row)).setDescription(text);
}

/**
 * Evolve a stored Pokemon the chosen way, with its new moves.
 *
 * Checks again from the database, since it may have changed while the card
 * waited (traded, given an Everstone).
 *
 * @returns {{ ok: boolean, text: string, offered?: object[], row?: object }}
 */
function evolveAt(userId, pokemonId, timeOfDay) {
  const row = store.getOwnedPokemon(userId, pokemonId);
  if (!row) return { ok: false, text: 'That Pokemon is no longer yours, so nothing changed.' };

  // Not mid-battle or mid-trade, where it could change what is fighting or
  // what gets handed over (see Utils/partylock.js).
  const busy = partylock.refusalFor(userId, 'evolve it');
  if (busy) return { ok: false, text: `${busy} It will ask again at its next level-up.` };

  const evolved = evolution.resolve(row, 'level-up', { level: row.level, timeOfDay });
  if (!evolved || evolved.choice) {
    return { ok: false, text: `**${displayName(row)}** can't evolve that way any more, so nothing changed.` };
  }

  const after = store.updatePokemon(row.id, evolved.changes);
  const { learned, offered } = store.learnMoves(row.id, learnset.movesOnGrowth(row, after, [after]));

  let text = `Congratulations! **${displayName(row)}** evolved into **${evolved.target.name}**!`;
  if (learned.length) text += `\nIt learned **${learned.join('**, **')}**.`;

  // Evolving changes which species are owned.
  try {
    const line = questengine.announce(questengine.sync(userId).completed);
    if (line) text += `\n${line}`;
  } catch (err) {
    console.error('Quest sync failed after an evolution:', err);
  }

  return { ok: true, text, offered, row: after };
}

/**
 * Ask once. Resolves when answered, declined or timed out.
 *
 * @param {object}   options
 * @param {function} options.send       posts a payload, returns the Message
 * @param {string}   options.userId     the owner; only they can answer
 * @param {number}   options.pokemonId  the database id, not the party number
 * @param {object[]} options.options    from evolution.resolve's `choice`
 */
async function ask({ send, userId, pokemonId, options }) {
  const row = store.getOwnedPokemon(userId, pokemonId);
  if (!row || !(options || []).length) return;

  const prompt = await send({ embeds: [card(row, options)], components: buttons(options) });
  if (!prompt || typeof prompt.awaitMessageComponent !== 'function') return;

  livebuttons.track(prompt, userId);

  let choice;
  try {
    choice = await livebuttons.answered(await prompt.awaitMessageComponent({
      componentType: ComponentType.Button,
      time: ANSWER_MS,
      filter: (button) => button.user.id === userId,
    }));
  } catch {
    livebuttons.release(prompt);
    await prompt
      .edit({
        embeds: [settled(row, `No answer, so **${displayName(row)}** stayed as it is. It will ask again at its next level-up.`)],
        components: [],
      })
      .catch(() => {});
    return;
  }

  livebuttons.release(prompt);

  if (choice.customId === STAY) {
    await choice
      .update({
        embeds: [settled(row, `**${displayName(row)}** stayed as it is. It will ask again at its next level-up.`)],
        components: [],
      })
      .catch(() => {});
    return;
  }

  const result = evolveAt(userId, pokemonId, choice.customId.split(':')[1]);
  await choice.update({ embeds: [settled(result.row || row, result.text)], components: [] }).catch(() => {});

  if (result.offered && result.offered.length) {
    await moveprompt.askAll({ send, userId, pokemonId, moves: result.offered });
  }
}

module.exports = { ask, evolveAt, card, buttons, ANSWER_MS };
