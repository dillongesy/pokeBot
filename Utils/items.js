'use strict';

/**
 * What an item does when you use it.
 *
 * Derived from the imported data wherever possible, so adding items to the
 * shop needs no change here. The vitamins and EV berries are mapped by hand.
 *
 * Run `node Utils/items.js` to see the coverage.
 */

const fs = require('fs');
const path = require('path');

const content = require('./content');
const evolution = require('./evolution');
const happiness = require('./happiness');
const {
  loadSpecies,
  experienceForLevel,
  normaliseName,
  MAX_LEVEL,
  STATS,
} = require('./pokemon');

const DATA = path.join(__dirname, '..', 'Data');

/** EV limits, as in the games. */
const MAX_EV_PER_STAT = 252;
const MAX_EV_TOTAL = 510;
const VITAMIN_EV = 10;

/**
 * Which stat each vitamin trains.
 *
 * PokeAPI only describes these in prose, so the mapping is written out.
 */
const VITAMINS = {
  'hp-up': 'hp',
  protein: 'attack',
  iron: 'defense',
  calcium: 'special_attack',
  zinc: 'special_defense',
  carbos: 'speed',
};

/**
 * The six berries that lower one stat's EVs by 10 and raise friendship, the
 * reverse of the vitamins.
 */
const EV_BERRIES = {
  'pomeg-berry': 'hp',
  'kelpsy-berry': 'attack',
  'qualot-berry': 'defense',
  'hondew-berry': 'special_attack',
  'grepa-berry': 'special_defense',
  'tamato-berry': 'speed',
};

// ---------------------------------------------------------------------------
// Mega stones
// ---------------------------------------------------------------------------

let megaCache = null;

const commonPrefix = (a, b) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
};

/**
 * Work out which species each Mega Stone belongs to.
 *
 * Older stones name the species in their effect text ("Allows Venusaur to
 * Mega Evolve"). Newer Legends Z-A stones have no effect text yet, so they are
 * matched to an unclaimed Mega form by name ("clefablite" -> Clefable).
 */
function megaStones() {
  if (megaCache) return megaCache;

  const index = JSON.parse(fs.readFileSync(path.join(DATA, 'Pokemon', 'index.json'), 'utf8'));

  const speciesByName = new Map(index.species.map((s) => [s.displayName.toLowerCase(), s]));
  const megaForms = new Map();
  for (const form of index.forms) {
    if (!form.isMega) continue;
    if (!megaForms.has(form.speciesId)) megaForms.set(form.speciesId, []);
    megaForms.get(form.speciesId).push(form);
  }

  const stones = new Map();
  const unmatchedStones = [];

  for (const [slug] of content.items()) {
    const item = content.item(slug);
    if (!item || item.category !== 'mega-stones') continue;

    const described = /Allows (.+?) to Mega Evolve into (.+?)\.?$/.exec(item.shortEffect || '');

    if (described) {
      const species = speciesByName.get(described[1].toLowerCase());
      const forms = species ? megaForms.get(species.id) || [] : [];
      if (species && forms.length) {
        // "Mega Charizard X" tells us which of the two to pick.
        const target =
          forms.find((f) => described[2].toLowerCase().endsWith(f.folder.toLowerCase().slice(-1)) &&
            f.folder.length > 4) || forms[0];
        stones.set(slug, { speciesId: species.id, form: target.folder });
        continue;
      }
    }

    unmatchedStones.push(slug);
  }

  // Pair leftover stones with unclaimed Mega forms by shared name. Tracked per
  // form, so a species with Mega X and Mega Y can take two stones.
  const speciesById = new Map(index.species.map((s) => [s.id, s]));
  const claimed = new Set([...stones.values()].map((s) => `${s.speciesId}/${s.form}`));

  const free = [];
  for (const [speciesId, forms] of megaForms) {
    for (const form of forms) {
      if (!claimed.has(`${speciesId}/${form.folder}`)) {
        free.push({ speciesId, form: form.folder });
      }
    }
  }

  for (const slug of unmatchedStones) {
    const stoneSuffix = /-([xyz])$/.exec(slug);

    let best = -1;
    let bestRank = -1;
    let bestScore = 0;

    for (let i = 0; i < free.length; i += 1) {
      const score = commonPrefix(slug, speciesById.get(free[i].speciesId).name);

      // A five-character prefix match ("starminite"/"starmie").
      if (score < 5) continue;

      // "raichunite-y" should land on "Mega Y" rather than "Mega X".
      const formSuffix = / ([XYZ])$/.exec(free[i].form);
      const suffixesAgree = stoneSuffix && formSuffix
        ? stoneSuffix[1] === formSuffix[1].toLowerCase()
        : !stoneSuffix && !formSuffix;

      // Prefer the plain "Mega" over variants like Magearna's "Original Mega".
      const plain = /^Mega( [XYZ])?$/.test(free[i].form);

      // Combined score: name match first, then the X/Y letter, then the plain
      // form.
      const rank = score * 100 + (suffixesAgree ? 10 : 0) + (plain ? 1 : 0);

      if (rank > bestRank) {
        bestRank = rank;
        bestScore = score;
        best = i;
      }
    }

    if (best >= 0 && bestScore >= 5) {
      stones.set(slug, free[best]);
      free.splice(best, 1);
    }
  }

  megaCache = stones;
  return stones;
}

