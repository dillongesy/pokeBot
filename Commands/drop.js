'use strict';

/**
 * /drop - drops a random Pokemon.
 *
 * Species rarity and the shiny rate come from Utils/rates.js; which form of a
 * species you get comes from the per-form percentages in Utils/formrates.js,
 * baked into Data/Pokemon/index.json at import time.
 *
 * Run `node Commands/drop.js 10` to roll drops in the terminal.
 */

const fs = require('fs');
const path = require('path');

const {
  SlashCommandBuilder,
  EmbedBuilder,
  AttachmentBuilder,
  MessageFlags,
} = require('discord.js');

const rates = require('../Utils/rates');
const rarity = require('../Utils/rarity');
const incense = require('../Utils/incense');
const { createPokemon } = require('../Utils/pokemon');
const store = require('../Utils/store');
const reminders = require('../Utils/reminders');

const POKEMON_DIR = path.join(__dirname, '..', 'Data', 'Pokemon');
const INDEX_FILE = path.join(POKEMON_DIR, 'index.json');

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

/** Embed colour for shinies. */
const SHINY_COLOR = 0xffd700;

const RARITY_LABELS = {
  normal: 'Common',
  legendary: 'Legendary',
  ultraBeast: 'Ultra Beast',
  mythical: 'Mythical',
};

const GENDER_LABELS = {
  male: 'Male',
  female: 'Female',
  genderless: 'Genderless',
};

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

let cached = null;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Group every species by rarity once, keeping each species' forms beside it.
 * Call reload() after re-importing the data.
 */
function load() {
  if (cached) return cached;

  if (!fs.existsSync(INDEX_FILE)) {
    throw new Error('Data/Pokemon/index.json is missing. Run "node Utils/importdata.js pokemon".');
  }

  const index = readJson(INDEX_FILE);

  const formsBySpecies = new Map();
  for (const form of index.forms) {
    if (!formsBySpecies.has(form.speciesId)) formsBySpecies.set(form.speciesId, []);
    formsBySpecies.get(form.speciesId).push(form);
  }

  const byRarity = { normal: [], legendary: [], ultraBeast: [], mythical: [] };
  const speciesById = new Map();
  for (const species of index.species) {
    byRarity[rarity.bucketFor(species.rarity)].push(species);
    speciesById.set(species.id, species);
  }

  cached = { byRarity, formsBySpecies, speciesById };
  return cached;
}

function reload() {
  cached = null;
  return load();
}

// ---------------------------------------------------------------------------
// Rolling
// ---------------------------------------------------------------------------

const pickRandom = (list) => list[Math.floor(Math.random() * list.length)];

/**
 * How many times a regional incense re-rolls the rarity before falling back to
 * choosing directly.
 */
const MAX_RARITY_REROLLS = 100;

/**
 * The rarity percentages in force for one drop.
 *
 * Normally just rates.rarity. A Shiny Incense adds rates.shinyIncenseAddedRates
 * and subtracts the same total from `normal`, so the table still sums to 100.
 * `normal` is floored at zero.
 */
function rarityTable({ shinyIncense = false } = {}) {
  if (!shinyIncense) return rates.rarity;

  const added = rates.shinyIncenseAddedRates || {};
  const table = { ...rates.rarity };
  let taken = 0;

  for (const [bucket, amount] of Object.entries(added)) {
    if (!amount) continue;
    table[bucket] = (table[bucket] || 0) + amount;
    taken += amount;
  }

  table.normal = Math.max(0, (table.normal || 0) - taken);
  return table;
}

/**
 * Roll a rarity from the given percentages, skipping empty buckets.
 */
function rollRarity(byRarity, table = rates.rarity) {
  const options = Object.entries(table).filter(
    ([name, percent]) => percent > 0 && byRarity[name] && byRarity[name].length
  );

  if (!options.length) {
    throw new Error('Every rarity is set to 0 in Utils/rates.js, so nothing can drop.');
  }

  const total = options.reduce((sum, [, percent]) => sum + percent, 0);
  let roll = Math.random() * total;

  for (const [name, percent] of options) {
    roll -= percent;
    if (roll < 0) return name;
  }

  return options[options.length - 1][0];
}

