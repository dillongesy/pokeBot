'use strict';

/**
 * .forcespawn - drop exactly what you ask for. Admin only.
 *
 * Takes a species (name or dex number) followed by any number of `key=value`
 * overrides. Anything not specified is rolled as normal.
 *
 *   .forcespawn charizard
 *   .forcespawn charizard form=gmax
 *   .forcespawn 6 form="mega x" shiny
 *   .forcespawn tatsugiri form=droopy gender=female
 *   .forcespawn mewtwo level=100 iv=31 nature=timid ability=hidden
 *   .forcespawn eevee ivs=31/0/31/31/31/0
 *
 * Overrides:
 *   form=<name>     any form, including ones that never drop naturally
 *   level=1-100     shiny            (a bare flag, or shiny=no)
 *   gender=m|f|none nature=<name>
 *   iv=0-31         every IV at once
 *   ivs=a/b/c/d/e/f hp/atk/def/spa/spd/spe, in that order
 *   ability=1|2|hidden
 *
 * The spawn is a normal drop that anyone can catch, with the usual rewards and
 * quest credit. It does not use the admin's cooldown or incense, and a forced
 * shiny does not count toward Shiny Dropper.
 */

const { SlashCommandBuilder, MessageFlags } = require('discord.js');

const admin = require('../Utils/admin');
const names = require('../Utils/names');
const pokemon = require('../Utils/pokemon');
const drop = require('./drop');

const GENDERS = {
  m: 'male', male: 'male', boy: 'male',
  f: 'female', female: 'female', girl: 'female',
  n: 'genderless', none: 'genderless', genderless: 'genderless', nb: 'genderless',
};

const NO = /^(no|false|off|0)$/i;

/** Names are compared with everything but letters and digits removed. */
const fold = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Split the arguments into a species and a bag of overrides.
 *
 * Everything up to the first `key=value` or bare flag is the species, so
 * multi-word names need no quotes. Quoted values keep their spaces
 * (`form="mega x"`), though `form=megax` also works.
 */
function parseArgs(args = []) {
  const words = args.map(String).filter((w) => w.length);
  const options = {};
  const speciesWords = [];

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    const eq = word.indexOf('=');

    if (eq > 0) {
      const key = word.slice(0, eq).toLowerCase();
      let value = word.slice(eq + 1);

      // form="single strike gmax" - swallow words until the quote closes.
      if (/^["']/.test(value)) {
        const quote = value[0];
        value = value.slice(1);
        while (!value.endsWith(quote) && i + 1 < words.length) {
          i += 1;
          value += ` ${words[i]}`;
        }
        value = value.replace(new RegExp(`${quote}$`), '');
      }

      options[key] = value;
      continue;
    }

    // A bare flag, but only one we know - otherwise it is part of the name.
    if (/^(shiny|square)$/i.test(word)) {
      options.shiny = 'yes';
      continue;
    }

    if (Object.keys(options).length) {
      // A stray word after the overrides started: report it.
      options._stray = word;
      continue;
    }

    speciesWords.push(word);
  }

  return { species: speciesWords.join(' ').trim(), options };
}

/**
 * Turn the parsed options into what rollDrop wants, or into a complaint.
 *
 * Every value is validated against the imported data, and invalid values are
 * answered with the list of valid choices.
 *
 * @returns {{ ok: true, force: object } | { ok: false, message: string }}
 */
function buildForce(speciesEntry, options) {
  const force = { speciesId: speciesEntry.id, mon: {} };
  const species = pokemon.loadSpecies(speciesEntry.id);
  const forms = (species && species.forms) || [];

  if (options._stray) {
    return { ok: false, message: `I do not know what \`${options._stray}\` means here.` };
  }

  if (options.form !== undefined) {
    const wanted = fold(options.form);
    const match = forms.find((f) => fold(f.folder) === wanted);

    if (!match) {
      return {
        ok: false,
        message:
          `${speciesEntry.displayName} has no "${options.form}" form. ` +
          `It has: ${forms.map((f) => f.folder).join(', ')}.`,
      };
    }

    force.form = match.folder;
  }

  if (options.shiny !== undefined) force.shiny = !NO.test(options.shiny);

  if (options.gender !== undefined) {
    const gender = GENDERS[String(options.gender).toLowerCase()];
    if (!gender) return { ok: false, message: 'Gender has to be male, female or genderless.' };
    force.gender = gender;
  }

  if (options.level !== undefined) {
    const level = parseInt(options.level, 10);
    if (!Number.isInteger(level) || level < 1 || level > pokemon.MAX_LEVEL) {
      return { ok: false, message: `Level has to be between 1 and ${pokemon.MAX_LEVEL}.` };
    }
    force.mon.level = level;
  }

  // iv=31 sets all six; ivs=31/0/31/31/31/0 sets them one at a time.
  if (options.iv !== undefined || options.ivs !== undefined) {
    const raw = options.ivs !== undefined ? String(options.ivs) : String(options.iv);
    const parts = raw.split(/[\/,\s]+/).filter((p) => p.length);

    if (parts.length !== 1 && parts.length !== pokemon.STATS.length) {
      return {
        ok: false,
        message: `IVs are one number for all six, or six separated by slashes (${pokemon.STATS.join('/')}).`,
      };
    }

    const values = parts.map((p) => parseInt(p, 10));
    if (values.some((v) => !Number.isInteger(v) || v < 0 || v > pokemon.MAX_IV)) {
      return { ok: false, message: `Every IV has to be between 0 and ${pokemon.MAX_IV}.` };
    }

    const ivs = {};
    pokemon.STATS.forEach((stat, i) => {
      ivs[stat] = values.length === 1 ? values[0] : values[i];
    });
    force.mon.ivs = ivs;
  }

  if (options.nature !== undefined) {
    const wanted = fold(options.nature);
    const nature = pokemon.loadNatures().find((n) => fold(n.name) === wanted);
    if (!nature) return { ok: false, message: `There is no "${options.nature}" nature.` };
    force.mon.nature = nature;
  }

  if (options.ability !== undefined) {
    // Abilities depend on the form, so resolve them after the form.
    const folder = force.form || (forms.find((f) => f.percentage > 0) || forms[0] || {}).folder;
    const form = folder ? pokemon.loadForm(speciesEntry.id, folder) : null;
    const abilities = (form && form.abilities) || [];

    if (!abilities.length) {
      return { ok: false, message: `${speciesEntry.displayName} has no abilities in the data.` };
    }

    const wanted = String(options.ability).toLowerCase();
    let picked = null;

    if (wanted === 'hidden' || wanted === 'h') picked = abilities.find((a) => a.isHidden);
    else if (/^\d+$/.test(wanted)) picked = abilities.filter((a) => !a.isHidden)[Number(wanted) - 1];
    else picked = abilities.find((a) => fold(a.name) === fold(wanted));

    if (!picked) {
      return {
        ok: false,
        message:
          `No such ability. ${speciesEntry.displayName} has: ` +
          abilities.map((a, i) => `${a.isHidden ? 'hidden' : i + 1} ${a.name}`).join(', ') + '.',
      };
    }

    force.mon.ability = picked;
  }

  return { ok: true, force };
}