// ---------------------------------------------------------------------------
// Working out what an item is
// ---------------------------------------------------------------------------

/**
 * Classify an item.
 *
 * @returns {{ kind: string, ... }} kind is one of:
 *   level    raises the level by one
 *   ev       adds effort to one stat
 *   mega     held; switches to a Mega form
 *   form     changes the form without evolving - plates, memories, trims
 *   slot     goes in the repel or incense slot, not onto a Pokemon
 *   evolve   consumed; evolves the Pokemon
 *   hold     held; does something in battle
 *   none     nothing implemented
 */
function classify(slug) {
  const item = content.item(slug);
  if (!item) return { kind: 'none', reason: `There is no item called "${slug}".` };

  // An item the shop defines itself says outright what it does.
  if (item.effect && item.effect.kind) return { returnable: true, ...item.effect, item };

  if (slug === 'rare-candy') return { kind: 'level', item };
  if (VITAMINS[slug]) return { kind: 'ev', stat: VITAMINS[slug], amount: VITAMIN_EV, item };
  if (EV_BERRIES[slug]) {
    return { kind: 'ev-drop', stat: EV_BERRIES[slug], amount: VITAMIN_EV, item };
  }

  const mega = megaStones().get(slug);
  if (mega) return { kind: 'mega', ...mega, returnable: true, item };

  // Use the evolution data rather than the category, which isn't reliable
  // (the Kubfu scrolls are filed under "gameplay").
  if (evolution.useItems().has(slug) || item.category === 'evolution') {
    return { kind: 'evolve', item };
  }

  // Anything with `holdable`, `holdable-active` or `holdable-passive`.
  if ((item.attributes || []).some((a) => a === 'holdable' || a.startsWith('holdable-'))) {
    return { kind: 'hold', item };
  }

  // PokeAPI's attributes are incomplete (Eviolite, Rocky Helmet, Assault Vest
  // and others have none), so anything with a battle effect is also treated
  // as holdable.
  if (require('./battleeffects').isHeldEffect(slug)) return { kind: 'hold', item };

  return { kind: 'none', item, reason: `${item.displayName} does not do anything yet.` };
}

/** The current total effort spread across all six stats. */
function totalEvs(row) {
  return STATS.reduce((sum, stat) => {
    const column = stat.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
    return sum + (row[`ev_${column}`] || 0);
  }, 0);
}

/**
 * Which base form a Mega belongs to.
 *
 *   "Curly Mega"    -> "Curly"        Tatsugiri's, one per shape
 *   "Original Mega" -> "Original"     Magearna's
 *   "Mega X"        -> "Default"      Charizard's, the ordinary one
 *
 * Anything that is not a Mega folder at all returns null.
 */
function megaBaseOf(folder) {
  const match = /^(?:(.+) )?Mega(?: [XYZ])?$/.exec(folder);
  if (!match) return null;
  return match[1] || 'Default';
}

/**
 * Which form a family item should produce for this Pokemon.
 *
 * A family item names a form rather than a species (the Dynamax Band names
 * "Gmax", the Reveal Glass "Therian") and works on any species with that form
 * in Data/Pokemon.
 *
 * When a species has several (Urshifu, Toxtricity), the one matching its
 * current form is used, as in megaFormFor.
 *
 * @returns {string|null} the form folder, or null if this Pokemon has none
 */
