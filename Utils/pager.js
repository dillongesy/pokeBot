'use strict';

/**
 * Button pagination, shared by every command that shows a long list.
 *
 * The caller supplies the page count and a function that renders one page;
 * this module handles the buttons, the collector and cleanup.
 */

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const livebuttons = require('./livebuttons');

/** How long the buttons stay active after the last press. Each press restarts it. */
const IDLE_MS = 5 * 60_000;

/**
 * The longest the buttons stay active however often they are pressed, so
 * listeners don't pile up. Each one checks every button press the bot sees.
 */
const MAX_MS = 30 * 60_000;

const BUTTONS = [
  { id: 'pageFirst', label: '⏪' },
  { id: 'pagePrev', label: '◀' },
  { id: 'pageNext', label: '▶' },
  { id: 'pageLast', label: '⏩' },
];

/** The four buttons, optionally all disabled. */
function buildRow(disabled = false) {
  return new ActionRowBuilder().addComponents(
    BUTTONS.map((button) =>
      new ButtonBuilder()
        .setCustomId(button.id)
        .setLabel(button.label)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled)
    )
  );
}

/** Where a button press moves to. Wraps at both ends. */
function nextPage(current, pages, id) {
  if (id === 'pageFirst') return 0;
  if (id === 'pageLast') return pages - 1;
  if (id === 'pagePrev') return current === 0 ? pages - 1 : current - 1;
  if (id === 'pageNext') return current === pages - 1 ? 0 : current + 1;
  return current;
}

/**
 * Post a paged message and wire up its buttons.
 *
 * @param {object}   options
 * @param {function} options.send     posts the payload, returns the Message
 * @param {number}   options.pages    how many pages there are
 * @param {number}   options.page     which one to open on, zero-based
 * @param {function} options.render   (pageIndex) => EmbedBuilder
 * @param {string}   options.userId   only this user may press the buttons
 */
async function sendPaged({ send, pages, page = 0, render, userId }) {
  const total = Math.max(1, pages);
  let current = Math.min(Math.max(0, page), total - 1);

  // A single page needs no buttons at all.
  const payload = { embeds: [render(current)] };
  if (total > 1) payload.components = [buildRow()];

  const message = await send(payload);
  if (total <= 1 || !message || !message.createMessageComponentCollector) return message;

  const collector = message.createMessageComponentCollector({
    filter: (i) => i.user.id === userId,
    idle: IDLE_MS,
    time: MAX_MS,
  });

  livebuttons.track(message, userId);

  collector.on('collect', async (interaction) => {
    current = nextPage(current, total, interaction.customId);
    try {
      await interaction.update({ embeds: [render(current)], components: [buildRow()] });
    } catch (err) {
      // 10008 is "unknown message": it was deleted. Ignore.
      if (err.code !== 10008) console.error('Pager update failed:', err);
    }
  });

  collector.on('end', async () => {
    livebuttons.release(message);

    try {
      await message.edit({ components: [buildRow(true)] });
    } catch (err) {
      if (err.code !== 10008) console.error('Pager cleanup failed:', err);
    }
  });

  return message;
}

/**
 * Adapt an interaction to the `send` this module wants.
 *
 * A slash reply is not a Message, so it has to be fetched back before it can
 * carry a collector.
 */
function interactionSender(interaction) {
  return async (payload) => {
    if (interaction.replied || interaction.deferred) return interaction.followUp(payload);
    await interaction.reply(payload);
    return interaction.fetchReply();
  };
}

module.exports = { sendPaged, buildRow, nextPage, interactionSender, IDLE_MS, MAX_MS, BUTTONS };
