'use strict';

/**
 * A sectioned menu: a dropdown to jump between sections, and page buttons
 * within the current one. Used by `.shop` and `.help`.
 *
 * The caller supplies the sections and how to render each page; this module
 * handles the components, the collector and cleanup, with the same idle
 * timeout as Utils/pager.js. Only the person who opened it can use it.
 */

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = require('discord.js');

const { IDLE_MS, MAX_MS } = require('./pager');
const livebuttons = require('./livebuttons');
const { clip } = require('./display');

/** Discord's limits on a dropdown. */
const MAX_OPTIONS = 25;
const MAX_LABEL = 100;

const HOME = '__home__';

/**
 * The dropdown and, when the section has more than one page, the page
 * buttons.
 */
function buildRows({ sections, home, current, page, placeholder, disabled = false }) {
  const options = [
    ...(home ? [{ value: HOME, label: home.label, description: home.description, emoji: home.emoji }] : []),
    ...sections.map((s) => ({ value: s.id, label: s.label, description: s.description, emoji: s.emoji })),
  ]
    .slice(0, MAX_OPTIONS)
    .map((option) => ({
      value: option.value,
      label: clip(option.label, MAX_LABEL),
      ...(option.description ? { description: clip(option.description, MAX_LABEL) } : {}),
      ...(option.emoji ? { emoji: option.emoji } : {}),
      default: option.value === current,
    }));

  const rows = [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('menu:section')
        .setPlaceholder(placeholder)
        .addOptions(options)
        .setDisabled(disabled)
    ),
  ];

  const section = sections.find((s) => s.id === current);
  const pages = section ? section.pages : 1;

  // A section that names its pages (TMs by type) gets a second dropdown to
  // jump straight to one.
  const labels = section && section.pageLabels;
  if (labels && labels.length > 1 && labels.length <= MAX_OPTIONS) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('menu:jump')
          .setPlaceholder('Jump to...')
          .addOptions(
            labels.map((label, i) => ({
              value: String(i),
              label: clip(label, MAX_LABEL),
              default: i === page,
            }))
          )
          .setDisabled(disabled)
      )
    );
  }

  if (pages > 1) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('menu:prev')
          .setLabel('◀')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(disabled),
        new ButtonBuilder()
          .setCustomId('menu:page')
          .setLabel(`Page ${page + 1} of ${pages}`)
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId('menu:next')
          .setLabel('▶')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(disabled)
      )
    );
  }

  return rows;
}

/**
 * Post a menu and wire it up.
 *
 * @param {object}   options
 * @param {function} options.send         posts the payload, returns the Message
 * @param {string}   options.userId       only this user may use it
 * @param {Array<{id, label, description?, emoji?, pages, pageLabels?, render(page) => EmbedBuilder}>} options.sections
 *        `pageLabels`, when given, adds a dropdown to jump to a page by name
 * @param {{label, description?, emoji?, render() => EmbedBuilder}} [options.home]  an overview, listed first
 * @param {string}   [options.start]      section id to open on; the overview (or first section) otherwise
 * @param {string}   [options.placeholder]
 */
async function sendMenu({ send, userId, sections, home = null, start = null, placeholder = 'Choose a section' }) {
  let current = start && sections.some((s) => s.id === start) ? start : home ? HOME : sections[0].id;
  let page = 0;

  const view = () => {
    const section = sections.find((s) => s.id === current);
    return section ? section.render(page) : home.render();
  };

  const rows = (disabled = false) =>
    buildRows({ sections, home, current, page, placeholder, disabled });

  const message = await send({ embeds: [view()], components: rows() });
  if (!message || !message.createMessageComponentCollector) return message;

  const collector = message.createMessageComponentCollector({
    filter: (i) => i.user.id === userId,
    idle: IDLE_MS,
    time: MAX_MS,
  });

  livebuttons.track(message, userId);

  collector.on('collect', async (interaction) => {
    if (interaction.customId === 'menu:section') {
      current = interaction.values[0];
      page = 0;
    } else if (interaction.customId === 'menu:jump') {
      page = Number(interaction.values[0]) || 0;
    } else {
      const section = sections.find((s) => s.id === current);
      const pages = section ? section.pages : 1;
      const step = interaction.customId === 'menu:next' ? 1 : -1;
      page = (page + step + pages) % pages;
    }

    try {
      await interaction.update({ embeds: [view()], components: rows() });
    } catch (err) {
      // 10008 is "unknown message": it was deleted. Ignore.
      if (err.code !== 10008) console.error('Menu update failed:', err);
    }
  });

  collector.on('end', async () => {
    livebuttons.release(message);

    try {
      await message.edit({ components: rows(true) });
    } catch (err) {
      if (err.code !== 10008) console.error('Menu cleanup failed:', err);
    }
  });

  return message;
}

module.exports = { sendMenu, buildRows, HOME };