function familyFormFor(row, familyName) {
  const species = loadSpecies(row.species_id);
  const forms = (species && species.forms) || [];

  const candidates = forms.filter(
    (form) => form.folder === familyName || form.folder.endsWith(` ${familyName}`)
  );

  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0].folder;

  const mine = candidates.find((form) => form.folder === `${row.form_folder} ${familyName}`);
  return mine ? mine.folder : candidates[0].folder;
}

/**
 * Which Mega form a stone should produce for this Pokemon.
 *
 * Usually the form the stone names. Some species have a Mega per form rather
 * than per stone:
 *
 *   Meowstic     Male Mega / Female Mega
 *   Tatsugiri    Curly, Droopy and Stretchy Megas
 *   Magearna     a plain "Mega" and an "Original Mega"
 *
 * For those, the Mega matching the current form is used, worked out from the
 * folder names. Charizard's two stones both belong to the default form, so
 * the stone decides.
 */
function megaFormFor(row, effect) {
  const species = loadSpecies(effect.speciesId);
  const forms = (species && species.forms) || [];

  const belongsHere = forms.filter((form) => megaBaseOf(form.folder) === row.form_folder);
  if (!belongsHere.length) return effect.form;

  // Charizardite Y names Mega Y, and both are the default form's.
  if (belongsHere.some((form) => form.folder === effect.form)) return effect.form;

  return belongsHere[0].folder;
}

// ---------------------------------------------------------------------------
// Forms that come from a held item
// ---------------------------------------------------------------------------

/**
 * Rule: if an item put a Pokemon into a form, the Pokemon is holding that
 * item, and removing the item reverts the form.
 *
 * `form_folder` is still stored (so reads don't need to load species data),
 * but for these forms it is set and cleared together with `equipped_item`.
 * formIsConsistent checks that the two agree.
 */

/** The form a species starts in - the one wild drops come in. */
function baseFormFolder(row) {
  const species = loadSpecies(row.species_id);
  const forms = (species && species.forms) || [];
  const base = forms.find((form) => form.percentage > 0) || forms[0];
  return base ? base.folder : null;
}

/** Does this folder name belong to the family `familyName`? "Single Strike Gmax" does. */
const isFamilyForm = (folder, familyName) =>
  folder === familyName || folder.endsWith(` ${familyName}`);

/** "Single Strike Gmax" without its "Gmax" is "Single Strike", if that is a real form. */
function withoutFamily(row, folder, familyName) {
  if (folder === familyName) return baseFormFolder(row);

  const prefix = folder.slice(0, -(familyName.length + 1));
  const species = loadSpecies(row.species_id);
  const forms = (species && species.forms) || [];

  return forms.some((form) => form.folder === prefix) ? prefix : baseFormFolder(row);
}

/**
 * What this Pokemon would revert to if its held item came off - or null if the
 * held item is not what is holding the current form up.
 *
 * A Pokemon can hold an item that isn't causing its form (another species'
 * Mega Stone, or a plate in its default form); then this returns null.
 *
 * The previous form is recovered from the folder name: "Curly Mega" reverts
 * to "Curly", "Single Strike Gmax" to "Single Strike", and a plain "Mega" or
 * "Origin" to the default form.
 */
function formWithoutHeldItem(row) {
  if (!row.equipped_item) return null;

  const effect = classify(row.equipped_item);

  if (effect.kind === 'mega') {
    // Any Mega folder of the right species counts, since some species'
    // Megas depend on their form rather than the stone.
    if (row.species_id !== effect.speciesId) return null;

    const base = megaBaseOf(row.form_folder);
    if (base === null) return null;

    const species = loadSpecies(row.species_id);
    const forms = (species && species.forms) || [];
    return forms.some((form) => form.folder === base) ? base : baseFormFolder(row);
  }

  if (effect.kind === 'form' && effect.reuse === 'held') {
    if (effect.speciesId === null) {
      return isFamilyForm(row.form_folder, effect.form)
        ? withoutFamily(row, row.form_folder, effect.form)
        : null;
    }

    if (row.species_id !== effect.speciesId) return null;
    return row.form_folder === effect.form ? baseFormFolder(row) : null;
  }

  return null;
}

