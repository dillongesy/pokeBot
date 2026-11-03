'use strict';

/**
 * .trade - swap Pokemon with someone, one for one.
 *
 *   .trade @user          ask them to trade; they press Accept or Decline
 *   .trade add 12         put your #12 into the trade (again to change it)
 *   .trade confirm        lock it in; the swap happens once both confirm
 *   .trade cancel         either side can call it off
 *   .trade                what the current trade looks like
 *
 * Once anyone has confirmed, the Pokemon can't be changed; cancel and start
 * again instead. A trade with no activity for 5 minutes times out.
 *
 * Trades are always one for one. Quest progress is based on what you own, so
 * free gifting would let players pass one Pokemon around to complete the same
 * quest repeatedly.
 *
 * While a trade is open both players are held by Utils/partylock.js, so
 * neither can release, reorder or battle with what they're offering. Trades
 * live in memory, like battles, so a restart clears them.
 *
 * Held items travel with the Pokemon, and trade evolutions happen on arrival
 * (Kadabra, Onix holding a Metal Coat, Karrablast for Shelmet). The original
 * trainer is kept. Quests are recalculated for both players afterwards.
 */

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} = require('discord.js');

const store = require('../Utils/store');
const pager = require('../Utils/pager');
const partylock = require('../Utils/partylock');
const livebuttons = require('../Utils/livebuttons');
const content = require('../Utils/content');
const questengine = require('../Utils/questengine');
const { displayName, ivPercent, titleCase } = require('../Utils/display');
const { loadSpecies } = require('../Utils/pokemon');
const evolution = require('../Utils/evolution');
const learnset = require('../Utils/learnset');
const moveprompt = require('../Utils/moveprompt');

/** How long a request waits for Accept or Decline. */
const REQUEST_MS = 60_000;

/** How long an open trade can sit with nothing happening. */
const IDLE_MS = 5 * 60_000;

/** Only the people in a trade get pinged, never @everyone in a name. */
const MENTIONS = { allowedMentions: { parse: ['users'] } };

const mention = (id) => `<@${id}>`;

/** The words each action answers to. */
const ADD_WORDS = new Set(['add', 'set', 'offer', 'put']);
const CONFIRM_WORDS = new Set(['confirm', 'accept', 'yes', 'ok']);
const CANCEL_WORDS = new Set(['cancel', 'decline', 'no', 'stop', 'quit']);

/**
 * Open trades: userId -> session. Both players point at the same session.
 *
 * session = {
 *   users: [a, b], names: { id: name }, picks: { id: pokemonId | null },
 *   confirmed: Set<userId>, send, timer
 * }
 */
const sessions = new Map();

/** Players with a request out or waiting on them, so they can't stack up. */
const requested = new Set();

/** One side of a trade, described: "**✨Pikachu** ♀, Lv.36, IV 61%, holding Leftovers" */
function describe(row) {
  if (!row) return '*nothing*';
  const held = row.equipped_item
    ? `, holding ${content.item(row.equipped_item)?.displayName || titleCase(row.equipped_item)}`
    : '';
  return `**${displayName(row)}**, Lv.${row.level}, IV ${ivPercent(row)}%${held}`;
}

/** Pull a Discord user id out of a mention, or accept a raw id. */
function parseUserId(raw) {
  const match = /^<@!?(\d+)>$/.exec(String(raw || '').trim());
  if (match) return match[1];
  return /^\d{15,25}$/.test(String(raw || '').trim()) ? String(raw).trim() : null;
}

/** The other player in a session. */
const otherOf = (session, userId) => session.users.find((id) => id !== userId);

/** What each player has put in, re-read so it's current. */
const pickOf = (session, userId) =>
  session.picks[userId] ? store.getOwnedPokemon(userId, session.picks[userId]) : null;

/** Restart the inactivity clock. */
function touch(session) {
  clearTimeout(session.timer);
  session.timer = setTimeout(() => {
    end(session);
    // From a timer, so nothing may throw out of here.
    Promise.resolve()
      .then(() => session.send({ content: 'Trade has timed out due to inactivity.' }))
      .catch(() => {});
  }, IDLE_MS);
  if (session.timer.unref) session.timer.unref();
}

/** Close a session and let both players use their party again. */
function end(session) {
  clearTimeout(session.timer);
  for (const id of session.users) {
    if (sessions.get(id) === session) sessions.delete(id);
    partylock.release(id);
  }
}

/** Start a trade between two players who have agreed to it. */
function open(a, b, names, send) {
  const session = {
    users: [a, b],
    names,
    picks: { [a]: null, [b]: null },
    confirmed: new Set(),
    send,
    timer: null,
  };

  for (const id of session.users) {
    sessions.set(id, session);
    partylock.hold(id, partylock.TRADE);
  }

  touch(session);
  return session;
}

