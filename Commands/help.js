'use strict';

/**
 * .help - what the bot does and how to ask it.
 *
 * One group of commands per page. Each line shows the command, a short
 * description and its shortest aliases. `.help <command>` shows one command
 * with all of its aliases.
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const rates = require('../Utils/rates');
const pager = require('../Utils/pager');
const { loadCommands } = require('../Utils/commands');
const admin = require('../Utils/admin');

/**
 * Help content, grouped by topic rather than by file.
 */
const GROUPS = [
  {
    name: '🎯 Catching',
    commands: [
      { name: 'drop', usage: '.d', blurb: 'Drop a wild Pokemon into the channel.' },
      { name: '(type its name)', usage: 'pikachu', blurb: 'Catch it. No command needed - just say what it is.' },
      { name: 'hint', usage: '.hint', blurb: 'Reveal some letters of the current drop.' },
      { name: 'remind', usage: '.remind', blurb: 'Get pinged when your cooldown ends.' },
      {
        name: '(repels & incenses)',
        usage: '.useitem max-repel',
        blurb: 'Steer your next drop. `.shop repels` - one of each can be armed.',
      },
    ],
  },
  {
    name: '📦 Your collection',
    commands: [
      { name: 'party', usage: '.p [sort]', blurb: 'Everything you have caught. `.p shiny`, `.p lvl 25-35`, `.p suggested`.' },
      { name: 'view', usage: '.v <id>', blurb: 'One Pokemon in full - stats, IVs, nature.' },
      { name: 'nickname', usage: '.nick <id> <name>', blurb: 'Rename one. "clear" undoes it.' },
      { name: 'order', usage: '.order <field>', blurb: 'Rearrange the party. `.order battle` builds your team.' },
      { name: 'release', usage: '.release <id>', blurb: 'Let one go. Asks first. Pays nothing.' },
    ],
  },
  {
    name: '💰 Economy',
    commands: [
      { name: 'shop', usage: '.shop', blurb: 'Stock. `.shop repels`, or `.shop eevee` for one species.' },
      { name: 'buy', usage: '.buy <item> [n]', blurb: 'Buy from either shop. Pays in the right currency.' },
      { name: 'goldshop', usage: '.gs', blurb: 'Permanent buffs, bought with quest gold. `.goldbuy <id>`.' },
      { name: 'bag', usage: '.bag', blurb: 'What you are carrying, numbered.' },
      { name: 'examine', usage: '.iv <item>', blurb: 'Read what something in your bag does.' },
      { name: 'useitem', usage: '.useitem <id> <item>', blurb: 'Level, evolve, Mega Evolve or equip. `default` puts a form back.' },
      { name: 'take', usage: '.take <id>', blurb: 'Take back what it is holding. A held form reverts.' },
      { name: 'inventorysort', usage: '.is <mode>', blurb: 'A-Z, shop order, quantity, or `swap a b`.' },
      { name: 'trash', usage: '.trash <item> [n]', blurb: 'Destroy items. Asks first.' },
    ],
  },
  {
    name: '🏆 Progress',
    commands: [
      { name: 'me', usage: '.me', blurb: 'Your coins, gold, buffs and totals.' },
      { name: 'dex', usage: '.dex <name>', blurb: 'Look up any Pokemon. Buttons walk the dex.' },
      { name: 'questprogress', usage: '.qp', blurb: 'What you are closest to finishing. `.qp done` for the rest.' },
      { name: 'count', usage: '.count', blurb: 'How many of each species you own.' },
      { name: 'uncaught', usage: '.u', blurb: 'Every species you have never caught.' },
      { name: 'leaderboard', usage: '.lb [board]', blurb: 'Who is winning. Any Pokemon name works too.' },
    ],
  },
  {
    name: '🤝 Other trainers',
    commands: [
      { name: 'trade', usage: '.t @user <id>', blurb: 'Swap Pokemon. Some evolve on arrival.' },
      { name: 'team', usage: '.team @user', blurb: 'The first six, which are the battle team.' },
      { name: 'compare', usage: '.compare @user', blurb: 'What they have that you do not.' },
    ],
  },
  {
    name: '⚔️ Battling',
    commands: [
      { name: 'battle', usage: '.battle', blurb: 'Fight whatever turns up, with your first six.' },
      { name: 'battle milestone', usage: '.battle milestone', blurb: 'Take on the gym leader waiting for you.' },
      { name: 'moves', usage: '.moves <id>', blurb: 'What one of yours knows, and what is next.' },
      { name: 'tm', usage: '.tm <id> [move]', blurb: 'Teach a move. TMs are reusable.' },
      { name: 'pvp-battle', usage: '.pvp @user', blurb: 'Fight another player.', soon: true },
    ],
  },
  {
    // Server configuration. Not adminOnly: these use Discord's Manage Server
    // permission rather than the bot's admin list, so server staff need to
    // be able to find them.
    name: '⚙️ Server setup',
    commands: [
      { name: 'setchannel', usage: '.setchannel #channel', blurb: 'Confine the bot to certain channels. `remove #x` undoes one.' },
      { name: 'viewchannels', usage: '.viewchannels', blurb: 'Where the bot is allowed to work here.' },
      { name: 'resetchannels', usage: '.resetchannels', blurb: 'Let it work everywhere again. Asks first.' },
    ],
  },
  {
    // Hidden from non-admins, including from .help <command>.
    name: '🔧 Admin',
    adminOnly: true,
    commands: [
      { name: 'forcespawn', usage: '.forcespawn <mon> [key=value]', blurb: 'Drop exactly what you ask for. `form=`, `shiny`, `level=`, `iv=`, `gender=`, `nature=`, `ability=`.' },
      { name: 'give', usage: '.give @user <n> [what]', blurb: 'Coins, gold or items. A negative number takes them back.' },
      { name: 'admin', usage: '.admin add @user', blurb: 'Owner only. Who else may run these.' },
    ],
  },
];