/**
 * Does what this Pokemon is holding agree with the form it is in?
 *
 * False means they disagree, e.g. a Mega holding no stone.
 *
 * Only item-derived forms are checked; stored forms (Rotom, Furfrou,
 * Oricorio) always pass.
 */
function formIsConsistent(row) {
  const wanted = itemForForm(row);

  // No held item produces this form (stored forms, and Mega Rayquaza).
  if (wanted === null) return true;

  return row.equipped_item === wanted;
}

let causerCache = null;

/**
 * Everything that can put a Pokemon into a Mega form.
 *
 * The Mega Stones, plus Dragon Ascent (Rayquaza), which the shop defines as
 * an item with `kind: 'mega'` and so isn't found by megaStones().
 */
function megaCausers() {
  if (causerCache) return causerCache;

  const all = new Map(megaStones());

  // customItems(), since Dragon Ascent has no PokeAPI record.
  for (const [slug, item] of content.customItems()) {
    if (all.has(slug)) continue;

    const effect = item && item.effect;
    if (effect && effect.kind === 'mega' && effect.speciesId) {
      all.set(slug, { speciesId: effect.speciesId, form: effect.form });
    }
  }

  causerCache = all;
  return all;
}

/**
 * Which item would produce the form this Pokemon is already in.
 *
 * The inverse of formWithoutHeldItem. Used by formIsConsistent, and to repair
 * records that are in an item form without holding the item.
 *
 * @returns {string|null} the item slug, or null if no item explains this form
 */
function itemForForm(row) {
  if (megaBaseOf(row.form_folder) !== null) {
    const candidates = [...megaCausers()].filter(
      ([, mega]) => mega.speciesId === row.species_id
    );

    // Prefer the stone that names this exact form (Charizard has two).
    const exact = candidates.find(([, mega]) => mega.form === row.form_folder);
    if (exact) return exact[0];

    return candidates.length === 1 ? candidates[0][0] : null;
  }

  for (const entry of require('./formitems').items) {
    if (entry.reuse !== 'held') continue;

    if (entry.species === null) {
      if (isFamilyForm(row.form_folder, entry.form)) return entry.item;
      continue;
    }

    if (entry.species === row.species_id && entry.form === row.form_folder) return entry.item;
  }

  return null;
}

/**
 * Put a Pokemon back into its default form for nothing.
 *
 * Reached via ".useitem <id> default". Only applies to stored forms (Rotom,
 * Furfrou, Oricorio, the fusions); held-item forms revert with `.take`, so
 * this refuses on those.
 */
function revertToDefault(row) {
  const base = baseFormFolder(row);

  if (!base) return { ok: false, message: 'That Pokemon has no default form to return to.' };

  if (row.form_folder === base) {
    return { ok: false, message: 'It is already in its default form.' };
  }

  if (formWithoutHeldItem(row) !== null) {
    const heldName = (content.item(row.equipped_item) || {}).displayName || row.equipped_item;
    return {
      ok: false,
      message:
        `That form comes from the ${heldName} it is holding. ` +
        'Use `.take` instead - you get the item back.',
    };
  }

  const restored = evolution.remapAbility(row.species_id, base, row.ability_slot || 1);

  return {
    ok: true,
    consumed: false,
    changes: {
      form_folder: base,
      ...(restored ? { ability: restored.name } : {}),
    },
    message: `It went back to its ${base} form.`,
  };
}

/**
 * Apply an item to a Pokemon.
 *
 * Returns the changes and a message but writes nothing; the caller consumes
 * the item and commits.
 *
 * @returns {{ ok: boolean, message: string, changes?: object, consumed?: boolean }}
 */
