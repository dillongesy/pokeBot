'use strict';

/**
 * .battle - fight something.
 *
 *   .battle                    whatever the world puts in front of you
 *   .battle milestone          the gym leader waiting at your trainer level
 *   .battle milestone <name>   one Elite Four member, in any order
 *
 * An Elite Four is one milestone made of four battles. All four unlock
 * together; ordinary rewards are paid for each, and the milestone itself is
 * cleared (with its rewards) by beating the last one.
 *
 * Whether a battle is wild or against a trainer is decided by
 * Utils/encounter.js; the mix shifts with trainer level. Milestone battles
 * are started explicitly.
 *
 * This file is only the Discord layer (buttons, embed and turn loop).
 * Utils/battle.js resolves turns, Utils/encounter.js builds the opponent,
 * Utils/rewards.js decides the payout and Utils/store.js saves it.
 *
 * Battles are kept in memory, so a restart ends any battle in progress. HP and
 * PP don't persist between fights and losing costs nothing, so this is
 * acceptable.
 */

const fs = require('fs');
const path = require('path');

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  AttachmentBuilder,
} = require('discord.js');

const store = require('../Utils/store');
const battle = require('../Utils/battle');
const encounter = require('../Utils/encounter');
const rewards = require('../Utils/rewards');
const milestones = require('../Utils/milestones');
const rates = require('../Utils/rates');
const typechart = require('../Utils/typechart');
const movepower = require('../Utils/movepower');
const { titleCase, capitalize } = require('../Utils/display');
const partylock = require('../Utils/partylock');
const moveprompt = require('../Utils/moveprompt');
const livebuttons = require('../Utils/livebuttons');
const daily = require('../Utils/daily');
const ai = require('../Utils/ai');
const cond = require('../Utils/conditions');
const rules = require('../Utils/moverules');
const obedience = require('../Utils/obedience');
const drop = require('./drop');

const POKEMON_DIR = path.join(__dirname, '..', 'Data', 'Pokemon');

/** How long a player has to choose, per turn. */
const TURN_MS = 90_000;

/** The pause between turns that play out on their own (Dig, Outrage, a recharge). */
const AUTO_TURN_MS = 1_500;

/** How much of the log the card shows: the latest lines, up to this many. */
const CARD_LOG_LINES = 18;
const CARD_LOG_CHARS = 3_500;

/** How long the finished card's log button keeps working. */
const LOG_KEPT_MS = 15 * 60_000;

/** One battle per person at a time. Keyed by Discord id. */
const active = new Map();

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/**
 * The two pixel sprites for a Pokemon - front and back.
 *
 * An embed has two fixed image slots: `image` (large, bottom left) and
 * `thumbnail` (small, top right). Placing sprites in them gives a classic
 * battle layout:
 *
 *   image      your Pokemon, back sprite
 *   thumbnail  the opponent, front sprite
 *
 * Static pixel sprites are used; 1,567 of the 1,578 forms have both.
 */
function spritesFor(speciesId, formFolder, shiny) {
  const file = path.join(POKEMON_DIR, String(speciesId), formFolder, 'data.json');
  if (!fs.existsSync(file)) return { front: null, back: null };

  const urls = JSON.parse(fs.readFileSync(file, 'utf8')).spriteUrls || {};

  return {
    front: (shiny && urls.frontShiny) || urls.front || null,
    back: (shiny && urls.backShiny) || urls.back || null,
  };
}

const HEALTH_WIDTH = 12;

function healthBar(mon) {
  const fraction = Math.max(0, mon.hp / mon.maxHp);
  const filled = mon.hp > 0 ? Math.max(1, Math.round(fraction * HEALTH_WIDTH)) : 0;
  return '█'.repeat(filled) + '░'.repeat(HEALTH_WIDTH - filled);
}

/** A short status tag, or nothing. */
const statusTag = (mon) =>
  mon.status ? ` \`${{ paralysis: 'PAR', poison: 'PSN', burn: 'BRN', sleep: 'SLP', freeze: 'FRZ' }[mon.status]}\`` : '';

/** How many of a side are still standing, as dots. */
const teamDots = (side) =>
  side.team.map((mon) => (mon.fainted ? '○' : '●')).join('');

function lineFor(mon, side) {
  return (
    `**${mon.name}** Lv.${mon.level}${statusTag(mon)}\n` +
    `${healthBar(mon)} ${mon.hp}/${mon.maxHp}\n` +
    `${teamDots(side)}`
  );
}

/**
 * What one move button says.
 *
 * "Thunderbolt (90) 15/15 PP": name, power and remaining PP. Status moves show
 * no power.
 *
 * Power is calculated against the current opponent, so variable-power moves
 * show their real value (Low Kick is 120 against Snorlax but 20 against
 * Gastly).
 */
function moveLabel(entry, attacker, defender) {
  const power = movepower.describe(entry.data, {
    attacker,
    defender,
    entry,
    allies: attacker.allies,
    speedOf: battle.effectiveSpeed,
  });

  const pp = `${entry.pp}/${entry.maxPp}`;

  // Hidden Power shows the type the user's IVs give it.
  const name = entry.name === 'hidden-power' && attacker.hiddenPowerType
    ? `${entry.data.displayName} ${capitalize(attacker.hiddenPowerType)}`
    : entry.data.displayName;

  // Discord limits button labels to 80 characters.
  return `${name}${power ? ` (${power})` : ''} ${pp} PP`.slice(0, 80);
}

/** Being given a status, in the games' words. */
const STATUS_GIVEN = {
  paralysis: (n) => `${n} is **paralyzed**! It may be unable to move!`,
  burn: (n) => `${n} was **burned**!`,
  poison: (n) => `${n} was **poisoned**!`,
  'badly poison': (n) => `${n} was **badly poisoned**!`,
  sleep: (n) => `${n} **fell asleep**!`,
  freeze: (n) => `${n} was **frozen solid**!`,
};

/** Getting over one: on its own, or with `source` (Lum Berry, Shed Skin...). */
const STATUS_CURED = {
  paralysis: [(n) => `${n} was cured of paralysis!`, 'cured its paralysis'],
  burn: [(n) => `${n}'s burn was healed!`, 'healed its burn'],
  poison: [(n) => `${n} was cured of its poisoning!`, 'cured its poison'],
  sleep: [(n) => `${n} woke up!`, 'woke it up'],
  freeze: [(n) => `${n} thawed out!`, 'defrosted it'],
};

/** "kept it from being ___", for a status an ability blocks. */
const STATUS_PAST = {
  paralysis: 'paralyzed', burn: 'burned', poison: 'poisoned', 'badly poison': 'badly poisoned',
  sleep: 'put to sleep', freeze: 'frozen', confus: 'confused',
};