/**
 * Which rarity this drop lands in, honouring whatever is equipped.
 *
 * A rarity incense picks the bucket directly. Otherwise the table is rolled,
 * and a regional incense re-rolls until it lands on a rarity that region has
 * (for example, every Ultra Beast is Alolan, so a Kanto Incense must never
 * land on that tier).
 *
 * Re-rolling keeps the relative odds between the remaining tiers intact. The
 * loop is bounded and has a deterministic fallback.
 */
function pickRarity(byRarity, { shinyIncense = false, forceRarity = null, region = null } = {}) {
  if (forceRarity && byRarity[forceRarity] && byRarity[forceRarity].length) return forceRarity;

  const table = rarityTable({ shinyIncense });
  if (!region || !region.length) return rollRarity(byRarity, table);

  const wanted = new Set(region);
  const hasRegion = (name) => (byRarity[name] || []).some((species) => wanted.has(species.region));

  for (let attempt = 0; attempt < MAX_RARITY_REROLLS; attempt += 1) {
    const bucket = rollRarity(byRarity, table);
    if (hasRegion(bucket)) return bucket;
  }

  // Re-rolls ran out: take any bucket that has the region.
  const possible = Object.keys(table).filter((name) => table[name] > 0 && hasRegion(name));
  if (possible.length) return pickRandom(possible);

  // The region has no Pokemon at all (not in the data). incense.narrow()
  // reports it and the drop goes ahead unfiltered.
  return rollRarity(byRarity, table);
}

/**
 * Pick which form of a species drops, using the percentages set in
 * Utils/formrates.js. Forms at 0% (such as Megas) never drop.
 */
function rollForm(forms) {
  const droppable = forms.filter((f) => f.percentage > 0);

  // Nothing droppable for this species, so fall back to its default form.
  if (!droppable.length) return forms.find((f) => f.isDefault) || forms[0];

  const total = droppable.reduce((sum, f) => sum + f.percentage, 0);
  let roll = Math.random() * total;

  for (const form of droppable) {
    roll -= form.percentage;
    if (roll < 0) return form;
  }

  return droppable[droppable.length - 1];
}

function rollGender(form, speciesGender) {
  if (form.genderLock) return form.genderLock;
  if (!speciesGender || speciesGender.genderless) return 'genderless';
  return Math.random() * 100 < speciesGender.femalePercent ? 'female' : 'male';
}

/**
 * Roll for a natural shiny.
 *
 * `multiplier` is the Shiny Charm from the gold shop. It divides the 1-in-N
 * denominator, so 2 turns 1/4096 into 1/2048.
 */
function rollShiny(multiplier = 1) {
  const scale = Number(multiplier) > 0 ? Number(multiplier) : 1;
  const rate = Number(rates.shinyRate) / scale;

  if (!Number.isFinite(rate) || rate <= 1) return true;
  return Math.random() < 1 / rate;
}

/**
 * Work out what to show. Artwork is either a PokeAPI url we can hand straight
 * to Discord, or a file on disk for the forms PokeAPI cannot render.
 */
function resolveImage(data, formDir, shiny) {
  const wanted = shiny ? 'artworkShiny' : 'artwork';
  const order = shiny ? ['artworkShiny', 'artwork'] : ['artwork', 'artworkShiny'];

  for (const key of order) {
    const value = data.images[key];
    if (!value) continue;

    const isLocal = key === 'artwork' ? data.images.artworkIsLocal : data.images.shinyIsLocal;
    if (!isLocal) return { url: value, file: null, isFallback: key !== wanted };

    const full = path.join(formDir, value);
    if (fs.existsSync(full)) return { url: null, file: full, isFallback: key !== wanted };
  }

  return { url: null, file: null, isFallback: false };
}

/**
 * Roll a drop.
 *
 * @returns {{ species: object, form: object, rarity: string, shiny: boolean,
 *             gender: string, image: object }}
 */