function apply(row, slug) {
  const effect = classify(slug);
  const name = effect.item ? effect.item.displayName : slug;

  switch (effect.kind) {
    case 'level': {
      if (row.level >= MAX_LEVEL) {
        return { ok: false, message: `It is already level ${MAX_LEVEL}.` };
      }

      const level = row.level + 1;

      // Look up the species' growth rate.
      const species = loadSpecies(row.species_id);
      const growthRate = species && species.breeding ? species.breeding.growthRate : 'medium';

      const changes = { level, exp: experienceForLevel(growthRate, level) };

      // Check for a level-up evolution.
      const evolved = evolution.resolve(row, 'level-up', { level });

      if (evolved) {
        return {
          ok: true,
          consumed: true,
          changes: { ...changes, ...evolved.changes },
          evolvedInto: evolved.target.name,
          alsoCreates: evolved.alsoCreates,
          message: `It grew to level ${level} and evolved into ${evolved.target.name}!`,
        };
      }

      return { ok: true, consumed: true, changes, message: `It grew to level ${level}.` };
    }

    case 'ev': {
      const column = `ev_${effect.stat}`;
      const current = row[column] || 0;

      if (current >= MAX_EV_PER_STAT) {
        return { ok: false, message: `Its ${effect.stat.replace('_', ' ')} effort is already maxed.` };
      }

      const spare = Math.min(
        effect.amount,
        MAX_EV_PER_STAT - current,
        MAX_EV_TOTAL - totalEvs(row)
      );

      if (spare <= 0) {
        return { ok: false, message: `It cannot take any more effort (${MAX_EV_TOTAL} total).` };
      }

      return {
        ok: true,
        consumed: true,
        changes: { [column]: current + spare },
        message: `Its ${effect.stat.replace('_', ' ')} effort rose by ${spare}, to ${current + spare}.`,
      };
    }

    case 'ev-drop': {
      const column = `ev_${effect.stat}`;
      const current = row[column] || 0;
      const readable = effect.stat.replace('_', ' ');

      if (current <= 0) {
        return { ok: false, message: `It has no ${readable} effort to lose.` };
      }

      const lost = Math.min(effect.amount, current);
      const friendship = happiness.fromBerry(row.happiness);

      return {
        ok: true,
        consumed: true,
        changes: {
          [column]: current - lost,
          ...(friendship ? { happiness: happiness.clamp((row.happiness || 0) + friendship) } : {}),
        },
        message:
          `Its ${readable} effort fell by ${lost}, to ${current - lost}.` +
          (friendship ? ` It liked that - friendship up ${friendship}.` : ''),
      };
    }

    case 'ev-reset': {
      const spent = totalEvs(row);
      if (spent <= 0) return { ok: false, message: 'It has no effort to clear.' };

      const changes = {};
      for (const stat of STATS) {
        changes[`ev_${stat.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())}`] = 0;
      }

      return {
        ok: true,
        consumed: true,
        changes,
        message: `All ${spent} of its effort was cleared. It can be trained from scratch.`,
      };
    }

    case 'mega': {
      if (row.species_id !== effect.speciesId) {
        const owner = loadSpecies(effect.speciesId);
        return {
          ok: false,
          message: `${name} only works on ${owner ? owner.displayName : 'another Pokemon'}.`,
        };
      }
      // Pick the Mega for species whose Mega depends on their form
      // (Meowstic, Tatsugiri) rather than the stone.
      const target = megaFormFor(row, effect);

      if (row.form_folder === target) {
        return { ok: false, message: `It has already Mega Evolved.` };
      }

      // Use the Mega form's ability. ability_slot is left unchanged so the
      // original ability returns on reverting.
      const megaAbility = evolution.remapAbility(effect.speciesId, target, row.ability_slot || 1);

      return {
        ok: true,
        consumed: false,
        returnable: effect.returnable !== false,
        changes: {
          form_folder: target,
          equipped_item: slug,
          ...(megaAbility ? { ability: megaAbility.name } : {}),
        },
        message:
          effect.returnable === false
            ? `It Mega Evolved! The ${name} is used up - reverting will not give it back.`
            : `It Mega Evolved! Take the ${name} back off to revert.`,
      };
    }

    case 'form': {
      // Family items name a form (e.g. "Gmax") and work on any species with it.
      const family = effect.speciesId === null;
      const target = family ? familyFormFor(row, effect.form) : effect.form;

      if (family && !target) {
        return { ok: false, message: `${name} does nothing for that Pokemon.` };
      }

      if (!family && row.species_id !== effect.speciesId) {
        const owner = loadSpecies(effect.speciesId);
        return {
          ok: false,
          message: `${name} only works on ${owner ? owner.displayName : 'another Pokemon'}.`,
        };
      }

      if (row.form_folder === target) {
        return { ok: false, message: `It is already in its ${target} form.` };
      }

      // The new form's ability applies, as with Megas.
      const swapped = evolution.remapAbility(row.species_id, target, row.ability_slot || 1);

      // Held form items are held rather than consumed, like Mega Stones.
      if (effect.reuse === 'held') {
        return {
          ok: true,
          consumed: false,
          returnable: true,
          changes: {
            form_folder: target,
            equipped_item: slug,
            ...(swapped ? { ability: swapped.name } : {}),
          },
          message: `It changed into its ${target} form! Take the ${name} back off to revert.`,
        };
      }

      // "keep" items stay in the bag.
      const consumed = effect.reuse !== 'keep';

      return {
        ok: true,
        consumed,
        changes: {
          form_folder: target,
          ...(swapped ? { ability: swapped.name } : {}),
        },
        message:
          `It changed into its ${target} form!` +
          (effect.reuse === 'keep' ? ` You keep the ${name}.` : '') +
          ' `.useitem <id> default` puts it back for nothing.',
      };
    }

    case 'evolve': {
      const result = evolution.resolve(row, 'use-item', { item: slug });

      // Gimmighoul's evolution consumes many coins.
      if (result && slug === evolution.COIN_EVOLUTION.item) {
        return {
          ok: true,
          consumed: true,
          consumedQuantity: evolution.COIN_EVOLUTION.quantity,
          changes: result.changes,
          evolvedInto: result.target.name,
          message: `${evolution.COIN_EVOLUTION.quantity} coins later, it evolved into ${result.target.name}!`,
        };
      }

      if (!result) {
        if (row.equipped_item === evolution.EVERSTONE) {
          return { ok: false, message: 'It is holding an Everstone, so it will not evolve.' };
        }

        // Trade-evolution items are held, not used, so equip it.
        if (evolution.tradeHeldItems().has(slug)) {
          if (row.equipped_item === slug) {
            return { ok: false, message: `It is already holding the ${name}. Now trade it.` };
          }
          return {
            ok: true,
            consumed: false,
            returnable: true,
            changes: { equipped_item: slug },
            message: `It is now holding the ${name}. Trade it away and it will evolve.`,
          };
        }

        return { ok: false, message: `The ${name} has no effect on this Pokemon.` };
      }

      return {
        ok: true,
        consumed: true,
        changes: result.changes,
        evolvedInto: result.target.name,
        alsoCreates: result.alsoCreates,
        message: `It evolved into ${result.target.name}!`,
      };
    }

    case 'hold':
      if (row.equipped_item === slug) {
        return { ok: false, message: `It is already holding the ${name}.` };
      }
      return {
        ok: true,
        consumed: false,
        changes: { equipped_item: slug },
        message: `It is now holding the ${name}.`,
      };

    // TMs are taught with `.tm`, which handles choosing a move slot.
    case 'tm': {
      const machines = require('./machines');
      const tm = machines.forMove(effect.move);
      const readable = tm ? tm.moveDisplayName : effect.move;

      const refusal = machines.refusalFor(row, slug);
      if (refusal) return { ok: false, message: refusal };

      return {
        ok: false,
        teachable: { move: effect.move, displayName: readable },
        message:
          `${row.display_name} can learn ${readable}. ` +
          `Use \`.tm ${row.id} ${effect.move}\` - it says which move it would replace first.`,
      };
    }

    default:
      return { ok: false, message: effect.reason || `${name} does not do anything yet.` };
  }
}

module.exports = {
  VITAMINS,
  MAX_EV_PER_STAT,
  MAX_EV_TOTAL,
  VITAMIN_EV,
  megaStones,
  familyFormFor,
  megaBaseOf,
  baseFormFolder,
  formWithoutHeldItem,
  formIsConsistent,
  itemForForm,
  revertToDefault,
  classify,
  totalEvs,
  apply,
};

// `node Utils/items.js` - report what is and is not covered.
if (require.main === module) {
  const stones = megaStones();
  const counts = {};

  for (const [slug] of content.items()) {
    counts[classify(slug).kind] = (counts[classify(slug).kind] || 0) + 1;
  }

  console.log(`Mega stones mapped to a species: ${stones.size}`);
  console.log('');
  console.log('Every imported item, by what it does:');
  for (const [kind, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${kind.padEnd(8)} ${count}`);
  }
}
