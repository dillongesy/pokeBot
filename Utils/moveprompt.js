'use strict';

/**
 * Asking which move to forget.
 *
 * When a Pokemon earns a move with all four slots full (levelling in battle,
 * Rare Candy, evolving), the player gets one card per move: the new move's
 * details, the four it knows, and a button for each of them plus one to keep
 * what it has. Only the owner can answer.
 *
 * Nothing is lost by ignoring it: `.moves <n> learn` can still teach the move
 * later, since what a Pokemon can learn is derived from its level.
 */

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} = require('discord.js');

const store = require('./store');
const content = require('./content');
const learnset = require('./learnset');
const moveinfo = require('./moveinfo');
const livebuttons = require('./livebuttons');
const { displayName, colorFor, titleCase, clip } = require('./display');

/**
 * How long the buttons stay live. One press answers it, so there is no idle
 * timer to refresh; it is long so a player who steps away can still choose.
 */
const ANSWER_MS = 15 * 60_000;

const KEEP = 'learn:keep';

/** Discord's limit on an embed title. */
const TITLE_LIMIT = 256;

const nameOf = (slot) => (slot.data ? slot.data.displayName : titleCase(slot.move));

/** How to teach it later, for the footer and the "kept" message. */
const laterHint = (row, move) => `.moves ${row.party_number} learn ${move.name}`;

/** The question: the new move, and the four it would replace one of. */
function card(row, move, known) {
  return new EmbedBuilder()
    .setTitle(clip(`${displayName(row)} wants to learn ${move.displayName}`, TITLE_LIMIT))
    .setColor(colorFor(row))
    .setDescription(
      `**${move.displayName}** (${moveinfo.learnedAt(move)})\n` +
        `${moveinfo.details(content.move(move.name))}\n\n` +
        'It already knows four moves. Pick one to forget, or keep the ones it has.'
    )
    .addFields(
      known.map((slot) => ({
        name: `${slot.slot}. ${nameOf(slot)}`,
        value: moveinfo.details(slot.data, slot.ppUp),
      }))
    )
    .setFooter({ text: `It can still learn it later with ${laterHint(row, move)}` });
}

/** One button per known move, then the one that keeps them all. */
function buttons(known, disabled = false) {
  return [
    new ActionRowBuilder().addComponents(
      ...known.map((slot) =>
        new ButtonBuilder()
          .setCustomId(`learn:${slot.slot}`)
          .setLabel(clip(`Forget ${nameOf(slot)}`, 80))
          .setStyle(ButtonStyle.Primary)
          .setDisabled(disabled)
      ),
      new ButtonBuilder()
        .setCustomId(KEEP)
        .setLabel('Keep current moves')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled)
    ),
  ];
}

/** The card once it has been answered, with the outcome in place of the question. */
function settled(row, move, text) {
  return new EmbedBuilder()
    .setTitle(clip(`${displayName(row)} and ${move.displayName}`, TITLE_LIMIT))
    .setColor(colorFor(row))
    .setDescription(text);
}

/**
 * Offer one move. Resolves once it has been answered, skipped or timed out.
 *
 * @param {object}   options
 * @param {function} options.send       posts a payload, returns the Message
 * @param {string}   options.userId     the owner; only they can answer
 * @param {number}   options.pokemonId  the database id, not the party number
 * @param {object}   options.move       {name, displayName, level, evolution}
 */
async function ask({ send, userId, pokemonId, move }) {
  const row = store.getOwnedPokemon(userId, pokemonId);
  if (!row) return;

  const known = store.movesOf(row.id);
  if (known.some((slot) => slot.move === move.name)) return;

  // A slot may have opened up since the move was earned.
  if (known.length < learnset.MAX_MOVES) {
    const taught = store.teachMove(row.id, move.name);
    if (taught.ok) await send({ content: `**${displayName(row)}** learned **${move.displayName}**!` });
    return;
  }

  const prompt = await send({ embeds: [card(row, move, known)], components: buttons(known) });
  if (!prompt || typeof prompt.awaitMessageComponent !== 'function') return;

  livebuttons.track(prompt, userId);

  let choice;
  try {
    choice = await prompt.awaitMessageComponent({
      componentType: ComponentType.Button,
      time: ANSWER_MS,
      filter: (button) => button.user.id === userId,
    });
  } catch {
    livebuttons.release(prompt);

    // Timed out: keep its moves and leave the card readable.
    await prompt
      .edit({
        embeds: [
          settled(
            row,
            move,
            `No answer, so **${displayName(row)}** kept its moves.\n` +
              `\`${laterHint(row, move)} <slot>\` still teaches it.`
          ),
        ],
        components: [],
      })
      .catch(() => {});
    return;
  }

  livebuttons.release(prompt);

  // It may have been traded or released while the card was waiting.
  const now = store.getOwnedPokemon(userId, pokemonId);

  let text;
  if (!now) {
    text = 'That Pokemon is no longer yours, so nothing changed.';
  } else if (choice.customId === KEEP) {
    text =
      `**${displayName(now)}** did not learn **${move.displayName}**.\n` +
      `\`${laterHint(now, move)} <slot>\` still teaches it.`;
  } else {
    const slot = Number(choice.customId.split(':')[1]);
    const taught = store.teachMove(now.id, move.name, slot);
    const forgotten = taught.replaced && content.move(taught.replaced);

    text = taught.ok
      ? `1, 2 and... Poof! **${displayName(now)}** forgot ` +
        `**${forgotten ? forgotten.displayName : titleCase(taught.replaced || '')}** ` +
        `and learned **${move.displayName}**!`
      : taught.message;
  }

  await choice
    .update({ embeds: [settled(now || row, move, text)], components: [] })
    .catch(() => {});
}

/** Offer several moves in turn, one card at a time. */
async function askAll({ send, userId, pokemonId, moves }) {
  for (const move of moves || []) {
    try {
      await ask({ send, userId, pokemonId, move });
    } catch (err) {
      console.error('A move offer failed:', err);
    }
  }
}

module.exports = { ask, askAll, card, buttons, ANSWER_MS };
