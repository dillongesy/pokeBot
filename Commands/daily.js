'use strict';

/**
 * .daily - today's three quests, and the vote check.
 *
 * Running it also asks top.gg whether the player has voted (Utils/topgg.js),
 * and pays the vote quest if so. Catches and battle wins are counted as they
 * happen (Utils/daily.js).
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const store = require('../Utils/store');
const daily = require('../Utils/daily');
const topgg = require('../Utils/topgg');
const rates = require('../Utils/rates');

/** Same style as the trainer bar in `.me`. */
function bar(done, target, width = 10) {
  const filled = Math.max(0, Math.min(width, Math.round((done / target) * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/** "5h 4m", or "3m" in the last hour. */
function countdown(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

const tick = (done) => (done ? '✅' : '⬜');

/** What the vote check said, for the vote field. */
function voteLine(row, check, botId) {
  if (row.vote_done) return 'Done. Thanks for voting!';

  if (!check.ok) {
    if (check.reason === 'not-configured') {
      return 'Voting is not open yet, so the bonus only needs the other two for now.';
    }
    return 'Could not reach top.gg just now. Try `.daily` again in a minute.';
  }

  return (
    `[Vote for the bot on top.gg](${topgg.voteUrl(botId)}), then run \`.daily\` again to claim.\n` +
    'Claim it within 12 hours of voting.'
  );
}

/**
 * Check for a vote, then build the card.
 *
 * @param {string} botId  the bot's Discord id, for the vote link
 */
async function show(userId, botId) {
  store.ensureUser(userId);

  let row = daily.today(userId);
  let notices = [];

  let check = { ok: true, votedAt: null };
  if (!row.vote_done) {
    check = await topgg.lastVote(userId);
    if (check.ok && check.votedAt) {
      notices = daily.recordVote(userId, check.votedAt);
      row = daily.today(userId);
    }
  }

  const { catchCoins, voteLootboxes, bonusLootboxes, timezoneLabel } = rates.daily;
  const resetsIn = daily.nextReset() - Date.now();
  const boxes = (n) => `${n} Lootbox${n === 1 ? '' : 'es'}`;

  const embed = new EmbedBuilder()
    .setTitle('Daily quests')
    .setColor(row.bonus_done ? 0xf1c40f : 0x3498db)
    .setDescription(
      (notices.length ? `${notices.join('\n')}\n\n` : '') +
        `New quests at midnight ${timezoneLabel}, in **${countdown(resetsIn)}**.`
    )
    .addFields(
      {
        name: `${tick(row.catch_done)} Catch ${row.catch_target} Pokemon`,
        value:
          `${bar(row.catches, row.catch_target)} ${row.catches}/${row.catch_target}\n` +
          `Reward: ${catchCoins} coins`,
      },
      {
        name: `${tick(row.battle_done)} Win ${row.battle_target} battles`,
        value:
          `${bar(row.wins, row.battle_target)} ${row.wins}/${row.battle_target}\n` +
          'Reward: a Rare Candy or a random TM',
      },
      {
        name: `${tick(row.vote_done)} Vote on top.gg`,
        value:
          voteLine(row, check, botId) +
          (check.ok || check.reason !== 'not-configured' ? `\nReward: ${boxes(voteLootboxes)}` : ''),
      },
      {
        name: `${tick(row.bonus_done)} ${daily.voteCounts() ? 'All three' : 'Catch and battle'}`,
        value: `Reward: ${boxes(bonusLootboxes)}`,
      }
    );

  return { embeds: [embed] };
}

module.exports = {
  aliases: ['daily', 'dailies', 'dq', 'vote'],

  data: new SlashCommandBuilder()
    .setName('daily')
    .setDescription('Your daily quests, and claim your top.gg vote.'),

  async execute(interaction) {
    // The top.gg check can take a moment, so acknowledge first.
    await interaction.deferReply();
    await interaction.editReply(await show(interaction.user.id, interaction.client.user.id));
  },

  async run(message) {
    await message.channel.send(await show(message.author.id, message.client.user.id));
  },

  show,
  countdown,
};
