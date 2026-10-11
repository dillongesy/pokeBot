#!/usr/bin/env node
'use strict';

/**
 * PokeDropperV2 - data importer
 *
 * Builds the Data folder from PokeAPI (https://pokeapi.co/docs/v2) plus three
 * hand-editable files that sit alongside this one:
 *
 *   formrates.js  per-form drop percentages
 *   artwork.js    artwork for forms PokeAPI has no render for
 *   custom.js     forms PokeAPI does not carry at all, gender locks, exclusions
 *
 * Images: PokeAPI's CDN url is stored as-is wherever it exists, so the repo
 * stays small. Only the forms PokeAPI cannot render are downloaded to disk.
 *
 * Fair use (https://pokeapi.co/docs/v2#fairuse):
 *   - every response is cached to Data/.cache, so re-runs read disk, not the API
 *   - images already on disk are never re-downloaded
 *   - at most CONCURRENCY requests in flight, each followed by a short delay
 *   - 429/5xx retried with exponential backoff, Retry-After honoured
 *   - a real User-Agent identifies this client
 *
 * Usage:
 *   node Utils/importdata.js                  # everything
 *   node Utils/importdata.js pokemon items    # only these sections
 *   node Utils/importdata.js --no-images      # skip image downloads
 *   node Utils/importdata.js --limit=10       # first 10 entries per section
 *   node Utils/importdata.js --help
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const FORM_RATES = require('./formrates');
const ARTWORK = require('./artwork');
const CUSTOM = require('./custom');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API = 'https://pokeapi.co/api/v2';
const USER_AGENT =
  'PokeDropperV2/1.0 (personal Discord bot; results cached locally per PokeAPI fair use)';

const CONCURRENCY = 5;
const REQUEST_DELAY = 100;
const MAX_RETRIES = 3;
const CR = String.fromCharCode(13);

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'Data');
const CACHE = path.join(DATA, '.cache');

// The API has no flag for these, so the lists live here.
const ULTRA_BEASTS = new Set([793, 794, 795, 796, 797, 798, 799, 803, 804, 805, 806]);
const PSEUDO_LEGENDARIES = new Set([149, 248, 373, 376, 445, 635, 706, 784, 887, 998]);

// Paradox Pokemon count as legendary here even though PokeAPI does not flag them.
const EXTRA_LEGENDARY = new Set([1009, 1010, 1020, 1021, 1022, 1023]);

// PokeAPI has no Hisui region - Legends Arceus species are filed under Galar.
const HISUI_SPECIES = new Set([899, 900, 901, 902, 903, 904, 905]);

// Regional forms carry a region their species' generation does not know about.
const FORM_REGIONS = {
  alola: 'Alola',
  galar: 'Galar',
  hisui: 'Hisui',
  paldea: 'Paldea',
};

const EXCLUDED = new Set(CUSTOM.exclude || []);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** "mega-charizard-x" -> "Mega Charizard X" */
function titleCase(slug) {
  if (!slug) return '';
  return String(slug)
    .split(/[-_ ]+/)
    .filter(Boolean)
    .map((w) => {
      if (w === 'gmax') return 'Gmax';
      if (/^[xyz]$/.test(w)) return w.toUpperCase();
      if (/^\d+$/.test(w)) return w;
      return w[0].toUpperCase() + w.slice(1);
    })
    .join(' ');
}

/** Drop characters Windows refuses in a folder name. */
function safeFolder(name) {
  const cleaned = String(name)
    .replace(/[<>:"/\|?*]/g, '')
    .split('')
    .filter((ch) => ch.charCodeAt(0) >= 32)   // drop control characters
    .join('')
    .trim()
    .replace(/\.+$/, '');
  return cleaned || 'Unknown';
}


/** Trailing id out of a PokeAPI url: ".../pokemon/25/" -> 25 */
function idFromUrl(url) {
  const m = /\/(\d+)\/?$/.exec(url || '');
  return m ? Number(m[1]) : null;
}

function english(entries, field) {
  if (!Array.isArray(entries)) return null;
  const hit = entries.find((e) => e.language && e.language.name === 'en');
  return hit ? hit[field] : null;
}

/** PokeAPI flavor text is full of hard line breaks and soft hyphens. */
function cleanText(text) {
  return String(text || '')
    .replace(/[\n\f\r­]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function namesByLanguage(names) {
  const out = {};
  for (const n of names || []) out[n.language.name] = n.name;
  return out;
}

/** Every English flavour entry, newest first, de-duplicated by text. */
function flavorEntries(entries, textField = 'flavor_text') {
  const seen = new Set();
  const out = [];
  for (const e of entries || []) {
    if (!e.language || e.language.name !== 'en') continue;
    const text = cleanText(e[textField]);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push({
      text,
      version: (e.version && e.version.name) || (e.version_group && e.version_group.name) || null,
    });
  }
  return out.reverse();
}

async function writeJson(filePath, data, pretty = true) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(data, null, pretty ? 2 : 0));
}

// ---------------------------------------------------------------------------
// Progress line
// ---------------------------------------------------------------------------

let progress = { label: '', done: 0, total: 0, cached: 0 };

function startProgress(label, total) {
  progress = { label, done: 0, total, cached: 0 };
  drawProgress();
}

function drawProgress() {
  if (!progress.total) return;
  const pct = Math.floor((progress.done / progress.total) * 100);
  process.stdout.write(
    CR + `  ${progress.label}: ${progress.done}/${progress.total} (${pct}%)  ${progress.cached} from cache    `
  );
}

function tickProgress(fromCache) {
  progress.done += 1;
  if (fromCache) progress.cached += 1;
  if (progress.done % 5 === 0 || progress.done === progress.total) drawProgress();
}

function endProgress() {
  if (progress.total) {
    progress.done = progress.total;
    drawProgress();
    console.log('');
  }
  progress.total = 0;
}

// ---------------------------------------------------------------------------
// Cached fetching
// ---------------------------------------------------------------------------

/** Mirror the API path into the cache: .../pokemon/25/ -> Data/.cache/pokemon/25.json */
function cachePathFor(url) {
  const u = new URL(url);
  let rel = u.pathname.replace(/^\/api\/v2\//, '').replace(/^\/+|\/+$/g, '');
  if (u.search) rel += '_' + u.search.replace(/[^a-z0-9=&]/gi, '_');
  return path.join(CACHE, ...rel.split('/')) + '.json';
}

async function fetchWithRetry(url, asBuffer = false) {
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });

      if (res.status === 404) return null;

      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : 1000 * Math.pow(2, attempt);
        lastError = new Error(`HTTP ${res.status} on ${url}`);
        if (attempt < MAX_RETRIES) {
          await sleep(wait);
          continue;
        }
        throw lastError;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);

      return asBuffer ? Buffer.from(await res.arrayBuffer()) : await res.json();
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        await sleep(1000 * Math.pow(2, attempt));
        continue;
      }
    }
  }

  throw lastError;
}

