'use strict';

/**
 * .trade - swap Pokemon with someone.
 *
 *   .trade @user 12         offer your #12 to them
 *   .trade accept 45        accept, giving them your #45
 *   .trade confirm 45       same as accept
 *   .trade decline          turn down the offer waiting on you
 *   .trade cancel           take back the offer you made
 *   .trade                  show whatever is pending
 *
 * Trades are always one for one. Quest progress is based on what you own, so
 * free gifting would let players pass one Pokemon around to complete the same
 * quest repeatedly.
 *
 * Both sides are re-checked at accept time, so an offer whose Pokemon has
 * since been released or traded fails cleanly.
 *
 * Quests are recalculated for both players afterwards. Completed quests stay
 * completed. The original trainer is kept, and held items travel with the
 * Pokemon.
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const store = require('../Utils/store');
const partylock = require('../Utils/partylock');
const content = require('../Utils/content');
const questengine = require('../Utils/questengine');
const { displayName, ivPercent, titleCase } = require('../Utils/display');
const evolution = require('../Utils/evolution');

/** How long an unanswered offer stands. */
const TTL_MS = 5 * 60 * 1000;

const mention = (id) => `<@${id}>`;

/** The words each response answers to. */
const ACCEPT_WORDS = new Set(['accept', 'confirm', 'yes', 'ok']);
const DECLINE_WORDS = new Set(['decline', 'no', 'reject', 'deny']);

/** One side of a trade, described. */
function describe(row) {
  if (!row) return '*nothing*';
  const held = row.equipped_item
    ? ` · holding ${content.item(row.equipped_item)?.displayName || titleCase(row.equipped_item)}`
    : '';
  return `**${displayName(row)}** · Lv.${row.level} · IV ${ivPercent(row)}%${held}`;
}

/** Pull a Discord user id out of a mention, or accept a raw id. */
function parseUserId(raw) {
  const match = /^<@!?(\d+)>$/.exec(String(raw || '').trim());
  if (match) return match[1];
  return /^\d{15,25}$/.test(String(raw || '').trim()) ? String(raw).trim() : null;
}

/** Offer one of yours to somebody. */
function offer(fromUserId, targetRaw, rawPokemonId, channelId) {
  const toUserId = parseUserId(targetRaw);

  if (!toUserId) return { content: 'Trade with who? Try `.trade @someone 12`.' };
  if (toUserId === fromUserId) return { content: 'You cannot trade with yourself.' };

  // Not allowed while either player is in a battle (see Utils/partylock.js).
  const busy = partylock.refusalFor(fromUserId, 'offer a trade');
  if (busy) return { content: busy };

  if (partylock.heldBy(toUserId) === partylock.BATTLE) {
    return { content: 'They are in the middle of a battle. Try again when it is over.' };
  }

  const id = store.parsePartyNumber(rawPokemonId);
  if (!Number.isInteger(id)) {
    return { content: 'Offer which one? Try `.trade @someone 12`, using the number from `.party`.' };
  }

  const row = store.getOwnedByNumber(fromUserId, id);
  if (!row) return { content: store.noSuchNumber(fromUserId, id) };

  // The trades table stores global ids, so use row.id from here on rather
  // than the party number the player typed.
  const already = store.pendingTradeFor(row.id);
  if (already) return { content: `#${id} is already promised in another trade. Cancel it first.` };

  const outstanding = store.openTradeFrom(fromUserId);
  if (outstanding) {
    return {
      content: 'You already have an offer out. Use `.trade cancel` before making another.',
    };
  }

  store.createTrade({
    fromUserId,
    toUserId,
    offeredPokemon: row.id,
    wantedPokemon: null,
    channelId,
    ttlMs: TTL_MS,
  });

  const embed = new EmbedBuilder()
    .setTitle('Trade offered')
    .setColor(0x4287f5)
    .setDescription(`${mention(fromUserId)} offers ${mention(toUserId)}:\n${describe(row)}`)
    .addFields({
      name: 'To respond',
      value:
        '`.trade accept <your pokemon>` to swap for one of yours\n' +
        '`.trade decline` to say no',
    })
    .setFooter({ text: 'Expires in 5 minutes · trades are always one for one' });

  return { embeds: [embed] };
}

