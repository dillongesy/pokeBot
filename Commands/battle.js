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
const obedience = require('../Utils/obedience');
const drop = require('./drop');

const POKEMON_DIR = path.join(__dirname, '..', 'Data', 'Pokemon');

/** How long a player has to choose, per turn. */
const TURN_MS = 90_000;

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

  // Discord limits button labels to 80 characters.
  return `${entry.data.displayName}${power ? ` (${power})` : ''} ${pp} PP`.slice(0, 80);
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
      case 'one-hit-ko': lines.push(`**${event.name}** went down in one hit!`); break;
      case 'magnitude': lines.push(`Magnitude ${event.number}!`); break;
      case 'stockpile': lines.push(`${event.name} stockpiled ${event.count}.`); break;
      case 'present-heal': lines.push(`${event.name} unwrapped it and felt better!`); break;
      case 'multi-hit': lines.push(`Hit ${event.hits} times!`); break;
      case 'faint': lines.push(`**${event.name}** fainted!`); break;
      case 'status': lines.push(`${event.name} was **${event.status}ed**!`); break;
      case 'cured': lines.push(`${event.name} shook off its ${event.status}.`); break;
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
      case 'paralysed': lines.push(`${event.name} is paralysed and can't move!`); break;
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
        lines.push(`${event.name}'s ${event.by} kept it from being ${event.status}ed.`);
        break;

      default: break;
    }
  }

  return lines;
}

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

  const recent = log.slice(-9);
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

  // Labels depend on the target. Without one, fall back to the move's own
  // numbers.
  const theirs = state.sides[1] ? battle.activeOf(state.sides[1]) : null;

  const rows = [];

  const anyPp = mine.moves.some((entry) => entry.pp > 0);

  if (!anyPp) {
    // Any slot works: the engine uses Struggle when no move has PP.
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
            .setDisabled(entry.pp <= 0)
        )
      )
    );
  }

  const bench = battle.benchOf(side);
  const extra = new ActionRowBuilder();

  if (bench.length) {
    extra.addComponents(
      new ButtonBuilder()
        .setCustomId('bt:switch')
        .setLabel(`Switch (${bench.length})`)
        .setStyle(ButtonStyle.Success)
    );
  }

  extra.addComponents(
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
  // `lines` is the summary for the battle card; `announcements` (evolutions,
  // milestones) are posted as separate messages.
  const evolutions = [];
  const offers = [];
  const announcements = [];

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
  // (experience itself was paid during the fight). Every recorded Pokemon is
  // passed: the battle state's levels are never updated as exp is paid, so
  // awardBattle compares against the stored level and skips anyone who didn't
  // grow.
  const startedAt = setup.startedAt || new Map();

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
      lines.push(...daily.recordWin(userId));
    } catch (err) {
      console.error('Daily quest update failed after a battle:', err);
    }
  } else if (outcome === 'fled') {
    lines.push(
      state.kind === 'wild'
        ? '**You got away safely.** Nothing was lost.'
        : '**You walked away.** Nothing was lost.'
    );
  } else {
    lines.push(`**You were defeated.** Nothing was lost. Try again with \`.battle\`.`);
  }

  // Experience lines were already logged per knockout.
  for (const mon of applied.pokemon) {
    // Moves learned into a free slot go on the card.
    if ((mon.learned || []).length) {
      lines.push(`${mon.name} learned **${mon.learned.join('**, **')}**!`);
    }

    // Moves that need a slot freed get their own prompt instead (see conclude).
    if ((mon.offered || []).length) offers.push({ id: mon.id, moves: mon.offered });

    // Evolutions are announced separately (see `announcements` below).
    for (const step of mon.evolutions || []) evolutions.push(step);
  }

  // Mention the extra Shedinja from Nincada's evolution.
  for (const born of applied.spawned || []) {
    lines.push(`A **${born.display_name}** was left behind - it is #${born.party_number}.`);
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

      lines.push('');
      lines.push(
        `**${member.member} is beaten!** That is ${beaten.size} of the Elite Four. ` +
          `Still to go: **${milestones.listNames(left)}**.`
      );
      lines.push('`.battle milestone` takes on the next, or name one: `.battle milestone ' +
        `${left[0].toLowerCase()}\`.`);
    }
  }

  if (payout.clearsMilestone) {
    const cleared = store.clearMilestone(userId);
    const after = store.trainerProgress(userId);

    lines.push('');
    lines.push(`**${member ? `The ${milestones.title(member)}` : setup.fight.name} is behind you.**`);
    lines.push(`Trainer level **${cleared.level}** - you now command Pokemon up to **level ${cleared.cap}**.`);
    if (after.next) {
      lines.push(
        `Next: **${milestones.title(after.next)}**` +
          `${milestones.isEliteFour(after.next) ? '' : ` of ${after.next.region}`}.`
      );
    }
    else lines.push('That was the last one. `.me` to prestige.');
  }

  // Warn about anything that just reached the obedience limit or went past
  // it. Experience keeps flowing after a milestone, so this is how players
  // find out before a Pokemon quietly stops fighting for them.
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

    // Going over gets its own message so it can't be missed; reaching the
    // limit is a line on the card.
    if (warning.kind === 'over') announcements.push(`### ⚠️ ${mon.name} will stop obeying you\n${text}`);
    else lines.push(`⚠️ ${text}`);
  }

  // ------------------------------------------------------------------
  // What gets its own message.
  // ------------------------------------------------------------------

  for (const step of evolutions) {
    announcements.push(
      [
        `### ✨ What? ${step.from} is evolving!`,
        `**${step.from}** evolved into **${step.into}**!`,
      ].join('\n')
    );
  }

  // Announce a milestone battle as soon as it unlocks.
  if (applied.levelled && applied.levelled.becamePending) {
    const standing = store.trainerProgress(userId);

    if (standing.next && milestones.isEliteFour(standing.next)) {
      const names = standing.next.members.map((m) => m.name);

      announcements.push(
        [
          `### 🏆 Elite Four ${milestones.listNames(names)} are waiting for you.`,
          `Your trainer bar is full - the **${milestones.title(standing.next)}** is the next ` +
            `milestone. Beat all four, in any order, to raise your cap to **${standing.cap + 1}**.`,
          '`.battle milestone` takes them on in order, or name one: ' +
            `\`.battle milestone ${names[0].toLowerCase()}\`.`,
        ].join('\n')
      );
    } else if (standing.next) {
      announcements.push(
        [
          `### 🏆 ${standing.next.name} is waiting for you.`,
          `Your trainer bar is full - **${standing.next.name}** of ${standing.next.region} is ` +
            `the next milestone, and beating them raises your cap to **${standing.cap + 1}**.`,
          'Take them on with `.battle milestone` when you are ready.',
        ].join('\n')
      );
    }
  }

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
    // Always release the battle, its buttons and the party lock.
    active.delete(userId);
    livebuttons.release(card);
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

  const componentsFor = () =>
    mode === 'moves' ? buildControls(state) : buildSwitchRow(state, mode === 'replace');

  while (!state.finished) {
    let choice;

    try {
      choice = await card.awaitMessageComponent({
        componentType: ComponentType.Button,
        time: TURN_MS,
        filter: (button) => button.user.id === userId,
      });
    } catch {
      // Timed out: treated the same as fleeing (see settle()).
      await conclude({ userId, state, setup, card, log, outcome: 'fled', edit: null });
      return;
    }

    const [, verb, value] = choice.customId.split(':');

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
      mode = 'moves';

      await choice.update({ embeds: [buildCard(state, log)], components: componentsFor() });
      continue;
    }

    const action =
      verb === 'send'
        ? { type: 'switch', index: Number(value) }
        : { type: 'move', slot: Number(value) };

    // The opponent chooses from the same pre-turn state as the player.
    const foe = state.sides[1];
    const foeAction = {
      type: 'move',
      slot: battle.chooseMove(battle.activeOf(foe), battle.activeOf(state.sides[0])),
    };

    const events = battle.resolveTurn(state, [action, foeAction]);
    log.push(...narrate(events));

    // Pay out experience for knockouts this turn.
    log.push(...payKnockouts({ userId, state, cap: setup.cap, paid }));

    // Fainted opponents are replaced immediately; the player chooses their own
    // replacement via `mode` below.
    if (battle.activeOf(foe).fainted && !battle.wipedOut(foe)) {
      const free = battle.benchOf(foe);
      if (free.length) {
        // `arriving` holds events triggered by the replacement's entry.
        const arriving = [];
        const sent = battle.sendOut(state, 1, free[0].index, arriving);
        if (sent) log.push(...narrate([sent, ...arriving]));
      }
    }

    if (state.finished) {
      await conclude({ userId, state, setup, card, log, edit: choice });
      return;
    }

    const mine = state.sides[0];
    mode = battle.activeOf(mine).fainted && !battle.wipedOut(mine) ? 'replace' : 'moves';

    await choice.update({ embeds: [buildCard(state, log)], components: componentsFor() });
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
 * Only experience and EVs are handled here; evolutions and new moves wait
 * until the end (see settle()).
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
      applied = store.awardKnockout(userId, earned);
    } catch (err) {
      // Log payout errors without ending the battle.
      console.error('A knockout could not be paid for:', err);
      continue;
    }

    for (const mon of applied) {
      lines.push(
        `${mon.name} gained **${mon.exp.toLocaleString()}** exp` +
          (mon.levelledFrom ? ` and grew to **level ${mon.level}**!` : '.')
      );
    }
  }

  return lines;
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

  const heading =
    outcome === 'fled'
      ? state.kind === 'wild'
        ? 'Got away'
        : 'Walked away'
      : state.winner === 0
        ? 'Victory'
        : 'Defeat';

  const finished = buildCard(state, log)
    .setFooter({ text: `${state.turn} turn${state.turn === 1 ? '' : 's'}` })
    .addFields({ name: heading, value: lines.join('\n') || '-' });

  const payload = { embeds: [finished], components: [] };

  if (edit) await edit.update(payload).catch(() => {});
  else await card.edit(payload).catch(() => {});

  // Post evolutions and milestone unlocks as separate messages. Best-effort:
  // rewards are already saved, and the headless test driver has no channel.
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