/**
 * Why these two can't start a trade right now, or null.
 * Checked when asking and again when Accept is pressed.
 */
function blocker(fromUserId, toUserId) {
  if (sessions.has(fromUserId)) return 'You are already in a trade. `.trade cancel` to end it first.';
  if (sessions.has(toUserId)) return 'They are already in a trade.';

  if (partylock.heldBy(fromUserId)) return partylock.refusalFor(fromUserId, 'start a trade');
  if (partylock.heldBy(toUserId)) return 'They are busy with a battle or trade. Try again when it is over.';

  return null;
}

/** "Trade Request" card with Accept and Decline, for the target to press. */
function requestCard(fromUserId, toUserId) {
  return {
    embeds: [
      new EmbedBuilder()
        .setTitle('Trade Request')
        .setColor(0x4287f5)
        .setDescription(`${mention(fromUserId)} wants to trade with ${mention(toUserId)}.`)
        .setFooter({ text: 'Trades are one for one. Held items go with the Pokemon.' }),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('trade:accept').setLabel('Accept').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('trade:decline').setLabel('Decline').setStyle(ButtonStyle.Danger)
      ),
    ],
    ...MENTIONS,
  };
}

/**
 * Ask someone to trade, and open the trade if they accept.
 *
 * @param {function} reply   answers the command, returns the Message
 * @param {function} send    posts later messages (timeout) to the channel
 * @param {object}   names   { userId: name } for both players
 */
async function request({ reply, send, fromUserId, toUserId, names }) {
  if (!toUserId) return reply({ content: 'Trade with who? Try `.trade @someone`.' });
  if (toUserId === fromUserId) return reply({ content: "You can't trade with yourself!" });

  if (requested.has(fromUserId)) return reply({ content: 'You already have a trade request waiting.' });
  if (requested.has(toUserId)) return reply({ content: 'They already have a trade request waiting.' });

  const busy = blocker(fromUserId, toUserId);
  if (busy) return reply({ content: busy });

  const prompt = await reply(requestCard(fromUserId, toUserId));
  if (!prompt || typeof prompt.awaitMessageComponent !== 'function') return;

  requested.add(fromUserId);
  requested.add(toUserId);
  livebuttons.track(prompt, toUserId);

  let choice;
  try {
    choice = await prompt.awaitMessageComponent({
      componentType: ComponentType.Button,
      time: REQUEST_MS,
      filter: (button) => button.user.id === toUserId,
    });
  } catch {
    await prompt.edit({ content: 'Trade request timed out.', embeds: [], components: [] }).catch(() => {});
    return;
  } finally {
    requested.delete(fromUserId);
    requested.delete(toUserId);
    livebuttons.release(prompt);
  }

  if (choice.customId === 'trade:decline') {
    await choice
      .update({ content: `Trade declined by ${mention(toUserId)}.`, embeds: [], components: [], ...MENTIONS })
      .catch(() => {});
    return;
  }

  // Something may have started while the request sat there.
  const late = blocker(fromUserId, toUserId);
  if (late) {
    await choice.update({ content: late, embeds: [], components: [] }).catch(() => {});
    return;
  }

  open(fromUserId, toUserId, names, send);

  await choice
    .update({
      content:
        'Trade accepted. Both users, please add your Pokémon to the trade using `.trade add <slot>`, ' +
        'then `.trade confirm`.',
      embeds: [],
      components: [],
    })
    .catch(() => {});
}

/** Put one of yours into the trade, or swap it for another. */
function add(userId, rawPokemonId) {
  const session = sessions.get(userId);
  if (!session) return { content: 'You are not in a trade. Start one with `.trade @someone`.' };

  if (session.confirmed.size) {
    return {
      content: 'Someone has already confirmed the trade, so it cannot be changed now. `.trade cancel` to start over.',
    };
  }

  const id = store.parsePartyNumber(rawPokemonId);
  if (!Number.isInteger(id)) return { content: 'Add which one? Try `.trade add 12`, using the number from `.party`.' };

  const row = store.getOwnedByNumber(userId, id);
  if (!row) return { content: store.noSuchNumber(userId, id) };

  session.picks[userId] = row.id;
  touch(session);

  const other = otherOf(session, userId);
  const theirs = pickOf(session, other);

  if (!theirs) {
    return {
      content: `${session.names[userId]} added ${describe(row)} to the trade. Waiting for the other user to add their Pokémon.`,
    };
  }

  const [a, b] = session.users;
  return {
    content:
      `Trade set: ${describe(pickOf(session, a))} (added by ${session.names[a]}) and ` +
      `${describe(pickOf(session, b))} (added by ${session.names[b]}). Type \`.trade confirm\` to confirm the trade.`,
  };
}

