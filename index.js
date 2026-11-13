'use strict';

/**
 * Bot entry point.
 *
 *   npm start
 *
 * Every command in Commands/ is available two ways: as ".name" in chat and, if
 * it defines one, as a slash command. Catching is neither - it watches ordinary
 * chat for a Pokemon's name, so it is handled separately.
 */

const fs = require('fs');
const path = require('path');

const { Client, GatewayIntentBits, MessageFlags } = require('discord.js');

const { loadCommands } = require('./Utils/commands');
const { tryCatch } = require('./Commands/catch');
const db = require('./Utils/db');
const store = require('./Utils/store');
const crashlog = require('./Utils/crashlog');

// Every reported failure also goes to a file in Logs/ (see Utils/crashlog.js),
// and so does any freeze long enough for Discord to give up on a button
// press (see Utils/lagwatch.js).
crashlog.install();
const lagwatch = require('./Utils/lagwatch');
lagwatch.start();
const reminders = require('./Utils/reminders');
const channels = require('./Utils/channels');
const livebuttons = require('./Utils/livebuttons');

const ENV_FILE = path.join(__dirname, '.env');
const PREFIX = '.';

/** Read .env into process.env. Node can do this itself on 20.12+. */
function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return;

  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(ENV_FILE);
    return;
  }

  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([\w.-]+)\s*=\s*(.*)$/.exec(line);
    if (!match || line.trimStart().startsWith('#')) continue;
    const value = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (!(match[1] in process.env)) process.env[match[1]] = value;
  }
}

loadEnv();

const TOKEN = process.env.DISCORD_TOKEN;

if (!TOKEN) {
  console.error('No DISCORD_TOKEN found. Put DISCORD_TOKEN=... in .env');
  process.exit(1);
}

// Create the database before accepting any traffic.
db.open();

const { byAlias, slash, skipped, collisions } = loadCommands();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    // Privileged. Enable "Message Content Intent" on the bot's page in the
    // Discord developer portal, or none of this will be visible to the bot.
    GatewayIntentBits.MessageContent,
  ],
});

client.once('clientReady', (bot) => {
  const names = [...new Set([...byAlias.keys()])].sort().join(', ');
  console.log(`Logged in as ${bot.user.tag}`);

  // Cooldown reminders are timers, so a restart loses them. Rebuild from the
  // database rather than making people re-opt-in.
  reminders.attach(bot);
  const armed = reminders.rearmAll();
  if (armed) console.log(`re-armed ${armed} cooldown reminder(s)`);
  console.log(`prefix commands: ${names}`);
  console.log(`slash commands:  ${slash.map((c) => c.data.name).join(', ') || 'none'}`);
  if (skipped.length) console.log(`not implemented yet: ${skipped.join(', ')}`);

  // Two commands claiming the same alias is a bug, so report it.
  for (const clash of collisions) {
    console.warn(
      `alias collision: .${clash.alias} is ${clash.kept}, so ${clash.dropped} does not get it`
    );
  }
});

// Which channels the bot may speak in. Both live in Utils/channels.js rather
// than here so they can be tested without logging into Discord.
const { mayAnswer, notHere } = channels;

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.content) return;

  try {
    // A prefix command, if it looks like one.
    if (message.content.startsWith(PREFIX)) {
      const [word, ...args] = message.content.slice(PREFIX.length).trim().split(/\s+/);
      const name = (word || '').toLowerCase();
      const command = byAlias.get(name);

      if (command && command.run) {
        if (!mayAnswer(message.guildId, message.channelId, name)) return;

        store.noteGuild(message.author.id, message.guildId);
        lagwatch.note(`.${name} ${args.join(' ')}`.trim());
        await command.run(message, args);
        return;
      }
    }

    // Otherwise it may be a catch attempt. Catching respects the channel
    // allowlist the same way commands do.
    if (!mayAnswer(message.guildId, message.channelId)) return;

    if (await tryCatch(message)) store.noteGuild(message.author.id, message.guildId);
  } catch (err) {
    crashlog.record('command', err, {
      message: message.content,
      userId: message.author && message.author.id,
      guildId: message.guildId,
      channelId: message.channelId,
    });
    console.error('Message handler failed:', err);
    await message.channel.send('Something went wrong running that.').catch(() => {});
  }
});

/**
 * Discord gives every press and slash command 3 seconds to be answered. Note
 * any that only reached the bot after most of that was gone: the delay was
 * on the way here (the network, Discord itself), not in the bot. At most one
 * log a minute.
 */
const LATE_MS = 2000;
let lastLate = 0;

function noteIfLate(interaction, what) {
  const age = Date.now() - interaction.createdTimestamp;
  if (age < LATE_MS || Date.now() - lastLate < 60_000) return;
  lastLate = Date.now();
  crashlog.record('late', new Error(`${what} reached the bot ${(age / 1000).toFixed(1)} seconds after it was made`), {
    what,
    ageMs: age,
    wsPingMs: client.ws.ping,
    userId: interaction.user && interaction.user.id,
    note: "The time is measured against this machine's clock. If every log says about the same delay, check the clock (timedatectl).",
  });
}

client.on('interactionCreate', async (interaction) => {
  // Buttons and menus are handled by their own collectors. This only answers
  // the presses none of them will: expired, left over from before a restart,
  // or pressed by someone else.
  if (interaction.isMessageComponent()) {
    lagwatch.note(`button ${interaction.customId}`);
    noteIfLate(interaction, `The press on ${interaction.customId}`);
    await livebuttons.answerStray(interaction);
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const command = slash.find((c) => c.data.name === interaction.commandName);
  if (!command) return;

  // Interactions must be answered or Discord shows an error, so a blocked
  // channel gets an ephemeral notice instead of silence.
  if (!mayAnswer(interaction.guildId, interaction.channelId, interaction.commandName)) {
    await interaction
      .reply({ content: notHere(interaction.guildId), flags: MessageFlags.Ephemeral })
      .catch(() => {});
    return;
  }

  try {
    store.noteGuild(interaction.user.id, interaction.guildId);
    lagwatch.note(`/${interaction.commandName}`);
    noteIfLate(interaction, `/${interaction.commandName}`);
    await command.execute(interaction);
  } catch (err) {
    crashlog.record('command', err, {
      command: `/${interaction.commandName}`,
      options: interaction.options && interaction.options.data,
      userId: interaction.user && interaction.user.id,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
    });
    console.error(`/${interaction.commandName} failed:`, err);
    const content = 'Something went wrong running that.';
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content }).catch(() => {});
    } else {
      await interaction.reply({ content }).catch(() => {});
    }
  }
});

client.on('error', (err) => console.error('Client error:', err));

// Log stray errors and keep running, so one broken command can't take the
// whole bot offline.
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => {
  crashlog.record('crash', err, { what: 'uncaught exception' });
  console.error('Uncaught exception:', err);
});

/**
 * Shut down cleanly. Closing the database checkpoints the WAL file back into
 * the main database file, so backups taken afterwards are complete.
 */
let closing = false;

function shutdown(signal) {
  if (closing) return;
  closing = true;

  console.log(`${signal} - shutting down.`);
  client.destroy().catch(() => {});
  try {
    db.close();
  } catch (err) {
    console.error('Closing the database failed:', err);
  }
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(signal));

client.login(TOKEN);