function rollDrop({
  shinyIncense = false,
  forceRarity = null,
  region = null,
  repelChance = 0,
  caught = null,
  shinyMultiplier = 1,
  force = null,
} = {}) {
  const { byRarity, formsBySpecies, speciesById } = load();

  // .forcespawn may fix some of these values; everything else is rolled.
  const chosen = force && force.speciesId ? speciesById.get(force.speciesId) : null;
  if (force && force.speciesId && !chosen) {
    throw new Error(`No species ${force.speciesId} in Data/Pokemon/index.json.`);
  }

  // A Shiny Incense guarantees a shiny and also improves the rarity odds. A
  // natural shiny does not affect rarity.
  const shiny = force && force.shiny !== undefined && force.shiny !== null
    ? !!force.shiny
    : shinyIncense || rollShiny(shinyMultiplier);

  let speciesEntry;
  let bucket;
  let narrowed = { pool: null, notes: [] };

  if (chosen) {
    speciesEntry = chosen;
    bucket = rarity.bucketFor(chosen.rarity);
  } else {
    bucket = pickRarity(byRarity, { shinyIncense, forceRarity, region });

    // Region and repel narrow the pool within the rolled rarity. Either is
    // skipped if it would leave nothing to pick from.
    narrowed = incense.narrow(byRarity[bucket], { region, chance: repelChance, caught });
    speciesEntry = pickRandom(narrowed.pool);
  }

  const forms = formsBySpecies.get(speciesEntry.id) || [];
  const formEntry = (force && force.form && forms.find((f) => f.folder === force.form))
    // A forced form ignores the drop percentages, so 0% forms can be spawned.
    || rollForm(forms);

  const speciesDir = path.join(POKEMON_DIR, speciesEntry.folder);
  const formDir = path.join(speciesDir, formEntry.folder);

  const species = readJson(path.join(speciesDir, 'info.json'));
  const form = readJson(path.join(formDir, 'data.json'));

  return {
    species,
    form,
    rarity: bucket,
    shiny,
    // What the equipped items did, for the card to report.
    notes: narrowed.notes,
    gender: (force && force.gender) || rollGender(formEntry, species.gender),
    image: resolveImage(form, formDir, shiny),
    // IVs, nature, level and stats are generated at drop time, so what
    // appeared is exactly what gets caught.
    mon: createPokemon(species, form, (force && force.mon) || {}),
  };
}

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

const capitalize = (word) => (word ? word[0].toUpperCase() + word.slice(1) : word);

/**
 * The drop card.
 *
 * Intentionally anonymous: no name, dex number, gender or flavour text, since
 * identifying the Pokemon from its artwork is the game. Only the artwork and
 * three clues are shown.
 *
 * The embed colour shows the rarity: blue common, green legendary, pink
 * mythical, purple Ultra Beast, gold shiny.
 */
function buildEmbed(drop) {
  const { form, shiny } = drop;

  return new EmbedBuilder()
    .setColor(shiny ? SHINY_COLOR : rarity.COLORS[drop.rarity] ?? rarity.COLORS.normal)
    .addFields(
      { name: 'Type', value: form.types.map(capitalize).join(' / '), inline: true },
      { name: 'Region', value: form.region || 'Unknown', inline: true },
      { name: 'Base Stat Total', value: String(form.stats.total), inline: true }
    );
}

/**
 * Build the message payload for a drop. Shared by the slash command and the
 * ".d" prefix command, so both render the same embed.
 */
function buildDropMessage(drop, used = {}) {
  const embed = buildEmbed(drop);
  const files = [];

  // Report which equipped items were used and whether they took effect.
  const spent = [used.repel, used.incense].filter(Boolean).map(incense.nameOf);

  if (spent.length) {
    embed.setFooter({
      text: `Used ${spent.join(' + ')}` + (drop.notes && drop.notes.length ? ` · ${drop.notes.join(' · ')}` : ''),
    });
  }

  if (drop.image.url) {
    embed.setImage(drop.image.url);
  } else if (drop.image.file) {
    const fileName = `${drop.form.slug}${drop.shiny ? '-shiny' : ''}.png`;
    files.push(new AttachmentBuilder(drop.image.file, { name: fileName }));
    embed.setImage(`attachment://${fileName}`);
  }

  return { embeds: [embed], files };
}

/**
 * Roll a drop, save it as a wild Pokemon, and post the card.
 *
 * Shared by the prefix command and the slash command. `send` posts the payload
 * and hands back the message, which differs between the two.
 *
 * @returns {{ drop: object, dropId: number, crit: boolean }}
 */
