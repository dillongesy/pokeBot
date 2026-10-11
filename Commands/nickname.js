'use strict';

/**
 * .nickname <id> <name> - rename one of your Pokemon.
 *
 * Letters, numbers and single spaces only. Nicknames are shown in embeds and
 * chat, so anything that could carry markdown, mentions, links or invisible
 * characters is rejected rather than escaped.
 */

const { SlashCommandBuilder } = require('discord.js');

const store = require('../Utils/store');
const { displayName } = require('../Utils/display');

const MAX_LENGTH = 18;

/** Only these characters, and never a leading, trailing or doubled space. */
const ALLOWED = /^[A-Za-z0-9]+(?: [A-Za-z0-9]+)*$/;

/**
 * Check a proposed nickname.
 *
 * @returns {{ ok: true, nickname: string } | { ok: false, reason: string }}
 */
function validate(raw) {
  const nickname = String(raw ?? '').trim();

  if (!nickname) return { ok: false, reason: 'Give it a name, like `.nickname 12 Sparky`.' };

  if (nickname.length > MAX_LENGTH) {
    return { ok: false, reason: `Nicknames can be at most ${MAX_LENGTH} characters.` };
  }

  if (!ALLOWED.test(nickname)) {
    return {
      ok: false,
      reason: 'Nicknames can only use letters, numbers and single spaces.',
    };
  }

  return { ok: true, nickname };
}

/** Do the rename, or say why not. Shared by both invocations. */
function rename(userId, rawId, rawNickname) {
  const id = store.parsePartyNumber(rawId);
  if (!Number.isInteger(id)) {
    return { content: 'Which one? Try `.nickname 12 Sparky`, using the number from `.party`.' };
  }

  const row = store.getOwnedByNumber(userId, id);
  if (!row) return { content: store.noSuchNumber(userId, id) };

  // "clear" and "reset" put the species name back.
  const wanted = String(rawNickname ?? '').trim();
  if (/^(clear|reset|none)$/i.test(wanted)) {
    store.setNickname(userId, row.id, null);
    return { content: `#${id} is back to being ${displayName({ ...row, nickname: null })}.` };
  }

  const checked = validate(wanted);
  if (!checked.ok) return { content: checked.reason };

  store.setNickname(userId, row.id, checked.nickname);
  return {
    content: `#${id} is now called ${displayName({ ...row, nickname: checked.nickname })}.`,
  };
}

module.exports = {
  aliases: ['nickname', 'nick'],

  data: new SlashCommandBuilder()
    .setName('nickname')
    .setDescription('Renames one of your Pokemon.')
    .addIntegerOption((option) =>
      option.setName('id').setDescription('Its number, from /party.').setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName('name')
        .setDescription('Letters, numbers and spaces. Use "clear" to remove it.')
        .setRequired(true)
        .setMaxLength(MAX_LENGTH)
    ),

  async execute(interaction) {
    store.ensureUser(interaction.user.id);
    await interaction.reply(
      rename(interaction.user.id, interaction.options.getInteger('id'), interaction.options.getString('name'))
    );
  },

  async run(message, args) {
    store.ensureUser(message.author.id);
    await message.channel.send(rename(message.author.id, args[0], args.slice(1).join(' ')));
  },

  validate,
  rename,
  MAX_LENGTH,
};
