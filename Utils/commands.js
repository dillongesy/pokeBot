'use strict';

/**
 * Loads everything in Commands/ and works out how each one can be invoked.
 *
 * A command file exports some of:
 *
 *   data     a SlashCommandBuilder, if it should exist as a slash command
 *   execute  handler for the slash command, given an interaction
 *   run      handler for the prefix command, given a message and its arguments
 *   aliases  the prefix names it answers to, so ["d", "drop"] gives .d and .drop
 *
 * A file exporting neither handler is skipped.
 */

const fs = require('fs');
const path = require('path');

const COMMANDS_DIR = path.join(__dirname, '..', 'Commands');

/** Files in Commands/ that are not commands. */
const SKIP = new Set(['catch.js']);

function loadCommands() {
  const commands = new Map();
  const byAlias = new Map();
  const owner = new Map();
  const slash = [];
  const skipped = [];
  const collisions = [];

  for (const file of fs.readdirSync(COMMANDS_DIR)) {
    if (!file.endsWith('.js') || SKIP.has(file)) continue;

    const name = path.basename(file, '.js');
    const command = require(path.join(COMMANDS_DIR, file));

    if (!command || (!command.run && !command.execute)) {
      skipped.push(name);
      continue;
    }

    commands.set(name, command);

    // The file name is always an alias. Deduplicated because most files also
    // list their own name in `aliases`.
    const claimed = new Set(
      [name, ...(command.aliases || [])].map((alias) => String(alias).toLowerCase())
    );

    for (const key of claimed) {
      // If two files claim the same alias, the first one keeps it and the
      // clash is reported at startup.
      if (owner.has(key)) {
        collisions.push({ alias: key, kept: owner.get(key), dropped: name });
        continue;
      }

      owner.set(key, name);
      byAlias.set(key, command);
    }

    if (command.data && command.execute) slash.push(command);
  }

  return { commands, byAlias, slash, skipped, collisions, owner };
}

module.exports = { loadCommands, COMMANDS_DIR };