/**
 * Work out what to spawn. Does not touch Discord.
 *
 * @returns {{ ok: true, force: object } | { ok: false, message: string }}
 */
function plan(args = []) {
  const { species: query, options } = parseArgs(args);

  if (!query) {
    return { ok: false, message: 'Spawn what? Try `.forcespawn charizard form=gmax shiny`.' };
  }

  // A bare number is a dex number.
  const speciesEntry = /^\d+$/.test(query)
    ? names.speciesById(Number(query))
    : names.resolveOne(query);

  if (!speciesEntry) {
    return {
      ok: false,
      message: /^\d+$/.test(query)
        ? `There is no Pokemon #${query}.`
        : `I do not know a Pokemon called "${query}".`,
    };
  }

  return buildForce(speciesEntry, options);
}

module.exports = {
  aliases: ['forcespawn', 'fs', 'spawn'],

  data: new SlashCommandBuilder()
    .setName('forcespawn')
    .setDescription('Admin only. Drops exactly what you ask for.')
    .addStringOption((option) =>
      option.setName('species').setDescription('Name or dex number.').setRequired(true)
    )
    .addStringOption((option) => option.setName('form').setDescription('A form folder, even one that never drops.'))
    .addBooleanOption((option) => option.setName('shiny').setDescription('Force shiny.'))
    .addIntegerOption((option) =>
      option.setName('level').setDescription('1-100.').setMinValue(1).setMaxValue(100)
    )
    .addStringOption((option) =>
      option
        .setName('gender')
        .setDescription('Which gender.')
        .addChoices(
          { name: 'male', value: 'male' },
          { name: 'female', value: 'female' },
          { name: 'genderless', value: 'genderless' }
        )
    )
    .addStringOption((option) => option.setName('ivs').setDescription('One number for all six, or hp/atk/def/spa/spd/spe.'))
    .addStringOption((option) => option.setName('nature').setDescription('A nature name.'))
    .addStringOption((option) => option.setName('ability').setDescription('1, 2 or hidden.')),

  async execute(interaction) {
    if (!admin.isAdmin(interaction.user.id)) {
      await interaction.reply({ content: admin.DENIED, flags: MessageFlags.Ephemeral });
      return;
    }

    const args = [interaction.options.getString('species')];
    for (const key of ['form', 'level', 'gender', 'ivs', 'nature', 'ability']) {
      const value = key === 'level'
        ? interaction.options.getInteger('level')
        : interaction.options.getString(key);
      if (value !== null && value !== undefined) args.push(`${key}=${value}`);
    }
    if (interaction.options.getBoolean('shiny')) args.push('shiny');

    const planned = plan(args);
    if (!planned.ok) {
      await interaction.reply({ content: planned.message, flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.reply({ content: 'Spawning…', flags: MessageFlags.Ephemeral });
    await drop.performDrop({
      userId: interaction.user.id,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      send: async (payload) => interaction.channel.send(payload),
      force: planned.force,
      spend: false,
    });
  },

  async run(message, args) {
    if (!admin.isAdmin(message.author.id)) {
      await message.channel.send(admin.DENIED);
      return;
    }

    const planned = plan(args);
    if (!planned.ok) {
      await message.channel.send(planned.message);
      return;
    }

    await drop.performDrop({
      userId: message.author.id,
      guildId: message.guildId,
      channelId: message.channelId,
      send: async (payload) => message.channel.send(payload),
      force: planned.force,
      spend: false,
    });
  },

  parseArgs,
  buildForce,
  plan,
};
