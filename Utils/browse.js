'use strict';

/**
 * Back and forward buttons for a card that shows one thing at a time:
 * `.view` steps through your Pokemon, `.team @user v 3` through their six.
 *
 * The caller says how to draw a key and which key comes next; this module
 * handles the buttons, the collector and cleanup, with the same timeouts as
 * Utils/pager.js. Only the person who opened it can press.
 */

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const { IDLE_MS, MAX_MS } = require('./pager');
const livebuttons = require('./livebuttons');

const PREV = 'browse:prev';
const NEXT = 'browse:next';

function buildRow(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(PREV).setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder().setCustomId(NEXT).setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(disabled)
  );
}

/**
 * Post the first card and wire up its buttons.
 *
 * @param {object}   options
 * @param {function} options.send    posts a payload, returns the Message
 * @param {string}   options.userId  only this user may press
 * @param {*}        options.start   the key to open on
 * @param {function} options.render  (key) => payload ({embeds, files}), or null if it is gone
 * @param {function} options.step    (key, 1 | -1) => the next key, or null if there is no other
 */
async function sendBrowser({ send, userId, start, render, step }) {
  let current = start;
  const first = render(current);
  if (!first) return null;

  // Nothing else to step to: no buttons.
  const others = step(current, 1) != null;
  const message = await send(others ? { ...first, components: [buildRow()] } : first);
  if (!others || !message || typeof message.createMessageComponentCollector !== 'function') return message;

  livebuttons.track(message, userId);

  const collector = message.createMessageComponentCollector({
    filter: (i) => i.user.id === userId && (i.customId === PREV || i.customId === NEXT),
    idle: IDLE_MS,
    time: MAX_MS,
  });

  collector.on('collect', async (press) => {
    // Answered first, so Discord never gives up on it (Utils/livebuttons.js).
    const interaction = await livebuttons.answered(press);
    const next = step(current, interaction.customId === NEXT ? 1 : -1);
    let payload = next != null ? render(next) : null;
    if (payload) current = next;
    else payload = render(current) || {};

    try {
      // Artwork can be an attachment, which an edit keeps unless told to
      // drop it, so the old one is cleared and the new one sent.
      await interaction.update({
        ...payload,
        files: payload.files || [],
        attachments: [],
        components: [buildRow()],
      });
    } catch (err) {
      if (err.code !== 10008) console.error('Browse update failed:', err);
    }
  });

  collector.on('end', async () => {
    livebuttons.release(message);
    try {
      await message.edit({ components: [buildRow(true)] });
    } catch (err) {
      if (err.code !== 10008) console.error('Browse cleanup failed:', err);
    }
  });

  return message;
}

module.exports = { sendBrowser, buildRow, PREV, NEXT };
