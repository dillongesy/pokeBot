'use strict';

/**
 * Registers slash commands with Discord.
 *
 *   npm run deploy              every server the bot is in (up to an hour to appear)
 *   npm run deploy -- <guildId> one server, visible immediately
 *
 * Only needs running when a command's name, description or options change -
 * not on every restart.
 */

const fs = require('fs');
const path = require('path');

const { REST, Routes } = require('discord.js');

const { loadCommands } = require('./commands');

const ENV_FILE = path.join(__dirname, '..', '.env');

function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return;
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(ENV_FILE);
    return;
  }
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([\w.-]+)\s*=\s*(.*)$/.exec(line);
    if (!match || line.trimStart().startsWith('#')) continue;
    if (!(match[1] in process.env)) {
      process.env[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}

async function deploy(guildId) {
  loadEnv();

  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;

  if (!token) throw new Error('No DISCORD_TOKEN in .env');
  if (!clientId) throw new Error('No DISCORD_CLIENT_ID in .env');

  const { slash } = loadCommands();
  const body = slash.map((command) => command.data.toJSON());

  const rest = new REST().setToken(token);
  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);

  const registered = await rest.put(route, { body });

  console.log(
    `Registered ${registered.length} slash command(s) ` +
      (guildId ? `to guild ${guildId}.` : 'globally - these can take up to an hour to show up.')
  );
  for (const command of registered) console.log(`  /${command.name}`);
}

module.exports = { deploy };

if (require.main === module) {
  deploy(process.argv[2]).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