/** What starting each condition says, in the games' words. */
const VOLATILE_START = {
  taunt: (n) => `${n} fell for the taunt!`,
  torment: (n) => `${n} was subjected to torment!`,
  embargo: (n) => `${n} can't use items anymore!`,
  healBlock: (n) => `${n} was prevented from healing!`,
  gastroAcid: (n) => `${n}'s Ability was suppressed!`,
  foresight: (n) => `${n} was identified!`,
  miracleEye: (n) => `${n} was identified!`,
  telekinesis: (n) => `${n} was hurled into the air!`,
  nightmare: (n) => `${n} began having a nightmare!`,
  yawn: (n) => `${n} grew drowsy!`,
  octolock: (n) => `${n} can't escape the Octolock!`,
  attract: (n) => `💕 ${n} fell in love!`,
  encore: (n) => `${n} must do an encore!`,
  powder: (n) => `${n} is covered in powder!`,
  electrify: (n) => `${n}'s moves have been electrified!`,
  focusEnergy: (n) => `${n} is getting pumped!`,
  laserFocus: (n) => `${n} concentrated intensely!`,
  magnetRise: (n) => `${n} levitated with electromagnetism!`,
  imprison: (n) => `${n} sealed any moves its target shares with it!`,
  magicCoat: (n) => `${n} shrouded itself with Magic Coat!`,
  snatch: (n) => `${n} waits for a target to make a move!`,
  charge: (n) => `${n} began charging power!`,
  destinyBond: (n) => `${n} is hoping to take its attacker down with it!`,
  grudge: (n) => `${n} wants its target to bear a grudge!`,
  endure: (n) => `${n} braced itself!`,
  aquaRing: (n) => `${n} surrounded itself with a veil of water!`,
  ingrain: (n) => `${n} planted its roots!`,
};

const VOLATILE_END = {
  taunt: (n) => `${n} shook off the taunt!`,
  encore: (n) => `${n}'s encore ended!`,
  disable: (n) => `${n}'s move is no longer disabled!`,
  magnetRise: (n) => `${n}'s electromagnetism wore off!`,
  telekinesis: (n) => `${n} was freed from the telekinesis!`,
  embargo: (n) => `${n} can use items again!`,
  healBlock: (n) => `${n}'s Heal Block wore off!`,
  throatChop: (n) => `${n} can use sound-based moves again!`,
};

const SIDE_START = {
  reflect: (s) => `🛡️ Reflect made ${s}'s team stronger against physical moves!`,
  lightScreen: (s) => `🛡️ Light Screen made ${s}'s team stronger against special moves!`,
  auroraVeil: (s) => `🛡️ Aurora Veil made ${s}'s team stronger against physical and special moves!`,
  safeguard: (s) => `${s}'s team cloaked itself in a mystical veil!`,
  mist: (s) => `${s}'s team became shrouded in mist!`,
  tailwind: (s) => `💨 The Tailwind blew from behind ${s}'s team!`,
  luckyChant: (s) => `Lucky Chant shielded ${s}'s team from critical hits!`,
};

const SIDE_END = {
  reflect: 'Reflect', lightScreen: 'Light Screen', auroraVeil: 'Aurora Veil', safeguard: 'Safeguard',
  mist: 'mist', tailwind: 'Tailwind', luckyChant: 'Lucky Chant',
};

const FIELD_START = {
  trickRoom: 'twisted the dimensions!',
  magicRoom: 'created a bizarre area in which held items lose their effects!',
  wonderRoom: 'created a bizarre area in which Defense and Sp. Def stats are swapped!',
  gravity: 'Gravity intensified!',
  mudSport: "Electricity's power was weakened!",
  waterSport: "Fire's power was weakened!",
  fairyLock: 'No one will be able to run away during the next turn!',
  ionDeluge: 'A deluge of ions showers the battlefield!',
};

const FIELD_END = {
  trickRoom: 'The twisted dimensions returned to normal!',
  magicRoom: 'Magic Room wore off, and held items regained their effects!',
  wonderRoom: 'Wonder Room wore off, and Defense and Sp. Def returned to normal!',
  gravity: 'Gravity returned to normal!',
  mudSport: 'The effects of Mud Sport have faded.',
  waterSport: 'The effects of Water Sport have faded.',
};

const RESTRICTED = {
  taunt: (n, m) => `${n} can't use ${m} after the taunt!`,
  disable: (n, m) => `${n}'s ${m} is disabled!`,
  torment: (n) => `${n} can't use the same move twice in a row due to the torment!`,
  'heal-block': (n, m) => `${n} can't use ${m} because of Heal Block!`,
  gravity: (n, m) => `${n} can't use ${m} because of gravity!`,
  imprison: (n, m) => `${n} can't use its sealed ${m}!`,
  'throat-chop': (n, m) => `${n} can't use ${m} because of Throat Chop!`,
  repeat: (n, m) => `${n} can't use ${m} twice in a row!`,
};

/** The log line for a condition or status-move event, or null. */
function conditionLine(event) {
  const n = event.name;
  switch (event.kind) {
    case 'confused': return `😵 **${n}** became confused!`;
    case 'confusion-turn': return `${n} is confused!`;
    case 'confusion-hit': return `It hurt itself in its confusion! **-${event.damage}**`;
    case 'confusion-end': return `${n} snapped out of its confusion!`;
    case 'confusion-cured': return `${n}'s ${event.source} snapped it out of its confusion!`;
    case 'already': return `${n} is already ${event.what}!`;
    case 'protected-by': return `${n} is protected by ${event.by}!`;
    case 'in-love': return `${n} is in love with ${event.with}!`;
    case 'immobilized-by-love': return `${n} is immobilized by love!`;
    case 'restricted': return (RESTRICTED[event.reason] || ((x, m) => `${x} can't use ${m}!`))(n, event.move);
    case 'volatile-start':
      return (VOLATILE_START[event.what] || ((x) => `${x} is under ${event.label}!`))(n) +
        (event.source ? ` (${event.source})` : '');
    case 'choose-switch': return event.isPlayer ? '**Who will you send in?**' : null;
    case 'condition-end': return VOLATILE_END[event.what] ? VOLATILE_END[event.what](n) : null;
    case 'side-start': return (SIDE_START[event.what] || ((s) => `${event.label} took effect for ${s}'s team!`))(event.side);
    case 'side-end': return `${event.side}'s ${SIDE_END[event.what] || event.what} wore off!`;
    case 'guard-up': return `${event.label} protected ${n}'s team!`;
    case 'guarded': return `${n} was protected by ${event.by}!`;
    case 'hazard-set':
      return {
        Spikes: `Spikes were scattered around ${event.side}'s feet!`,
        'Toxic Spikes': `Poison spikes were scattered around ${event.side}'s feet!`,
        'pointed stones': `🪨 Pointed stones float in the air around ${event.side}'s team!`,
        'a sticky web': `A sticky web has been laid out beneath ${event.side}'s team!`,
      }[event.what] || `${event.what} surround ${event.side}'s team!`;
    case 'hazard-damage':
      return event.source === 'Stealth Rock'
        ? `Pointed stones dug into ${n}! **-${event.amount}**`
        : `${n} was hurt by the spikes! **-${event.amount}**`;
    case 'hazard-cleared': return `${n} absorbed the ${event.what}!`;
    case 'sticky-web': return `${n} was caught in a sticky web!`;
    case 'court-change': return `${n} swapped the battle effects affecting each side of the field!`;
    case 'field-start':
      return event.what === 'trickRoom' || event.what === 'magicRoom' || event.what === 'wonderRoom'
        ? `${n} ${FIELD_START[event.what]}`
        : FIELD_START[event.what] || `${event.label} took effect!`;
    case 'field-end': return FIELD_END[event.what] || null;
    case 'terrain-start': return `🌱 **${event.text}**`;
    case 'terrain-end': return event.text;
    case 'wish-made': return `🌠 ${n} made a wish!`;
    case 'wish': return `${event.from}'s wish came true! ${n} restored health. **+${event.amount}**`;
    case 'healing-wish': return `The ${event.lunar ? 'lunar dance' : 'healing wish'} came true for ${n}!`;
    case 'revived': return `${n} was revived and is ready to fight again!`;
    case 'condition-heal': return `${n} restored health with ${event.source}. **+${event.amount}**`;
    case 'condition-damage': return `${n} is afflicted by the ${event.source}! **-${event.amount}**`;
    case 'disabled': return `${n}'s ${event.move} was disabled!`;
    case 'spite': return `It reduced the PP of ${n}'s ${event.move} by ${event.amount}!`;
    case 'perish-song': return '🎵 All Pokemon that hear the song will faint in three turns!';
    case 'perish': return `${n}'s perish count fell to ${event.count}.`;
    case 'cursed': return `${event.by} cut its own HP and put a curse on ${n}! **-${event.cost}**`;
    case 'destiny-bond': return `${n} took its attacker down with it!`;
    case 'grudge': return `${n}'s ${event.move} lost all its PP due to the grudge!`;
    case 'lock-on': return `${n} took aim at ${event.target}!`;
    case 'haze': return 'All stat changes were eliminated!';
    case 'psych-up': return `${n} copied ${event.target}'s stat changes!`;
    case 'swapped': return `${n} switched its ${event.what} with ${event.target}!`;
    case 'split': return `${n} shared its ${event.what} with ${event.target}!`;
    case 'power-trick': return `${n} switched its stats around!`;
    case 'topsy-turvy': return `All stat changes on ${n} were inverted!`;
    case 'belly-drum': return `${n} cut its own HP and maximized its Attack! **-${event.cost}**`;
    case 'pain-split': return 'The battlers shared their pain!';
    case 'retyped': return `${n} transformed into the ${event.types.map((t) => titleCase(t)).join('/')} type!`;
    case 'ability-changed': return `${n} acquired ${event.ability}!`;
    case 'skill-swap': return `${n} swapped Abilities with its target!`;
    case 'transformed': return `${n} transformed into ${event.target}!`;
    case 'item-swap': return `${n} switched items with its target!`;
    case 'item-given': return `${event.target} received ${event.item} from ${n}!`;
    case 'item-recycled': return `${n} found one ${event.item}!`;
    case 'item-lost': return `${n}'s ${event.item} was corroded away!`;
    case 'shed-tail': return `${n} shed its tail to create a decoy! **-${event.cost}**`;
    case 'dragged-out': return `${n} was dragged out!`;
    case 'blown-away': return `💨 ${n} was blown away!`;
    case 'teleported': return `${n} teleported away!`;
    case 'learned-move': return `${n} learned ${event.move}!`;
    case 'after-you': return `${n} took the kind offer!`;
    case 'quash': return `${n}'s move was postponed!`;
    case 'defog': return `${n} blew away the hazards and screens!`;
    case 'tidy-up': return 'Tidying up complete!';
    case 'spun-free': return `${n} blew away the hazards around it!`;
    case 'snatched': return `${n} snatched ${event.move}!`;
    case 'bounced': return `${n} bounced the ${event.move} back!`;
    case 'powder-blast': return `When the flame touched the powder on ${n}, it exploded!`;
    case 'screens-broken': return `${event.side}'s screens shattered!`;
    case 'cant-escape': return `${n} can no longer escape!`;
    default: return null;
  }
}

