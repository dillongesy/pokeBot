'use strict';

/**
 * .shop - what there is to buy.
 *
 * Two shops share this command. The coin shop sells items from Data/Items; the
 * gold shop sells buffs, paid for with gold earned from quests.
 *
 *   .shop                  an overview, with a menu of every section
 *   .shop gold             opens on the gold shop
 *   .shop <section>        opens on that section (e.g. .shop mega)
 *   .shop <pokemonName>    everything that does something to that species
 *
 * The menu (Utils/menu.js) has a dropdown to jump between sections and page
 * buttons within one.
 *
 * The species view is derived from the evolution and Mega data, so it stays in
 * sync with the shop automatically.
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const store = require('../Utils/store');
const content = require('../Utils/content');
const pager = require('../Utils/pager');
const menu = require('../Utils/menu');
const { describeItem } = require('./examine');
const names = require('../Utils/names');
const evolution = require('../Utils/evolution');
const itemRules = require('../Utils/items');
const { titleCase, fitLines, capFields, clip, LIMITS } = require('../Utils/display');

const money = (amount) => amount.toLocaleString('en-US');

/** Hours as something readable: 24 -> "24h", null -> "permanent". */
const duration = (hours) => (hours == null ? 'permanent' : `${hours}h`);

/** Maximum length of an item's effect line. */
const EFFECT_CHARS = 96;

/**
 * Shorten text that may contain `code`, never leaving a code span open.
 *
 * A cut inside "`.take`" leaves a stray backtick that swallows the formatting
 * of everything after it on the page, so cut before the half-open span.
 */