/** JSON fetch backed by Data/.cache. Returns null for 404s. */
async function getJson(url) {
  const cacheFile = cachePathFor(url);

  try {
    const raw = await fsp.readFile(cacheFile, 'utf8');
    tickProgress(true);
    return raw === 'null' ? null : JSON.parse(raw);
  } catch {
    // not cached yet
  }

  const data = await fetchWithRetry(url, false);
  await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
  await fsp.writeFile(cacheFile, JSON.stringify(data));
  await sleep(REQUEST_DELAY);
  tickProgress(false);
  return data;
}

/** Download an image unless it is already on disk. */
async function getImage(url, destPath) {
  if (!url) return false;

  try {
    const stat = await fsp.stat(destPath);
    if (stat.size > 0) {
      tickProgress(true);
      return true;
    }
  } catch {
    // not downloaded yet
  }

  let buf = null;
  try {
    buf = await fetchWithRetry(url, true);
  } catch {
    buf = null; // a dead curated link should not abort the whole import
  }

  if (!buf) {
    tickProgress(false);
    return false;
  }

  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  await fsp.writeFile(destPath, buf);
  await sleep(REQUEST_DELAY);
  tickProgress(false);
  return true;
}

/** Run `worker` over `items` with at most `concurrency` in flight. */
async function pool(items, worker, concurrency = CONCURRENCY) {
  const results = new Array(items.length);
  let next = 0;

  async function run() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

/** Every entry of a list endpoint, as full objects, sorted by id. */
async function fetchAll(resource, label, limit = 0) {
  const list = await getJson(`${API}/${resource}?limit=100000&offset=0`);
  let urls = list.results.map((r) => r.url);
  if (limit > 0) urls = urls.slice(0, limit);
  startProgress(label, urls.length);
  const all = await pool(urls, (u) => getJson(u));
  endProgress();
  return all.filter(Boolean).sort((a, b) => a.id - b.id);
}

// ---------------------------------------------------------------------------
// Pokemon - shaping
// ---------------------------------------------------------------------------

function genderInfo(species) {
  const rate = species.gender_rate; // -1 = genderless, otherwise eighths female

  if (rate < 0) {
    return {
      genderless: true,
      malePercent: 0,
      femalePercent: 0,
      genderRate: rate,
      hasGenderDifferences: species.has_gender_differences,
    };
  }

  const female = (rate / 8) * 100;
  return {
    genderless: false,
    malePercent: Number((100 - female).toFixed(1)),
    femalePercent: Number(female.toFixed(1)),
    genderRate: rate,
    hasGenderDifferences: species.has_gender_differences,
  };
}

function evolutionCondition(detail) {
  const out = { trigger: detail.trigger ? detail.trigger.name : null };

  const values = {
    minLevel: detail.min_level,
    minHappiness: detail.min_happiness,
    minBeauty: detail.min_beauty,
    minAffection: detail.min_affection,
    gender: detail.gender,
    timeOfDay: detail.time_of_day,
    needsOverworldRain: detail.needs_overworld_rain,
    turnUpsideDown: detail.turn_upside_down,
    relativePhysicalStats: detail.relative_physical_stats,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value !== null && value !== undefined && value !== '' && value !== false) out[key] = value;
  }

  const refs = {
    item: detail.item,
    heldItem: detail.held_item,
    knownMove: detail.known_move,
    knownMoveType: detail.known_move_type,
    location: detail.location,
    partySpecies: detail.party_species,
    partyType: detail.party_type,
    tradeSpecies: detail.trade_species,
  };
  for (const [key, value] of Object.entries(refs)) {
    if (value) out[key] = value.name;
  }

  return out;
}

/** Turn the nested evolution chain into a flat, ordered list. */
function flattenChain(node, out = [], stage = 1, from = null) {
  out.push({
    id: idFromUrl(node.species.url),
    name: node.species.name,
    displayName: titleCase(node.species.name),
    stage,
    evolvesFrom: from,
    conditions: (node.evolution_details || []).map(evolutionCondition),
  });

  for (const child of node.evolves_to || []) {
    flattenChain(child, out, stage + 1, node.species.name);
  }

  return out;
}

