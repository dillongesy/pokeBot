'use strict';

/**
 * Catching a Pokemon.
 *
 * There is no .catch or /catch. This listens to ordinary chat, and if what
 * someone typed is the name of a Pokemon currently dropped in that channel,
 * they catch it.
 *
 * Only the species name counts, never the form: "vulpix" catches an Alolan
 * Vulpix. Accepted spellings come from Utils/names.js, which includes every
 * localised name (ピカチュウ, Glurak) and a few custom aliases.
 */

const store = require('../Utils/store');
const questengine = require('../Utils/questengine');
const { displayName } = require('../Utils/display');

/** Longer messages are never a guess. Generous to allow for localised names. */
const MAX_NAME_LENGTH = 48;

/**
 * A display name safe to put in a message.
 *
 * Discord renders @everyone and @here from plain text, so a crafted nickname
 * could make the bot ping the whole server. Such names are replaced outright.
 */
function safeDisplayName(member, fallback = 'Someone') {
  const name = member && member.displayName ? String(member.displayName) : '';
  if (!name) return fallback;

  const lowered = name.toLowerCase();
  if (lowered.includes('@everyone') || lowered.includes('@here')) return 'Someone';

  return name;
}

/**
 * Try to catch something with this message.
 *
 * @returns {Promise<boolean>} whether the message was a successful catch
 */
async function tryCatch(message) {
  const guess = message.content.trim();

  // Cheap rejections first - most chat is not a Pokemon name.
  if (!guess || guess.length > MAX_NAME_LENGTH || guess.includes('\n')) return false;

  const drop = store.findOpenDropByName(message.channelId, guess);
  if (!drop) return false;

  // Somebody else may have claimed it between the lookup and here, in which
  // case claimDrop returns false and we stay quiet.
  if (!store.claimDrop(drop.drop_id, message.author.id)) return false;

  // The Amulet Coin only doubles coins for catching your own drop.
  const ownDrop = drop.dropped_by === message.author.id;
  const coins = store.awardCatchCoins(message.author.id, { ownDrop });

  const trainer = safeDisplayName(message.member, message.author.username);

  // Update quest progress. The catch has already been saved, so a failure here
  // is logged and picked up by the next sync.
  let finished = null;
  try {
    finished = questengine.announce(questengine.sync(message.author.id).completed);
  } catch (err) {
    console.error('Quest sync failed after a catch:', err);
  }

  await message.channel.send(
    `Added ${displayName(drop)} to ${trainer}'s party! ` +
      `Level ${drop.level}. You gained **${coins}** coins for your catch.` +
      (finished ? `\n${finished}` : '')
  );

  return true;
}

module.exports = { tryCatch, safeDisplayName };