function clipMarkdown(text, limit) {
  const cut = clip(text, limit);
  if ((cut.match(/`/g) || []).length % 2 === 0) return cut;

  return `${cut.slice(0, cut.lastIndexOf('`')).trimEnd()}…`;
}

/**
 * One shop item. The price is right-aligned in a code span so prices line up,
 * followed by the name, the effect and the buy command:
 *
 *   `  3,000` **Fire Stone**
 *   Evolves an Eevee into Flareon…
 *   `.buy fire-stone`
 *
 * @param {number} width  how wide the price column is, for this page
 */
function itemLine(entry, width, coins) {
  const item = content.item(entry.item);
  const name = item ? item.displayName : titleCase(entry.item);

  const price = money(entry.price);
  const affordable = coins >= entry.price;

  // Bold the prices the player can afford.
  const shown = `\`${price.padStart(width)}\``;

  // Use PokeAPI's short effect where available; otherwise fall back to the
  // .examine description (Mega Stones have no PokeAPI text).
  const blurb = (item && item.shortEffect) || describeItem(entry.item);
  const effect = blurb ? clipMarkdown(blurb, EFFECT_CHARS) : null;

  return (
    `${shown} ${affordable ? '**' + name + '**' : name}\n` +
    `${effect ? effect + '\n' : ''}\`.buy ${entry.item}\``
  );
}

/**
 * How many items fit on one page.
 *
 * Discord allows 4,096 characters in a description and an item takes about
 * 110. Ten keeps a page short enough to scan.
 */
const PAGE_SIZE = 10;

/** A picture for each section in the dropdown. Sections not listed get none. */
const SECTION_EMOJI = {
  'Mega Stones': '💎',
  'Repels & Incenses': '🌿',
  'Form Change': '🔄',
  'Evolution Items': '🌟',
  'Special Evolution': '✨',
  'Held Gear': '🪨',
  'Trade Items': '🤝',
  Training: '💪',
  'Held Items': '🎒',
  'Type Boosters': '🔥',
  Berries: '🍓',
  TMs: '💿',
};

const GOLD = 'gold';

/** The most TMs of one type on a page; Normal and Psychic run over. */
const TMS_PER_PAGE = 25;

/**
 * A section split into pages: `{ items, label }` each.
 *
 * TMs get a page per type (split where a type is too long), labelled so the
 * menu can offer a jump-to-type dropdown. Everything else is cut into
 * PAGE_SIZE pieces with no labels.
 */
function pagesOf(section) {
  const items = section.items || [];

  if (section.name !== 'TMs') {
    const pages = [];
    for (let i = 0; i < Math.max(1, items.length); i += PAGE_SIZE) {
      pages.push({ items: items.slice(i, i + PAGE_SIZE), label: null });
    }
    return pages;
  }

  const byType = new Map();
  for (const entry of items) {
    const move = content.move(entry.item.replace(/^tm-/, ''));
    const type = move ? titleCase(move.type) : 'Other';
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push(entry);
  }

  const pages = [];
  for (const [type, list] of [...byType].sort((a, b) => a[0].localeCompare(b[0]))) {
    const parts = Math.ceil(list.length / TMS_PER_PAGE);
    for (let i = 0; i < parts; i += 1) {
      pages.push({
        items: list.slice(i * TMS_PER_PAGE, (i + 1) * TMS_PER_PAGE),
        label: parts > 1 ? `${type} (${i + 1}/${parts})` : type,
      });
    }
  }
  return pages;
}

/** Section ids for the menu: the name, lowercased and dashed. */
const sectionId = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

/** A section description as plain text for the dropdown (no markdown). */
const plain = (text) => String(text || '').replace(/[`*_]/g, '');

/**
 * The coin shop and gold shop as a menu: an overview, a dropdown of sections
 * and page buttons within each (see Utils/menu.js).
 *
 * @param {string|null} startSection  a coin shop section name, or 'gold'
 */
function buildShop(user, startSection = null) {
  const shopSections = (content.shop().sections || []).filter((s) => (s.items || []).length);
  const balance = store.getUser(user.id);
  const coins = balance ? balance.coins : 0;

  const sections = shopSections.map((section) => {
    const items = section.items || [];
    const chunks = pagesOf(section);
    const affordable = items.filter((e) => coins >= e.price).length;

    return {
      id: sectionId(section.name),
      label: section.name,
      emoji: SECTION_EMOJI[section.name],
      description: `${items.length} item${items.length === 1 ? '' : 's'}` +
        (section.description ? `. ${plain(section.description)}` : ''),
      pages: chunks.length,
      pageLabels: chunks.every((c) => c.label) ? chunks.map((c) => c.label) : null,
      render: (page) => {
        const { items: slice, label } = chunks[page];

        // Size the price column per page.
        const width = Math.max(...slice.map((e) => money(e.price).length));

        return new EmbedBuilder()
          .setTitle(
            `${SECTION_EMOJI[section.name] ? `${SECTION_EMOJI[section.name]} ` : ''}${section.name}` +
              (label ? `: ${label}` : '')
          )
          .setColor(0xf7d02c)
          .setDescription(
            // The section blurb on its first page only.
            (section.description && page === 0 ? `*${section.description}*\n\n` : '') +
              slice.map((entry) => itemLine(entry, width, coins)).join('\n\n')
          )
          .setFooter({
            text: `You have ${money(coins)} coins. ${affordable} of ${items.length} here are affordable.`,
          });
      },
    };
  });

  sections.push({
    id: GOLD,
    label: 'Gold Shop',
    emoji: '🪙',
    description: 'Permanent buffs, bought with gold from quests.',
    pages: 1,
    render: () => buildGoldShop(user).embeds[0],
  });

  const home = {
    label: 'Overview',
    emoji: '🏪',
    description: 'Your coins and every section.',
    render: () =>
      new EmbedBuilder()
        .setTitle('🏪 Shop')
        .setColor(0xf7d02c)
        .setDescription(
          `You have **${money(coins)}** coins and **${money(balance ? balance.gold : 0)}** gold.\n\n` +
            'Pick a section from the menu below. Buy with `.buy <item>`, and use ' +
            '`.shop <pokemon>` to see everything that works on one species.'
        )
        .addFields({
          name: 'Sections',
          value: fitLines(
            shopSections.map(
              (s) => `${SECTION_EMOJI[s.name] || '•'} **${s.name}** - ${s.items.length} item${s.items.length === 1 ? '' : 's'}`
            ).concat('🪙 **Gold Shop** - buffs for quest gold')
          ),
        }),
  };

  const start = startSection === GOLD ? GOLD : startSection ? sectionId(startSection) : null;

  return { menu: { sections, home, start, placeholder: 'Browse a section' } };
}

/** The gold shop. Each buff gets its own line, since they need explaining. */
function buildGoldShop(user) {
  const goldShop = content.goldShop();
  const balance = store.getUser(user.id);

  const embed = new EmbedBuilder()
    .setTitle('Gold Shop')
    .setColor(0xffd700)
    .setDescription(
      `You have **${money(balance ? balance.gold : 0)}** gold.\n` +
        'Gold comes from finishing quests. Buy with `.buy <id>`.'
    );

  for (const entry of goldShop.items || []) {
    embed.addFields({
      name: clip(`${entry.name} - ${money(entry.price)} gold`, LIMITS.fieldName),
      value: clip(
        `\`${entry.id}\`, lasts ${duration(entry.durationHours)}\n${entry.description}`,
        LIMITS.fieldValue
      ),
    });
  }

  embed.setFields(capFields(embed.data.fields || []));
  return { embeds: [embed] };
}

