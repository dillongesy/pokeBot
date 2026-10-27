'use strict';

/**
 * Which messages have buttons the bot is still listening to, and whose they
 * are.
 *
 * Buttons only work while a collector for their message is running, and
 * collectors live in memory. Without an answer, Discord shows "This
 * interaction failed" when someone presses a button that has expired, that
 * was left over from before a restart, or that belongs to someone else.
 * index.js uses this to answer those presses instead.
 *
 * Every place that listens for presses tracks its message while it listens
 * and releases it when it stops.
 */

const { MessageFlags } = require('discord.js');

/** Message id -> the Discord id of the only person who may press. */
const live = new Map();

/** Start answering presses on this message for `ownerId`. */
function track(message, ownerId) {
  if (message && message.id) live.set(message.id, ownerId);
}

/** Stop: the collector has ended. */
function release(message) {
  if (message && message.id) live.delete(message.id);
}

/**
 * Answer a button or menu press that no collector will.
 *
 * Presses by the owner of a live message are left to its collector.
 */
async function answerStray(interaction) {
  const owner = interaction.message ? live.get(interaction.message.id) : undefined;
  if (owner === interaction.user.id) return;

  const content =
    owner === undefined
      ? 'These buttons have expired. Run the command again to get fresh ones.'
      : `Only <@${owner}> can use these buttons. Run the command yourself to get your own.`;

  await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
}

module.exports = { track, release, answerStray };
