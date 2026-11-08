'use strict';

/**
 * What the shop, .buy and .examine say an item does: one short line.
 *
 * Display only. Code that needs item facts reads Utils/content.js; nothing
 * here changes how an item works.
 *
 * Mega Stones, form-change items, type boosters and TMs are described from
 * their data; everything else is written out below.
 */

const names = require('./names');
const formitems = require('./formitems');
const machines = require('./machines');

const TEXT = {
  // Mega Evolution
  'dragon-ascent': 'Teaches Rayquaza Dragon Ascent, allowing it to Mega Evolve.',

  // Drops
  'ultra-beast-incense': 'Your next drop is an Ultra Beast.',

  // Evolution stones
  'fire-stone': 'Evolves Vulpix, Growlithe, Eevee, Pansear or Capsakid.',
  'water-stone': 'Evolves Poliwhirl, Shellder, Staryu, Eevee, Lombre or Panpour.',
  'thunder-stone': 'Evolves Pikachu, Magneton, Eevee, Nosepass, Eelektrik, Charjabug or Tadbulb.',
  'leaf-stone': 'Evolves Gloom, Weepinbell, Hisuian Voltorb, Exeggcute, Eevee, Nuzleaf or Pansage.',
  'moon-stone': 'Evolves Nidorina, Nidorino, Clefairy, Jigglypuff, Skitty or Munna.',
  'ice-stone': 'Evolves Alolan Sandshrew, Alolan Vulpix, Eevee, Galarian Darumaka, Crabrawler or Cetoddle.',
  'sun-stone': 'Evolves Gloom, Sunkern, Cottonee, Petilil or Helioptile.',
  'shiny-stone': 'Evolves Togetic, Roselia, Minccino or Floette.',
  'dusk-stone': 'Evolves Murkrow, Misdreavus, Lampent or Doublade.',
  'dawn-stone': 'Evolves a male Kirlia or a female Snorunt.',

  // Special evolution
  'scroll-of-darkness': 'Evolves Kubfu into Single Strike Style Urshifu.',
  'scroll-of-waters': 'Evolves Kubfu into Rapid Strike Style Urshifu.',
  'auspicious-armor': 'Evolves Charcadet into Armarouge.',
  'malicious-armor': 'Evolves Charcadet into Ceruledge.',
  'galarica-cuff': 'Evolves Galarian Slowpoke into Galarian Slowbro.',
  'galarica-wreath': 'Evolves Galarian Slowpoke into Galarian Slowking.',
  'black-augurite': 'Evolves Scyther into Kleavor.',
  'metal-alloy': 'Evolves Duraludon into Archaludon.',
  'peat-block': 'Evolves Ursaring into Ursaluna.',
  'sweet-apple': 'Evolves Applin into Appletun.',
  'tart-apple': 'Evolves Applin into Flapple.',
  'syrupy-apple': 'Evolves Applin into Dipplin.',
  'cracked-pot': 'Evolves Sinistea into Polteageist.',
  'chipped-pot': 'Evolves Sinistea into Polteageist.',
  'unremarkable-teacup': 'Evolves Poltchageist into Sinistcha.',
  'masterpiece-teacup': 'Evolves Poltchageist into Sinistcha.',
  'strawberry-sweet': 'Evolves Milcery into Alcremie.',
  'berry-sweet': 'Evolves Milcery into Alcremie.',
  'gimmighoul-coin': 'Evolves Gimmighoul into Gholdengo once it is given 999.',

  // Held gear
  everstone: 'Prevents the holder from evolving.',
  'soothe-bell': "Doubles the happiness the holder gains.",
  'oval-stone': 'Evolves Happiny into Chansey when it levels up holding it.',
  'razor-claw': "Raises the holder's critical-hit ratio. Evolves Sneasel into Weavile when it levels up holding it.",
  'razor-fang': "The holder's attacks may make the target flinch. Evolves Gligar into Gliscor when it levels up holding it.",

  // Trade evolution
  'metal-coat': 'Boosts the power of Steel-type moves by 20%. Evolves Onix into Steelix and Scyther into Scizor when traded holding it.',
  'kings-rock': "The holder's attacks may make the target flinch. Evolves Poliwhirl into Politoed and Slowpoke into Slowking when traded holding it.",
  'dragon-scale': 'Evolves Seadra into Kingdra when traded holding it.',
  'up-grade': 'Evolves Porygon into Porygon2 when traded holding it.',
  'dubious-disc': 'Evolves Porygon2 into Porygon-Z when traded holding it.',
  protector: 'Evolves Rhydon into Rhyperior when traded holding it.',
  electirizer: 'Evolves Electabuzz into Electivire when traded holding it.',
  magmarizer: 'Evolves Magmar into Magmortar when traded holding it.',
  'reaper-cloth': 'Evolves Dusclops into Dusknoir when traded holding it.',
  'prism-scale': 'Evolves Feebas into Milotic when traded holding it.',
  sachet: 'Evolves Spritzee into Aromatisse when traded holding it.',
  'whipped-dream': 'Evolves Swirlix into Slurpuff when traded holding it.',
  'deep-sea-tooth': "Doubles Clamperl's Special Attack. Evolves Clamperl into Huntail when traded holding it.",
  'deep-sea-scale': "Doubles Clamperl's Special Defense. Evolves Clamperl into Gorebyss when traded holding it.",

  // Training
  'rare-candy': "Raises a Pokemon's level by one.",
  'hp-up': "Raises a Pokemon's HP effort by 10.",
  protein: "Raises a Pokemon's Attack effort by 10.",
  iron: "Raises a Pokemon's Defense effort by 10.",
  calcium: "Raises a Pokemon's Special Attack effort by 10.",
  zinc: "Raises a Pokemon's Special Defense effort by 10.",
  carbos: "Raises a Pokemon's Speed effort by 10.",
  'pomeg-berry': "Lowers a Pokemon's HP effort by 10 and raises its happiness.",
  'kelpsy-berry': "Lowers a Pokemon's Attack effort by 10 and raises its happiness.",
  'qualot-berry': "Lowers a Pokemon's Defense effort by 10 and raises its happiness.",
  'hondew-berry': "Lowers a Pokemon's Special Attack effort by 10 and raises its happiness.",
  'grepa-berry': "Lowers a Pokemon's Special Defense effort by 10 and raises its happiness.",
  'tamato-berry': "Lowers a Pokemon's Speed effort by 10 and raises its happiness.",
  'reset-bag': "Clears all of a Pokemon's effort.",

  // Held items
  leftovers: "Restores 1/16 of the holder's max HP at the end of every turn.",
  'choice-band': "Boosts the holder's Attack by 50%, but it can only use the first move it picks.",
  'choice-specs': "Boosts the holder's Special Attack by 50%, but it can only use the first move it picks.",
  'choice-scarf': "Boosts the holder's Speed by 50%, but it can only use the first move it picks.",
  'life-orb': "Boosts the power of the holder's moves by 30%, but it loses 1/10 of its max HP each time it attacks.",
  'focus-sash': 'If the holder has full HP, it survives a hit that would knock it out with 1 HP.',
  'assault-vest': "Boosts the holder's Special Defense by 50%, but it can't use status moves.",
  eviolite: "Boosts the holder's Defense and Special Defense by 50% if it can still evolve.",
  'rocky-helmet': 'When the holder is hit by a contact move, the attacker loses 1/6 of its max HP.',
  'weakness-policy': "When the holder is hit by a super-effective move, its Attack and Special Attack sharply rise.",
  'expert-belt': 'Boosts the power of super-effective moves by 20%.',
  'shell-bell': 'The holder restores HP equal to 1/8 of the damage it deals.',
  'muscle-band': 'Boosts the power of physical moves by 10%.',
  'wise-glasses': 'Boosts the power of special moves by 10%.',
  'scope-lens': "Raises the holder's critical-hit ratio.",
  'focus-band': 'The holder may survive a hit that would knock it out with 1 HP.',
  'air-balloon': 'The holder floats and is immune to Ground-type moves until it is hit by an attack.',
  'black-sludge': 'A Poison-type holder restores 1/16 of its max HP every turn. Any other holder loses 1/8.',
  'iron-ball': "Halves the holder's Speed and lets Ground-type moves hit it.",
  'flame-orb': 'Burns the holder at the end of the turn.',
  'toxic-orb': 'Badly poisons the holder at the end of the turn.',
  'light-ball': "Doubles Pikachu's Attack and Special Attack.",
  'thick-club': "Doubles Cubone's and Marowak's Attack.",
  'soul-dew': "Boosts the power of Latias's and Latios's Psychic- and Dragon-type moves by 20%.",
  'lucky-punch': "Raises Chansey's critical-hit ratio by two stages.",
  stick: "Raises Farfetch'd's critical-hit ratio by two stages.",
  'large-leek': "Raises Farfetch'd's and Sirfetch'd's critical-hit ratio by two stages.",
  'metal-powder': "Doubles Ditto's Defense, until it transforms.",
  'quick-powder': "Doubles Ditto's Speed, until it transforms.",

  // Berries
  'sitrus-berry': "Restores 1/4 of the holder's max HP when its HP drops to half or below.",
  'oran-berry': "Restores 10 HP when the holder's HP drops to half or below.",
  'berry-juice': "Restores 20 HP when the holder's HP drops to half or below.",
  'lum-berry': 'Cures the holder of any status condition or confusion.',
  'cheri-berry': 'Cures the holder of paralysis.',
  'chesto-berry': 'Wakes the holder up.',
  'pecha-berry': 'Cures the holder of poison.',
  'rawst-berry': 'Heals the holder of a burn.',
  'aspear-berry': 'Thaws the holder out if it is frozen.',
  'liechi-berry': "Raises the holder's Attack when its HP drops to 1/4 or below.",
  'ganlon-berry': "Raises the holder's Defense when its HP drops to 1/4 or below.",
  'petaya-berry': "Raises the holder's Special Attack when its HP drops to 1/4 or below.",
  'apicot-berry': "Raises the holder's Special Defense when its HP drops to 1/4 or below.",
  'salac-berry': "Raises the holder's Speed when its HP drops to 1/4 or below.",
};