/** Turn the engine's events into something readable, dropping the noise. */
function narrate(events) {
  const lines = [];

  for (const event of events) {
    switch (event.kind) {
      case 'move': lines.push(`**${event.name}** used **${event.move}**!`); break;
      case 'struggle': lines.push(`**${event.name}** has nothing left and struggled!`); break;
      case 'critical': lines.push('💥 A critical hit!'); break;

      // Emphasised so effectiveness stands out in the log.
      case 'effectiveness':
        lines.push(`${event.effectiveness > 1 ? '🔺' : '🔻'} **${event.text}**`);
        break;

      case 'damage': lines.push(`${event.name} took **${event.damage}**.`); break;
      case 'miss': lines.push(`It missed ${event.name}.`); break;
      case 'immune': lines.push(`It doesn't affect ${event.name}...`); break;

      // Variable-power moves that need an explanation (e.g. a move that
      // failed rather than missed).
      case 'failed': lines.push(event.text || 'But it failed!'); break;

      // Lines the engine words itself (charging, recharging, Knock Off...).
      case 'note': lines.push(event.text); break;
      case 'hurt': lines.push(`${event.source} **-${event.amount}**`); break;
      case 'one-hit-ko': lines.push(`**${event.name}** went down in one hit!`); break;
      case 'magnitude': lines.push(`Magnitude ${event.number}!`); break;
      case 'stockpile': lines.push(`${event.name} stockpiled ${event.count}.`); break;
      case 'present-heal': lines.push(`${event.name} unwrapped it and felt better!`); break;
      case 'multi-hit': lines.push(`Hit ${event.hits} times!`); break;
      case 'faint': lines.push(`**${event.name}** fainted!`); break;
      case 'status': {
        const say = STATUS_GIVEN[event.status];
        lines.push(say ? say(event.name) : `${event.name} was afflicted with ${event.status}!`);
        break;
      }
      case 'cured': {
        const [plain, by] = STATUS_CURED[event.status] || [(n) => `${n} recovered.`, 'cured it'];
        lines.push(event.source ? `${event.name}'s ${event.source} ${by}!` : plain(event.name));
        break;
      }
      case 'residual':
        lines.push(`${event.name} was hurt by its ${event.status}. **-${event.damage}**`);
        break;
      case 'stat':
        lines.push(
          `${event.name}'s ${titleCase(event.stat)} ` +
          `${event.delta > 0 ? 'rose' : 'fell'}${Math.abs(event.delta) > 1 ? ' sharply' : ''}.`
        );
        break;
      case 'stat-blocked':
        lines.push(
          event.by
            ? `${event.name}'s ${event.by} kept its ${titleCase(event.stat)} up.`
            : `${event.name}'s ${titleCase(event.stat)} won't go ${event.direction}.`
        );
        break;
      case 'drain': lines.push(`${event.name} drained health. **+${event.amount}**`); break;
      case 'recoil': lines.push(`${event.name} was hurt by recoil. **-${event.amount}**`); break;
      case 'heal': lines.push(`${event.name} restored health. **+${event.amount}**`); break;
      case 'flinch': lines.push(`${event.name} flinched!`); break;
      case 'asleep': lines.push(`${event.name} is fast asleep.`); break;
      case 'frozen': lines.push(`${event.name} is frozen solid!`); break;
      case 'paralysed': lines.push(`${event.name} is paralyzed! It can't move!`); break;
      case 'withdraw': lines.push(`${event.side} withdrew ${event.name}.`); break;
      case 'send-out': lines.push(`${event.side} sent out **${event.name}**!`); break;
      case 'no-pp': lines.push(`${event.name} has no PP left for that.`); break;
      case 'timeout': lines.push('The battle went on too long and was called.'); break;

      // Abilities and held items. Each line names its source (e.g. Intimidate).
      case 'absorb':
        lines.push(
          `${event.source} absorbed the attack!` +
            (event.healed ? ` ${event.name} restored health.` : '')
        );
        break;
      case 'endured': lines.push(`${event.name} hung on with its ${event.source}!`); break;
      case 'item-heal':
        lines.push(`${event.name} restored health with its ${event.source}. **+${event.amount}**`);
        break;
      case 'chip': lines.push(`${event.name} was hurt by its ${event.source}. **-${event.amount}**`); break;

      // Field effects: weather, Protect, traps, Leech Seed and Substitute (see
      // Utils/field.js). Damage amounts are included.
      case 'weather-start': lines.push(`🌦️ **${event.text}**`); break;
      case 'weather-end': lines.push(`${event.text}`); break;
      case 'weather-damage':
        lines.push(`${event.name} is buffeted by the ${String(event.source).toLowerCase()}. **-${event.amount}**`);
        break;

      case 'protected-self': lines.push(`🛡️ **${event.name}** protected itself!`); break;
      case 'protected': lines.push(`**${event.name}** protected itself!`); break;

      case 'trapped':
        lines.push(`**${event.name}** was trapped by ${event.source}! (${event.turns} turns)`);
        break;
      case 'trap-damage': lines.push(`${event.name} is hurt by ${event.source}. **-${event.amount}**`); break;
      case 'freed': lines.push(`${event.name} was freed from ${event.source}.`); break;
      case 'cannot-flee': lines.push(`${event.name} cannot escape ${event.source}!`); break;

      case 'seeded': lines.push(`🌱 **${event.name}** was seeded!`); break;
      case 'seed-drain': lines.push(`${event.name}'s health was sapped. **-${event.amount}**`); break;
      case 'seed-heal': lines.push(`${event.name} took the sapped health. **+${event.amount}**`); break;

      case 'substitute-up':
        lines.push(`**${event.name}** put up a substitute. **-${event.cost}**`);
        break;
      case 'substitute-hit':
        lines.push(
          event.broke
            ? `The substitute broke! (**${event.damage}**)`
            : `The substitute took **${event.damage}**.`
        );
        break;
      case 'item-used': lines.push(`${event.name} used up its ${event.item}.`); break;
      case 'shrugged-off': lines.push(`${event.name}'s ${event.by} shrugged it off.`); break;
      case 'status-blocked':
        lines.push(`${event.name}'s ${event.by} kept it from being ${STATUS_PAST[event.status] || event.status}.`);
        break;

      // Conditions and status moves (Utils/conditions.js, Utils/statusmoves.js).
      default: {
        const line = conditionLine(event);
        if (line) lines.push(line);
        break;
      }
    }
  }

  return lines;
}

