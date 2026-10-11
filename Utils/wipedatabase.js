'use strict';

/**
 * Wipes player data.
 *
 *   npm run wipe -- --all            everything, back to an empty schema
 *   npm run wipe -- --pokemon        every Pokemon and drop, keep users
 *   npm run wipe -- --drops          uncaught drops only
 *   npm run wipe -- --users          users, buffs, inventory and quest progress
 *   npm run wipe -- --user <id>      one player and everything they own
 *   npm run wipe -- --all --yes      skip the confirmation prompt
 *
 * This only ever touches Data/pokedropper.db. The imported PokeAPI data is a
 * separate concern - delete Data/ and re-run the importer for that.
 *
 * Nothing here is recoverable, so it prints what it is about to destroy and
 * waits for you to type "yes" unless --yes is passed.
 */

const fs = require('fs');
const readline = require('readline');

const db = require('./db');

/** The tables a wipe can clear, in an order that respects foreign keys. */
const TARGETS = {
  drops: {
    describe: 'uncaught drops (the Pokemon behind them are deleted too)',
    tables: ['drops', 'pokemon'],
    run(handle) {
      // Only wild ones. A caught Pokemon belongs to somebody.
      const drops = handle.prepare('DELETE FROM drops WHERE caught_by IS NULL').run();
      // Released Pokemon also have no trainer, but they are not wild.
      const mons = handle
        .prepare('DELETE FROM pokemon WHERE current_trainer_id IS NULL AND released_at IS NULL')
        .run();
      return { drops: drops.changes, pokemon: mons.changes };
    },
  },

  pokemon: {
    describe: 'every Pokemon and every drop, caught or not',
    run(handle) {
      const drops = handle.prepare('DELETE FROM drops').run();
      const mons = handle.prepare('DELETE FROM pokemon').run();
      handle.prepare('UPDATE users SET total_caught = 0').run();
      return { drops: drops.changes, pokemon: mons.changes };
    },
  },

  users: {
    describe: 'every player, their coins, buffs, items and quest progress',
    run(handle) {
      const quests = handle.prepare('DELETE FROM quest_progress').run();
      const inventory = handle.prepare('DELETE FROM inventory').run();
      const buffs = handle.prepare('DELETE FROM user_buffs').run();
      const users = handle.prepare('DELETE FROM users').run();
      return {
        quest_progress: quests.changes,
        inventory: inventory.changes,
        user_buffs: buffs.changes,
        users: users.changes,
      };
    },
  },

  all: {
    describe: 'EVERYTHING - every player, Pokemon, drop, item and quest',
    run(handle) {
      const counts = {};
      for (const table of [
        'quest_progress',
        'inventory',
        'user_buffs',
        'drops',
        'pokemon',
        'users',
      ]) {
        counts[table] = handle.prepare(`DELETE FROM ${table}`).run().changes;
      }
      // Start ids from 1 again on a full wipe.
      handle.prepare("DELETE FROM sqlite_sequence WHERE name IN ('pokemon', 'drops')").run();
      return counts;
    },
  },
};

/** How many rows each table currently holds. */
function rowCounts(handle) {
  const counts = {};
  for (const table of ['users', 'user_buffs', 'pokemon', 'drops', 'inventory', 'quest_progress']) {
    counts[table] = handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  }
  return counts;
}

/** Delete one player and everything of theirs. */
function wipeUser(handle, userId) {
  const counts = {};

  counts.drops = handle
    .prepare('DELETE FROM drops WHERE dropped_by = ? OR caught_by = ?')
    .run(userId, userId).changes;

  counts.pokemon = handle
    .prepare('DELETE FROM pokemon WHERE current_trainer_id = ?')
    .run(userId).changes;

  // Orphan anything they originally caught but has since been traded away.
  handle
    .prepare('UPDATE pokemon SET original_trainer_id = NULL WHERE original_trainer_id = ?')
    .run(userId);

  for (const table of ['quest_progress', 'inventory', 'user_buffs', 'users']) {
    counts[table] = handle
      .prepare(`DELETE FROM ${table} WHERE discord_user_id = ?`)
      .run(userId).changes;
  }

  return counts;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

function parseArgs(argv) {
  const options = { target: null, userId: null, yes: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--user') {
      options.target = 'user';
      options.userId = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--') && TARGETS[arg.slice(2)]) {
      options.target = arg.slice(2);
    }
  }

  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);

  if (!options.target) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].split('/**')[1].trim());
    return;
  }

  if (options.target === 'user' && !options.userId) {
    throw new Error('--user needs a Discord user id, like: npm run wipe -- --user 123456789');
  }

  // A database from an older schema can't be opened, so --all rebuilds it
  // from scratch. Other targets need a readable database to leave the rest
  // intact.
  let handle;
  try {
    handle = db.open();
  } catch (err) {
    if (options.target !== 'all') throw err;

    console.log(`${err.message}\n`);
    console.log('Rebuilding it empty, since that is what --all does anyway.');

    if (!options.yes) {
      const answer = await ask('\nType "yes" to continue: ');
      if (answer !== 'yes') {
        console.log('Cancelled. Nothing was deleted.');
        return;
      }
    }

    db.reset();
    console.log('\nDone. The database is empty and at the current schema version.');
    return;
  }

  const before = rowCounts(handle);

  console.log(`Database: ${db.DB_FILE}`);
  console.log('Currently holding:');
  for (const [table, count] of Object.entries(before)) console.log(`  ${table.padEnd(16)} ${count}`);
  console.log('');

  const what =
    options.target === 'user'
      ? `player ${options.userId} and everything they own`
      : TARGETS[options.target].describe;

  console.log(`About to delete ${what}.`);
  console.log('This cannot be undone.');

  if (!options.yes) {
    const answer = await ask('\nType "yes" to continue: ');
    if (answer !== 'yes') {
      console.log('Cancelled. Nothing was deleted.');
      return;
    }
  }

  handle.exec('BEGIN');
  let deleted;
  try {
    deleted =
      options.target === 'user'
        ? wipeUser(handle, options.userId)
        : TARGETS[options.target].run(handle);
    handle.exec('COMMIT');
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }

  // Hand the freed pages back to the filesystem.
  handle.exec('VACUUM');

  console.log('');
  console.log('Deleted:');
  for (const [table, count] of Object.entries(deleted)) {
    console.log(`  ${table.padEnd(16)} ${count}`);
  }

  const after = rowCounts(handle);
  console.log('');
  console.log('Now holding:');
  for (const [table, count] of Object.entries(after)) console.log(`  ${table.padEnd(16)} ${count}`);
}

module.exports = { main, parseArgs, rowCounts, wipeUser, TARGETS };

if (require.main === module) {
  main()
    .then(() => db.close())
    .catch((err) => {
      console.error('Wipe failed:', err.message);
      process.exit(1);
    });
}
