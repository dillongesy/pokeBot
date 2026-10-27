'use strict';

/**
 * .dex <name or number> - look anything up, owned or not.
 *
 * Reads Data/Pokemon directly, so it covers all 1,025 species and every form,
 * including the ones that never drop.
 *
 *   .dex pikachu
 *   .dex 25
 *   .dex ninetales alola     a specific form
 *   .dex pikachu shiny       the other artwork
 *
 * The card is interactive: ◀ ▶ step through the dex, ✨ toggles shiny artwork,
 * and a dropdown switches forms. All of them edit the same message.
 */

const fs = require('fs');
const path = require('path');

const {
  SlashCommandBuilder,
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = require('discord.js');

const store = require('../Utils/store');
const pager = require('../Utils/pager');
const livebuttons = require('../Utils/livebuttons');
const { normaliseName, loadSpecies, loadForm, evolutionTier } = require('../Utils/pokemon');
const { TYPE_COLORS, SHINY_COLOR, GENDER_SYMBOLS, capitalize, titleCase, fitLines, clip, LIMITS } = require('../Utils/display');

const POKEMON_DIR = path.join(__dirname, '..', 'Data', 'Pokemon');

let indexCache = null;
function index() {
  if (!indexCache) {
    indexCache = JSON.parse(fs.readFileSync(path.join(POKEMON_DIR, 'index.json'), 'utf8'));
  }
  return indexCache;
}

/**
 * Find a species, and optionally one of its forms.
 *
 * The whole query is tried as a form name first, so ".dex ninetales alola"
 * finds the Alolan form.
 */
function find(query) {
  const words = String(query || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;

  const key = normaliseName(words.join(''));
  const data = index();

  // A form slug matches the whole query: "ninetales alola" -> ninetales-alola.
  const form = data.forms.find((f) => normaliseName(f.slug) === key);
  if (form) {
    return { speciesId: form.speciesId, formFolder: form.folder };
  }

  // Otherwise the leading words are the species and the rest is the form.
  for (let take = words.length; take > 0; take -= 1) {
    const speciesKey = normaliseName(words.slice(0, take).join(''));
    const species =
      data.species.find((s) => normaliseName(s.name) === speciesKey) ||
      data.species.find((s) => String(s.id) === speciesKey);

    if (!species) continue;

    const rest = words.slice(take).join(' ').toLowerCase();
    const forms = data.forms.filter((f) => f.speciesId === species.id);
    const wanted = rest
      ? forms.find((f) => f.folder.toLowerCase() === rest)
      : forms.find((f) => f.isDefault) || forms[0];

    if (!wanted) {
      return {
        speciesId: species.id,
        error: `${species.displayName} has no form called "${rest}". It has: ${forms
          .map((f) => f.folder)
          .join(', ')}.`,
      };
    }

    return { speciesId: species.id, formFolder: wanted.folder };
  }

  return null;
}

/** Artwork for a form, either a CDN url or a file to attach. */
function artwork(speciesId, formFolder, shiny) {
  const dir = path.join(POKEMON_DIR, String(speciesId), formFolder);
  const file = path.join(dir, 'data.json');
  if (!fs.existsSync(file)) return { url: null, file: null };

  const images = JSON.parse(fs.readFileSync(file, 'utf8')).images || {};
  const order = shiny ? ['artworkShiny', 'artwork'] : ['artwork', 'artworkShiny'];

  for (const key of order) {
    const value = images[key];
    if (!value) continue;
    const isLocal = key === 'artwork' ? images.artworkIsLocal : images.shinyIsLocal;
    if (!isLocal) return { url: value, file: null };
    const full = path.join(dir, value);
    if (fs.existsSync(full)) return { url: null, file: full };
  }

  return { url: null, file: null };
}

const STAT_ROWS = [
  ['hp', 'HP'],
  ['attack', 'Attack'],
  ['defense', 'Defense'],
  ['specialAttack', 'Sp. Atk'],
  ['specialDefense', 'Sp. Def'],
  ['speed', 'Speed'],
];

/** A small bar for comparing base stats. */
function statBars(base) {
  return STAT_ROWS.map(([key, label]) => {
    const value = base[key] || 0;
    const filled = Math.max(1, Math.round((Math.min(value, 200) / 200) * 18));
    return `${label.padEnd(7)} ${String(value).padStart(3)} ${'█'.repeat(filled)}`;
  }).join('\n');
}

/**
 * Render one card from an already-resolved state.
 *
 * Takes a resolved { speciesId, formFolder, shiny } state rather than a query,
 * because button presses have no text to parse.
 */
function renderCard(userId, state) {
  const found = { speciesId: state.speciesId, formFolder: state.formFolder };
  const shiny = !!state.shiny;

  const species = loadSpecies(found.speciesId);
  const form = loadForm(found.speciesId, found.formFolder);
  if (!species || !form) return { content: 'No data for that form.' };

  const data = index();
  const forms = data.forms.filter((f) => f.speciesId === species.id);
  const entry = forms.find((f) => f.folder === found.formFolder);

  const embed = new EmbedBuilder()
    .setTitle(`#${String(species.dex.national).padStart(4, '0')} ${form.displayName}${shiny ? ' ✨' : ''}`)
    .setColor(shiny ? SHINY_COLOR : TYPE_COLORS[form.types[0]] ?? 0x888888)
    .addFields(
      { name: 'Type', value: form.types.map(capitalize).join(' / '), inline: true },
      { name: 'Region', value: form.region || species.region || 'Unknown', inline: true },
      // "generation-vii" -> "Gen VII" (titleCase would give "Gen vii").
      {
        name: 'Generation',
        value: `Gen ${String(species.generation).replace('generation-', '').toUpperCase()}`,
        inline: true,
      }
    );

  if (species.genus) embed.setDescription(`*The ${species.genus}*`);

  embed.addFields({
    name: `Base stats - ${form.stats.total} total`,
    value: '```\n' + statBars(form.stats.base) + '\n```',
  });

  embed.addFields(
    {
      name: 'Abilities',
      value:
        (form.abilities || [])
          .map((a) => `${a.displayName}${a.isHidden ? ' *(hidden)*' : ''}`)
          .join('\n') || 'None',
      inline: true,
    },
    {
      name: 'Size',
      value: `${form.physical.heightMeters} m\n${form.physical.weightKilograms} kg`,
      inline: true,
    },
    {
      name: 'Gender',
      value: species.gender.genderless
        ? 'Genderless'
        : `${species.gender.malePercent}% ${GENDER_SYMBOLS.male}` +
          ` / ${species.gender.femalePercent}% ${GENDER_SYMBOLS.female}`,
      inline: true,
    }
  );

  // The evolution line, marking where this one sits.
  const chain = (species.evolution || {}).chain || [];
  if (chain.length > 1) {
    embed.addFields({
      name: 'Evolution',
      value: chain
        .map((link) => (link.id === species.id ? `**${link.displayName}**` : link.displayName))
        .join(' → '),
    });
  }

  // How many the viewer owns, of the species and of this specific form.
  // Counted in SQL since parties can be very large.
  const owned = userId ? store.countOwned(userId, species.id) : { total: 0, byForm: new Map() };
  const ownedForm = owned.byForm.get(found.formFolder) || 0;

  embed.addFields({
    name: 'Owned',
    value:
      `**${owned.total.toLocaleString('en-US')}** total` +
      (forms.length > 1 ? `\n**${ownedForm.toLocaleString('en-US')}** of this form` : ''),
    inline: true,
  });

  // Other forms, whether they can drop, and how many of each you have.
  if (forms.length > 1) {
    embed.addFields({
      name: `Forms (${forms.length})`,
      value: fitLines(
        forms.map((f) => {
          const mark = f.folder === found.formFolder ? '**' : '';
          const rate = f.percentage > 0 ? `${f.percentage}%` : 'no drop';
          const have = owned.byForm.get(f.folder) || 0;
          return `${mark}${f.folder}${mark} - ${rate}${have ? ` (you have ${have})` : ''}`;
        })
      ),
    });
  }

  const rarity = [];
  if (species.rarity.isLegendary) rarity.push('Legendary');
  if (species.rarity.isMythical) rarity.push('Mythical');
  if (species.rarity.isUltraBeast) rarity.push('Ultra Beast');
  if (species.rarity.isBaby) rarity.push('Baby');
  if (species.rarity.isParadox) rarity.push('Paradox');
  if (species.rarity.isPseudoLegendary) rarity.push('Pseudo-legendary');

  embed.setFooter({
    text:
      [
        rarity.length ? rarity.join(', ') : evolutionTier(species) === 'final' ? 'Fully evolved' : 'Evolves',
        `${entry && entry.percentage > 0 ? `drops ${entry.percentage}%` : 'never drops'}`,
        // Show both counts so it's clear which one is which.
        owned.total
          ? `you own ${ownedForm} of this form, ${owned.total} across all forms`
          : 'you own none of any form',
      ].join('. '),
  });

  const art = artwork(found.speciesId, found.formFolder, shiny);
  const files = [];

  if (art.url) {
    embed.setThumbnail(art.url);
  } else if (art.file) {
    const name = `${entry ? entry.slug : 'pokemon'}${shiny ? '-shiny' : ''}.png`;
    files.push(new AttachmentBuilder(art.file, { name }));
    embed.setThumbnail(`attachment://${name}`);
  }

  return { embeds: [embed], files };
}

// ---------------------------------------------------------------------------
// The interactive shell
// ---------------------------------------------------------------------------

/** How long the buttons stay active after the last press, and at most (see Utils/pager.js). */
const { IDLE_MS, MAX_MS } = pager;

/** Discord's limit on dropdown options. */
const MAX_FORM_OPTIONS = 25;

const CUSTOM = { prev: 'dexPrev', next: 'dexNext', shiny: 'dexShiny', form: 'dexForm' };

/** The default form of a species, used when stepping with ◀ and ▶. */
function defaultFormOf(speciesId) {
  const forms = index().forms.filter((f) => f.speciesId === speciesId);
  const wanted = forms.find((f) => f.isDefault) || forms[0];
  return wanted ? wanted.folder : null;
}

/**
 * Walk to the next or previous species that actually has data.
 *
 * Wraps at both ends. Loops because the index may have gaps.
 */
function step(speciesId, delta) {
  const ids = index().species.map((s) => s.id).sort((a, b) => a - b);
  const at = ids.indexOf(speciesId);
  if (at < 0) return ids[0];
  return ids[(at + delta + ids.length) % ids.length];
}

/** The buttons and, if the species has more than one, the form dropdown. */
function buildComponents(state, disabled = false) {
  const forms = index().forms.filter((f) => f.speciesId === state.speciesId);
  const prev = step(state.speciesId, -1);
  const next = step(state.speciesId, 1);

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CUSTOM.prev)
      .setLabel(`◀ #${prev}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(CUSTOM.shiny)
      .setLabel(state.shiny ? '✨ Shiny' : '✨ Normal')
      .setStyle(state.shiny ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(CUSTOM.next)
      .setLabel(`#${next} ▶`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled)
  );

  if (forms.length < 2) return [buttons];

  // Some species have more than 25 forms (Alcremie has 63), so show a window
  // around the current form.
  let shown = forms;
  if (forms.length > MAX_FORM_OPTIONS) {
    const at = Math.max(0, forms.findIndex((f) => f.folder === state.formFolder));
    const from = Math.min(Math.max(0, at - Math.floor(MAX_FORM_OPTIONS / 2)), forms.length - MAX_FORM_OPTIONS);
    shown = forms.slice(from, from + MAX_FORM_OPTIONS);
  }

  const menu = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(CUSTOM.form)
      .setPlaceholder(clip(`Forms - showing ${state.formFolder}`, 150))
      .setDisabled(disabled)
      .addOptions(
        shown.map((f) => ({
          label: clip(f.folder, 100),
          value: clip(f.folder, 100),
          description: clip(f.percentage > 0 ? `drops ${f.percentage}%` : 'never drops', 100),
          default: f.folder === state.formFolder,
        }))
      )
  );

  return [buttons, menu];
}