/** The latest lines of the log that fit on the card. */
function recentLines(log) {
  const lines = [];
  let length = 0;
  for (let i = log.length - 1; i >= 0 && lines.length < CARD_LOG_LINES; i -= 1) {
    length += log[i].length + 1;
    if (length > CARD_LOG_CHARS) break;
    lines.unshift(log[i]);
  }
  return lines;
}

/**
 * The whole log, for the Battle log button, seen only by whoever pressed it.
 * Long battles come as a text file.
 */
function fullLog(log) {
  const text = log.join('\n');
  if (text.length <= 4000) {
    return {
      embeds: [new EmbedBuilder().setTitle('Battle log').setColor(0x4287f5).setDescription(text || 'Nothing has happened yet.')],
      flags: MessageFlags.Ephemeral,
    };
  }
  const plain = log.map((line) => line.replace(/\*/g, '')).join('\n');
  return {
    content: `The whole battle, ${log.length} lines:`,
    files: [new AttachmentBuilder(Buffer.from(plain, 'utf8'), { name: 'battle-log.txt' })],
    flags: MessageFlags.Ephemeral,
  };
}

/** The button that shows the whole log. */
const logButton = () =>
  new ButtonBuilder().setCustomId('bt:log').setLabel('Battle log').setStyle(ButtonStyle.Secondary);

/** The card. Rebuilt from scratch each turn rather than edited in place. */
function buildCard(state, log) {
  const [playerSide, foeSide] = state.sides;
  const mine = battle.activeOf(playerSide);
  const theirs = battle.activeOf(foeSide);

  const title = {
    wild: `A wild ${theirs.name} appeared!`,
    trainer: `${foeSide.name} wants to battle!`,
    milestone: `${foeSide.name} wants to battle!`,
  }[state.kind] || 'Battle!';

  // Player on the left, opponent on the right, matching the sprites.
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(state.kind === 'milestone' ? 0xf1c40f : 0x4287f5)
    .addFields(
      { name: playerSide.name, value: lineFor(mine, playerSide), inline: true },
      { name: foeSide.name, value: lineFor(theirs, foeSide), inline: true }
    );

  const theirArt = spritesFor(theirs.speciesId, theirs.form, theirs.shiny);
  const myArt = spritesFor(mine.speciesId, mine.form, mine.shiny);

  // A few forms have no back sprite; use the front one instead.
  const myPicture = myArt.back || myArt.front;
  const theirPicture = theirArt.front || theirArt.back;

  if (myPicture) embed.setImage(myPicture);
  if (theirPicture) embed.setThumbnail(theirPicture);

  const recent = recentLines(log);
  if (recent.length) embed.setDescription(recent.join('\n'));

  embed.setFooter({ text: `Turn ${state.turn + 1}, ${TURN_MS / 1000}s to choose` });

  return embed;
}

/**
 * Move buttons, plus a switch when there is somebody to switch to.
 *
 * Move buttons are disabled at zero PP. When every move is out of PP, a
 * Struggle button is shown instead.
 */
function buildControls(state) {
  const side = state.sides[0];
  const mine = battle.activeOf(side);

  // Locked in (the second turn of Dig, Outrage, a recharge...): there is
  // nothing to choose, and the turn plays out on its own (see loop()).
  if (rules.lockedAction(mine)) return [];

  // Labels depend on the target. Without one, fall back to the move's own
  // numbers.
  const theirs = state.sides[1] ? battle.activeOf(state.sides[1]) : null;

  const rows = [];

  // A move can't be picked with no PP, when a condition forbids it (Taunt,
  // Disable, Torment, Heal Block, Gravity, Imprison), or when Encore forces
  // another.
  const encored = cond.encoreSlot(mine);
  const blocked = (entry, index) =>
    entry.pp <= 0 ||
    Boolean(cond.restriction(state, 0, mine, index)) ||
    (encored != null && index !== encored);
  const anyPp = mine.moves.some((entry, index) => !blocked(entry, index));

  if (!anyPp) {
    // Any slot works: the engine uses Struggle when nothing is usable.
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('bt:move:0')
          .setLabel('Struggle')
          .setStyle(ButtonStyle.Danger)
      )
    );
  } else if (mine.moves.length) {
    rows.push(
      new ActionRowBuilder().addComponents(
        ...mine.moves.slice(0, 4).map((entry, index) =>
          new ButtonBuilder()
            .setCustomId(`bt:move:${index}`)
            .setLabel(moveLabel(entry, mine, theirs))
            .setStyle(
              entry.data.damageClass === 'status' ? ButtonStyle.Secondary : ButtonStyle.Primary
            )
            .setDisabled(blocked(entry, index))
        )
      )
    );
  }

  const bench = battle.benchOf(side);
  const extra = new ActionRowBuilder();

  // Held in the sky by Sky Drop: no switching out.
  if (bench.length && !(mine.volatiles && mine.volatiles.skyDropped)) {
    extra.addComponents(
      new ButtonBuilder()
        .setCustomId('bt:switch')
        .setLabel(`Switch (${bench.length})`)
        .setStyle(ButtonStyle.Success)
    );
  }

  extra.addComponents(
    logButton(),
    new ButtonBuilder()
      .setCustomId('bt:forfeit')
      .setLabel(state.kind === 'wild' ? 'Run' : 'Forfeit')
      .setStyle(ButtonStyle.Danger)
  );

  rows.push(extra);
  return rows;
}

/**
 * The bench, as buttons.
 *
 * `forced` means the active Pokemon has fainted and must be replaced, so there
 * is no Back button. Up to five buttons (a full team leaves a bench of five).
 */
