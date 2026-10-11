'use strict';

/**
 * .release <id> - let a Pokemon go.
 *
 * Releasing is permanent, so it takes two steps: the first shows the Pokemon
 * (level, IVs, held item) and the second confirms.
 *
 *   .release 12        what would happen
 *   .release 12 yes    actually do it
 *
 * A held item is handed back rather than lost with the Pokemon.
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const store = require('../Utils/store');
const partylock = require('../Utils/partylock');
const questengine = require('../Utils/questengine');
const content = require('../Utils/content');
const { displayName, colorFor, ivPercent, typeList, capitalize, titleCase } = require('../Utils/display');

/** Words that count as "yes, I meant it". */
const CONFIRM = /^(yes|y|confirm|sure)$/i;

/** The "are you sure" card. */
function buildPreview(row) {
  const embed = new EmbedBuilder()
    .setTitle(`Release ${displayName(row)}?`)
    .setColor(colorFor(row))
    .setDescription(
      row.shiny
        ? '**This one is shiny.** Releasing it is permanent.'
        : 'Releasing is permanent.'
    )
    .addFields(
      { name: 'Level', value: String(row.level), inline: true },
      { name: 'IVs', value: `${ivPercent(row)}%`, inline: true },
      { name: 'Type', value: typeList(row).map(capitalize).join(' / ') || '-', inline: true },
      { name: 'Nature', value: titleCase(row.nature), inline: true }
    );

  if (row.equipped_item) {
    const item = content.item(row.equipped_item);
    embed.addFields({
      name: 'Held item',
      value: `${item ? item.displayName : titleCase(row.equipped_item)} (returned to your bag)`,
    });
  }

  embed.setFooter({ text: `Type ".release ${row.party_number} yes" to confirm` });
  return { embeds: [embed] };
}

function release(userId, rawId, confirmation) {
  // Pokemon in an active battle cannot be released (see Utils/partylock.js).
  const busy = partylock.refusalFor(userId, 'release a Pokemon');
  if (busy) return { content: busy };

  const id = store.parsePartyNumber(rawId);

  if (!id) {
    return { content: 'Release which one? Try `.release 12`, using the number from `.party`.' };
  }

  const row = store.getOwnedByNumber(userId, id);
  if (!row) return { content: store.noSuchNumber(userId, id) };

  if (!CONFIRM.test(String(confirmation ?? '').trim())) return buildPreview(row);

  const held = row.equipped_item;

  // releasePokemon only matches while it is still theirs, so a release racing
  // a trade cannot act twice.
  if (!store.releasePokemon(userId, row.id)) {
    return { content: `#${id} is no longer yours to release.` };
  }

  // Releasing pays nothing, so catch-and-release can't be used to farm coins.
  if (held) store.addItem(userId, held);

  const item = held ? content.item(held) : null;

  // Recalculate quest progress. Completed quests stay completed.
  try {
    questengine.sync(userId);
  } catch (err) {
    console.error('Quest sync failed after a release:', err);
  }

  return {
    content:
      `Released ${displayName(row)}.` +
      (held ? ` The ${item ? item.displayName : titleCase(held)} went back in your bag.` : ''),
  };
}

module.exports = {
  aliases: ['release', 'r'],

  data: new SlashCommandBuilder()
    .setName('release')
    .setDescription('Lets one of your Pokemon go. Permanent.')
    .addIntegerOption((option) =>
      option.setName('id').setDescription('Its number, from /party.').setRequired(true)
    )
    .addBooleanOption((option) =>
      option.setName('confirm').setDescription('Set to true to actually release it.')
    ),

  async execute(interaction) {
    store.ensureUser(interaction.user.id);
    await interaction.reply(
      release(
        interaction.user.id,
        interaction.options.getInteger('id'),
        interaction.options.getBoolean('confirm') ? 'yes' : ''
      )
    );
  },

  async run(message, args) {
    store.ensureUser(message.author.id);
    await message.channel.send(release(message.author.id, args[0], args[1]));
  },

  release,
  buildPreview,
};