/** Lock it in. The second confirmation carries out the swap. */
function confirm(userId) {
  const session = sessions.get(userId);
  if (!session) return { content: 'No active trade to confirm.' };

  const [a, b] = session.users;
  if (!session.picks[a] || !session.picks[b]) {
    return { content: 'Both users need to add a Pokémon first, with `.trade add <slot>`.' };
  }

  session.confirmed.add(userId);
  touch(session);

  if (session.confirmed.size < 2) return { content: 'Trade confirmed. Waiting for the other user to confirm.' };

  return complete(session);
}

/** Carry out a trade both sides confirmed. */
function complete(session) {
  const [a, b] = session.users;
  const givenByA = pickOf(session, a);
  const givenByB = pickOf(session, b);

  end(session);

  if (!givenByA || !givenByB) return { content: 'Trade cancelled - one of the Pokémon is no longer available.' };

  // Recorded in the trades table, which also guards against a double swap.
  const tradeId = store.createTrade({
    fromUserId: a,
    toUserId: b,
    offeredPokemon: givenByA.id,
    wantedPokemon: givenByB.id,
    channelId: null,
    ttlMs: IDLE_MS,
  });

  const trade = {
    id: tradeId,
    from_user_id: a,
    to_user_id: b,
    offered_pokemon: givenByA.id,
    wanted_pokemon: givenByB.id,
  };

  const result = store.executeTrade(trade);
  if (!result.ok) {
    store.settleTrade(trade.id, 'cancelled');
    return { content: `Trade cancelled - ${result.reason}` };
  }

  // Both sides may evolve on arrival, each in its new owner's hands.
  // Karrablast and Shelmet need to have been traded for each other.
  const evolutions = [
    evolveOnTrade(givenByA.id, b, givenByB),
    evolveOnTrade(givenByB.id, a, givenByA),
  ].filter(Boolean);

  // Evolution moves with no free slot: each new owner is asked which to forget.
  const offers = evolutions.map((evolved) => evolved.offer).filter(Boolean);

  const lines = [`Trade completed! ${mention(a)} traded ${describe(givenByA)} with ${mention(b)} for ${describe(givenByB)}.`];
  for (const evolved of evolutions) lines.push(`🎉 ${evolved.text}`);

  // Recalculate quests for both players. The trade is already committed, so a
  // failure here is logged and picked up by the next sync.
  try {
    for (const [who, synced] of questengine.syncMany([a, b])) {
      const line = questengine.announce(synced.completed);
      if (line) lines.push(`${mention(who)}: ${line}`);
    }
  } catch (err) {
    console.error('Quest sync failed after a trade:', err);
  }

  // `offers` is not part of the message; the caller strips it and asks.
  return { content: lines.join('\n'), offers, ...MENTIONS };
}

/**
 * Evolve a Pokemon that just changed hands, if trading is what it was waiting
 * for.
 *
 * Held-item trade evolutions consume the item (Onix holding a Metal Coat).
 * Other held items are kept. An Everstone prevents evolution.
 *
 * Evolution moves go into free slots straight away; the rest come back as
 * `offer` for the new owner to be asked about.
 *
 * @param {object} tradedFor  the Pokemon it was traded for, as it was before
 * @returns {{text: string, offer: object|null}|null} null if nothing happened
 */
function evolveOnTrade(pokemonId, ownerId, tradedFor) {
  const row = store.getOwnedPokemon(ownerId, pokemonId);
  if (!row) return null;

  const partner = tradedFor ? loadSpecies(tradedFor.species_id) : null;
  const result = evolution.resolve(row, 'trade', { tradedFor: partner ? partner.name : null });
  if (!result || !result.changes) return null;

  const changes = { ...result.changes };
  let consumedName = null;

  if (result.consumesHeldItem && row.equipped_item) {
    consumedName =
      content.item(row.equipped_item)?.displayName || titleCase(row.equipped_item);
    changes.equipped_item = null;
  }

  const updated = store.updatePokemon(pokemonId, changes);
  const { learned, offered } = store.learnMoves(pokemonId, learnset.movesOnGrowth(row, updated));

  return {
    text:
      `${displayName(row)} evolved into **${displayName(updated)}**!` +
      (consumedName ? ` The ${consumedName} was used up.` : '') +
      (learned.length ? ` It learned **${learned.join('**, **')}**.` : ''),
    offer: offered.length ? { userId: ownerId, pokemonId, moves: offered } : null,
  };
}