/** What a press does to the state. Returns a new one rather than mutating. */
function applyPress(state, customId, values = []) {
  if (customId === CUSTOM.shiny) return { ...state, shiny: !state.shiny };

  if (customId === CUSTOM.prev || customId === CUSTOM.next) {
    const speciesId = step(state.speciesId, customId === CUSTOM.next ? 1 : -1);
    // Changing species resets the form but keeps the shiny toggle.
    return { speciesId, formFolder: defaultFormOf(speciesId), shiny: state.shiny };
  }

  // Validate the form, since renderCard trusts the state.
  if (customId === CUSTOM.form && values[0]) {
    const has = index().forms.some(
      (f) => f.speciesId === state.speciesId && f.folder === values[0]
    );
    if (has) return { ...state, formFolder: values[0] };
  }

  return state;
}

/**
 * Resolve a query to a starting state, or explain why not.
 *
 * @returns {{ state?: object, error?: string }}
 */
function resolve(query, shiny = false) {
  const found = find(query);
  if (!found) return { error: `Nothing called "${query}" in the dex.` };
  if (found.error) return { error: found.error };

  return { state: { speciesId: found.speciesId, formFolder: found.formFolder, shiny } };
}

/**
 * The whole command: resolve, post, then keep editing the same message.
 *
 * `send` posts the first payload and returns the Message, as in Utils/pager.js.
 */