const TYPE_NAMES = (type) => type.charAt(0).toUpperCase() + type.slice(1);

/** "Mega Charizard X" from Charizard and "Mega X". */
function megaName(species, form) {
  const suffix = form.replace(/^Mega\s*/, '');
  return `Mega ${species}${suffix ? ` ${suffix}` : ''}`;
}

/** Lazily built from the data, once. */
let generated = null;

function generate() {
  if (generated) return generated;
  generated = new Map();

  // Mega Stones
  const items = require('./items');
  for (const [slug, mega] of items.megaStones()) {
    const species = names.speciesById(mega.speciesId);
    if (!species) continue;
    generated.set(slug, `Allows ${species.displayName} to Mega Evolve into ${megaName(species.displayName, mega.form)}.`);
  }

  // Form change
  for (const entry of formitems.items) {
    const species = entry.species === null ? null : names.speciesById(entry.species);
    let text;
    if (entry.item === 'reveal-glass') {
      text = 'Changes Tornadus, Thundurus, Landorus or Enamorus into its Therian form.';
    } else if (entry.item === 'dynamax-band') {
      text = 'Gigantamaxes a Pokemon that has a Gigantamax form.';
    } else {
      const who = species ? species.displayName : entry.who;
      text = `Changes ${who} into its ${entry.form} form.`;
    }
    if (entry.reuse === 'consumed') text += ' Used up.';
    generated.set(entry.item, text);
  }

  // Type boosters (the plates are form items, described above)
  const battleeffects = require('./battleeffects');
  for (const [slug, boost] of battleeffects.typeBoostItems()) {
    if (generated.has(slug) || TEXT[slug]) continue;
    generated.set(slug, `Boosts the power of ${TYPE_NAMES(boost.type)}-type moves by 20%.`);
  }

  return generated;
}

/**
 * The line for an item, or null when there is nothing written for it.
 */
function describe(slug) {
  if (TEXT[slug]) return TEXT[slug];

  const fromData = generate().get(slug);
  if (fromData) return fromData;

  const tm = machines.bySlug(slug);
  if (tm) return `Teaches ${tm.moveDisplayName} to a Pokemon that can learn it.`;

  return null;
}

module.exports = { describe };