function buildSwitchRow(state, forced = false) {
  const bench = battle.benchOf(state.sides[0]);

  const rows = [
    new ActionRowBuilder().addComponents(
      ...bench.slice(0, 5).map((entry) =>
        new ButtonBuilder()
          .setCustomId(`bt:send:${entry.index}`)
          .setLabel(`${entry.mon.name} ${entry.mon.hp}/${entry.mon.maxHp}`)
          .setStyle(ButtonStyle.Success)
      )
    ),
  ];

  const second = new ActionRowBuilder();

  if (!forced) {
    second.addComponents(
      new ButtonBuilder().setCustomId('bt:back').setLabel('Back').setStyle(ButtonStyle.Secondary)
    );
  }

  // Running is allowed even when a replacement is required.
  second.addComponents(
    new ButtonBuilder()
      .setCustomId('bt:forfeit')
      .setLabel(state.kind === 'wild' ? 'Run' : 'Forfeit')
      .setStyle(ButtonStyle.Danger)
  );

  rows.push(second);
  return rows;
}

// ---------------------------------------------------------------------------
// Setting one up
// ---------------------------------------------------------------------------

/**
 * Which fight `.battle milestone` means.
 *
 * A gym or champion is just the milestone. For an Elite Four it is one
 * member: the one named, or the first not yet beaten.
 *
 * @returns {{ fight: object } | { error: string }}
 */
function chooseMember(userId, fight, memberName) {
  if (!milestones.isEliteFour(fight)) return { fight };

  const beaten = store.eliteFourBeaten(userId, fight.order);
  const left = fight.members.filter((member) => !beaten.has(member.name));
  const everyone = milestones.listNames(fight.members.map((member) => member.name));

  if (!memberName) {
    // All four beaten but somehow not cleared: let the last be fought again.
    return { fight: milestones.memberFight(fight, left[0] || fight.members[fight.members.length - 1]) };
  }

  const wanted = String(memberName).toLowerCase();
  const member = fight.members.find((m) => m.name.toLowerCase() === wanted);

  if (!member) {
    return {
      error:
        `The ${milestones.title(fight)} is ${everyone}. ` +
        `Pick one with \`.battle milestone <name>\`, or leave the name off to take the next in line.`,
    };
  }

  if (beaten.has(member.name) && left.length) {
    return {
      error:
        `You have already beaten **${member.name}**. ` +
        `Still to go: **${milestones.listNames(left.map((m) => m.name))}**.`,
    };
  }

  return { fight: milestones.memberFight(fight, member) };
}

/**
 * Everything needed to start, or a reason not to.
 *
 * Refuses an empty team, a locked milestone or a second concurrent battle,
 * and explains how to fix each. Testable without Discord.
 */
function prepare(userId, wantsMilestone, rng = Math.random, memberName = null) {
  if (active.has(userId)) {
    return { error: 'You are already in a battle. Finish that one first.' };
  }

  const standing = store.trainerProgress(userId);
  const { team, refused, cap, brought } = store.battleTeam(userId);

  if (!team.length) {
    if (!brought) {
      return { error: 'You have no Pokemon to fight with. Type `.d` to drop one.' };
    }

    // None of the first six will obey. Explain who refused and why, and point
    // to the commands that fix it.
    const why = refused.slice(0, 3).map((r) => `• ${r.why}`).join('\n');
    const more = refused.length > 3 ? `\n• …and ${refused.length - 3} more` : '';

    const usable = store.suggestedTeam(userId, 6);

    return {
      error:
        `**None of the ${brought} at the top of your party will listen to you.**\n` +
        `Trainer level ${standing.level} commands up to level ${cap}.\n\n${why}${more}\n\n` +
        (usable.length
          ? 'Run `.party suggested` to see who will, then `.p swap <a> <b>` to move ' +
            `them into the first six. You have **${store.countParty(userId, {
              obeysAtCap: cap,
            }).toLocaleString()}** that would fight.`
          : 'Nothing you own obeys yet. Catch something at or below your cap with `.d`.'),
    };
  }

  if (wantsMilestone) {
    if (!standing.next) {
      return { error: 'You have beaten every canon fight there is. Nothing is waiting.' };
    }

    if (!standing.pending) {
      return {
        error:
          `**${milestones.title(standing.next)}** is not ready for you yet - ` +
          `${standing.remaining.toLocaleString()} more trainer exp. Win some ordinary ` +
          'battles first with `.battle`.',
      };
    }

    const chosen = chooseMember(userId, standing.next, memberName);
    if (chosen.error) return { error: chosen.error };

    return {
      kind: encounter.MILESTONE,
      team,
      refused,
      cap,
      brought,
      fight: chosen.fight,
      opponent: encounter.opponentFor({
        kind: encounter.MILESTONE, cap, anchor: encounter.levelAnchor(cap, team), fight: chosen.fight, rng,
      }),
    };
  }

  const kind = encounter.pickKind(standing.milestonesCleared, standing.totalMilestones, rng);

  // Species come from the normal drop roller, with the same rarity weighting.
  // Roll enough for the largest possible trainer team.
  const speciesIds = [];
  for (let i = 0; i < rates.battle.maxNpcTeam; i += 1) {
    try {
      speciesIds.push(drop.rollDrop({ forceRarity: 'normal' }).species.id);
    } catch {
      speciesIds.push(1 + Math.floor(rng() * 800));
    }
  }

  return {
    kind,
    team,
    refused,
    cap,
    brought,
    opponent: encounter.opponentFor({
      kind,
      cap,
      anchor: encounter.levelAnchor(cap, team),
      cleared: standing.milestonesCleared,
      total: standing.totalMilestones,
      speciesIds,
      rng,
    }),
  };
}

/**
 * Apply and describe the end-of-battle rewards.
 *
 * Called on every exit, including fleeing and timing out. Experience is earned
 * per knockout either way; fleeing pays no coins or trainer exp.
 *
 * @param {string} outcome  'fled' when they walked away or ran out of time
 */