async function performDrop({
  userId,
  guildId,
  channelId,
  send,
  shinyIncense = false,
  // .forcespawn: what to spawn. Admin spawns skip the cooldown and leave
  // equipped items alone.
  force = null,
  spend = true,
}) {
  store.ensureUser(userId);

  // Read and clear both slots in one statement so concurrent drops can't use
  // the same item twice. Items are consumed even if their effect can't apply;
  // the card reports what happened.
  const used = spend ? store.consumeSlots(userId) : { repel: null, incense: null };

  const repel = used.repel ? incense.definitionOf(used.repel) : null;
  const worn = used.incense ? incense.definitionOf(used.incense) : null;

  // A caller can force the shiny path directly; otherwise a Shiny Incense in
  // the slot does it.
  const shinyWanted = shinyIncense || !!(worn && worn.shiny);

  const drop = rollDrop({
    shinyIncense: shinyWanted,
    forceRarity: worn ? worn.rarity || null : null,
    region: worn ? worn.region || null : null,
    repelChance: repel ? repel.chance : 0,
    // The Shiny Charm (permanent gold shop buff).
    shinyMultiplier: store.buffValue(userId, 'shiny_multiplier', 1) || 1,
    // Only queried when a repel is equipped.
    caught: repel ? store.caughtSpeciesIds(userId) : null,
    force,
  });

  const { dropId } = store.createDrop(drop.mon, {
    shiny: drop.shiny,
    gender: drop.gender,
    // Only natural shinies count toward Shiny Dropper. The flag is stored on
    // the Pokemon, so catching someone else's incense shiny doesn't count
    // either. Forced spawns never count.
    shinyNatural: drop.shiny && !shinyWanted && !force,
    guildId,
    channelId,
    droppedBy: userId,
  });

  // One live drop per channel: retire any older drop. Done after the insert
  // and excluding this drop, so it can never retire itself.
  const replaced = store.despawnChannelDrops(channelId, dropId);

  let crit = false;
  if (spend) {
    const started = store.startDropCooldown(userId);
    crit = started.crit;

    // Only schedules a reminder if .remind is on and a cooldown is running.
    if (!crit) reminders.schedule(userId, channelId, started.endsAt);
  }

  const message = await send(buildDropMessage(drop, { repel: used.repel, incense: used.incense }));
  if (message && message.id) store.attachDropMessage(dropId, message.id);

  return { drop, dropId, crit, replaced, used };
}

/** "4m 12s" - how long is left on a cooldown. */
function formatDuration(ms) {
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

module.exports = {
  data: new SlashCommandBuilder().setName('drop').setDescription('Drops a random Pokemon.'),

  /** ".d" and ".drop" both land here. */
  aliases: ['d', 'drop'],

  async execute(interaction) {
    const waiting = store.cooldownRemaining(interaction.user.id);
    if (waiting > 0) {
      await interaction.reply({
        content: `You can drop again in ${formatDuration(waiting)}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    try {
      const { crit } = await performDrop({
        userId: interaction.user.id,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        send: async (payload) => interaction.reply({ ...payload, withResponse: true }),
      });

      // Tell the player their cooldown was refunded by Critical Drop.
      if (crit) await interaction.followUp('Your drop has been instantly reset!');
    } catch (err) {
      const content = `Could not drop a Pokemon: ${err.message}`;
      if (interaction.replied || interaction.deferred) await interaction.followUp({ content });
      else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  },

  async run(message) {
    const waiting = store.cooldownRemaining(message.author.id);
    if (waiting > 0) {
      await message.channel.send(`You can drop again in ${formatDuration(waiting)}.`);
      return;
    }

    const { crit } = await performDrop({
      userId: message.author.id,
      guildId: message.guildId,
      channelId: message.channelId,
      send: async (payload) => message.channel.send(payload),
    });

    if (crit) await message.channel.send('Your drop has been instantly reset!');
  },

  rollDrop,
  rollForm,
  rollRarity,
  pickRarity,
  rollShiny,
  rarityTable,
  buildEmbed,
  buildDropMessage,
  performDrop,
  formatDuration,
  reload,
};

// `node Commands/drop.js [count]` - roll drops in the terminal.
if (require.main === module) {
  const count = Math.max(1, Number(process.argv[2]) || 1);

  for (let i = 0; i < count; i++) {
    const drop = rollDrop();

    const tags = [drop.shiny ? 'SHINY' : null, drop.rarity === 'normal' ? null : drop.rarity]
      .filter(Boolean)
      .join(', ');

    console.log(
      `#${String(drop.species.dex.national).padStart(4, '0')} ${drop.form.displayName}` +
        `  [${drop.form.types.join('/')}]  ${drop.form.region || '?'}  ${drop.gender}` +
        (tags ? `  <${tags}>` : '')
    );
  }
}
