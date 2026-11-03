'use strict';

/**
 * .bag - what you are carrying.
 *
 * Opens on everything, with:
 *
 *   Section dropdown   All items, or one of the shop's sections (Mega Stones,
 *                      Berries, TMs...) plus Other for anything the shop
 *                      doesn't sell. Sections you have nothing in are left
 *                      out, since a dropdown option can't be greyed out.
 *   Sort dropdown      shop order, A-Z, quantity or your own order. Saved, as
 *                      .inventorysort does, so the numbers shown are always
 *                      the ones .trash, .examine and .is swap use.
 *   Buttons            page back and forward
 *
 * Slot numbers count through the whole bag, so a section shows each item's
 * real slot ("12 Fire Stone" is .trash 12 from anywhere).
 *
 *   .bag [section | sort]   open on a section ("berries", "tms") or set a sort
 */

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = require('discord.js');

const store = require('../Utils/store');
const content = require('../Utils/content');
const inventory = require('../Utils/inventory');
const pager = require('../Utils/pager');
const livebuttons = require('../Utils/livebuttons');
const { foldName } = require('../Utils/names');
const { clip } = require('../Utils/display');
const inventorysort = require('./inventorysort');

const PAGE_SIZE = 20;

const COLOR = 0x9b7653;

/** How each sort mode reads. */
const SORT_LABELS = {
  shop: 'Shop order',
  alphabetical: 'A-Z',
  quantity: 'Quantity',
  custom: 'Your order',
};

const ALL = 'all';
const OTHER = 'Other';

/** An icon per shop section, for the dropdown. Unlisted sections get none. */
const SECTION_EMOJI = {
  'Mega Stones': '🧬',
  'Repels & Incenses': '🌫️',
  'Form Change': '🔄',
  'Evolution Items': '💎',
  'Special Evolution': '🌟',
  'Held Gear': '🔔',
  'Trade Items': '🔁',
  Training: '🏋️',
  'Held Items': '🎒',
  'Type Boosters': '🎯',
  Berries: '🍓',
  TMs: '💿',
  [OTHER]: '📦',
};

const CUSTOM = { section: 'bagSection', sort: 'bagSort', prev: 'bagPrev', next: 'bagNext' };

const money = (amount) => Number(amount || 0).toLocaleString('en-US');

/** The shop's sections in order, and which one each item is sold in. */
function shopSections() {
  const order = [];
  const sectionOf = new Map();

  for (const section of content.shop().sections || []) {
    order.push(section.name);
    for (const entry of section.items || []) {
      if (!sectionOf.has(entry.item)) sectionOf.set(entry.item, section.name);
    }
  }

  return { order: [...order, OTHER], sectionOf };
}

/** The bag, in the saved order, with each row's section. */
function loadBag(userId) {
  const { order, sectionOf } = shopSections();
  const rows = inventory.bagRows(userId).map((row) => ({ ...row, section: sectionOf.get(row.item) || OTHER }));

  const counts = new Map();
  for (const row of rows) counts.set(row.section, (counts.get(row.section) || 0) + 1);

  return { rows, order, counts };
}

/** "berries" -> "Berries", "tm" -> "TMs", or null. */
function parseSection(word, order) {
  const wanted = foldName(word || '');
  if (!wanted) return null;
  if (wanted === 'all') return ALL;

  return (
    order.find((name) => foldName(name) === wanted) ||
    order.find((name) => foldName(name).startsWith(wanted)) ||
    null
  );
}

/** "a-z" -> "alphabetical", or null. Same spellings as .inventorysort. */
const parseSort = (word) => inventorysort.parseMode(word);