function settle(userId, state, setup, outcome = null) {
  // `lines` is the battle card's result: who won, coins and trainer exp.
  // Everything else is posted as separate one-line messages below the card,
  // in this order (assembled at the bottom):
  //
  //   level-ups -> obedience warnings -> evolutions -> Shedinja -> daily quests
  //   -> Elite Four progress / milestone cleared -> Lootbox -> milestone unlock
  const evolutions = [];
  const offers = [];
  const levelUps = [];
  const stopsObeying = [];
  const extras = [];
  const dailyNotices = [];
  const progress = [];
  let lootboxMessage = null;
  const unlocks = [];

  // One Elite Four member. Only the win that completes all four pays as a
  // milestone; the others pay like an ordinary trainer.
  const member = setup.fight && setup.fight.member ? setup.fight : null;
  let finishesEliteFour = false;

  if (member && state.winner === 0) {
    const beaten = store.eliteFourBeaten(userId, member.order);
    beaten.add(member.member);
    finishesEliteFour = member.roster.every((name) => beaten.has(name));
  }

  const payout = rewards.forBattle({
    state,
    kind: member && !finishesEliteFour ? encounter.TRAINER : setup.kind,
    opponentLevel: setup.opponent.level,

    // Seeded from the battle so the coin roll is reproducible.
    rng: battle.rngFrom(`${state.seed}:coins`),
  });

  // Starting levels, so awardBattle can work out evolutions and new moves
  // (experience, and the levels it brought, were paid during the fight).
  // Every recorded Pokemon is passed; awardBattle compares against the stored
  // level and skips anyone who didn't grow.
  const startedAt = setup.startedAt || new Map();

  // Blown away by Roar or Dragon Tail, or teleported off: no result at all.
  payout.noContest = Boolean(state.endedBy);

  payout.grew = state.sides[0].team
    .filter((mon) => startedAt.has(mon.id))
    .map((mon) => ({ id: mon.id, from: startedAt.get(mon.id) }));

  const applied = store.awardBattle(userId, payout);
  const lines = [];

  if (payout.won) {
    lines.push(`**${setup.opponent.name} was defeated!**`);
    if (applied.coins) lines.push(`You earned **${applied.coins.toLocaleString()}** coins.`);
    if (applied.trainerExp) lines.push(`**+${applied.trainerExp.toLocaleString()}** trainer exp.`);

    // Daily quest progress. Only says anything when it completes one.
    try {
      dailyNotices.push(...daily.recordWin(userId));
    } catch (err) {
      console.error('Daily quest update failed after a battle:', err);
    }
  } else if (state.endedBy) {
    lines.push("**The battle ended.** It doesn't count as a win or a loss.");
  } else if (outcome === 'fled') {
    lines.push(
      state.kind === 'wild'
        ? '**You got away safely.** Nothing was lost.'
        : '**You walked away.** Nothing was lost.'
    );
  } else {
    lines.push(`**You were defeated.** Nothing was lost. Try again with \`.battle\`.`);
  }

  // Experience lines were already logged per knockout. Level-ups, and the
  // moves they taught, get their own message.
  for (const mon of applied.pokemon) {
    // One line per Pokemon, with any move it learned into a free slot.
    if (mon.levelledFrom) {
      const grew = mon.level - mon.levelledFrom;
      const learned = (mon.learned || []).length ? ` It learned ${mon.learned.join(', ')}.` : '';
      levelUps.push(
        `⬆️ **Level up!** ${mon.name} grew to level ${mon.level}` +
          (grew > 1 ? ` (up ${grew} from ${mon.levelledFrom}).` : '.') +
          learned
      );
    } else if ((mon.learned || []).length) {
      levelUps.push(`📘 **New move!** ${mon.name} learned ${mon.learned.join(', ')}.`);
    }

    // Moves that need a slot freed get their own prompt instead (see conclude).
    if ((mon.offered || []).length) offers.push({ id: mon.id, moves: mon.offered });

    // Evolutions are announced separately (see the bottom of this function).
    for (const step of mon.evolutions || []) evolutions.push(step);
  }

  // Mention the extra Shedinja from Nincada's evolution.
  for (const born of applied.spawned || []) {
    extras.push(`🐛 **A ${born.display_name} was left behind!** It is #${born.party_number}.`);
  }

  // Note which Pokemon fainted and so earned nothing.
  const lost = state.sides[0].team.filter((mon) => mon.participated && mon.fainted);
  if (lost.length && payout.knockouts > 0) {
    lines.push(
      `${lost.length === 1 ? `**${lost[0].name}** fainted and` : `**${lost.length}** of yours fainted and`}` +
        ' earned nothing.'
    );
  }

  // Record the member before the milestone is cleared, since clearing it
  // clears its member wins too.
  if (member && payout.won) {
    store.recordEliteFourWin(userId, member.order, member.member);

    if (!finishesEliteFour) {
      const beaten = store.eliteFourBeaten(userId, member.order);
      const left = member.roster.filter((name) => !beaten.has(name));

      progress.push(
        `🏆 **${member.member} is beaten!** That is ${beaten.size} of the Elite Four. ` +
          `Still to go: ${milestones.listNames(left)}. \`.battle milestone\` takes on the next, ` +
          `or name one: \`.battle milestone ${left[0].toLowerCase()}\`.`
      );
    }
  }

  if (payout.clearsMilestone) {
    const cleared = store.clearMilestone(userId);
    const after = store.trainerProgress(userId);

    const next = after.next
      ? `Next: ${milestones.title(after.next)}` +
        `${milestones.isEliteFour(after.next) ? '' : ` of ${after.next.region}`}.`
      : 'That was the last one. `.me` to prestige.';

    progress.push(
      `🏅 **${member ? `The ${milestones.title(member)}` : setup.fight.name} is behind you!** ` +
        `Trainer level ${cleared.level}: you now command Pokemon up to level ${cleared.cap}. ${next}`
    );

    if (cleared.lootboxes) {
      const boxes = cleared.lootboxes === 1 ? 'a Lootbox' : `${cleared.lootboxes} Lootboxes`;
      lootboxMessage =
        `🎁 **You received ${boxes}!** ` +
        `For beating ${member ? `the ${milestones.title(member)}` : setup.fight.name}. ` +
        `Open ${cleared.lootboxes === 1 ? 'it' : 'them'} with \`.use lootbox\`.`;
    }
  }

  // Say when something reaches the obedience limit, where battle experience
  // stops until the cap rises. ('over' only comes from a Rare Candy now, but
  // is handled the same way.)
  const standingNow = store.trainerProgress(userId);
  const nextFight = standingNow.next ? milestones.title(standingNow.next, true) : null;

  for (const mon of applied.pokemon) {
    if (!mon.levelledFrom) continue;

    const warning = obedience.levelWarning(
      { level: mon.level, met_level: mon.metLevel },
      mon.levelledFrom,
      standingNow.cap
    );
    if (!warning) continue;

    const text = obedience.describeWarning(warning, mon.name, standingNow.cap, nextFight);

    // Each warning is its own message, so neither can be missed.
    stopsObeying.push(
      warning.kind === 'over'
        ? `⚠️ **${mon.name} will stop obeying you.** ${text}`
        : `⚠️ **${mon.name} is at your limit.** ${text}`
    );
  }

  // ------------------------------------------------------------------
  // What gets its own message. Each is one line: an emoji, a bold title,
  // then plain text.
  // ------------------------------------------------------------------

  const evolving = evolutions.map(
    (step) => `✨ **What? ${step.from} is evolving!** It evolved into ${step.into}.`
  );

  // Announce a milestone battle as soon as it unlocks.
  // Also when clearing one leaves enough banked trainer exp that the next is
  // ready straight away.
  const unlockedNow = (applied.levelled && applied.levelled.becamePending) ||
    (payout.clearsMilestone && store.trainerProgress(userId).pending);

  if (unlockedNow) {
    const standing = store.trainerProgress(userId);

    if (standing.next && milestones.isEliteFour(standing.next)) {
      const names = standing.next.members.map((m) => m.name);

      unlocks.push(
        `🏆 **Elite Four ${milestones.listNames(names)} are waiting for you.** ` +
          `Beat all four, in any order, to raise your cap to ${standing.cap + 1}. ` +
          '`.battle milestone` takes them on in order, or name one: ' +
          `\`.battle milestone ${names[0].toLowerCase()}\`.`
      );
    } else if (standing.next) {
      unlocks.push(
        `🏆 **${standing.next.name} is waiting for you.** ` +
          `Your trainer bar is full. Beating ${standing.next.name} of ${standing.next.region} ` +
          `raises your cap to ${standing.cap + 1}. Start it with \`.battle milestone\`.`
      );
    }
  }

  const announcements = [
    ...(levelUps.length ? [levelUps.join('\n')] : []),
    ...stopsObeying,
    ...evolving,
    ...extras,
    ...dailyNotices,
    ...progress,
    ...(lootboxMessage ? [lootboxMessage] : []),
    ...unlocks,
  ];

  return { lines, announcements, offers };
}

// ---------------------------------------------------------------------------
// Running one
// ---------------------------------------------------------------------------