/**
 * Accept an offer, giving one of yours back.
 */
function accept(userId, rawPokemonId) {
  const trade = store.openTradeTo(userId);
  if (!trade) return { content: 'Nobody has offered you anything.' };

  // Only check for battles here. The pending trade is itself a lock, and
  // checking for it would block accepting the trade.
  if (partylock.heldBy(userId) === partylock.BATTLE) {
    return { content: partylock.refusalFor(userId, 'accept a trade') };
  }

  if (partylock.heldBy(trade.from_user_id) === partylock.BATTLE) {
    return { content: 'They have just started a battle. Try again when it is over.' };
  }

  const offered = store.getOwnedPokemon(trade.from_user_id, trade.offered_pokemon);
  if (!offered) {
    store.settleTrade(trade.id, 'cancelled');
    return { content: 'That offer is no longer valid - they do not have it any more.' };
  }

  if (rawPokemonId === undefined || rawPokemonId === null || String(rawPokemonId).trim() === '') {
    return {
      content:
        'Trades go both ways - name one of yours to give back. ' +
        'Try `.trade accept 45`, using the number from `.party`.',
    };
  }

  const id = store.parsePartyNumber(rawPokemonId);
  if (!Number.isInteger(id)) return { content: 'Give which one? Try `.trade accept 45`.' };

  const given = store.getOwnedByNumber(userId, id);
  if (!given) return { content: store.noSuchNumber(userId, id) };

  if (store.pendingTradeFor(given.id)) {
    return { content: `#${id} is promised in another trade already.` };
  }

  trade.wanted_pokemon = given.id;

  const result = store.executeTrade(trade);
  if (!result.ok) {
    store.settleTrade(trade.id, 'cancelled');
    return { content: result.reason };
  }

  // Both sides may evolve on arrival, each in its new owner's hands.
  const evolutions = [
    evolveOnTrade(trade.offered_pokemon, userId),
    evolveOnTrade(given.id, trade.from_user_id),
  ].filter(Boolean);

  const embed = new EmbedBuilder()
    .setTitle('Trade complete')
    .setColor(0x2ecc71)
    .addFields(
      { name: `${mention(trade.from_user_id)} gave`, value: describe(offered) },
      { name: `${mention(userId)} gave`, value: describe(given) }
    )
    .setFooter({ text: 'Original trainers are unchanged' });

  for (const evolved of evolutions) {
    embed.addFields({ name: 'Evolution!', value: evolved });
  }

  // Recalculate quests for both players. The trade is already committed, so a
  // failure here is logged and picked up by the next sync.
  try {
    for (const [who, synced] of questengine.syncMany([userId, trade.from_user_id])) {
      const line = questengine.announce(synced.completed);
      if (line) embed.addFields({ name: `Quest - ${mention(who)}`, value: line });
    }
  } catch (err) {
    console.error('Quest sync failed after a trade:', err);
  }

  return { embeds: [embed] };
}

/**
 * Evolve a Pokemon that just changed hands, if trading is what it was waiting
 * for.
 *
 * Held-item trade evolutions consume the item (Onix holding a Metal Coat).
 * Other held items are kept. An Everstone prevents evolution.
 *
 * @returns {string|null} something to show, or null if nothing happened
 */
function evolveOnTrade(pokemonId, ownerId) {
  const row = store.getOwnedPokemon(ownerId, pokemonId);
  if (!row) return null;

  const result = evolution.resolve(row, 'trade', {});
  if (!result) return null;

  const changes = { ...result.changes };
  let consumedName = null;

  if (result.consumesHeldItem && row.equipped_item) {
    consumedName =
      content.item(row.equipped_item)?.displayName || titleCase(row.equipped_item);
    changes.equipped_item = null;
  }

  const updated = store.updatePokemon(pokemonId, changes);

  return (
    `${displayName(row)} evolved into **${displayName(updated)}**!` +
    (consumedName ? ` The ${consumedName} was used up.` : '')
  );
}

function decline(userId) {
  const trade = store.openTradeTo(userId);
  if (!trade) return { content: 'Nobody has offered you anything.' };

  store.settleTrade(trade.id, 'declined');
  return { content: `Declined ${mention(trade.from_user_id)}'s offer.` };
}

