'use strict';

/**
 * .questprogress - what you are working on, and what you have finished.
 *
 *   .qp                    everything still open, closest to done first
 *   .qp done               everything finished
 *   .qp <name>             one quest, with what is still missing
 *   .qp kanto              everything in one region
 *
 * Reads stored progress rather than recalculating it. The quest engine keeps
 * those rows current on every catch, trade, purchase and evolution.
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const store = require('../Utils/store');
const content = require('../Utils/content');
const questengine = require('../Utils/questengine');
const questprogress = require('../Utils/questprogress');
const names = require('../Utils/names');
const pager = require('../Utils/pager');
const { clip, fitLines, titleCase, LIMITS } = require('../Utils/display');

const PAGE_SIZE = 12;

/** Words asking for the finished list rather than the open one. */
const DONE_WORDS = new Set(['done', 'complete', 'completed', 'finished', 'c']);

/** A small progress bar. */
function bar(progress, required, width = 10) {
  const filled = required ? Math.round((progress / required) * width) : 0;
  return '█'.repeat(Math.min(width, filled)) + '░'.repeat(Math.max(0, width - filled));
}

/** One quest on one line. */
function line(entry) {
  const percent = entry.required ? Math.floor((entry.progress / entry.required) * 100) : 0;
  return (
    `${entry.complete ? '✅' : '`' + bar(entry.progress, entry.required) + '`'} ` +
    `**${entry.quest.collection || entry.quest.id}** - ` +
    `${entry.progress}/${entry.required}${entry.complete ? '' : ` (${percent}%)`}`
  );
}

/** The reward, as something readable. Null when a quest pays nothing. */
function rewardLine(quest) {
  const reward = quest.reward || {};
  const parts = [];

  if (reward.gold) parts.push(`**${reward.gold}** gold`);
  if (reward.coins) parts.push(`**${reward.coins.toLocaleString('en-US')}** coins`);

  for (const item of reward.items || []) {
    const known = content.item(item);
    parts.push(known ? known.displayName : titleCase(item));
  }

  return parts.length ? parts.join(', ') : null;
}

/** One quest in full, with what is still missing. */
function buildOne(userId, entry) {
  const quest = entry.quest;

  const embed = new EmbedBuilder()
    .setTitle(quest.collection || quest.id)
    .setColor(entry.complete ? 0x2ecc71 : 0x5865f2)
    .setDescription(quest.description || '-')
    .addFields(
      { name: 'Progress', value: `${entry.progress}/${entry.required}`, inline: true },
      { name: 'Region', value: quest.region || '-', inline: true },
      { name: 'Reward', value: rewardLine(quest) || 'nothing', inline: true }
    );

  if (entry.complete) {
    embed.addFields({ name: 'Status', value: '✅ Finished. The reward has been paid.' });
    return { embeds: [embed] };
  }

  // What is left. A goal quest has no list, so it says the number instead.
  if (quest.goal) {
    embed.addFields({
      name: 'Still to go',
      value: `${entry.required - entry.progress} more.`,
    });
  } else {
    const snap = questprogress.snapshot(userId);
    const missing = questprogress.missing(quest, snap);

    embed.addFields({
      name: `Still missing (${missing.length})`,
      value: clip(
        fitLines(
          missing.map((need) => {
            const species = names.speciesById(need.dex);
            const label = species ? species.displayName : `#${need.dex}`;
            return `${label}${need.form && need.form !== 'Default' ? ` (${need.form})` : ''}`;
          }),
          LIMITS.fieldValue
        ),
        LIMITS.fieldValue
      ),
    });
  }

  return { embeds: [embed] };
}

/**
 * The list, filtered and sorted. Open quests are sorted closest to done first.
 */
function buildList(user, entries, { title, color, empty }) {
  if (!entries.length) {
    return {
      empty: new EmbedBuilder().setTitle(title).setDescription(empty).setColor(0x888888),
    };
  }

  const pages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));

  const render = (index) => {
    const slice = entries.slice(index * PAGE_SIZE, (index + 1) * PAGE_SIZE);

    return new EmbedBuilder()
      .setTitle(title)
      .setDescription(slice.map(line).join('\n'))
      .setColor(color)
      .setFooter({
        text: `${entries.length} quest${entries.length === 1 ? '' : 's'} · page ${index + 1}/${pages} · .qp <name> for one`,
      });
  };

  return { pages, page: 0, render, entries };
}

function build(user, args = []) {
  const query = args.filter(Boolean).map(String).join(' ').trim();
  const all = questengine.statusFor(user.id);
  const wanted = query.toLowerCase();

  // ".qp done"
  if (DONE_WORDS.has(wanted)) {
    const done = all.filter((e) => e.complete);
    return buildList(user, done, {
      title: `${user.username} - quests finished`,
      color: 0x2ecc71,
      empty: 'Nothing finished yet. `.qp` shows what you are closest to.',
    });
  }

  // ".qp" - open, closest to done first.
  if (!query) {
    const open = all
      .filter((e) => !e.complete)
      .sort((a, b) => b.progress / b.required - a.progress / a.required);

    return buildList(user, open, {
      title: `${user.username} - quests in progress`,
      color: 0x5865f2,
      empty: 'Every quest is finished. There is nothing left to do.',
    });
  }

  // ".qp <name>" - an exact quest, by id or by its display name.
  const one =
    all.find((e) => e.quest.id === wanted) ||
    all.find((e) => String(e.quest.collection || '').toLowerCase() === wanted);

  if (one) return buildOne(user.id, one);

  // ".qp kanto" - a region, or anything whose name contains the words.
  const matches = all.filter(
    (e) =>
      String(e.quest.region || '').toLowerCase() === wanted ||
      String(e.quest.collection || '').toLowerCase().includes(wanted) ||
      e.quest.id.includes(wanted)
  );

  if (matches.length === 1) return buildOne(user.id, matches[0]);

  return buildList(user, matches, {
    title: `${user.username} - quests matching "${query}"`,
    color: 0x5865f2,
    empty: `No quest matches "${query}". Try \`.qp\` for the list.`,
  });
}

/** Post whatever build() returned, paging it if it is a list. */
async function post(send, userId, built) {
  if (built.embeds) return send(built);
  if (built.empty) return send({ embeds: [built.empty] });

  return pager.sendPaged({
    send,
    pages: built.pages,
    page: built.page,
    render: built.render,
    userId,
  });
}

module.exports = {
  aliases: [
    'questprogress', 'qp', 'quests', 'quest',
    'questscompleted', 'completedquests', 'qc', 'cq',
  ],

  data: new SlashCommandBuilder()
    .setName('questprogress')
    .setDescription('Shows what quests you are working on.')
    .addStringOption((option) =>
      option
        .setName('filter')
        .setDescription('"done", a region, or one quest by name.')
    ),

  async execute(interaction) {
    store.ensureUser(interaction.user.id);

    const filter = interaction.options.getString('filter');
    const built = build(interaction.user, filter ? [filter] : []);

    await post(pager.interactionSender(interaction), interaction.user.id, built);
  },

  async run(message, args) {
    store.ensureUser(message.author.id);

    // .qc and .cq mean the finished list, with no argument needed.
    const invoked = String(message.content || '').slice(1).split(/\s+/)[0].toLowerCase();
    const forceDone = invoked === 'qc' || invoked === 'cq' ||
      invoked === 'questscompleted' || invoked === 'completedquests';

    const built = build(message.author, forceDone && !args.length ? ['done'] : args);

    await post((payload) => message.channel.send(payload), message.author.id, built);
  },

  build,
  buildOne,
  line,
  bar,
  rewardLine,
};