async function run(message, args) {
  const userId = message.author.id;
  store.ensureUser(userId);

  const wantsMilestone = ['milestone', 'gym', 'leader', 'm'].includes(
    String(args[0] || '').toLowerCase()
  );

  // `.battle milestone bruno`: an Elite Four member, by name.
  const setup = prepare(userId, wantsMilestone, Math.random, wantsMilestone ? args[1] : null);
  if (setup.error) {
    await message.channel.send(setup.error);
    return;
  }

  if (!setup.opponent.team.length) {
    await message.channel.send('Nothing turned up. Try again.');
    return;
  }

  const state = battle.create({
    player: { name: message.author.username, team: setup.team },
    opponent: { name: setup.opponent.name, team: setup.opponent.team },
    seed: `${userId}:${Date.now()}`,
    kind: setup.kind,
  });

  active.set(userId, state);

  // Lock the party until the battle ends (see Utils/partylock.js).
  partylock.hold(userId, partylock.BATTLE);

  const log = [];

  // Disobedience counts refer to the six Pokemon brought, not the whole party.
  if (setup.refused.length) {
    const names = setup.refused.map((r) => r.row.nickname || r.row.display_name);
    log.push(
      `*${setup.refused.length} of the ${setup.brought} you brought would not obey ` +
        `and stayed behind: ${names.slice(0, 3).join(', ')}` +
        `${names.length > 3 ? `, +${names.length - 3} more` : ''}.*`
    );
  }

  // Events from before the first turn, such as Intimidate.
  log.push(...narrate(state.openingEvents || []));

  let card = await message.channel.send({
    embeds: [buildCard(state, log)],
    components: buildControls(state),
  });

  // So presses from anyone else get an answer (see Utils/livebuttons.js).
  livebuttons.track(card, userId);

  try {
    await loop({ userId, state, setup, card, log });
  } catch (err) {
    console.error('Battle failed:', err);
    await card.edit({ content: 'The battle broke. Nothing was lost.', components: [] }).catch(() => {});
  } finally {
    // Always release the battle, its buttons and the party lock. (A finished
    // card's log button has been handed over to everyone by then.)
    active.delete(userId);
    livebuttons.release(card, userId);
    partylock.release(userId);
  }
}

/**
 * One turn at a time until somebody wins or the player walks away.
 *
 * The buttons are driven by a small state machine:
 *
 *   moves     an ordinary turn. Switching from here uses up the turn.
 *   switch    the player opened the bench and can still go back.
 *   replace   the active Pokemon fainted. The replacement is free (no turn is
 *             resolved, via battle.sendOut) and there is no going back.
 */
async function loop({ userId, state, setup, card, log }) {
  let mode = 'moves';

  // Opponents already paid out (so no knockout pays twice), and each of the
  // player's Pokemon's starting levels (used by settle()).
  const paid = new Set();
  const startedAt = new Map(state.sides[0].team.map((mon) => [mon.id, mon.level]));

  setup.paid = paid;
  setup.startedAt = startedAt;

  // 'midturn' is a switch the player must pick in the middle of a turn
  // (after their U-turn, Baton Pass or Teleport); like 'replace', there is no
  // going back.
  const componentsFor = () =>
    mode === 'moves' ? buildControls(state) : buildSwitchRow(state, mode === 'replace' || mode === 'midturn');

  // Answer the button press when there is one; turns that play out on their
  // own edit the card directly.
  const show = (choice, payload) => (choice ? choice.update(payload) : card.edit(payload));

  /**
   * Everything after a turn resolves: the log, experience, replacements and
   * the result. Returns true once the battle is over.
   */
  const finishTurn = async (events, choice) => {
    log.push(...narrate(events));

    // Pay out experience for knockouts this turn.
    log.push(...payKnockouts({ userId, state, cap: setup.cap, paid }));

    // Paused for the player to pick who comes in.
    if (state.awaitingSwitch === 0) {
      mode = 'midturn';
      await show(choice, { embeds: [buildCard(state, log)], components: componentsFor() });
      return false;
    }

    // Fainted opponents are replaced immediately, as are ones switching out
    // through Baton Pass, U-turn and the like. Looped because hazards can
    // knock out the replacement too. The player chooses their own
    // replacement via `mode` below.
    const foe = state.sides[1];
    for (let guard = 0; guard < battle.TEAM_SIZE && !state.finished; guard += 1) {
      const needs = battle.activeOf(foe).fainted || foe.pendingSwitch;
      const free = battle.benchOf(foe);
      if (!needs || battle.wipedOut(foe) || !free.length) break;

      // Whatever matches up best against the player's active Pokemon.
      const pick = ai.chooseReplacement(state, 1);

      // `arriving` holds the switch and anything triggered by it.
      const arriving = [];
      const sent = battle.sendOut(state, 1, pick != null ? pick : free[0].index, arriving);
      if (!sent) break;
      log.push(...narrate([sent, ...arriving]));
    }
    foe.pendingSwitch = null;
    battle.checkFinished(state, []);

    if (state.finished) {
      // Roar, Whirlwind or Teleport ending a wild battle counts as getting away.
      await conclude({ userId, state, setup, card, log, edit: choice, outcome: state.fled ? 'fled' : null });
      return true;
    }

    // The player picks a replacement after a faint, or after their own Baton
    // Pass, U-turn or Teleport.
    const mine = state.sides[0];
    const mustSwitch = battle.activeOf(mine).fainted || (mine.pendingSwitch && battle.benchOf(mine).length);
    mode = mustSwitch && !battle.wipedOut(mine) ? 'replace' : 'moves';

    await show(choice, { embeds: [buildCard(state, log)], components: componentsFor() });
    return false;
  };

  // When this choice runs out. Looking at the log doesn't restart the clock.
  let deadline = null;

  while (!state.finished) {
    let choice;
    if (deadline == null) deadline = Date.now() + TURN_MS;

    try {
      choice = await card.awaitMessageComponent({
        componentType: ComponentType.Button,
        time: Math.max(1_000, deadline - Date.now()),
        filter: (button) => button.user.id === userId,
      });
    } catch {
      // Timed out: treated the same as fleeing (see settle()).
      await conclude({ userId, state, setup, card, log, outcome: 'fled', edit: null });
      return;
    }

    const [, verb, value] = choice.customId.split(':');

    if (verb === 'log') {
      await choice.reply(fullLog(log)).catch(() => {});
      continue;
    }
    deadline = null;

    if (verb === 'switch') {
      mode = 'switch';
      await choice.update({ components: componentsFor() });
      continue;
    }

    if (verb === 'back') {
      mode = 'moves';
      await choice.update({ components: componentsFor() });
      continue;
    }

    if (verb === 'forfeit') {
      await conclude({ userId, state, setup, card, log, outcome: 'fled', edit: choice });
      return;
    }

    // A forced replacement is free: no turn is resolved.
    if (mode === 'replace' && verb === 'send') {
      const arriving = [];
      const sent = battle.sendOut(state, 0, Number(value), arriving);

      if (!sent) {
        // Invalid choice (fainted or already active): show the bench again.
        await choice.update({ components: componentsFor() });
        continue;
      }

      log.push(...narrate([sent, ...arriving]));

      // Hazards can knock out the one that just came in, and even end it.
      const after = [];
      battle.checkFinished(state, after);
      if (state.finished) {
        await conclude({ userId, state, setup, card, log, edit: choice });
        return;
      }

      const me = state.sides[0];
      mode = battle.activeOf(me).fainted ? 'replace' : 'moves';

      await choice.update({ embeds: [buildCard(state, log)], components: componentsFor() });
      continue;
    }

    let events;

    if (mode === 'midturn' && verb === 'send') {
      // The player picked who comes in after their U-turn or Baton Pass; the
      // rest of the turn (including the foe's chosen move) carries on.
      const target = state.sides[0].team[Number(value)];
      if (!target || target.fainted || Number(value) === state.sides[0].active) {
        await choice.update({ components: componentsFor() });
        continue;
      }
      events = battle.continueTurn(state, Number(value));
    } else {
      const action =
        verb === 'send'
          ? { type: 'switch', index: Number(value) }
          : { type: 'move', slot: Number(value) };

      // The opponent chooses from the same pre-turn state as the player
      // (Utils/ai.js: attacks, status, boosts, healing and, for trainers, the
      // occasional switch).
      const foeAction = ai.chooseAction(state, 1);

      // A switch out mid-turn (U-turn, Baton Pass...) happens straight away,
      // before the other side's move: the AI picks at once, and the turn
      // pauses for the player to pick.
      events = battle.resolveTurn(state, [action, foeAction], {
        choose: (s, sideIndex) => (sideIndex === 1 ? ai.chooseReplacement(s, 1) : null),
      });
    }

    if (await finishTurn(events, choice)) return;

    // Locked in (the second turn of Dig, the rest of Outrage, Hyper Beam's
    // recharge): those turns play out on their own, as in the games.
    while (mode === 'moves' && !state.finished && rules.lockedAction(battle.activeOf(state.sides[0]))) {
      await new Promise((resolve) => setTimeout(resolve, AUTO_TURN_MS));
      const more = battle.resolveTurn(state, [{ type: 'move', slot: 0 }, ai.chooseAction(state, 1)], {
        choose: (s, sideIndex) => (sideIndex === 1 ? ai.chooseReplacement(s, 1) : null),
      });
      if (await finishTurn(more, null)) return;
    }
  }

  await conclude({ userId, state, setup, card, log, edit: null });
}

