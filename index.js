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

        await command.run(message, args);
        return;
      }
    }

    // Otherwise it may be a catch attempt. Catching respects the channel
    // allowlist the same way commands do.
    if (!mayAnswer(message.guildId, message.channelId)) return;

    await tryCatch(message);
  } catch (err) {
    console.error('Message handler failed:', err);
    await message.channel.send('Something went wrong running that.').catch(() => {});
  }
});

client.on('interactionCreate', async (interaction) => {
  // Buttons and menus are handled by their own collectors. This only answers
  // the presses none of them will: expired, left over from before a restart,
  // or pressed by someone else.
  if (interaction.isMessageComponent()) {
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
    await command.execute(interaction);
  } catch (err) {
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
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));

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
