'use strict';

/**
 * Turning database rows into things people read.
 *
 * A `pokemon` row is flat and snake_cased; everything here exists so commands
 * do not each invent their own way of rendering one.
 */

const { STATS, MAX_IV } = require('./pokemon');

const TYPE_COLORS = {
  normal: 0xa8a77a,
  fire: 0xee8130,
  water: 0x6390f0,
  electric: 0xf7d02c,
  grass: 0x7ac74c,
  ice: 0x96d9d6,
  fighting: 0xc22e28,
  poison: 0xa33ea1,
  ground: 0xe2bf65,
  flying: 0xa98ff3,
  psychic: 0xf95587,
  bug: 0xa6b91a,
  rock: 0xb6a136,
  ghost: 0x735797,
  dragon: 0x6f35fc,
  dark: 0x705746,
  steel: 0xb7b7ce,
  fairy: 0xd685ad,
};

const SHINY_COLOR = 0xffd700;

/** The stat labels, in game order, matching the row's stat_ and iv_ columns. */
const STAT_LABELS = [
  ['hp', 'HP'],
  ['attack', 'Attack'],
  ['defense', 'Defense'],
  ['special_attack', 'Sp. Atk'],
  ['special_defense', 'Sp. Def'],
  ['speed', 'Speed'],
];

/**
 * How a gender reads in a list or on a card.
 *
 * ♂ and ♀ are followed by U+FE0E (variation selector 15), which requests the
 * text rendering. Without it Discord shows them as colour emoji, which breaks
 * column alignment.
 */
const TEXT_PRESENTATION = '︎';

const GENDER_SYMBOLS = {
  male: `♂${TEXT_PRESENTATION}`,
  female: `♀${TEXT_PRESENTATION}`,
  genderless: '',
};

const capitalize = (word) => (word ? word[0].toUpperCase() + word.slice(1) : word);

/** Turn a slug like "lightning-rod" into "Lightning Rod". */
const titleCase = (slug) =>
  String(slug || '')
    .split('-')
    .filter(Boolean)
    .map(capitalize)
    .join(' ');

/**
 * What to call a Pokemon.
 *
 * A nickname replaces the species name. Shinies always get the sparkle prefix.
 */
function displayName(row) {
  const name = row.nickname || row.display_name;
  return row.shiny ? `✨${name}` : name;
}

function typeList(row) {
  return String(row.types || '')
    .split(',')
    .filter(Boolean);
}

/** Gold for a shiny, otherwise the leading type's colour. */
function colorFor(row) {
  if (row.shiny) return SHINY_COLOR;
  return TYPE_COLORS[typeList(row)[0]] ?? 0x888888;
}

/** IV quality as the percentage players actually quote. */
function ivPercent(row) {
  return Math.round((row.iv_total / (MAX_IV * STATS.length)) * 1000) / 10;
}

/** "Charizard M, Lv.54" - one Pokemon on one line, for lists. */
function summaryLine(row) {
  const gender = GENDER_SYMBOLS[row.gender] || '';
  return (
    `\`#${String(row.party_number ?? row.id).padStart(4, ' ')}\` ` +
    `${displayName(row)}${gender ? ' ' + gender : ''}` +
    `, Lv.${row.level}, IV ${ivPercent(row)}%`
  );
}

/**
 * The six stats as an aligned block.
 *
 * The nature's boosted and lowered stats are marked with + and -.
 */
function statBlock(row, nature) {
  const lines = [];

  for (const [key, label] of STAT_LABELS) {
    const camel = key.replace(/_(.)/g, (_, c) => c.toUpperCase());
    let mark = ' ';
    if (nature && nature.increased === camel) mark = '+';
    if (nature && nature.decreased === camel) mark = '-';

    lines.push(
      `${mark} ${label.padEnd(7)} ${String(row[`stat_${key}`]).padStart(4)}` +
        `   IV ${String(row[`iv_${key}`]).padStart(2)}` +
        `   EV ${String(row[`ev_${key}`]).padStart(3)}`
    );
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Staying inside Discord's limits
// ---------------------------------------------------------------------------

/** What Discord will accept in one embed. Exceeding any of these is an API error. */
const LIMITS = {
  fieldValue: 1024,
  fieldName: 256,
  fields: 25,
  description: 4096,
  total: 6000,
};

/** Hard-truncate any string to a limit, with an ellipsis. */
function clip(text, limit) {
  const value = String(text ?? '');
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/**
 * Join lines into one field value, dropping any that will not fit.
 *
 * Keeps as many lines as fit and summarises the rest, so a long list can't
 * make the whole message fail.
 */
function fitLines(lines, limit = LIMITS.fieldValue) {
  const kept = [];
  let length = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = String(lines[i]);
    const remaining = lines.length - i;
    const note = `…and ${remaining} more`;

    // Leave room for the note if anything would be left over.
    const budget = remaining > 1 ? limit - note.length - 1 : limit;

    if (length + line.length + (kept.length ? 1 : 0) > budget) {
      kept.push(`…and ${remaining} more`);
      break;
    }

    length += line.length + (kept.length ? 1 : 0);
    kept.push(line);
  }

  // If even the first line doesn't fit, clip it.
  if (!kept.length || (kept.length === 1 && kept[0].startsWith('…and'))) {
    return lines.length ? clip(String(lines[0]), limit) : '-';
  }

  return kept.join('\n');
}

/**
 * Trim a list of embed fields to what Discord allows, replacing the overflow
 * with a single note so nothing disappears silently.
 */
function capFields(fields, max = LIMITS.fields) {
  if (fields.length <= max) return fields;

  const kept = fields.slice(0, max - 1);
  kept.push({ name: '​', value: `…and ${fields.length - kept.length} more` });
  return kept;
}

module.exports = {
  LIMITS,
  fitLines,
  capFields,
  clip,
  TYPE_COLORS,
  SHINY_COLOR,
  STAT_LABELS,
  GENDER_SYMBOLS,
  capitalize,
  titleCase,
  displayName,
  typeList,
  colorFor,
  ivPercent,
  summaryLine,
  statBlock,
};