/**
 * Pay for every opponent that has gone down and not yet been paid for.
 *
 * Called after each turn so experience appears in the log next to the faint.
 *
 * `paid` is the set of opponent ids already settled, kept for the whole
 * battle so a fainted opponent is not paid for again on later turns.
 *
 * A Pokemon that levels up does so straight away: its level, stats and HP
 * change for the rest of the fight. The log only shows the experience; the
 * level-ups are announced together once the battle is over (see settle()).
 * Evolutions and new moves also wait until the end.
 *
 * @returns {string[]} lines for the battle log
 */
function payKnockouts({ userId, state, cap, paid }) {
  const [playerSide, foeSide] = state.sides;
  const lines = [];

  for (const fallen of foeSide.team) {
    if (!fallen.fainted || paid.has(fallen.id)) continue;
    paid.add(fallen.id);

    const earned = rewards.forKnockout({ playerSide, fallen, cap });
    if (!earned.length) continue;

    let applied;
    try {
      applied = store.awardKnockout(userId, earned, cap);
    } catch (err) {
      // Log payout errors without ending the battle.
      console.error('A knockout could not be paid for:', err);
      continue;
    }

    for (const mon of applied) {
      // A Pokemon at the obedience limit earns nothing (it may still have
      // gained EVs), so only real experience is logged.
      if (mon.exp > 0) lines.push(`${mon.name} gained **${mon.exp.toLocaleString()}** exp.`);

      // Grow it in the fight too, so its new level and stats count from now.
      if (mon.levelledFrom) {
        const fighter = playerSide.team.find((m) => m.id === mon.id);
        battle.applyLevelUp(fighter, store.getOwnedPokemon(userId, mon.id));
      }
    }
  }

  return lines;
}

/**
 * Answer the finished card's log button for LOG_KEPT_MS, then take it away.
 * Runs in the background; the battle itself is already over.
 */
function keepLogOpen(card, log) {
  livebuttons.track(card, livebuttons.ANYONE);

  const collector = card.createMessageComponentCollector({ componentType: ComponentType.Button, time: LOG_KEPT_MS });
  collector.on('collect', (press) => {
    if (press.customId === 'bt:log') press.reply(fullLog(log)).catch(() => {});
  });
  collector.on('end', () => {
    livebuttons.release(card);
    card.edit({ components: [] }).catch(() => {});
  });
}

/**
 * End it, pay it out and post the final card.
 *
 * Every exit (win, loss, flee, timeout) comes through here, so rewards are
 * decided in one place.
 *
 * `edit` is the button interaction to answer, when there is one. A timeout has
 * none, so the card is edited directly.
 */
async function conclude({ userId, state, setup, card, log, outcome = null, edit = null }) {
  const { lines, announcements, offers } = settle(userId, state, setup, outcome);

  const heading = state.endedBy
    ? 'Battle over'
    : outcome === 'fled'
      ? state.kind === 'wild'
        ? 'Got away'
        : 'Walked away'
      : state.winner === 0
        ? 'Victory'
        : 'Defeat';

  const finished = buildCard(state, log)
    .setFooter({ text: `${state.turn} turn${state.turn === 1 ? '' : 's'}` })
    .addFields({ name: heading, value: lines.join('\n') || '-' });

  // The log stays readable for a while after the battle, by anyone.
  const keepLog = Boolean(card && typeof card.createMessageComponentCollector === 'function');
  const payload = {
    embeds: [finished],
    components: keepLog ? [new ActionRowBuilder().addComponents(logButton())] : [],
  };

  if (edit) await edit.update(payload).catch(() => {});
  else await card.edit(payload).catch(() => {});

  if (keepLog) keepLogOpen(card, log);

  // Post level-ups, warnings, evolutions, the Lootbox and milestone unlocks as
  // separate messages, in that order (see settle()). Best-effort: rewards are
  // already saved, and the headless test driver has no channel.
  if (announcements.length && card && card.channel && typeof card.channel.send === 'function') {
    for (const text of announcements) {
      await card.channel.send({ content: text }).catch(() => {});
    }
  }

  // Moves that need a slot freed: ask which to forget, one card at a time.
  // Not awaited, so the battle (and its party lock) ends while they wait.
  if (offers.length && card && card.channel && typeof card.channel.send === 'function') {
    const send = (payload) => card.channel.send(payload);

    (async () => {
      for (const offer of offers) {
        await moveprompt.askAll({ send, userId, pokemonId: offer.id, moves: offer.moves });
      }
    })().catch((err) => console.error('Move offers failed:', err));
  }
}

module.exports = {
  // `.b` is short for battle (`.buy` uses `.purchase`).
  aliases: ['battle', 'b', 'fight', 'bt'],

  data: new SlashCommandBuilder()
    .setName('battle')
    .setDescription('Fight whatever the world puts in front of you.')
    .addStringOption((option) =>
      option
        .setName('what')
        .setDescription('Leave empty for an ordinary battle.')
        .addChoices({ name: 'milestone', value: 'milestone' })
    )
    .addStringOption((option) =>
      option
        .setName('opponent')
        .setDescription('For the Elite Four: which member to fight. Leave empty for the next in line.')
    ),

  async execute(interaction) {
    // The battle runs on a separate message, so answer the interaction first.
    await interaction.reply({ content: 'Looking for a fight...' });

    const fake = {
      author: interaction.user,
      channel: interaction.channel,
      guildId: interaction.guildId,
    };

    await run(fake, [
      interaction.options.getString('what') || '',
      interaction.options.getString('opponent') || '',
    ]);
    await interaction.deleteReply().catch(() => {});
  },

  run,

  TURN_MS,
  active,
  prepare,
  settle,
  payKnockouts,
  narrate,
  moveLabel,
  buildCard,
  buildControls,
  buildSwitchRow,
  conclude,

  // Exported for headless testing; the bot itself goes through run().
  __loop: loop,
  spritesFor,
  healthBar,
};