function slimMoves(moves) {
  return (moves || [])
    .map((m) => ({
      name: m.move.name,
      displayName: titleCase(m.move.name),
      learn: m.version_group_details.map((v) => ({
        method: v.move_learn_method.name,
        level: v.level_learned_at,
        versionGroup: v.version_group.name,
      })),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function spriteUrls(sprites) {
  const other = sprites.other || {};
  const artwork = other['official-artwork'] || {};
  const home = other.home || {};
  const showdown = other.showdown || {};
  const dream = other.dream_world || {};

  return {
    artwork: artwork.front_default || null,
    artworkShiny: artwork.front_shiny || null,
    home: home.front_default || null,
    homeShiny: home.front_shiny || null,
    showdown: showdown.front_default || null,
    showdownShiny: showdown.front_shiny || null,
    dreamWorld: dream.front_default || null,
    front: sprites.front_default || null,
    frontShiny: sprites.front_shiny || null,
    frontFemale: sprites.front_female || null,
    frontShinyFemale: sprites.front_shiny_female || null,
    back: sprites.back_default || null,
    backShiny: sprites.back_shiny || null,
  };
}

function statsBlock(stats) {
  const keys = {
    hp: 'hp',
    attack: 'attack',
    defense: 'defense',
    'special-attack': 'specialAttack',
    'special-defense': 'specialDefense',
    speed: 'speed',
  };

  const base = {};
  const effort = {};
  let total = 0;

  for (const s of stats || []) {
    const key = keys[s.stat.name] || s.stat.name;
    base[key] = s.base_stat;
    effort[key] = s.effort;
    total += s.base_stat;
  }

  return { base, total, effortYield: effort };
}

/** Regional forms override the species' region. */
function regionForForm(slug, speciesRegion) {
  // "pikachu-alola-cap" is one of Ash's hats, not an Alolan Pikachu.
  if (slug.endsWith('-cap')) return speciesRegion;

  for (const [key, region] of Object.entries(FORM_REGIONS)) {
    if (slug.includes(`-${key}`)) return region;
  }
  return speciesRegion;
}

/**
 * What to call a form on a card: "Ho-Oh", "Ninetales Alola", "Kommo-o Totem".
 *
 * The species part uses PokeAPI's English name (which keeps punctuation); only
 * the form suffix is title-cased from the slug.
 */
function formDisplayName(slug, speciesSlug, speciesDisplay) {
  if (slug === speciesSlug) return speciesDisplay;

  if (slug.startsWith(`${speciesSlug}-`)) {
    return `${speciesDisplay} ${titleCase(slug.slice(speciesSlug.length + 1))}`.trim();
  }

  return titleCase(slug);
}

/** Folder name for a form: "Default", "Mega X", "Alola", "Fighting". */
function formFolder(slug, speciesSlug) {
  if (CUSTOM.rename && CUSTOM.rename[slug]) return safeFolder(CUSTOM.rename[slug]);
  const tail = slug.startsWith(speciesSlug) ? slug.slice(speciesSlug.length).replace(/^-/, '') : slug;
  return safeFolder(titleCase(tail) || 'Default');
}

// ---------------------------------------------------------------------------
// Pokemon - import
// ---------------------------------------------------------------------------

async function importPokemon(options) {
  console.log('');
  console.log('=== Pokemon ===');

  const generations = await fetchAll('generation', 'generations');
  const regionByGeneration = {};
  for (const g of generations) {
    regionByGeneration[g.name] = g.main_region ? titleCase(g.main_region.name) : null;
  }

  const allSpecies = await fetchAll('pokemon-species', 'species', options.limit);

  // every variety of every species
  const varietyUrls = [];
  for (const s of allSpecies) {
    for (const v of s.varieties) varietyUrls.push(v.pokemon.url);
  }
  startProgress('varieties', varietyUrls.length);
  const varieties = await pool(varietyUrls, (u) => getJson(u));
  endProgress();

  const pokemonById = new Map();
  const pokemonByName = new Map();
  for (const p of varieties) {
    if (!p) continue;
    pokemonById.set(p.id, p);
    pokemonByName.set(p.name, p);
  }

  // every form of every variety - this is the real roster, 1579 of them
  const formUrls = [];
  for (const p of pokemonByName.values()) {
    for (const f of p.forms) formUrls.push(f.url);
  }
  startProgress('forms', formUrls.length);
  const formList = await pool(formUrls, (u) => getJson(u));
  endProgress();

  const formsByVariety = new Map();
  for (const f of formList) {
    if (!f) continue;
    const v = f.pokemon.name;
    if (!formsByVariety.has(v)) formsByVariety.set(v, []);
    formsByVariety.get(v).push(f);
  }
  for (const list of formsByVariety.values()) {
    list.sort((a, b) => (a.form_order || 0) - (b.form_order || 0) || a.name.localeCompare(b.name));
  }

  // evolution chains
  const chainUrls = [
    ...new Set(allSpecies.map((s) => s.evolution_chain && s.evolution_chain.url).filter(Boolean)),
  ];
  startProgress('evolution chains', chainUrls.length);
  const chainList = await pool(chainUrls, (u) => getJson(u));
  endProgress();

  const chainById = new Map();
  for (const c of chainList) {
    if (c) chainById.set(c.id, flattenChain(c.chain));
  }

  // custom forms grouped by species
  const customBySpecies = new Map();
  for (const c of CUSTOM.forms || []) {
    if (!customBySpecies.has(c.species)) customBySpecies.set(c.species, []);
    customBySpecies.get(c.species).push(c);
  }

  // -- write folders -------------------------------------------------------

  const index = { species: [], forms: [] };
  const imageJobs = [];
  let missingRate = 0;

  process.stdout.write('  writing folders...');

  for (const species of allSpecies) {
    const speciesDir = path.join(DATA, 'Pokemon', String(species.id));
    const generation = species.generation ? species.generation.name : null;
    let region = generation ? regionByGeneration[generation] || null : null;
    if (HISUI_SPECIES.has(species.id)) region = 'Hisui';

    const dexNumbers = {};
    for (const entry of species.pokedex_numbers || []) {
      dexNumbers[entry.pokedex.name] = entry.entry_number;
    }

    const chainId = idFromUrl(species.evolution_chain && species.evolution_chain.url);
    const chain = chainId ? chainById.get(chainId) || [] : [];
    const inChain = chain.find((c) => c.id === species.id);
    const rates = FORM_RATES[species.id] || {};

    // flatten every form of every variety into one ordered roster
    const roster = [];
    for (const v of species.varieties) {
      const variety = pokemonByName.get(v.pokemon.name);
      if (!variety) continue;
      for (const form of formsByVariety.get(variety.name) || []) {
        if (EXCLUDED.has(form.name)) continue;
        roster.push({ form, variety });
      }
    }
    for (const c of customBySpecies.get(species.id) || []) {
      const base = pokemonByName.get(c.basedOn);
      if (base) roster.push({ custom: c, variety: base });
    }

    const speciesGender = genderInfo(species);

    const localised = namesByLanguage(species.names);

    // Everything true of the species no matter which form you get.
    const info = {
      id: species.id,
      name: species.name,

      // PokeAPI's English name rather than the slug, which has lost its
      // punctuation ("Ho-Oh", "Type: Null", "Mr. Mime"). Name matching is
      // handled separately by Utils/names.js.
      displayName: localised.en || titleCase(species.name),

      genus: english(species.genera, 'genus'),
      names: localised,
      dex: { national: species.id, order: species.order, entries: dexNumbers },
      generation,
      region,
      rarity: {
        isLegendary: species.is_legendary || EXTRA_LEGENDARY.has(species.id),
        isMythical: species.is_mythical,
        isBaby: species.is_baby,
        isUltraBeast: ULTRA_BEASTS.has(species.id),
        isPseudoLegendary: PSEUDO_LEGENDARIES.has(species.id),
        isParadox: EXTRA_LEGENDARY.has(species.id),
        captureRate: species.capture_rate,
        baseHappiness: species.base_happiness,
      },
      gender: speciesGender,
      breeding: {
        eggGroups: (species.egg_groups || []).map((g) => g.name),
        hatchCounter: species.hatch_counter,
        growthRate: species.growth_rate ? species.growth_rate.name : null,
      },
      appearance: {
        color: species.color ? species.color.name : null,
        shape: species.shape ? species.shape.name : null,
        habitat: species.habitat ? species.habitat.name : null,
      },
      evolution: {
        chainId,
        stage: inChain ? inChain.stage : 1,
        evolvesFrom: species.evolves_from_species ? species.evolves_from_species.name : null,
        conditions: inChain ? inChain.conditions : [],
        chain,
      },
      flavorText: flavorEntries(species.flavor_text_entries),
      formsSwitchable: species.forms_switchable,
      formCount: roster.length,
      forms: [],
      source: `${API}/pokemon-species/${species.id}`,
    };

    // -- one folder per form ------------------------------------------------
    const usedFolders = new Set();

    for (const entry of roster) {
      const { variety } = entry;
      const isCustom = Boolean(entry.custom);
      const slug = isCustom ? entry.custom.slug : entry.form.name;

      let folderName = isCustom
        ? safeFolder(entry.custom.name)
        : formFolder(slug, species.name);
      while (usedFolders.has(folderName)) folderName += '+';
      usedFolders.add(folderName);

      const formDir = path.join(speciesDir, folderName);
      const urls = spriteUrls(variety.sprites);

      // typing comes from the form, the only place per-form types are recorded
      const types = isCustom
        ? (variety.types || []).sort((a, b) => a.slot - b.slot).map((t) => t.type.name)
        : (entry.form.types || []).sort((a, b) => a.slot - b.slot).map((t) => t.type.name);

      // A form only wears its variety's official artwork when it IS that
      // variety's default look. Every other form needs a curated image.
      const usesVarietyArt = !isCustom && entry.form.is_default;
      const curated = isCustom
        ? { art: entry.custom.art, shiny: entry.custom.shiny }
        : ARTWORK[slug] || {};

      const artUrl = usesVarietyArt ? urls.artwork : null;
      const shinyUrl = usesVarietyArt ? urls.artworkShiny : null;
      const downloadArt = artUrl ? null : curated.art || null;
      const downloadShiny = shinyUrl ? null : curated.shiny || null;

      const percentage = slug in rates ? rates[slug] : 0;
      if (!(slug in rates)) missingRate++;

      const genderLock = (CUSTOM.genderLock && CUSTOM.genderLock[slug]) || null;

      const data = {
        id: isCustom ? null : entry.form.id,
        slug,
        name: isCustom ? entry.custom.name : entry.form.name,
        // Uses the species' English name plus the form suffix (see above).
        displayName: isCustom
          ? `${info.displayName} ${entry.custom.name}`
          : formDisplayName(entry.form.name, species.name, info.displayName),
        formName: folderName,
        folder: folderName,
        species: { id: species.id, name: species.name },
        isDefault: isCustom ? false : Boolean(entry.form.is_default) && variety.is_default,
        isCustom,
        isMega: isCustom ? false : Boolean(entry.form.is_mega),
        isGmax: slug.endsWith('-gmax'),
        isBattleOnly: isCustom ? false : Boolean(entry.form.is_battle_only),
        triggerConditions: isCustom
          ? []
          : (entry.form.trigger_conditions || []).map((t) => t.name),

        dropPercentage: percentage,
        genderLock,

        types,
        pastTypes: (variety.past_types || []).map((p) => ({
          generation: p.generation.name,
          types: p.types.sort((a, b) => a.slot - b.slot).map((t) => t.type.name),
        })),
        region: regionForForm(slug, region),

        stats: statsBlock(variety.stats),
        abilities: (variety.abilities || []).map((a) => ({
          name: a.ability ? a.ability.name : null,
          displayName: a.ability ? titleCase(a.ability.name) : null,
          isHidden: a.is_hidden,
          slot: a.slot,
        })),
        physical: {
          heightMeters: variety.height / 10,
          weightKilograms: variety.weight / 10,
          heightDecimetres: variety.height,
          weightHectograms: variety.weight,
          baseExperience: variety.base_experience,
        },
        gender: genderLock
          ? { genderless: false, malePercent: genderLock === 'male' ? 100 : 0, femalePercent: genderLock === 'female' ? 100 : 0, lockedBy: 'form' }
          : speciesGender,
        cries: variety.cries || null,
        heldItems: (variety.held_items || []).map((h) => h.item.name),

        images: {
          artwork: artUrl || (downloadArt ? 'artwork.png' : null),
          artworkShiny: shinyUrl || (downloadShiny ? 'artwork-shiny.png' : null),
          artworkIsLocal: !artUrl && Boolean(downloadArt),
          shinyIsLocal: !shinyUrl && Boolean(downloadShiny),
        },
        spriteUrls: urls,
        moves: slimMoves(variety.moves),
        source: isCustom ? null : `${API}/pokemon-form/${entry.form.id}`,
      };

      await writeJson(path.join(formDir, 'data.json'), data);

      info.forms.push({
        folder: folderName,
        slug,
        displayName: data.displayName,
        percentage,
        types,
      });

      index.forms.push({
        slug,
        displayName: data.displayName,
        speciesId: species.id,
        folder: folderName,
        path: `${species.id}/${folderName}`,
        percentage,
        isDefault: data.isDefault,
        isCustom,
        isMega: data.isMega,
        isGmax: data.isGmax,
        isBattleOnly: data.isBattleOnly,
        genderLock,
        types,
        region: data.region,
      });

      if (options.images) {
        if (downloadArt) imageJobs.push([downloadArt, path.join(formDir, 'artwork.png')]);
        if (downloadShiny) imageJobs.push([downloadShiny, path.join(formDir, 'artwork-shiny.png')]);
      }
    }

    await writeJson(path.join(speciesDir, 'info.json'), info);

    index.species.push({
      id: species.id,
      name: species.name,
      displayName: info.displayName,
      folder: String(species.id),
      generation,
      region,
      rarity: info.rarity,
      forms: info.forms.map((f) => f.folder),
    });
  }

  console.log(' done');

  index.species.sort((a, b) => a.id - b.id);
  await writeJson(path.join(DATA, 'Pokemon', 'index.json'), {
    generatedAt: new Date().toISOString(),
    source: 'https://pokeapi.co/docs/v2',
    speciesCount: index.species.length,
    formCount: index.forms.length,
    species: index.species,
    forms: index.forms,
  });

  if (missingRate) {
    console.log(`  note: ${missingRate} forms had no entry in formrates.js and default to 0%`);
  }

  if (imageJobs.length) {
    startProgress('artwork downloads', imageJobs.length);
    await pool(imageJobs, ([url, dest]) => getImage(url, dest));
    endProgress();
  }

  return { species: index.species.length, forms: index.forms.length, downloaded: imageJobs.length };
}

// ---------------------------------------------------------------------------
// Other resources
// ---------------------------------------------------------------------------

/**
 * Generic importer: Data/<folder>/<id>/data.json, plus an optional sprite.
 * `shape` maps the raw API object to what we store.
 */
async function importResource({ resource, folder, label, shape, spriteUrl, options }) {
  console.log('');
  console.log(`=== ${label} ===`);

  const all = await fetchAll(resource, label.toLowerCase(), options.limit);
  const outDir = path.join(DATA, folder);
  const index = [];
  const imageJobs = [];

  process.stdout.write('  writing folders...');

  for (const raw of all) {
    const entryDir = path.join(outDir, String(raw.id));
    const data = shape(raw);
    await writeJson(path.join(entryDir, 'data.json'), data);

    index.push({
      id: raw.id,
      name: raw.name,
      displayName: titleCase(raw.name),
      folder: String(raw.id),
    });

    if (options.images && spriteUrl) {
      const url = spriteUrl(raw);
      if (url) imageJobs.push([url, path.join(entryDir, 'sprite.png')]);
    }
  }

  console.log(' done');

  await writeJson(path.join(outDir, 'index.json'), {
    generatedAt: new Date().toISOString(),
    source: `${API}/${resource}`,
    count: index.length,
    entries: index,
  });

  if (imageJobs.length) {
    startProgress('sprites', imageJobs.length);
    await pool(imageJobs, ([url, dest]) => getImage(url, dest));
    endProgress();
  }

  return index.length;
}

const shapeItem = (item) => ({
  id: item.id,
  name: item.name,
  displayName: titleCase(item.name),
  names: namesByLanguage(item.names),
  category: item.category ? item.category.name : null,
  cost: item.cost,
  attributes: (item.attributes || []).map((a) => a.name),
  flingPower: item.fling_power,
  flingEffect: item.fling_effect ? item.fling_effect.name : null,
  effect: cleanText(english(item.effect_entries, 'effect')),
  shortEffect: cleanText(english(item.effect_entries, 'short_effect')),
  flavorText: flavorEntries(item.flavor_text_entries, 'text'),
  heldByPokemon: (item.held_by_pokemon || []).map((h) => h.pokemon.name),
  machines: (item.machines || []).map((m) => m.version_group.name),
  babyTriggerFor: item.baby_trigger_for ? idFromUrl(item.baby_trigger_for.url) : null,
  images: { sprite: item.sprites && item.sprites.default ? 'sprite.png' : null },
  spriteUrl: (item.sprites && item.sprites.default) || null,
  source: `${API}/item/${item.id}`,
});

const shapeMove = (move) => ({
  id: move.id,
  name: move.name,
  displayName: titleCase(move.name),
  names: namesByLanguage(move.names),
  type: move.type ? move.type.name : null,
  damageClass: move.damage_class ? move.damage_class.name : null,
  power: move.power,
  accuracy: move.accuracy,
  pp: move.pp,
  priority: move.priority,
  target: move.target ? move.target.name : null,
  generation: move.generation ? move.generation.name : null,
  effect: cleanText(english(move.effect_entries, 'effect')),
  shortEffect: cleanText(english(move.effect_entries, 'short_effect')),
  effectChance: move.effect_chance,
  meta: move.meta
    ? {
        ailment: move.meta.ailment ? move.meta.ailment.name : null,
        ailmentChance: move.meta.ailment_chance,
        category: move.meta.category ? move.meta.category.name : null,
        critRate: move.meta.crit_rate,
        drain: move.meta.drain,
        healing: move.meta.healing,
        flinchChance: move.meta.flinch_chance,
        statChance: move.meta.stat_chance,
        minHits: move.meta.min_hits,
        maxHits: move.meta.max_hits,
        minTurns: move.meta.min_turns,
        maxTurns: move.meta.max_turns,
      }
    : null,
  statChanges: (move.stat_changes || []).map((s) => ({ stat: s.stat.name, change: s.change })),
  learnedByPokemon: (move.learned_by_pokemon || []).map((p) => p.name),
  machines: (move.machines || []).map((m) => m.version_group.name),
  flavorText: flavorEntries(move.flavor_text_entries),
  source: `${API}/move/${move.id}`,
});

const shapeAbility = (ability) => ({
  id: ability.id,
  name: ability.name,
  displayName: titleCase(ability.name),
  names: namesByLanguage(ability.names),
  generation: ability.generation ? ability.generation.name : null,
  isMainSeries: ability.is_main_series,
  effect: cleanText(english(ability.effect_entries, 'effect')),
  shortEffect: cleanText(english(ability.effect_entries, 'short_effect')),
  flavorText: flavorEntries(ability.flavor_text_entries),
  pokemon: (ability.pokemon || []).map((p) => ({
    name: p.pokemon.name,
    isHidden: p.is_hidden,
    slot: p.slot,
  })),
  source: `${API}/ability/${ability.id}`,
});

const shapeType = (type) => ({
  id: type.id,
  name: type.name,
  displayName: titleCase(type.name),
  names: namesByLanguage(type.names),
  generation: type.generation ? type.generation.name : null,
  damageClass: type.move_damage_class ? type.move_damage_class.name : null,
  damageRelations: {
    doubleDamageTo: type.damage_relations.double_damage_to.map((t) => t.name),
    halfDamageTo: type.damage_relations.half_damage_to.map((t) => t.name),
    noDamageTo: type.damage_relations.no_damage_to.map((t) => t.name),
    doubleDamageFrom: type.damage_relations.double_damage_from.map((t) => t.name),
    halfDamageFrom: type.damage_relations.half_damage_from.map((t) => t.name),
    noDamageFrom: type.damage_relations.no_damage_from.map((t) => t.name),
  },
  pokemon: (type.pokemon || []).map((p) => ({ name: p.pokemon.name, slot: p.slot })),
  moveCount: (type.moves || []).length,
  source: `${API}/type/${type.id}`,
});

const shapeNature = (nature) => ({
  id: nature.id,
  name: nature.name,
  displayName: titleCase(nature.name),
  names: namesByLanguage(nature.names),
  increasedStat: nature.increased_stat ? nature.increased_stat.name : null,
  decreasedStat: nature.decreased_stat ? nature.decreased_stat.name : null,
  likesFlavor: nature.likes_flavor ? nature.likes_flavor.name : null,
  hatesFlavor: nature.hates_flavor ? nature.hates_flavor.name : null,
  source: `${API}/nature/${nature.id}`,
});

const shapeBerry = (berry) => ({
  id: berry.id,
  name: berry.name,
  displayName: titleCase(berry.name),
  item: berry.item ? berry.item.name : null,
  firmness: berry.firmness ? berry.firmness.name : null,
  naturalGiftType: berry.natural_gift_type ? berry.natural_gift_type.name : null,
  naturalGiftPower: berry.natural_gift_power,
  growthTime: berry.growth_time,
  maxHarvest: berry.max_harvest,
  size: berry.size,
  smoothness: berry.smoothness,
  soilDryness: berry.soil_dryness,
  flavors: (berry.flavors || []).map((f) => ({ flavor: f.flavor.name, potency: f.potency })),
  images: { sprite: 'sprite.png' },
  source: `${API}/berry/${berry.id}`,
});

/** Berry sprites live on the matching item, not the berry itself. */
async function importBerries(options) {
  const count = await importResource({
    resource: 'berry',
    folder: 'Berries',
    label: 'Berries',
    shape: shapeBerry,
    options: { images: false, limit: options.limit },
  });

  if (!options.images) return count;

  const berriesDir = path.join(DATA, 'Berries');
  const index = JSON.parse(await fsp.readFile(path.join(berriesDir, 'index.json'), 'utf8'));

  // Two network calls per berry, so this loop counts itself rather than
  // leaning on the shared progress line.
  const total = index.entries.length;
  let done = 0;
  process.stdout.write(CR + `  berry sprites: 0/${total}    `);

  await pool(index.entries, async (entry) => {
    const berryFile = path.join(berriesDir, entry.folder, 'data.json');
    const berry = JSON.parse(await fsp.readFile(berryFile, 'utf8'));

    if (berry.item) {
      const item = await getJson(`${API}/item/${berry.item}`);
      const url = item && item.sprites ? item.sprites.default : null;

      if (url) {
        await getImage(url, path.join(berriesDir, entry.folder, 'sprite.png'));
      } else {
        // A few berries have no sprite upstream, so don't claim one.
        berry.images = { sprite: null };
        await writeJson(berryFile, berry);
      }
    }

    done += 1;
    process.stdout.write(CR + `  berry sprites: ${done}/${total}    `);
  });

  console.log('');

  return count;
}

/** Machines are TM/HM/TR -> move mappings, so we group them by game instead. */
async function importMachines(options) {
  console.log('');
  console.log('=== Machines ===');

  const all = await fetchAll('machine', 'machines', options.limit);
  const byVersionGroup = new Map();

  for (const machine of all) {
    if (!machine.version_group || !machine.item || !machine.move) continue;
    const group = machine.version_group.name;
    if (!byVersionGroup.has(group)) byVersionGroup.set(group, []);
    byVersionGroup.get(group).push({
      id: machine.id,
      machine: machine.item.name,
      displayName: machine.item.name.toUpperCase(),
      move: machine.move.name,
      moveDisplayName: titleCase(machine.move.name),
    });
  }

  process.stdout.write('  writing folders...');

  const index = [];
  for (const [group, machines] of byVersionGroup) {
    machines.sort((a, b) => a.machine.localeCompare(b.machine, undefined, { numeric: true }));
    await writeJson(path.join(DATA, 'Machines', safeFolder(group), 'data.json'), {
      versionGroup: group,
      displayName: titleCase(group),
      count: machines.length,
      machines,
    });
    index.push({ name: group, displayName: titleCase(group), folder: safeFolder(group), count: machines.length });
  }

  console.log(' done');

  await writeJson(path.join(DATA, 'Machines', 'index.json'), {
    generatedAt: new Date().toISOString(),
    source: `${API}/machine`,
    count: all.length,
    versionGroups: index,
  });

  return all.length;
}

// ---------------------------------------------------------------------------
// Local content
//
// Quests and the two shops are defined in Utils/ since PokeAPI has no
// equivalent. These sections copy them into Data/ so everything the bot reads
// at runtime lives in one place.
//
// They make no network requests, so they finish instantly.
// ---------------------------------------------------------------------------

/** Read a generated index.json, or null if that section has not been imported. */
function readIndexIfPresent(...segments) {
  const file = path.join(DATA, ...segments);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** The goal kinds Utils/questprogress.js knows how to evaluate. */
const GOAL_KINDS = new Set(['total-caught', 'type-caught', 'coins-spent', 'shiny-caught']);

/** How many of a quest have to be done. Works for either shape. */
const questRequirement = (quest) =>
  quest.goal ? quest.goal.count : (quest.count ?? quest.requires.length);

/**
 * Copy the quest definitions into Data/Quests.
 *
 * Every dex number and form name is checked against the imported Pokemon
 * data, so typos fail here. If Pokemon hasn't been imported yet, quests are
 * written unvalidated with a warning.
 */
async function importQuests(quests = require('./quests')) {
  console.log('');
  console.log('=== Quests ===');

  const index = readIndexIfPresent('Pokemon', 'index.json');

  if (!index) {
    console.log('  ! Pokemon not imported yet, so dex numbers cannot be checked.');
  }

  const speciesById = new Map((index ? index.species : []).map((s) => [s.id, s]));
  const formsBySpecies = new Map();
  for (const form of index ? index.forms : []) {
    if (!formsBySpecies.has(form.speciesId)) formsBySpecies.set(form.speciesId, new Set());
    formsBySpecies.get(form.speciesId).add(form.folder);
  }

  const problems = [];
  const seen = new Set();

  for (const quest of quests) {
    if (!quest.id) problems.push('a quest is missing an id');
    else if (seen.has(quest.id)) problems.push(`duplicate quest id "${quest.id}"`);
    seen.add(quest.id);

    // A quest is either a list of Pokemon to collect or a counter to reach.
    const hasRequires = Array.isArray(quest.requires) && quest.requires.length;

    if (quest.goal) {
      if (hasRequires) problems.push(`${quest.id}: has both a goal and a requires list`);
      if (!GOAL_KINDS.has(quest.goal.kind)) {
        problems.push(
          `${quest.id}: unknown goal kind "${quest.goal.kind}". ` +
            `Known: ${[...GOAL_KINDS].join(', ')}`
        );
      }
      if (!(quest.goal.count > 0)) problems.push(`${quest.id}: goal count must be above zero`);

      // A type goal that names a type nothing has would never advance.
      if (quest.goal.kind === 'type-caught') {
        const types = readIndexIfPresent('Types', 'index.json');
        const known = types ? new Set(types.entries.map((t) => t.name)) : null;
        if (!quest.goal.type) problems.push(`${quest.id}: a type-caught goal needs a type`);
        else if (known && !known.has(quest.goal.type)) {
          problems.push(`${quest.id}: no type called "${quest.goal.type}"`);
        }
      }

      continue;
    }

    if (!hasRequires) {
      problems.push(`${quest.id}: needs either a requires list or a goal`);
      continue;
    }

    if (quest.count != null && quest.count > quest.requires.length) {
      problems.push(
        `${quest.id}: count is ${quest.count} but there are only ${quest.requires.length} requirements`
      );
    }

    if (!index) continue;

    for (const requirement of quest.requires) {
      const species = speciesById.get(requirement.dex);
      if (!species) {
        problems.push(`${quest.id}: no species with dex ${requirement.dex}`);
        continue;
      }
      if (requirement.form && !(formsBySpecies.get(requirement.dex) || new Set()).has(requirement.form)) {
        problems.push(`${quest.id}: ${species.name} has no form "${requirement.form}"`);
      }
    }
  }

  if (problems.length) {
    throw new Error(`Quest definitions are invalid:\n  - ${problems.join('\n  - ')}`);
  }

  // Rewrite from scratch so a quest deleted from the source stops existing.
  await fsp.rm(path.join(DATA, 'Quests'), { recursive: true, force: true });

  const summary = [];
  for (const quest of quests) {
    const folder = safeFolder(quest.id);
    await writeJson(path.join(DATA, 'Quests', folder, 'data.json'), quest);
    summary.push({
      id: quest.id,
      folder,
      region: quest.region || null,
      collection: quest.collection || quest.id,
      kind: quest.kind || (quest.goal ? 'achievement' : 'collection'),
      required: questRequirement(quest),
      gold: (quest.reward || {}).gold || 0,
    });
  }

  await writeJson(path.join(DATA, 'Quests', 'index.json'), {
    generatedAt: new Date().toISOString(),
    source: 'Utils/quests.js',
    count: summary.length,
    quests: summary,
  });

  console.log(`  ${summary.length} quests written${index ? ' and validated' : ''}`);
  return summary.length;
}

/**
 * Copy the coin shop into Data/Shop.
 *
 * Each entry names an item slug and a price; the rest comes from Data/Items at
 * runtime. Slugs are validated here.
 */
async function importShop() {
  console.log('');
  console.log('=== Shop ===');

  const shop = require('./shop');
  const index = readIndexIfPresent('Items', 'index.json');

  if (!index) {
    console.log('  ! Items not imported yet, so item slugs cannot be checked.');
  }

  const slugs = new Set((index ? index.entries || index.items || [] : []).map((e) => e.name));
  const problems = [];
  const seen = new Set();
  let count = 0;

  // Valid lootbox tiers, read from Utils/lootbox.js, plus 'none' (never drops).
  const TIERS = new Set([...Object.keys(require('./lootbox').TIERS), 'none']);

  // The Pokemon index, to check form-change items against real forms with
  // artwork.
  const pokedex = readIndexIfPresent('Pokemon', 'index.json');
  const formsBySpecies = new Map();
  for (const form of (pokedex && pokedex.forms) || []) {
    if (!formsBySpecies.has(form.speciesId)) formsBySpecies.set(form.speciesId, new Set());
    formsBySpecies.get(form.speciesId).add(form.folder);
  }

  for (const section of shop.sections || []) {
    for (const entry of section.items || []) {
      count += 1;
      const where = `${section.name}: ${entry.item || '(no slug)'}`;

      if (!entry.item) problems.push(`${section.name}: an entry has no item slug`);
      // Entries with their own definition don't need to be in Data/Items.
      else if (!entry.define && slugs.size && !slugs.has(entry.item)) {
        problems.push(`${where}: no such item in Data/Items`);
      }

      if (entry.item && seen.has(entry.item)) problems.push(`${where}: sold twice`);
      if (entry.item) seen.add(entry.item);

      if (!(entry.price >= 0)) problems.push(`${where}: no price`);

      // Every item must declare a lootbox tier; there is no default.
      if (!entry.tier) problems.push(`${where}: no lootbox tier (use 'none' if it should never drop)`);
      else if (!TIERS.has(entry.tier)) {
        problems.push(`${where}: unknown tier "${entry.tier}" - use ${[...TIERS].join(', ')}`);
      }

      // A form-change item has to point at a form that exists.
      const effect = entry.define && entry.define.effect;
      if (effect && effect.kind === 'form' && !effect.reset && formsBySpecies.size) {
        if (effect.speciesId === null) {
          // A family item must match at least one species' form.
          let users = 0;
          for (const forms of formsBySpecies.values()) {
            for (const folder of forms) {
              if (folder === effect.form || folder.endsWith(` ${effect.form}`)) {
                users += 1;
                break;
              }
            }
          }

          if (!users) {
            problems.push(`${where}: no species in Data/Pokemon has a "${effect.form}" form`);
          }
        } else {
          const forms = formsBySpecies.get(effect.speciesId);

          if (!forms) problems.push(`${where}: species ${effect.speciesId} is not in Data/Pokemon`);
          else if (!forms.has(effect.form)) {
            problems.push(
              `${where}: species ${effect.speciesId} has no "${effect.form}" form ` +
                `(it has: ${[...forms].join(', ')})`
            );
          }
        }
      }
    }
  }

  if (problems.length) {
    throw new Error(`Shop definitions are invalid:\n  - ${problems.join('\n  - ')}`);
  }

  await writeJson(path.join(DATA, 'Shop', 'data.json'), {
    generatedAt: new Date().toISOString(),
    source: 'Utils/shop.js',
    ...shop,
  });

  console.log(`  ${count} items across ${(shop.sections || []).length} sections`);
  return count;
}

/** Copy the gold shop into Data/GoldShop. */
async function importGoldShop() {
  console.log('');
  console.log('=== Gold shop ===');

  const goldShop = require('./goldshop');
  const problems = [];
  const seen = new Set();
  const byBuff = new Map();

  for (const entry of goldShop.items || []) {
    if (!entry.id) problems.push('an entry has no id');
    else if (seen.has(entry.id)) problems.push(`duplicate id "${entry.id}"`);
    seen.add(entry.id);

    if (!entry.buff) problems.push(`${entry.id}: no buff name`);
    if (!(entry.price >= 0)) problems.push(`${entry.id}: no price`);
    if (entry.value == null) problems.push(`${entry.id}: no value`);

    if (entry.buff) {
      if (!byBuff.has(entry.buff)) byBuff.set(entry.buff, []);
      byBuff.get(entry.buff).push(entry);
    }
  }

  // Validate tiered buffs: tiers must be consecutive with no gaps or
  // duplicates, since .goldbuy buys them in order.
  for (const [buff, entries] of byBuff) {
    const tiered = entries.filter((e) => e.tier != null);

    if (!tiered.length) {
      if (entries.length > 1) {
        problems.push(`${buff}: ${entries.length} untiered entries share one buff name`);
      }
      continue;
    }

    if (tiered.length !== entries.length) {
      problems.push(`${buff}: some entries have a tier and some do not`);
    }

    const wanted = tiered.map((_, i) => i + 1).join(',');
    const found = tiered.map((e) => e.tier).sort((a, b) => a - b).join(',');
    if (wanted !== found) problems.push(`${buff}: tiers are ${found}, expected ${wanted}`);

    // Each tier must be worth more than the one below.
    const ordered = [...tiered].sort((a, b) => a.tier - b.tier);
    for (let i = 1; i < ordered.length; i += 1) {
      if (!(ordered[i].value > ordered[i - 1].value)) {
        problems.push(`${buff}: tier ${ordered[i].tier} is not worth more than tier ${ordered[i - 1].tier}`);
      }
    }
  }

  if (problems.length) {
    throw new Error(`Gold shop definitions are invalid:\n  - ${problems.join('\n  - ')}`);
  }

  await writeJson(path.join(DATA, 'GoldShop', 'data.json'), {
    generatedAt: new Date().toISOString(),
    source: 'Utils/goldshop.js',
    ...goldShop,
  });

  console.log(`  ${(goldShop.items || []).length} buffs`);
  return (goldShop.items || []).length;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const SECTIONS = {
  pokemon: (options) => importPokemon(options),
  items: (options) =>
    importResource({
      resource: 'item',
      folder: 'Items',
      label: 'Items',
      shape: shapeItem,
      spriteUrl: (item) => (item.sprites ? item.sprites.default : null),
      options,
    }),
  moves: (options) =>
    importResource({ resource: 'move', folder: 'Moves', label: 'Moves', shape: shapeMove, options }),
  abilities: (options) =>
    importResource({
      resource: 'ability',
      folder: 'Abilities',
      label: 'Abilities',
      shape: shapeAbility,
      options,
    }),
  types: (options) =>
    importResource({ resource: 'type', folder: 'Types', label: 'Types', shape: shapeType, options }),
  natures: (options) =>
    importResource({
      resource: 'nature',
      folder: 'Natures',
      label: 'Natures',
      shape: shapeNature,
      options,
    }),
  berries: (options) => importBerries(options),
  machines: (options) => importMachines(options),

  // Local content runs last so it can be validated against the data above.
  quests: () => importQuests(),
  shop: () => importShop(),
  goldshop: () => importGoldShop(),
};

function parseArgs(argv) {
  const options = { images: true, limit: 0, sections: [] };

  for (const arg of argv) {
    if (arg === '--no-images') options.images = false;
    else if (arg.startsWith('--limit=')) options.limit = Number(arg.slice(8)) || 0;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown flag: ${arg}`);
    else options.sections.push(arg.toLowerCase());
  }

  const unknown = options.sections.filter((s) => !SECTIONS[s]);
  if (unknown.length) {
    throw new Error(
      `Unknown section(s): ${unknown.join(', ')}. Available: ${Object.keys(SECTIONS).join(', ')}`
    );
  }

  if (!options.sections.length) options.sections = Object.keys(SECTIONS);
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  if (options.help) {
    console.log(`
PokeDropperV2 data importer

  node Utils/importdata.js                 import everything
  node Utils/importdata.js pokemon items   import only these sections
  node Utils/importdata.js --no-images     skip image downloads
  node Utils/importdata.js --limit=10      first 10 entries per section

Sections: ${Object.keys(SECTIONS).join(', ')}

Responses are cached in Data/.cache, so re-running is cheap and stays within
PokeAPI's fair use policy. Delete that folder to force a fresh pull.

Drop rates live in Utils/formrates.js, custom forms in Utils/custom.js and
artwork PokeAPI cannot supply in Utils/artwork.js.
`);
    return;
  }

  const started = Date.now();
  console.log(`Importing from ${API}`);
  console.log(`Sections: ${options.sections.join(', ')}${options.images ? '' : ' (no images)'}`);

  await fsp.mkdir(CACHE, { recursive: true });

  const summary = {};
  for (const section of options.sections) {
    summary[section] = await SECTIONS[section](options);
  }

  const minutes = ((Date.now() - started) / 60000).toFixed(1);

  await writeJson(path.join(DATA, 'index.json'), {
    generatedAt: new Date().toISOString(),
    source: 'https://pokeapi.co/docs/v2',
    attribution:
      'Data from PokeAPI (https://pokeapi.co). Pokemon and Pokemon character names are trademarks of Nintendo.',
    sections: summary,
  });

  console.log('');
  console.log(`Done in ${minutes} min`);
  for (const [section, count] of Object.entries(summary)) {
    console.log(`  ${section}: ${typeof count === 'object' ? JSON.stringify(count) : count}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('');
    console.error('Import failed:', err.message);
    process.exit(1);
  });
}

module.exports = { main, SECTIONS, importQuests, importShop, importGoldShop };