async function sendDex({ send, userId, query, shiny = false }) {
  const { state: initial, error } = resolve(query, shiny);
  if (error) return send({ content: error });

  let state = initial;

  const payload = renderCard(userId, state);
  if (payload.content) return send(payload);

  const message = await send({ ...payload, components: buildComponents(state) });
  if (!message || !message.createMessageComponentCollector) return message;

  const collector = message.createMessageComponentCollector({
    filter: (i) => i.user.id === userId,
    idle: IDLE_MS,
    time: MAX_MS,
  });

  livebuttons.track(message, userId);

  collector.on('collect', async (interaction) => {
    state = applyPress(state, interaction.customId, interaction.values || []);

    try {
      const next = renderCard(userId, state);

      // Artwork may be an attachment, which an edit drops unless the files
      // are resent, so always resend them and clear the old ones.
      await interaction.update({
        embeds: next.embeds,
        files: next.files || [],
        attachments: [],
        components: buildComponents(state),
      });
    } catch (err) {
      if (err.code !== 10008) console.error('Dex update failed:', err);
    }
  });

  collector.on('end', async () => {
    livebuttons.release(message);

    try {
      await message.edit({ components: buildComponents(state, true) });
    } catch (err) {
      if (err.code !== 10008) console.error('Dex cleanup failed:', err);
    }
  });

  return message;
}