/** Find a section by name, or by any prefix of it. ".shop mega" lands here. */
function findSection(query) {
  const wanted = String(query).toLowerCase();

  return (
    (content.shop().sections || []).find(
      (s) => s.name.toLowerCase() === wanted || s.name.toLowerCase().startsWith(wanted)
    ) || null
  );
}

/**
 * The shop menu, opened on a named section.
 */
function buildSection(user, query) {
  const section = findSection(query);
  if (!section) return null;

  return buildShop(user, section.name);
}

// ---------------------------------------------------------------------------
// .shop <pokemonName>
// ---------------------------------------------------------------------------

/**
 * Every shop entry that does something to one species, with why.
 *
 * Derived from three sources:
 *
 *   - Utils/items.megaStones(), for its Mega Stone
 *   - the species' evolution links, for evolution items and trade held items
 *   - the shop's own `define` blocks, for items PokeAPI lacks (Dragon Ascent)
 *
 * Only items the shop actually sells are included.
 *
 * @returns {object[]} { item, price, section, why }
 */
function itemsForSpecies(species) {
  const found = new Map();

  // What the shop actually stocks, so nothing unbuyable is offered.
  const stocked = new Map();
  for (const section of content.shop().sections || []) {
    for (const entry of section.items || []) {
      stocked.set(entry.item, { price: entry.price, section: section.name, define: entry.define });
    }
  }

  const add = (slug, why) => {
    const entry = stocked.get(slug);
    if (!entry || found.has(slug)) return;
    found.set(slug, { item: slug, price: entry.price, section: entry.section, why });
  };

  // 1. Mega Stones (Charizard has two).
  for (const [slug, mega] of itemRules.megaStones()) {
    if (mega.speciesId === species.id) add(slug, `Mega Evolves it into ${titleCase(mega.form)}`);
  }

  // Dragon Ascent and anything else the shop defines itself names its species.
  for (const [slug, entry] of stocked) {
    const effect = entry.define && entry.define.effect;
    if (!effect) continue;

    if (effect.speciesId === species.id) {
      add(slug, entry.define.shortEffect || 'Changes its form');
      continue;
    }

    // Family items (Dynamax Band, Reveal Glass) name a form; include them if
    // this species has that form.
    if (effect.kind === 'form' && effect.speciesId === null && effect.form) {
      const target = itemRules.familyFormFor(
        { species_id: species.id, form_folder: null },
        effect.form
      );
      if (target) add(slug, `Changes it into its ${target} form`);
    }
  }

  // 2. What it evolves with, read off its own evolution links.
  for (const link of evolution.optionsFrom(species.id)) {
    const into = titleCase(link.name || link.species || 'something');

    for (const condition of link.conditions || []) {
      if (condition.trigger === 'use-item' && condition.item) {
        add(condition.item, `Evolves it into ${into}`);
      }
      if (condition.trigger === 'trade' && condition.heldItem) {
        add(condition.heldItem, `Hold it and trade to get ${into}`);
      }
    }
  }

  // Milcery's Sweets and Gimmighoul's coins use triggers with no item ("spin",
  // "gimmighoul-coins"), so match on the trigger, as Utils/evolution.js does.
  const links = evolution.optionsFrom(species.id);
  const triggers = new Set(
    links.flatMap((link) => (link.conditions || []).map((c) => c.trigger))
  );

  if (triggers.has('spin')) {
    for (const [sweet, label] of Object.entries(evolution.SPIN_SWEETS)) {
      add(sweet, `Spin with it to get the ${label} form`);
    }
  }

  if (triggers.has('gimmighoul-coins')) {
    add(
      evolution.COIN_EVOLUTION.item,
      `${evolution.COIN_EVOLUTION.quantity.toLocaleString('en-US')} of them evolve it`
    );
  }

  // 3. The Everstone, for species that can evolve.
  if (links.length) add('everstone', 'Hold it to stop it evolving');

  return [...found.values()];
}

