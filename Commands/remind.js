'use strict';

/**
 * .remind - get pinged when your drop cooldown ends.
 *
 * With no argument it toggles. The ping is sent to the channel you last
 * dropped in.
 *
 * The setting is stored, so it survives a restart. Turning it on during a
 * cooldown schedules a reminder for that cooldown immediately.
 */

const { SlashCommandBuilder } = require('discord.js');

const store = require('../Utils/store');
const reminders = require('../Utils/reminders');

/** "4m 12s" - shared wording with .drop. */
function formatDuration(ms) {
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/**
 * Flip the setting and arrange or cancel the pending reminder to match.
 *
 * @returns {string} what to tell them
 */
function toggle(userId, channelId, wanted = null) {
  store.ensureUser(userId);

  const on = store.toggleRemind(userId, wanted);

  if (!on) {
    reminders.cancel(userId);
    return "You will no longer be pinged when your drop is ready.";
  }

  const waiting = store.cooldownRemaining(userId);

  if (waiting > 0) {
    const user = store.getUser(userId);
    reminders.schedule(userId, channelId, user.cooldown_end);
    return `You will be pinged when your drop is ready, ${formatDuration(waiting)} to go.`;
  }

  return 'You will be pinged when your drop is ready. Your next drop starts the clock.';
}

module.exports = {
  aliases: ['remind', 'reminder', 'remindme'],

  data: new SlashCommandBuilder()
    .setName('remind')
    .setDescription('Ping you when your drop cooldown ends.')
    .addBooleanOption((option) =>
      option.setName('on').setDescription('Leave blank to toggle.')
    ),

  async execute(interaction) {
    const wanted = interaction.options.getBoolean('on');
    await interaction.reply(toggle(interaction.user.id, interaction.channelId, wanted));
  },

  async run(message) {
    await message.channel.send(toggle(message.author.id, message.channelId));
  },

  toggle,
};
