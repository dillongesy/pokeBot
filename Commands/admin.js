'use strict';

/**
 * .admin - who may run .forcespawn and .give.
 *
 *   .admin                    who has it
 *   .admin add @user          hand it over
 *   .admin add @user testing  ...with a note saying why
 *   .admin remove @user       take it back
 *
 * Owner only. The owner is DISCORD_OWNER_ID in .env and is not stored in the
 * admin table, so the owner can never be locked out (see Utils/admin.js).
 */

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');

const admin = require('../Utils/admin');

/** "<@123>" or a bare id. The same parser .trade uses. */
function parseUserId(raw) {
  const text = String(raw || '').trim();
  const match = /^<@!?(\d+)>$/.exec(text);
  if (match) return match[1];
  return /^\d{15,25}$/.test(text) ? text : null;
}

/** How long ago, roughly. Exact dates are not the interesting part here. */
function ago(then) {
  const days = Math.floor((Date.now() - then) / 86400000);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return `${Math.floor(days / 30)} months ago`;
}

function buildList() {
  const owner = admin.ownerId();
  const rows = admin.list();

  const embed = new EmbedBuilder()
    .setTitle('Bot admins')
    .setColor(0x5865f2)
    .setDescription(
      owner
        ? `**Owner** <@${owner}> - set in \`.env\`, cannot be changed from here.`
        : '**No owner is configured.** Set `DISCORD_OWNER_ID` in `.env` and restart; ' +
          'until then nobody can run the admin commands.'
    );

  if (!rows.length) {
    embed.addFields({
      name: 'Admins',
      value: owner ? 'Nobody yet. `.admin add @someone`' : '-',
    });
  } else {
    embed.addFields({
      name: `Admins (${rows.length})`,
      value: rows
        .map((row) => {
          const why = row.note ? ` - ${row.note}` : '';
          return `<@${row.discord_user_id}>, added ${ago(row.added_at)} by <@${row.added_by}>${why}`;
        })
        .join('\n')
        .slice(0, 1024),
    });
  }

  embed.setFooter({ text: 'Admins can run .forcespawn and .give. Only the owner can edit this list.' });
  return { embeds: [embed] };
}

/**
 * Decide what to do and what to say. Does not touch Discord.
 *
 * Named `manage` so it doesn't clash with the `run` prefix handler below.
 *
 * @returns {object} a Discord message payload
 */
function manage(userId, args = []) {
  // Reading the list is owner-only too. Who can spawn Pokemon and hand out
  // coins is not something an ordinary player needs to know.
  if (!admin.isOwner(userId)) return { content: admin.DENIED };

  const [action, target, ...rest] = args.map(String);
  const verb = (action || 'list').toLowerCase();

  if (verb === 'list' || verb === 'who') return buildList();

  if (verb !== 'add' && verb !== 'remove' && verb !== 'rm' && verb !== 'delete') {
    return { content: 'Try `.admin`, `.admin add @user` or `.admin remove @user`.' };
  }

  const id = parseUserId(target);
  if (!id) return { content: `Which user? Try \`.admin ${verb} @someone\`.` };

  if (verb === 'add') {
    const note = rest.join(' ').trim() || null;
    const result = admin.add(id, { by: userId, note });
    return { content: result.ok ? `<@${id}> is now an admin.` : result.message };
  }

  const result = admin.remove(id);
  return { content: result.ok ? `<@${id}> is no longer an admin.` : result.message };
}

module.exports = {
  aliases: ['admin', 'admins'],

  data: new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Owner only. Who may run the admin commands.')
    .addStringOption((option) =>
      option
        .setName('action')
        .setDescription('What to do. Defaults to listing them.')
        .addChoices(
          { name: 'list', value: 'list' },
          { name: 'add', value: 'add' },
          { name: 'remove', value: 'remove' }
        )
    )
    .addUserOption((option) => option.setName('user').setDescription('Who to add or remove.'))
    .addStringOption((option) => option.setName('note').setDescription('Why, for the list.')),

  async execute(interaction) {
    const action = interaction.options.getString('action') || 'list';
    const user = interaction.options.getUser('user');
    const note = interaction.options.getString('note');

    const args = [action];
    if (user) args.push(user.id);
    if (note) args.push(note);

    // Ephemeral: who has admin is not something to announce in the channel.
    await interaction.reply({ ...manage(interaction.user.id, args), flags: MessageFlags.Ephemeral });
  },

  async run(message, args) {
    await message.channel.send(manage(message.author.id, args));
  },

  manage,
  parseUserId,
  buildList,
};