/** Either side calls it off. */
function cancel(userId) {
  const session = sessions.get(userId);
  if (!session) return { content: 'No active trade to cancel.' };

  end(session);
  return { content: 'Trade has been cancelled.' };
}

/** What the current trade looks like. */
function status(userId) {
  const session = sessions.get(userId);
  if (!session) {
    return { content: 'To trade, use `.trade @someone` to start.' };
  }

  const embed = new EmbedBuilder().setTitle('Current trade').setColor(0x4287f5);

  for (const id of session.users) {
    embed.addFields({
      name: `${session.names[id]}${session.confirmed.has(id) ? ' ✅' : ''}`,
      value: describe(pickOf(session, id)),
    });
  }

  embed.setFooter({ text: '.trade add <slot> · .trade confirm · .trade cancel' });
  return { embeds: [embed] };
}

/**
 * Send a reply, then ask about any evolution moves that need a slot freed.
 *
 * Each owner answers their own prompt.
 *
 * @param {function} send  posts a payload, returns the Message
 */
async function reply(send, result) {
  const { offers, ...payload } = result;
  await send(payload);

  for (const offer of offers || []) await moveprompt.askAll({ send, ...offer });
}

/** A name to show for someone, from their server nickname if there is one. */
function nameOf(member, user) {
  return (member && member.displayName) || (user && (user.globalName || user.username)) || 'Someone';
}

/** Route the actions that aren't starting a trade. */
function run(userId, args) {
  const first = String(args[0] || '').toLowerCase();

  if (!first) return status(userId);
  if (ADD_WORDS.has(first)) return add(userId, args[1]);
  if (CONFIRM_WORDS.has(first)) return confirm(userId);
  if (CANCEL_WORDS.has(first)) return cancel(userId);

  return { content: 'To trade, use `.trade @someone` to start, then `.trade add <slot>` and `.trade confirm`.' };
}

module.exports = {
  aliases: ['trade', 't'],

  data: new SlashCommandBuilder()
    .setName('trade')
    .setDescription('Swaps Pokemon with someone, one for one.')
    .addSubcommand((sub) =>
      sub
        .setName('start')
        .setDescription('Ask someone to trade.')
        .addUserOption((o) => o.setName('user').setDescription('Who to trade with.').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Put one of yours into the trade.')
        .addIntegerOption((o) => o.setName('pokemon').setDescription('Its slot, from /party.').setRequired(true))
    )
    .addSubcommand((sub) => sub.setName('confirm').setDescription('Lock in the trade.'))
    .addSubcommand((sub) => sub.setName('cancel').setDescription('Call off the trade.'))
    .addSubcommand((sub) => sub.setName('status').setDescription('Show the current trade.')),

  async execute(interaction) {
    store.ensureUser(interaction.user.id);
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    if (sub === 'start') {
      const target = interaction.options.getUser('user');
      const targetMember = interaction.options.getMember('user');
      store.ensureUser(target.id);

      await request({
        reply: pager.interactionSender(interaction),
        send: (payload) => interaction.channel.send({ ...MENTIONS, ...payload }),
        fromUserId: userId,
        toUserId: target.id,
        names: { [userId]: nameOf(interaction.member, interaction.user), [target.id]: nameOf(targetMember, target) },
      });
      return;
    }

    const args = sub === 'add' ? ['add', interaction.options.getInteger('pokemon')] : sub === 'status' ? [] : [sub];

    // The first payload is the reply; move prompts follow it up.
    await reply(
      (payload) => (interaction.replied ? interaction.followUp(payload) : interaction.reply(payload)),
      run(userId, args)
    );
  },

  async run(message, args) {
    store.ensureUser(message.author.id);

    const send = (payload) => message.channel.send({ ...MENTIONS, ...payload });
    const first = String(args[0] || '').toLowerCase();
    const isAction = ADD_WORDS.has(first) || CONFIRM_WORDS.has(first) || CANCEL_WORDS.has(first);

    // Prefer the parsed mention over the raw text.
    const mentioned = message.mentions && message.mentions.users && message.mentions.users.first();
    const target = mentioned ? mentioned.id : !isAction ? parseUserId(args[0]) : null;

    if (target) {
      store.ensureUser(target);
      const member = message.guild ? message.guild.members.cache.get(target) : null;

      await request({
        reply: send,
        send,
        fromUserId: message.author.id,
        toUserId: target,
        names: {
          [message.author.id]: nameOf(message.member, message.author),
          [target]: nameOf(member, mentioned),
        },
      });
      return;
    }

    await reply(send, run(message.author.id, args));
  },

  request,
  open,
  add,
  confirm,
  cancel,
  status,
  evolveOnTrade,
  parseUserId,
  sessions,
};
