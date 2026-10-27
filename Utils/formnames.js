'use strict';

/**
 * How a form is named: "Alolan Rattata", "Phony Polteageist", "Mega Charizard X".
 *
 * PokeAPI's form slugs put the form after the species ("rattata-alola"), which
 * reads backwards. This turns a species name and a form label into the name
 * players expect:
 *
 *   regional         Alolan / Galarian / Hisuian / Paldean, before the name
 *   Mega / Gmax      "Mega Venusaur", "Gigantamax Venusaur", trailing X/Y/Z kept
 *   Primal / Totem   before the name
 *   anything else    before the name: "Heat Rotom", "Therian Tornadus"
 *
 * Whatever is left after a regional or battle prefix goes in brackets:
 * "Paldean Tauros (Combat Breed)", "Gigantamax Urshifu (Rapid Strike)".
 *
 * A few stay after the name, where that is how they are read: Unown's letters
 * ("Unown B") and Zygarde's percentages ("Zygarde 10%"). A default form whose
 * label says nothing ("Deoxys Normal") is just the species name.
 *
 * Used by the importer (Utils/importdata.js) when it writes Data/Pokemon.
 */

const REGIONAL = { Alola: 'Alolan', Galar: 'Galarian', Hisui: 'Hisuian', Paldea: 'Paldean' };

/** Default-form labels that only mean "the usual one". */
const PLAIN_DEFAULTS = new Set(['Normal', 'Average', 'Standard', 'Ordinary']);

/** Species whose form label reads best after the name. */
const SUFFIXED = new Set(['Unown', 'Zygarde']);

/** Spelling fixes for labels built from slugs. */
const SPELLING = {
  Phd: 'PhD',
  'Poke Ball': 'Poké Ball',
  'Family Of Three': 'Family of Three',
  'Family Of Four': 'Family of Four',
};

/** Event forms, which read best in brackets after the name. */
const BRACKETED = new Set(['Top 3 2024']);

/** Unown's two punctuation forms. */
const UNOWN_MARKS = { Exclamation: '!', Question: '?' };

const fix = (label) => SPELLING[label] || label;

// "Galarian Darmanitan", not "Galarian Darmanitan (Standard)".
const bracket = (rest) => (rest && !PLAIN_DEFAULTS.has(rest) ? ` (${fix(rest)})` : '');

/**
 * The display name for a form.
 *
 * @param {string} species  the species' English name, e.g. "Rattata"
 * @param {string} label    the form label, e.g. "Alola", "Mega X", "" for none
 * @param {boolean} isDefault
 */
function formDisplayName(species, label, isDefault = false) {
  const words = String(label || '').trim();
  if (!words) return species;

  if (isDefault && PLAIN_DEFAULTS.has(words)) return species;
  if (BRACKETED.has(words)) return `${species} (${words})`;

  // Already bracketed ("Rayquaza (Top 3 2024)"): leave it, so renaming twice
  // changes nothing.
  if (/^\(.*\)$/.test(words)) return `${species} ${words}`;

  if (SUFFIXED.has(species)) {
    if (species === 'Unown') return `Unown ${UNOWN_MARKS[words] || words}`;

    // "10", "50", "10 Power Construct" -> "Zygarde 10%", "Zygarde 10% (Power Construct)".
    // Also accepts its own output ("10% (Power Construct)"), so it is idempotent.
    const match = words.match(/^(\d+)%?(?:\s+\(?(.*?)\)?)?$/);
    if (match) return `Zygarde ${match[1]}%${bracket(match[2])}`;
    return `${fix(words)} Zygarde`;
  }

  const parts = words.split(' ');

  // Totem comes first and keeps whatever follows ("Totem Alolan Raticate").
  if (parts[0] === 'Totem') {
    return `Totem ${formDisplayName(species, parts.slice(1).join(' '), false)}`;
  }

  // Regional, anywhere in the label ("Alola", "Paldea Combat Breed", "Galar Zen").
  const regionAt = parts.findIndex((word) => REGIONAL[word]);
  if (regionAt >= 0) {
    const rest = parts.filter((_, i) => i !== regionAt).join(' ');
    // Pikachu's "Alola Cap" is a cap, not a regional form.
    if (rest !== 'Cap') return `${REGIONAL[parts[regionAt]]} ${species}${bracket(rest)}`;
  }

  // Mega, with an optional trailing letter ("Mega X") or leading variant
  // ("Curly Mega", "Female Mega", "Original Mega").
  const megaAt = parts.indexOf('Mega');
  if (megaAt >= 0) {
    const before = parts.slice(0, megaAt).join(' ');
    const after = parts.slice(megaAt + 1).join(' ');
    const letter = /^[XYZ]$/.test(after) ? ` ${after}` : '';
    const rest = [before, letter ? '' : after].filter(Boolean).join(' ');
    return `Mega ${species}${letter}${bracket(rest)}`;
  }

  const gmaxAt = parts.indexOf('Gmax');
  if (gmaxAt >= 0) {
    const rest = parts.filter((_, i) => i !== gmaxAt).join(' ');
    return `Gigantamax ${species}${bracket(rest)}`;
  }

  return `${fix(words)} ${species}`;
}

module.exports = { formDisplayName, REGIONAL };