/** ".shop pikachu" - everything that does something to one species. */
function buildForSpecies(user, species) {
  const balance = store.getUser(user.id);
  const entries = itemsForSpecies(species);

  const embed = new EmbedBuilder()
    .setTitle(`Shop - for ${species.displayName}`)
    .setColor(0xf7d02c)
    .setDescription(
      `You have **${money(balance ? balance.coins : 0)}** coins.\n` +
        (entries.length
          ? `**${entries.length}** thing${entries.length === 1 ? '' : 's'} here do${entries.length === 1 ? 'es' : ''} something to it.`
          : `Nothing in the shop does anything to ${species.displayName} specifically.`)
    );

  for (const entry of entries) {
    const item = content.item(entry.item);
    embed.addFields({
      name: clip(
        `${item ? item.displayName : titleCase(entry.item)} - ${money(entry.price)}`,
        LIMITS.fieldName
      ),
      value: clip(`\`${entry.item}\`\n${entry.why} *(${entry.section})*`, LIMITS.fieldValue),
    });
  }

  embed.setFields(capFields(embed.data.fields || []));

  // Rare Candy and vitamins work on everything, so mention them in a footnote.
  embed.setFooter({
    text: 'Rare Candy and the vitamins work on anything. See .shop training.',
  });

  return { embeds: [embed] };
}

/**
 * Post whatever render() returned. The shop is a menu; a species view or an
 * error is a single message.
 */
async function post(send, userId, built) {
  if (built.content || built.embeds) return send(built);

  return menu.sendMenu({ send, userId, ...built.menu });
}

/**
 * Work out what ".shop <something>" meant: gold shop, a section, or a species.
 * A section name takes priority over a species name.
 */
function render(user, args) {
  const query = args.join(' ').trim();
  const first = (args[0] || '').toLowerCase();

  if (!query) return buildShop(user);
  if (first === 'gold' || first === 'goldshop') return buildShop(user, GOLD);

  const section = buildSection(user, query);
  if (section) return section;

  const species = names.resolveOne(query);
  if (species) return buildForSpecies(user, species);

  const sections = (content.shop().sections || []).map((s) => s.name).join(', ');
  return {
    content:
      `"${query}" is not a shop section or a Pokemon. Sections: ${sections}. ` +
      'Or try `.shop gold`.',
  };
}

module.exports = {
  aliases: ['shop', 's', 'store'],

  data: new SlashCommandBuilder()
    .setName('shop')
    .setDescription('Shows what there is to buy.')
    .addStringOption((option) =>
      option
        .setName('section')
        .setDescription('A section name, a Pokemon, or "gold" for the gold shop.')
    ),

  async execute(interaction) {
    store.ensureUser(interaction.user.id);
    const section = interaction.options.getString('section');

    await post(
      pager.interactionSender(interaction),
      interaction.user.id,
      render(interaction.user, section ? [section] : [])
    );
  },

  async run(message, args) {
    store.ensureUser(message.author.id);

    await post(
      (payload) => message.channel.send(payload),
      message.author.id,
      render(message.author, args)
    );
  },

  buildShop,
  buildGoldShop,
  buildSection,
  buildForSpecies,
  itemsForSpecies,
  findSection,
  itemLine,
  render,
};
