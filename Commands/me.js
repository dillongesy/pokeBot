'use strict';

/**
 * .me - your trainer card.
 *
 * Money, totals, active buffs and a couple of highlights from the collection.
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const store = require('../Utils/store');
const content = require('../Utils/content');
const incense = require('../Utils/incense');
const drop = require('./drop');
const trainer = require('../Utils/trainer');
const milestones = require('../Utils/milestones');
const { displayName, ivPercent, titleCase } = require('../Utils/display');

const money = (amount) => Number(amount || 0).toLocaleString('en-US');

/** What a buff is called in the gold shop, so ".me" does not show raw keys. */
function buffLabel(name) {
  const entry = (() => {
    try {
      return (content.goldShop().items || []).find((i) => i.buff === name);
    } catch {
      return null;
    }
  })();

  return entry ? entry.name : titleCase(name);
}

/** "3h 12m" - how long a buff has left. */
function remaining(expiresAt) {
  if (expiresAt == null) return 'permanent';

  const left = expiresAt - Date.now();
  if (left <= 0) return 'expired';

  const hours = Math.floor(left / 3600000);
  const minutes = Math.floor((left % 3600000) / 60000);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/** A ten-cell bar. Discord has no progress bar, and this reads at a glance. */
function bar(fraction, width = 10) {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/**
 * The trainer line: level, obedience cap and progress bar. The cap is shown
 * explicitly because it decides which Pokemon will obey in battle.
 */
function trainerBlock(account) {
  // Computed from the row we already have to avoid a second read.
  const standing = trainer.progress(account);
  const next = milestones.next(standing.milestonesCleared);
  const total = milestones.total();

  const stars = standing.prestige ? ` ${'★'.repeat(Math.min(standing.prestige, 5))}` : '';
  const heading =
    `**Level ${standing.level}**${stars}` +
    (standing.prestige > 5 ? ` (prestige ${standing.prestige})` : '');

  // Three states: earning exp, ready for the next milestone, or all done.
  let progress;

  if (!next) {
    progress = `${bar(1)} **every canon fight beaten** - ready to prestige`;
  } else if (standing.pending) {
    progress = `${bar(1)} **ready** - ${next.name} is waiting. \`.battle milestone\``;
  } else {
    progress = `${bar(standing.fraction)} ${money(standing.exp)} / ${money(standing.needed)}`;
  }

  const upNext = next
    ? `Next: **${next.name}** of ${next.region}` +
      (next.type ? ` (${titleCase(next.type)})` : '')
    : `All ${total} milestones beaten`;

  return {
    name: 'Trainer',
    value:
      `${heading}\n${progress}\n` +
      `Commands Pokemon up to **level ${standing.cap}**\n` +
      `${money(standing.milestonesCleared)}/${total} milestones\n${upNext}`,
  };
}

function buildProfile(user) {
  const account = store.ensureUser(user.id);
  const total = store.countParty(user.id);

  const embed = new EmbedBuilder()
    .setTitle(`${user.username}`)
    .setColor(0x4287f5)
    .addFields(
      { name: 'Coins', value: money(account.coins), inline: true },
      { name: 'Gold', value: money(account.gold), inline: true },
      { name: 'Caught', value: money(account.total_caught), inline: true },
      trainerBlock(account)
    );

  if (account.battles_won || account.battles_lost) {
    embed.addFields({
      name: 'Battles',
      value: `${money(account.battles_won)} won, ${money(account.battles_lost)} lost`,
      inline: true,
    });
  }

  if (user.displayAvatarURL) embed.setThumbnail(user.displayAvatarURL());

  // Highlights, but only if there is anything to highlight.
  if (total) {
    const best = store.listParty(user.id, { sort: 'iv', direction: 'desc', limit: 1 })[0];
    const highest = store.listParty(user.id, { sort: 'level', direction: 'desc', limit: 1 })[0];
    const shinies = store
      .listParty(user.id, { sort: 'shiny', direction: 'desc', limit: 1000 })
      .filter((p) => p.shiny).length;

    embed.addFields(
      { name: 'Party size', value: money(total), inline: true },
      { name: 'Shinies', value: money(shinies), inline: true },
      { name: 'Coins spent', value: money(account.total_spent), inline: true },
      {
        name: 'Best IVs',
        value: `${displayName(best)} - ${ivPercent(best)}%`,
        inline: true,
      },
      {
        name: 'Highest level',
        value: `${displayName(highest)} - Lv.${highest.level}`,
        inline: true,
      },
      { name: '​', value: '​', inline: true }
    );
  }

  const buffs = store.activeBuffs(user.id);
  if (buffs.length) {
    embed.addFields({
      name: 'Active buffs',
      value: buffs
        .map((b) => `**${buffLabel(b.buff)}** ×${b.value}, ${remaining(b.expires_at)}`)
        .join('\n'),
    });
  }

  // Equipped repel and incense, so players can see what is active.
  const slots = store.activeSlots(user.id);
  if (slots.repel || slots.incense) {
    embed.addFields({
      name: 'Ready for your next drop',
      value: [slots.repel, slots.incense]
        .filter(Boolean)
        .map((slug) => `**${incense.nameOf(slug)}** - ${incense.describe(slug)}`)
        .join('\n'),
    });
  }

  const waiting = store.cooldownRemaining(user.id);
  embed.setFooter({
    text: waiting > 0 ? `Next drop in ${drop.formatDuration(waiting)}` : 'Ready to drop',
  });

  return { embeds: [embed] };
}

module.exports = {
  // Balance and buff shortcuts all show the trainer card.
  aliases: [
    'me', 'profile', 'trainer',
    'currency', 'c', 'bal', 'balance', 'gold', 'g',
    'buffs', 'buff',
  ],

  data: new SlashCommandBuilder().setName('me').setDescription('Shows your trainer card.'),

  async execute(interaction) {
    await interaction.reply(buildProfile(interaction.user));
  },

  async run(message) {
    await message.channel.send(buildProfile(message.author));
  },

  buildProfile,
  trainerBlock,
  bar,
  remaining,
};