function cancel(userId) {
  const trade = store.openTradeFrom(userId);
  if (!trade) return { content: 'You have no offer out.' };

  store.settleTrade(trade.id, 'cancelled');
  return { content: 'Cancelled your offer.' };
}

/** What is pending, in either direction. */
function status(userId) {
  const incoming = store.openTradeTo(userId);
  const outgoing = store.openTradeFrom(userId);

  if (!incoming && !outgoing) {
    return { content: 'No trades pending. Offer one with `.trade @someone 12`.' };
  }

  const embed = new EmbedBuilder().setTitle('Pending trades').setColor(0x4287f5);

  if (incoming) {
    const row = store.getOwnedPokemon(incoming.from_user_id, incoming.offered_pokemon);
    embed.addFields({
      name: `From ${mention(incoming.from_user_id)}`,
      value: `${describe(row)}\n\`.trade accept <your pokemon>\` or \`.trade decline\``,
    });
  }

  if (outgoing) {
    const row = store.getOwnedPokemon(userId, outgoing.offered_pokemon);
    embed.addFields({
      name: `To ${mention(outgoing.to_user_id)}`,
      value: `${describe(row)}\n\`.trade cancel\` to take it back`,
    });
  }

  return { embeds: [embed] };
}

/** Route ".trade ..." to the right thing. */
function run(userId, args, channelId) {
  const first = String(args[0] || '').toLowerCase();

  if (!first) return status(userId);
  if (ACCEPT_WORDS.has(first)) return accept(userId, args[1]);
  if (DECLINE_WORDS.has(first)) return decline(userId);
  if (first === 'cancel') return cancel(userId);

  return offer(userId, args[0], args[1], channelId);
}

module.exports = {
  aliases: ['trade', 't'],

  data: new SlashCommandBuilder()
    .setName('trade')
    .setDescription('Swaps Pokemon with someone.')
    .addSubcommand((sub) =>
      sub
        .setName('offer')
        .setDescription('Offer one of yours to someone.')
        .addUserOption((o) => o.setName('user').setDescription('Who to trade with.').setRequired(true))
        .addIntegerOption((o) =>
          o.setName('pokemon').setDescription('Its number, from /party.').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('accept')
        .setDescription('Accept the offer waiting on you.')
        .addIntegerOption((o) =>
          o
            .setName('pokemon')
            .setDescription('What to give back. Trades are always one for one.')
            .setRequired(true)
        )
    )
    .addSubcommand((sub) => sub.setName('decline').setDescription('Turn down the offer waiting on you.'))
    .addSubcommand((sub) => sub.setName('cancel').setDescription('Take back the offer you made.'))
    .addSubcommand((sub) => sub.setName('status').setDescription('Show pending trades.')),

  async execute(interaction) {
    store.ensureUser(interaction.user.id);
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    if (sub === 'offer') {
      const target = interaction.options.getUser('user');
      await interaction.reply(
        offer(userId, `<@${target.id}>`, interaction.options.getInteger('pokemon'), interaction.channelId)
      );
      return;
    }

    if (sub === 'accept') {
      await interaction.reply(accept(userId, interaction.options.getInteger('pokemon')));
      return;
    }

    if (sub === 'decline') {
      await interaction.reply(decline(userId));
      return;
    }

    if (sub === 'cancel') {
      await interaction.reply(cancel(userId));
      return;
    }

    await interaction.reply(status(userId));
  },

  async run(message, args) {
    store.ensureUser(message.author.id);

    // Prefer the parsed mention over the raw text.
    const mentioned = message.mentions && message.mentions.users && message.mentions.users.first();
    const first = String(args[0] || '').toLowerCase();
    const isAction = ACCEPT_WORDS.has(first) || DECLINE_WORDS.has(first) || first === 'cancel';

    if (mentioned && !isAction) {
      await message.channel.send(offer(message.author.id, `<@${mentioned.id}>`, args[1], message.channelId));
      return;
    }

    await message.channel.send(run(message.author.id, args, message.channelId));
  },

  offer,
  accept,
  decline,
  cancel,
  status,
  parseUserId,
  TTL_MS,
};