/** A static (non-interactive) card payload. */
function buildDex(userId, query, shiny = false) {
  const { state, error } = resolve(query, shiny);
  if (error) return { content: error };
  return renderCard(userId, state);
}

module.exports = {
  aliases: ['dex', 'pokedex', 'lookup'],

  data: new SlashCommandBuilder()
    .setName('dex')
    .setDescription('Looks up any Pokemon.')
    .addStringOption((option) =>
      option.setName('pokemon').setDescription('A name, a dex number, or "ninetales alola".').setRequired(true)
    )
    .addBooleanOption((option) =>
      option.setName('shiny').setDescription('Show the shiny artwork.')
    ),

  async execute(interaction) {
    store.ensureUser(interaction.user.id);

    await sendDex({
      send: pager.interactionSender(interaction),
      userId: interaction.user.id,
      query: interaction.options.getString('pokemon'),
      shiny: interaction.options.getBoolean('shiny') || false,
    });
  },

  async run(message, args) {
    if (!args.length) {
      await message.channel.send('Look up what? Try `.dex pikachu` or `.dex 25`.');
      return;
    }

    store.ensureUser(message.author.id);

    // A trailing "shiny" asks for the other artwork.
    const shiny = /^shiny$/i.test(args[args.length - 1]);
    const query = (shiny ? args.slice(0, -1) : args).join(' ');

    await sendDex({
      send: (payload) => message.channel.send(payload),
      userId: message.author.id,
      query,
      shiny,
    });
  },

  find,
  buildDex,
  renderCard,
  resolve,
  sendDex,
  applyPress,
  buildComponents,
  step,
  defaultFormOf,
  CUSTOM,
};