/** One page, with its controls. */
function render(user, state, disabled = false) {
  const balance = store.getUser(user.id);
  const wallet =
    `**${money(balance ? balance.coins : 0)}** coins and ` +
    `**${money(balance ? balance.gold : 0)}** gold`;

  const { rows, order, counts } = loadBag(user.id);
  const sort = (balance && balance.bag_sort) || 'shop';

  const embed = new EmbedBuilder().setTitle(`${user.username}'s bag`).setColor(COLOR);

  if (!rows.length) {
    embed.setDescription(`${wallet}\n\nNothing yet. Have a look at \`.shop\`.`);
    return { embeds: [embed], components: [] };
  }

  // A section emptied since the last look (trashed, used up) falls back to all.
  const section = state.section === ALL || counts.has(state.section) ? state.section : ALL;
  const shown = section === ALL ? rows : rows.filter((row) => row.section === section);

  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const page = ((state.page % pages) + pages) % pages;
  const slice = shown.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const width = String(rows.length).length;

  const lines = slice.map(
    (row) =>
      `\`${String(row.slot).padStart(width, ' ')}\` **${row.displayName}** ×${row.quantity}` +
      (section === ALL ? ` (${row.section})` : '')
  );

  embed
    .setDescription(`${wallet}\n\n${section === ALL ? '' : `**${section}**\n`}${lines.join('\n')}`)
    .setFooter({
      text:
        `${shown.length} item${shown.length === 1 ? '' : 's'}` +
        (section === ALL ? '' : ` of ${rows.length}`) +
        ` · ${SORT_LABELS[sort] || sort} · Page ${page + 1}/${pages}` +
        ' · .examine <n> to read one',
    });

  const components = [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(CUSTOM.section)
        .setPlaceholder('Section')
        .setDisabled(disabled)
        .addOptions(
          { label: `All items (${rows.length})`, value: ALL, emoji: '🧺', default: section === ALL },
          ...order
            .filter((name) => counts.has(name))
            .slice(0, 24)
            .map((name) => ({
              label: clip(`${name} (${counts.get(name)})`, 100),
              value: name,
              ...(SECTION_EMOJI[name] ? { emoji: SECTION_EMOJI[name] } : {}),
              default: section === name,
            }))
        )
    ),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(CUSTOM.sort)
        .setPlaceholder('Sort')
        .setDisabled(disabled)
        .addOptions(
          Object.entries(SORT_LABELS).map(([value, label]) => ({
            label: `Sort: ${label}`,
            value,
            default: value === sort,
          }))
        )
    ),
  ];

  if (pages > 1) {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(CUSTOM.prev).setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
        new ButtonBuilder().setCustomId(CUSTOM.next).setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(disabled)
      )
    );
  }

  return { embeds: [embed], components };
}

/**
 * What a press or a pick does. A new sort is saved through .inventorysort, so
 * the two never disagree about what "your order" means.
 */
function applyPress(userId, state, customId, values = []) {
  switch (customId) {
    case CUSTOM.section:
      return { ...state, section: values[0] || ALL, page: 0 };
    case CUSTOM.sort:
      if (SORT_LABELS[values[0]]) inventorysort.sortBag(userId, [values[0]]);
      return { ...state, page: 0 };
    case CUSTOM.prev:
      return { ...state, page: state.page - 1 };
    case CUSTOM.next:
      return { ...state, page: state.page + 1 };
    default:
      return state;
  }
}

/**
 * Post the bag and keep its controls live for its owner.
 *
 * `word` may name a section ("berries") or a sort ("quantity", saved).
 */
async function show({ send, user, word }) {
  const { order } = loadBag(user.id);
  const state = { section: ALL, page: 0 };

  // Sort names first: "s" is shop order, not Special Evolution.
  const sort = parseSort(word);
  const section = sort ? null : parseSection(word, order);
  if (sort) inventorysort.sortBag(user.id, [sort]);
  else if (section) state.section = section;

  const first = render(user, state);
  const message = await send(first);
  if (!first.components.length || !message || typeof message.createMessageComponentCollector !== 'function') return;

  livebuttons.track(message, user.id);

  let current = state;
  const collector = message.createMessageComponentCollector({
    filter: (i) => i.user.id === user.id,
    idle: pager.IDLE_MS,
    time: pager.MAX_MS,
  });

  collector.on('collect', async (interaction) => {
    current = applyPress(user.id, current, interaction.customId, interaction.values || []);
    try {
      await interaction.update(render(user, current));
    } catch (err) {
      if (err.code !== 10008) console.error('Bag update failed:', err);
    }
  });

  collector.on('end', async () => {
    livebuttons.release(message);
    try {
      await message.edit(render(user, current, true));
    } catch (err) {
      if (err.code !== 10008) console.error('Bag cleanup failed:', err);
    }
  });
}

module.exports = {
  aliases: ['bag', 'inventory', 'i', 'items'],

  data: new SlashCommandBuilder()
    .setName('bag')
    .setDescription('Shows the items you own.')
    .addStringOption((option) =>
      option.setName('section').setDescription('Open on one section, like Berries or TMs.')
    )
    .addStringOption((option) =>
      option
        .setName('sort')
        .setDescription('How to order it (remembered).')
        .addChoices(...Object.entries(SORT_LABELS).map(([value, name]) => ({ name, value })))
    ),

  async execute(interaction) {
    store.ensureUser(interaction.user.id);
    const sort = interaction.options.getString('sort');
    if (sort) inventorysort.sortBag(interaction.user.id, [sort]);

    await show({
      send: pager.interactionSender(interaction),
      user: interaction.user,
      word: interaction.options.getString('section'),
    });
  },

  async run(message, args) {
    store.ensureUser(message.author.id);
    await show({ send: (payload) => message.channel.send(payload), user: message.author, word: args.join(' ') });
  },

  render,
  applyPress,
  parseSection,
  loadBag,
  PAGE_SIZE,
  SORT_LABELS,
};