/** The groups this person is allowed to see. */
function groupsFor(userId) {
  return GROUPS.filter((group) => !group.adminOnly || admin.isAdmin(userId));
}

/** Every command in GROUPS, flattened, for looking one up by name. */
function allCommands(userId) {
  return groupsFor(userId).flatMap((group) =>
    group.commands.map((c) => ({ ...c, group: group.name }))
  );
}

/**
 * The prefix names that reach a command, read from the loader so the help
 * always matches the real aliases.
 */
function aliasesFor(name) {
  const { byAlias } = loadCommands();
  const target = byAlias.get(name);
  if (!target) return [];

  return [...byAlias.entries()]
    .filter(([, command]) => command === target)
    .map(([alias]) => alias)
    .sort((a, b) => a.length - b.length);
}

const minutes = Math.round(rates.dropCooldownMs / 60000);

/** Maximum aliases shown per line. */
const ALIASES_SHOWN = 2;

/**
 * The other spellings worth mentioning beside a command's usage.
 *
 * Only the shortest few, excluding whichever one the usage line already shows.
 */
function otherAliases(command) {
  const shown = String(command.usage || '').replace(/^\./, '').split(/\s+/)[0].toLowerCase();

  return aliasesFor(command.name)
    .filter((alias) => alias !== shown)
    .slice(0, ALIASES_SHOWN);
}

/**
 * One command's help line.
 *
 * Entries that are not commands ("type its name in chat") are shown as-is.
 */
function commandLine(command) {
  const isCommand = String(command.usage || '').startsWith('.');
  const label = isCommand ? `\`${command.usage}\`` : `**${command.usage}**`;

  const others = isCommand ? otherAliases(command) : [];
  const tail = others.length ? ` (also \`.${others.join('` `.')}\`)` : '';

  return `${label}${tail}${command.soon ? '  *(soon)*' : ''}\n${command.blurb}`;
}

/**
 * Everything a paged help render needs.
 *
 * Page 0 is an overview; each group follows on its own page. Returns the same
 * shape as .party and .bag for the pager.
 */
