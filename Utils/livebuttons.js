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

/** Track with this instead of an id when anyone may press (a finished battle's log). */
const ANYONE = '*';

/** Start answering presses on this message for `ownerId`. */
function track(message, ownerId) {
  if (message && message.id) live.set(message.id, ownerId);
}

/** Stop: the collector has ended. With `ownerId`, only if it is still theirs. */
function release(message, ownerId) {
  if (!message || !message.id) return;
  if (ownerId !== undefined && live.get(message.id) !== ownerId) return;
  live.delete(message.id);
}

/**
 * Answer a button or menu press that no collector will.
 *
 * Presses by the owner of a live message are left to its collector.
 */
async function answerStray(interaction) {
  const owner = interaction.message ? live.get(interaction.message.id) : undefined;
  if (owner === interaction.user.id || owner === ANYONE) return;

  const content =
    owner === undefined
      ? 'These buttons have expired. Run the command again to get fresh ones.'
      : `Only <@${owner}> can use these buttons. Run the command yourself to get your own.`;

  await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
}

/**
 * Answer a press at once, then do the work.
 *
 * Discord gives a press 3 seconds to be answered or shows "This interaction
 * failed". Deferring answers it straight away, so the work after it (a
 * database query, an image upload, looking up names) can't run that clock
 * out. The returned object stands in for the press: update() edits the
 * message the button is on, reply() posts a private message.
 *
 * A press that reached the bot after the 3 seconds (a freeze, a slow
 * network) can't be answered any more. The work still happens: update()
 * edits the message directly instead, and reply() is skipped.
 */
function acknowledge(press) {
  const deferred = typeof press.deferUpdate === 'function';
  let answered = !deferred;
  return {
    press,
    customId: press.customId,
    values: press.values || [],
    user: press.user,
    ready: deferred
      ? press.deferUpdate().then(() => { answered = true; }, () => {})
      : Promise.resolve(),
    update(payload) {
      if (!deferred) return press.update(payload);
      return answered ? press.editReply(payload) : press.message.edit(payload);
    },
    reply(payload) {
      if (!deferred) return press.reply(payload);
      return answered ? press.followUp(payload) : Promise.resolve();
    },
  };
}

/**
 * acknowledge(), waited for: `const choice = await answered(press)`.
 */
async function answered(press) {
  const choice = acknowledge(press);
  await choice.ready;
  return choice;
}

module.exports = { ANYONE, track, release, answerStray, acknowledge, answered };
