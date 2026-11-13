'use strict';

/**
 * .release <slot> - let a Pokemon go.
 *
 * Releasing is permanent, so it always asks first: a card showing the Pokemon
 * (level, IVs, held item) with Release and Keep buttons. The button acts on
 * that exact Pokemon by its permanent id, so slots shifting in the meantime
 * can't make it release a different one.
 *
 * A held item is handed back rather than lost with the Pokemon.
 */

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} = require('discord.js');

const store = require('../Utils/store');
const partylock = require('../Utils/partylock');
const questengine = require('../Utils/questengine');
const content = require('../Utils/content');
const livebuttons = require('../Utils/livebuttons');
const pager = require('../Utils/pager');
const { displayName, colorFor, ivPercent, typeList, capitalize, titleCase } = require('../Utils/display');

/** How long the buttons wait for an answer. */
const CONFIRM_MS = 60_000;

const YES = 'release:yes';
const NO = 'release:no';

/** "✨Pikachu Lv.36, IV 61%" */
const brief = (row) => `**${displayName(row)}** Lv.${row.level}, IV ${ivPercent(row)}%`;

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

  embed.setFooter({ text: `Slot ${row.party_number}` });

  return {
    content: `Release ${brief(row)}?`,
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(YES).setLabel('Release').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(NO).setLabel('Keep it').setStyle(ButtonStyle.Secondary)
      ),
    ],
  };
}

/**
 * Find the Pokemon and build the question, or explain why not.
 *
 * @returns {{ row?: object, payload: object }}
 */
function ask(userId, rawId) {
  // Pokemon in an active battle cannot be released (see Utils/partylock.js).
  const busy = partylock.refusalFor(userId, 'release a Pokemon');
  if (busy) return { payload: { content: busy } };

  const id = store.parsePartyNumber(rawId);

  if (!id) {
    return { payload: { content: 'Release which one? Try `.release 12`, using the number from `.party`.' } };
  }

  const row = store.getOwnedByNumber(userId, id);
  if (!row) return { payload: { content: store.noSuchNumber(userId, id) } };

  return { row, payload: buildPreview(row) };
}

/**
 * Let go of this exact Pokemon (by its permanent id) and say what happened.
 * Checked again here, because a battle or trade may have started since the
 * question was asked.
 */
function release(userId, row) {
  const busy = partylock.refusalFor(userId, 'release a Pokemon');
  if (busy) return busy;

  const held = row.equipped_item;

  // releasePokemon only matches while it is still theirs, so a release racing
  // a trade cannot act twice.
  if (!store.releasePokemon(userId, row.id)) {
    return `${displayName(row)} is no longer yours to release.`;
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

  return (
    `Released ${brief(row)}.` +
    (held ? ` The ${item ? item.displayName : titleCase(held)} went back in your bag.` : '')
  );
}

/** Ask, wait for a button, then release or keep it. */
async function askThenRelease({ send, userId, rawId }) {
  const { row, payload } = ask(userId, rawId);
  const prompt = await send(payload);
  if (!row || !prompt || typeof prompt.awaitMessageComponent !== 'function') return;

  livebuttons.track(prompt, userId);

  let choice;
  try {
    choice = await livebuttons.answered(await prompt.awaitMessageComponent({
      componentType: ComponentType.Button,
      time: CONFIRM_MS,
      filter: (button) => button.user.id === userId,
    }));
  } catch {
    // Timed out: nothing happens.
    livebuttons.release(prompt);
    await prompt.edit({ content: `Kept ${brief(row)}. No answer, so nothing was released.`, components: [] }).catch(() => {});
    return;
  }

  livebuttons.release(prompt);

  const text = choice.customId === YES ? release(userId, row) : `Kept ${brief(row)}.`;
  await choice.update({ content: text, embeds: [], components: [] }).catch(() => {});
}

module.exports = {
  aliases: ['release', 'r'],

  data: new SlashCommandBuilder()
    .setName('release')
    .setDescription('Lets one of your Pokemon go. Permanent; asks first.')
    .addIntegerOption((option) =>
      option.setName('id').setDescription('Its slot, from /party.').setRequired(true)
    ),

  async execute(interaction) {
    store.ensureUser(interaction.user.id);
    await askThenRelease({
      send: pager.interactionSender(interaction),
      userId: interaction.user.id,
      rawId: interaction.options.getInteger('id'),
    });
  },

  async run(message, args) {
    store.ensureUser(message.author.id);
    await askThenRelease({
      send: (payload) => message.channel.send(payload),
      userId: message.author.id,
      rawId: args[0],
    });
  },

  ask,
  release,
  buildPreview,
};