function buildPaged(userId) {
  const groups = groupsFor(userId);
  const pages = groups.length + 1;

  const render = (index) => {
    const embed = new EmbedBuilder().setColor(0xf7d02c);

    if (index === 0) {
      embed
        .setTitle('PokeDropper')
        .setDescription(
          'Drop a wild Pokemon, then **type its name in chat to catch it** - ' +
            'first correct answer wins.\n\n' +
            `Dropping has a ${minutes} minute cooldown. Only the species name matters, ` +
            'never the form, and spelling is forgiving - every language works, so ' +
            '`ピカチュウ` and `Glurak` catch just as well as `pikachu`.'
        )
        .addFields({
          name: 'Your Pokemon have numbers',
          value:
            '`.party` gives each one a small number - **#1**, **#2** - and that is what ' +
            'every command takes: `.view 3`, `.release 3`, `.trade @someone 3`.\n' +
            'A number is yours and it never moves. Sorting your party does not change it, ' +
            'and one that leaves takes its number with it, so a gap just means something ' +
            'used to be there.',
        })
        .addFields({
          name: 'What is on the other pages',
          value: GROUPS.map(
            (group, i) => `\`${i + 1}\`  ${group.name} - ${group.commands.length} commands`
          ).join('\n'),
        });
    } else {
      const group = groups[index - 1];

      embed
        .setTitle(group.name)
        .setDescription(group.commands.map(commandLine).join('\n\n'));
    }

    embed.setFooter({
      text:
        `Page ${index + 1}/${pages}. Everything works as a slash command too, ` +
        'and .help <command> shows one in detail.',
    });

    return embed;
  };

  return { pages, page: 0, render };
}

/** The full help as a single embed. */
function buildHelp() {
  const built = buildPaged();
  return { embeds: [built.render(0)] };
}

/** Help for one command. */
function buildCommandHelp(query, userId) {
  const wanted = String(query).toLowerCase().replace(/^[./]/, '');
  const found =
    allCommands(userId).find((c) => c.name === wanted) ||
    allCommands(userId).find((c) => aliasesFor(c.name).includes(wanted));

  if (!found) {
    return { content: `No command called \`${query}\`. Try \`.help\` for the list.` };
  }

  const alias = aliasesFor(found.name);

  const embed = new EmbedBuilder()
    .setTitle(`.${found.name}`)
    .setDescription(found.blurb)
    .setColor(found.soon ? 0x888888 : 0xf7d02c)
    .addFields(
      { name: 'Usage', value: `\`${found.usage}\``, inline: true },
      {
        name: 'Aliases',
        value: alias.length ? alias.map((a) => `\`.${a}\``).join(' ') : 'none',
        inline: true,
      },
      { name: 'Group', value: found.group, inline: true }
    );

  if (found.soon) embed.setFooter({ text: 'Not built yet.' });

  return { embeds: [embed] };
}

module.exports = {
  // .h belongs to .hint.
  aliases: ['help', 'commands', 'cmds'],

  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Explains what the bot does.')
    .addStringOption((option) =>
      option.setName('command').setDescription('Get detail on one command.')
    ),

  async execute(interaction) {
    const wanted = interaction.options.getString('command');

    if (wanted) {
      await interaction.reply(buildCommandHelp(wanted, interaction.user.id));
      return;
    }

    const built = buildPaged(interaction.user.id);
    await pager.sendPaged({
      send: pager.interactionSender(interaction),
      pages: built.pages,
      page: built.page,
      render: built.render,
      userId: interaction.user.id,
    });
  },

  async run(message, args) {
    if (args.length) {
      await message.channel.send(buildCommandHelp(args.join(' '), message.author.id));
      return;
    }

    const built = buildPaged(message.author.id);
    await pager.sendPaged({
      send: (payload) => message.channel.send(payload),
      pages: built.pages,
      page: built.page,
      render: built.render,
      userId: message.author.id,
    });
  },

  buildHelp,
  buildPaged,
  buildCommandHelp,
  commandLine,
  aliasesFor,
  groupsFor,
  GROUPS,
};
