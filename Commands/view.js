'use strict';

/**
 * .view <id> - everything about one of your Pokemon.
 *
 * Shows stats, IVs, nature, moves, met data and exp progress.
 */

const fs = require('fs');
const path = require('path');

const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');

const store = require('../Utils/store');
const happiness = require('../Utils/happiness');
const { loadNatures, loadSpecies, experienceForLevel, MAX_LEVEL } = require('../Utils/pokemon');
const {
  displayName,
  typeList,
  colorFor,
  ivPercent,
  statBlock,
  titleCase,
  capitalize,
  GENDER_SYMBOLS,
} = require('../Utils/display');

const POKEMON_DIR = path.join(__dirname, '..', 'Data', 'Pokemon');

/** Find the artwork for a stored Pokemon, matching how drop.js resolves it. */
function resolveArtwork(row) {
  const formDir = path.join(POKEMON_DIR, String(row.species_id), row.form_folder);
  const dataFile = path.join(formDir, 'data.json');
  if (!fs.existsSync(dataFile)) return { url: null, file: null };

  const images = JSON.parse(fs.readFileSync(dataFile, 'utf8')).images || {};
  const order = row.shiny ? ['artworkShiny', 'artwork'] : ['artwork', 'artworkShiny'];

  for (const key of order) {
    const value = images[key];
    if (!value) continue;

    const isLocal = key === 'artwork' ? images.artworkIsLocal : images.shinyIsLocal;
    if (!isLocal) return { url: value, file: null };

    const full = path.join(formDir, value);
    if (fs.existsSync(full)) return { url: null, file: full };
  }

  return { url: null, file: null };
}

/** "August 12, 2026". Fixed to en-US so it reads the same for everyone. */
const DATE = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
});

/**
 * Where and when this Pokemon was met, and at what level.
 *
 * The met level matters because Utils/obedience.js uses it.
 *
 * Every part is optional and omitted when unknown. Some Pokemon (Shedinja,
 * admin grants) have no met data at all.
 */
function metLine(row) {
  // e.g. "Met at level 16, caught in #general on August 12, 2026."
  let line = '';

  if (row.met_level !== null && row.met_level !== undefined) {
    line = `Met at level **${row.met_level}**`;
  }

  if (row.met_channel_id) {
    line += line ? `, caught in <#${row.met_channel_id}>` : `Caught in <#${row.met_channel_id}>`;
  }

  // Use met_at only. acquired_at is not always the catch date (older imported
  // records carry the import time), so showing it would be misleading.
  if (row.met_at) {
    line += line ? ` on ${DATE.format(new Date(row.met_at))}` : `Met on ${DATE.format(new Date(row.met_at))}`;
  }

  return line ? `${line}.` : null;
}

/**
 * "17 - 1,204/2,197 to 18" plus a small bar.
 *
 * The growth rate belongs to the species, so it is looked up rather than
 * assumed.
 */
function levelField(row) {
  if (row.level >= MAX_LEVEL) return `${row.level} - fully grown`;

  const species = loadSpecies(row.species_id);
  const growth = (species && species.breeding && species.breeding.growthRate) || 'medium';

  const start = experienceForLevel(growth, row.level);
  const next = experienceForLevel(growth, row.level + 1);

  const span = Math.max(1, next - start);
  const into = Math.max(0, Math.min(span, (row.exp || 0) - start));

  const WIDTH = 10;
  const filled = Math.max(0, Math.min(WIDTH, Math.round((into / span) * WIDTH)));

  return (
    `${row.level}\n` +
    '`' + '█'.repeat(filled) + '░'.repeat(WIDTH - filled) + '`\n' +
    `${into.toLocaleString()}/${span.toLocaleString()} to ${row.level + 1}`
  );
}

function buildView(row) {
  const nature = loadNatures().find((n) => n.name === row.nature) || null;
  const gender = GENDER_SYMBOLS[row.gender] || '';

  const embed = new EmbedBuilder()
    .setTitle(`${displayName(row)}${gender ? ' ' + gender : ''}`)
    .setColor(colorFor(row))
    .addFields(
      { name: 'Level', value: levelField(row), inline: true },
      { name: 'Type', value: typeList(row).map(capitalize).join(' / ') || 'Unknown', inline: true },
      { name: 'Region', value: row.region || 'Unknown', inline: true },
      { name: 'Nature', value: nature ? nature.displayName : titleCase(row.nature), inline: true },
      { name: 'Ability', value: titleCase(row.ability) || 'None', inline: true },
      { name: 'Base Stat Total', value: String(row.bst), inline: true },
      {
        name: 'Friendship',
        value: `${happiness.describe(row.happiness)} (${row.happiness})`,
        inline: true,
      },
      { name: `Stats - IV ${ivPercent(row)}%`, value: '```\n' + statBlock(row, nature) + '\n```' }
    )
    .setFooter({
      // The global id, which never changes (unlike the per-owner party number).
      text:
        `#${row.party_number} · ID ${row.id} · ` +
        `caught by ${row.original_trainer_id === row.current_trainer_id ? 'you' : 'someone else'}` +
        (row.equipped_item ? ` · holding ${titleCase(row.equipped_item)}` : ''),
    });

  const met = metLine(row);
  if (met) embed.addFields({ name: 'Met', value: met });

  // The species name is worth showing when a nickname is hiding it.
  if (row.nickname) embed.setDescription(`*${row.display_name}*`);

  // Full-width image here; lookup commands like .dex use a thumbnail.
  const art = resolveArtwork(row);
  const files = [];

  if (art.url) {
    embed.setImage(art.url);
  } else if (art.file) {
    const fileName = `${row.form_slug}${row.shiny ? '-shiny' : ''}.png`;
    files.push(new AttachmentBuilder(art.file, { name: fileName }));
    embed.setImage(`attachment://${fileName}`);
  }

  return { embeds: [embed], files };
}

/** Resolve the argument to one of the user's Pokemon, or explain why not. */
function resolve(userId, rawId) {
  if (rawId === undefined || rawId === null || rawId === '') {
    const latest = store.latestCaught(userId);
    if (!latest) return { error: 'You have not caught anything yet. Type `.d` to drop one.' };
    return { row: latest };
  }

  const id = store.parsePartyNumber(rawId);
  if (!id) return { error: 'Give me a number, like `.view 12`.' };

  const row = store.getOwnedByNumber(userId, id);
  if (!row) return { error: store.noSuchNumber(userId, id) };

  return { row };
}

module.exports = {
  aliases: ['view', 'v', 'info'],

  data: new SlashCommandBuilder()
    .setName('view')
    .setDescription('Shows one of your Pokemon in full.')
    .addIntegerOption((option) =>
      option.setName('id').setDescription('Its number, from .party. Defaults to your newest.')
    ),

  async execute(interaction) {
    store.ensureUser(interaction.user.id);
    const { row, error } = resolve(interaction.user.id, interaction.options.getInteger('id'));

    if (error) {
      await interaction.reply({ content: error });
      return;
    }

    await interaction.reply(buildView(row));
  },

  async run(message, args) {
    store.ensureUser(message.author.id);
    const { row, error } = resolve(message.author.id, args[0]);

    if (error) {
      await message.channel.send(error);
      return;
    }

    await message.channel.send(buildView(row));
  },

  resolve,
  buildView,
  resolveArtwork,
  metLine,
};
