'use strict';

/**
 * The bot's database - a single SQLite file at Data/pokedropper.db.
 *
 * Uses node:sqlite, which is built into Node, so there is nothing to install
 * or compile. Only player data is stored here; static game data (species,
 * items, quests, shop stock) lives as files under Data/.
 *
 * The schema below is created on an empty database. An older database is
 * upgraded by MIGRATIONS when there is a path from its version (additive
 * changes only); otherwise it is refused on startup and has to be upgraded by
 * hand or rebuilt.
 *
 * Run `node Utils/db.js` to create it, or `node Utils/db.js --reset` to delete
 * and rebuild it.
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_FILE = path.join(__dirname, '..', 'Data', 'pokedropper.db');

/**
 * Bumped whenever the schema below changes.
 *
 * Stored in SQLite's `PRAGMA user_version`, so an out-of-date file fails
 * clearly at startup instead of with "no such column" errors later.
 */
const SCHEMA_VERSION = 18;

/**
 * Which Elite Four members a player has beaten on the milestone in front of
 * them. `milestone` is its 1-based ladder order. Rows are deleted when that
 * milestone is cleared, so a prestige starts the four again.
 */
const ELITE_FOUR_WINS = `
CREATE TABLE elite_four_wins (
  discord_user_id TEXT NOT NULL REFERENCES users(discord_user_id) ON DELETE CASCADE,
  milestone       INTEGER NOT NULL,
  member          TEXT NOT NULL,
  beaten_at       INTEGER NOT NULL,

  PRIMARY KEY (discord_user_id, milestone, member)
);
`;

/**
 * Which servers each player has used the bot in, for the leaderboards' "This
 * server" filter (the bot can't list a server's members without the members
 * intent). Written on every command and catch in a server.
 */
const USER_GUILDS = `
CREATE TABLE user_guilds (
  discord_user_id TEXT NOT NULL,
  guild_id        TEXT NOT NULL,
  PRIMARY KEY (discord_user_id, guild_id)
);
`;

/**
 * Daily quests: one row per player per day, where a day runs midnight to
 * midnight US Central (see Utils/daily.js).
 *
 * Old rows are pruned after a week. `vote_created_at` is kept on the row so a
 * top.gg vote is only ever credited once, even across midnight.
 */
const DAILY_QUESTS = `
CREATE TABLE daily_quests (
  discord_user_id TEXT NOT NULL REFERENCES users(discord_user_id) ON DELETE CASCADE,

  -- 'YYYY-MM-DD' in America/Chicago.
  day             TEXT NOT NULL,

  catch_target    INTEGER NOT NULL,
  catches         INTEGER NOT NULL DEFAULT 0,
  battle_target   INTEGER NOT NULL,
  wins            INTEGER NOT NULL DEFAULT 0,

  -- 1 once each reward has been paid.
  catch_done      INTEGER NOT NULL DEFAULT 0,
  battle_done     INTEGER NOT NULL DEFAULT 0,
  vote_done       INTEGER NOT NULL DEFAULT 0,
  bonus_done      INTEGER NOT NULL DEFAULT 0,

  -- Overdrive, the hidden goals past the dailies: 1 once each has been paid.
  od_catch_done   INTEGER NOT NULL DEFAULT 0,
  od_battle_done  INTEGER NOT NULL DEFAULT 0,
  od_both_done    INTEGER NOT NULL DEFAULT 0,

  -- When the credited vote was cast, per top.gg. Milliseconds since the epoch.
  vote_created_at INTEGER,

  PRIMARY KEY (discord_user_id, day)
);
`;

const SCHEMA = `
-- ---------------------------------------------------------------------------
-- Players
-- ---------------------------------------------------------------------------

-- One row per Discord user. Discord IDs are 64-bit snowflakes that lose
-- precision as JS numbers, so they are stored as TEXT everywhere.
CREATE TABLE users (
  discord_user_id TEXT PRIMARY KEY,

  coins           INTEGER NOT NULL DEFAULT 0,
  gold            INTEGER NOT NULL DEFAULT 0,
  total_caught    INTEGER NOT NULL DEFAULT 0,
  total_spent     INTEGER NOT NULL DEFAULT 0,

  cooldown_end    INTEGER NOT NULL DEFAULT 0,

  -- Opt-in ping when the drop cooldown ends.
  remind_enabled  INTEGER NOT NULL DEFAULT 0,

  -- How this player likes .party sorted. 'custom' means the hand-made order
  -- held in pokemon.party_position.
  party_sort      TEXT NOT NULL DEFAULT 'party',
  party_direction TEXT NOT NULL DEFAULT 'asc',

  -- Unused since schema 16, when party numbers became slots (see
  -- pokemon.party_number). Kept so older databases need no table rebuild.
  next_party_number INTEGER NOT NULL DEFAULT 1,

  -- How this player likes .bag sorted, set by .inventorysort: alphabetical,
  -- shop (the shop's own order), quantity, or 'custom' (inventory.position).
  bag_sort        TEXT NOT NULL DEFAULT 'shop',

  -- The two consumable slots, holding an item slug from Utils/incense.js.
  -- Equipping moves the item out of the bag and into one of these; the next
  -- drop reads it and clears it.
  --
  -- Columns rather than buff rows because they hold a slug, not a number.
  active_repel    TEXT,
  active_incense  TEXT,

  -- ---- Trainer progression -------------------------------------------------
  --
  -- See Utils/trainer.js. The obedience cap is derived from trainer_level
  -- rather than stored.
  trainer_level      INTEGER NOT NULL DEFAULT 1,
  trainer_exp        INTEGER NOT NULL DEFAULT 0,

  -- Milestone battles won. trainer_level can never exceed
  -- milestones_cleared + 1.
  milestones_cleared INTEGER NOT NULL DEFAULT 0,

  -- How many times they have run the whole ladder and reset it. Shown in .me.
  prestige           INTEGER NOT NULL DEFAULT 0,

  -- Win/loss counts for .me and the leaderboards. Fleeing is a loss; a
  -- battle ended by Roar and the like counts as neither. The totals cover
  -- every kind; the split by kind started at schema 15.
  battles_won        INTEGER NOT NULL DEFAULT 0,
  battles_lost       INTEGER NOT NULL DEFAULT 0,
  wild_won           INTEGER NOT NULL DEFAULT 0,
  wild_lost          INTEGER NOT NULL DEFAULT 0,
  trainer_won        INTEGER NOT NULL DEFAULT 0,
  trainer_lost       INTEGER NOT NULL DEFAULT 0,
  milestone_won      INTEGER NOT NULL DEFAULT 0,
  milestone_lost     INTEGER NOT NULL DEFAULT 0,

  -- Days in a row with every daily done, and the last such day (Utils/daily.js).
  daily_streak       INTEGER NOT NULL DEFAULT 0,
  daily_streak_day   TEXT,

  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- Buffs are rows rather than columns so new ones need no schema change.
-- Repels and incenses are stored on users instead.
CREATE TABLE user_buffs (
  discord_user_id TEXT NOT NULL REFERENCES users(discord_user_id) ON DELETE CASCADE,
  buff            TEXT NOT NULL,
  value           REAL NOT NULL DEFAULT 1,
  expires_at      INTEGER,
  PRIMARY KEY (discord_user_id, buff)
);

-- What each user owns. The item column is the slug from Data/Items, so the
-- name, effect, sprite and price are never duplicated here.
CREATE TABLE inventory (
  discord_user_id TEXT NOT NULL REFERENCES users(discord_user_id) ON DELETE CASCADE,
  item            TEXT NOT NULL,
  quantity        INTEGER NOT NULL DEFAULT 0,

  -- Position in the hand-ordered bag (".is swap a b"). NULL sorts last.
  position        INTEGER,

  PRIMARY KEY (discord_user_id, item)
);

-- ---------------------------------------------------------------------------
-- Pokemon
-- ---------------------------------------------------------------------------

-- One row per individual Pokemon that has ever existed.
--
-- A row with current_trainer_id IS NULL and released_at IS NULL is a wild
-- Pokemon that has dropped but not been caught. Catching it fills in the
-- trainer columns, so it stays the same record.
--
-- Only instance data is stored. Base stats, artwork and so on are looked up
-- in Data/Pokemon via species_id + form_folder.
CREATE TABLE pokemon (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,

  species_id           INTEGER NOT NULL,
  form_folder          TEXT NOT NULL,
  form_slug            TEXT NOT NULL,
  species_name         TEXT NOT NULL,

  -- The species name reduced to letters and digits, so "Ho-Oh", "ho oh" and
  -- "hooh" all compare equal. Written by Utils/pokemon.js normaliseName().
  species_key          TEXT NOT NULL DEFAULT '',

  display_name         TEXT NOT NULL,
  nickname             TEXT,

  original_trainer_id  TEXT,
  current_trainer_id   TEXT,

  -- When a Pokemon was released. Distinguishes released Pokemon from
  -- uncaught drops. Rows are kept so drop history survives.
  released_at          INTEGER,

  level                INTEGER NOT NULL,
  exp                  INTEGER NOT NULL DEFAULT 0,
  nature               TEXT NOT NULL,
  ability              TEXT NOT NULL,

  -- Ability slot from PokeAPI: 1 and 2 are normal, 3 is hidden. Evolving and
  -- reverting from a Mega keep the slot rather than the ability.
  ability_slot         INTEGER NOT NULL DEFAULT 1,

  gender               TEXT NOT NULL,
  shiny                INTEGER NOT NULL DEFAULT 0,

  -- Friendship, 0-255. See Utils/happiness.js.
  happiness            INTEGER NOT NULL DEFAULT 70,

  -- Whether this shiny came from a natural roll rather than a Shiny Incense.
  -- Used by the Shiny Dropper quest; stored on the Pokemon so it doesn't
  -- matter who caught it. 0 when unknown.
  shiny_natural        INTEGER NOT NULL DEFAULT 0,

  iv_hp                INTEGER NOT NULL,
  iv_attack            INTEGER NOT NULL,
  iv_defense           INTEGER NOT NULL,
  iv_special_attack    INTEGER NOT NULL,
  iv_special_defense   INTEGER NOT NULL,
  iv_speed             INTEGER NOT NULL,
  iv_total             INTEGER NOT NULL,

  ev_hp                INTEGER NOT NULL DEFAULT 0,
  ev_attack            INTEGER NOT NULL DEFAULT 0,
  ev_defense           INTEGER NOT NULL DEFAULT 0,
  ev_special_attack    INTEGER NOT NULL DEFAULT 0,
  ev_special_defense   INTEGER NOT NULL DEFAULT 0,
  ev_speed             INTEGER NOT NULL DEFAULT 0,

  -- Derived from base + IV + EV + level + nature. Stored rather than computed
  -- on read so a party list can sort by them in SQL.
  stat_hp              INTEGER NOT NULL,
  stat_attack          INTEGER NOT NULL,
  stat_defense         INTEGER NOT NULL,
  stat_special_attack  INTEGER NOT NULL,
  stat_special_defense INTEGER NOT NULL,
  stat_speed           INTEGER NOT NULL,
  current_hp           INTEGER NOT NULL,

  -- Copied from Data/Pokemon so parties can be sorted and filtered in SQL.
  -- Rewritten when the form changes (see recalculateStats in
  -- Utils/pokemon.js).
  bst                  INTEGER NOT NULL,
  types                TEXT NOT NULL,
  region               TEXT,

  -- normal | legendary | mythical | ultraBeast, from Utils/rarity.js. Stored
  -- for filtering and sorting in SQL.
  rarity               TEXT NOT NULL DEFAULT 'normal',

  -- The slot used in commands (".view 12"): 1 to N with no gaps, in the order
  -- the player arranged (.swap, .order). A new Pokemon takes the end; when one
  -- leaves, everything after it moves up. The id above is the permanent
  -- identity, unique across the bot, shown in .view.
  --
  -- NULL means unowned (an uncaught drop or a released Pokemon).
  party_number         INTEGER,

  -- Unused since schema 16: the hand-made order is the slot order now.
  party_position       INTEGER,

  equipped_item        TEXT,
  acquired_method      TEXT NOT NULL DEFAULT 'drop',
  acquired_at          INTEGER,

  -- Met data. met_level is used by Utils/obedience.js.
  --
  -- Written once when a Pokemon is caught or granted, and not changed by
  -- trades. NULL on older records that predate met data.
  met_level            INTEGER,
  met_channel_id       TEXT,
  met_guild_id         TEXT,

  -- When it was met. Unlike acquired_at (when it last changed hands), this is
  -- only written at the actual catch, so NULL means the date is unknown.
  met_at               INTEGER,

  created_at           INTEGER NOT NULL
);

CREATE INDEX idx_pokemon_trainer     ON pokemon(current_trainer_id);
CREATE INDEX idx_pokemon_species     ON pokemon(species_id);
CREATE INDEX idx_pokemon_species_key ON pokemon(species_key);
CREATE INDEX idx_pokemon_released    ON pokemon(released_at);
CREATE INDEX idx_pokemon_rarity      ON pokemon(current_trainer_id, rarity);
CREATE INDEX idx_pokemon_position    ON pokemon(current_trainer_id, party_position);

-- Party numbers are unique per player. Partial index, so unowned rows (NULL)
-- don't collide.
CREATE UNIQUE INDEX idx_pokemon_party_number
  ON pokemon(current_trainer_id, party_number)
  WHERE current_trainer_id IS NOT NULL AND party_number IS NOT NULL;

-- What each Pokemon knows, one row per move.
--
-- A separate table so duplicate moves can be prevented with a constraint.
--
-- Current PP is not stored; it is battle state and refills after every
-- battle. pp_up is stored because PP Ups are permanent.
CREATE TABLE pokemon_moves (
  pokemon_id INTEGER NOT NULL REFERENCES pokemon(id) ON DELETE CASCADE,

  -- 1-4. Which button the move sits on, and the order they are listed in.
  slot       INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 4),

  -- The move's PokeAPI name, the same way inventory stores an item slug.
  -- Power, accuracy, type and the rest stay in Data/Moves.
  move       TEXT    NOT NULL,

  -- How many PP Ups have been used on it, 0-3. Not the current PP.
  pp_up      INTEGER NOT NULL DEFAULT 0 CHECK (pp_up BETWEEN 0 AND 3),

  PRIMARY KEY (pokemon_id, slot)
);

-- One Pokemon cannot know the same move twice.
CREATE UNIQUE INDEX idx_pokemon_moves_unique ON pokemon_moves(pokemon_id, move);

-- ---------------------------------------------------------------------------
-- Drops
-- ---------------------------------------------------------------------------

-- Where and when a Pokemon was dropped, and who claimed it. Kept apart from
-- the Pokemon itself so this doubles as drop history.
--
-- A drop is claimable while caught_by AND despawned_at are both NULL.
CREATE TABLE drops (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  pokemon_id   INTEGER NOT NULL REFERENCES pokemon(id) ON DELETE CASCADE,
  guild_id     TEXT,
  channel_id   TEXT NOT NULL,
  message_id   TEXT,
  dropped_by   TEXT,
  created_at   INTEGER NOT NULL,
  caught_by    TEXT,
  caught_at    INTEGER,

  -- Set when a newer drop in the same channel replaced this one (one live
  -- drop per channel).
  despawned_at INTEGER
);

CREATE INDEX idx_drops_open    ON drops(channel_id, caught_by, despawned_at);
CREATE INDEX idx_drops_message ON drops(message_id);

-- ---------------------------------------------------------------------------
-- Trading
-- ---------------------------------------------------------------------------

-- An offer waiting on the other person.
--
-- Stored in the database so pending trades survive a restart.
--
-- status: open | accepted | declined | cancelled | expired
CREATE TABLE trades (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user_id    TEXT NOT NULL,
  to_user_id      TEXT NOT NULL,
  offered_pokemon INTEGER NOT NULL REFERENCES pokemon(id) ON DELETE CASCADE,
  wanted_pokemon  INTEGER REFERENCES pokemon(id) ON DELETE SET NULL,
  channel_id      TEXT,
  status          TEXT NOT NULL DEFAULT 'open',
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  settled_at      INTEGER
);

-- Index for looking up the offer between two players.
CREATE INDEX idx_trades_open    ON trades(to_user_id, from_user_id, status);
CREATE INDEX idx_trades_offered ON trades(offered_pokemon, status);

-- ---------------------------------------------------------------------------
-- Quests
-- ---------------------------------------------------------------------------

-- Per-user quest state. The quest definition itself lives in Data/Quests.
--
-- Progress is a plain count, recalculated by Utils/questprogress.js.
CREATE TABLE quest_progress (
  discord_user_id TEXT NOT NULL REFERENCES users(discord_user_id) ON DELETE CASCADE,
  quest_id        TEXT NOT NULL,
  progress        INTEGER NOT NULL DEFAULT 0,
  completed       INTEGER NOT NULL DEFAULT 0,

  -- Milliseconds since the epoch, like every other timestamp here.
  completed_at    INTEGER,

  PRIMARY KEY (discord_user_id, quest_id)
);

CREATE INDEX idx_quest_progress_open ON quest_progress(discord_user_id, completed);

-- ---------------------------------------------------------------------------
-- Servers
-- ---------------------------------------------------------------------------

-- Which channels a server lets the bot work in.
--
-- No rows for a guild means every channel is allowed. Checking a channel is a
-- primary key lookup.
CREATE TABLE guild_channels (
  guild_id   TEXT NOT NULL,
  channel_id TEXT NOT NULL,

  -- Who added it and when.
  added_by   TEXT,
  added_at   INTEGER NOT NULL,

  PRIMARY KEY (guild_id, channel_id)
);

-- ---------------------------------------------------------------------------
-- Administration
-- ---------------------------------------------------------------------------

-- Who may run .forcespawn and .give.
--
-- The owner is not stored here; it comes from DISCORD_OWNER_ID in .env.
--
-- Not linked to users, since an admin doesn't have to be a player.
CREATE TABLE admins (
  discord_user_id TEXT PRIMARY KEY,

  -- Who added them and when.
  added_by        TEXT NOT NULL,
  added_at        INTEGER NOT NULL,
  note            TEXT
);

${DAILY_QUESTS}
${ELITE_FOUR_WINS}
${USER_GUILDS}`;

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

/**
 * Upgrades from one schema version to the next, keyed by the version they
 * start from. Each must only add (new tables, new columns), so a live
 * database keeps its players.
 *
 * A database more than one version behind runs each step in turn. One with no
 * path forward is still refused (see applySchema).
 *
 * A step is SQL, or a function given the handle for a one-off data fix. Steps
 * are removed once every live database has run them; the last ones (10 to 13:
 * daily quests, Elite Four wins, form renames and the milestone Lootbox
 * back-pay) were removed after the server reached 13.
 */
const MIGRATIONS = {
  13: splitGenderForms,
  15: partyNumbersAsSlots,
  16: heldFormsMatchItems,
  // The daily streak and the overdrive goals.
  17: `
    ALTER TABLE users ADD COLUMN daily_streak INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN daily_streak_day TEXT;
    ALTER TABLE daily_quests ADD COLUMN od_catch_done INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE daily_quests ADD COLUMN od_battle_done INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE daily_quests ADD COLUMN od_both_done INTEGER NOT NULL DEFAULT 0;
  `,
  14: `
    ALTER TABLE users ADD COLUMN wild_won       INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN wild_lost      INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN trainer_won    INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN trainer_lost   INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN milestone_won  INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN milestone_lost INTEGER NOT NULL DEFAULT 0;
    ${USER_GUILDS}
    INSERT OR IGNORE INTO user_guilds (discord_user_id, guild_id)
      SELECT caught_by, guild_id FROM drops WHERE caught_by IS NOT NULL AND guild_id IS NOT NULL
      UNION
      SELECT dropped_by, guild_id FROM drops WHERE dropped_by IS NOT NULL AND guild_id IS NOT NULL;
  `,
};

/**
 * Schema 17 changes no tables. It repairs Pokemon left in a held-item form
 * (a Mega, an Origin Forme, a plate's type) after the item holding it up was
 * swapped for another: they go back to the form they had without it, with
 * that form's ability, as `.take` would have done.
 */
function heldFormsMatchItems(handle) {
  const items = require('./items');
  const evolution = require('./evolution');
  const rows = handle
    .prepare("SELECT id, species_id, form_folder, equipped_item, ability_slot FROM pokemon WHERE form_folder IS NOT NULL")
    .all();
  const fix = handle.prepare('UPDATE pokemon SET form_folder = ?, ability = COALESCE(?, ability) WHERE id = ?');

  for (const row of rows) {
    const wanted = items.itemForForm(row);
    if (wanted === null || row.equipped_item === wanted) continue;

    // Where it would go if the item causing the form came off.
    const base = items.formWithoutHeldItem({ ...row, equipped_item: wanted });
    if (base === null || base === row.form_folder) continue;

    const ability = evolution.remapAbility(row.species_id, base, row.ability_slot || 1);
    fix.run(base, ability ? ability.name : null, row.id);
  }
}

/**
 * Schema 16 changes no tables. Party numbers become slots, 1 to N with no
 * gaps, so each party is renumbered in the order its owner sees it now: their
 * hand-made order if they use one, otherwise their old numbers. The hand-made
 * order ("custom") is the slot order from now on.
 */
function partyNumbersAsSlots(handle) {
  const users = handle.prepare('SELECT discord_user_id AS id, party_sort FROM users').all();

  // Parked on negative values first, so the unique index can't trip.
  const park = handle.prepare('UPDATE pokemon SET party_number = -id WHERE current_trainer_id = ?');
  const place = handle.prepare('UPDATE pokemon SET party_number = ? WHERE id = ?');

  let renumbered = 0;
  for (const user of users) {
    const order = user.party_sort === 'custom'
      ? 'party_position IS NULL, party_position, party_number IS NULL, party_number, id'
      : 'party_number IS NULL, party_number, id';

    const ids = handle
      .prepare(`SELECT id FROM pokemon WHERE current_trainer_id = ? ORDER BY ${order}`)
      .all(user.id)
      .map((row) => row.id);

    park.run(user.id);
    ids.forEach((id, i) => place.run(i + 1, id));
    renumbered += ids.length;
  }

  handle.exec("UPDATE users SET party_sort = 'party' WHERE party_sort = 'custom'");
  console.log(`Numbered ${renumbered} owned Pokemon as party slots.`);
}

/**
 * Schema 14 changes no tables. Species that look different by gender
 * (Combee, Pikachu) now have a Male and a Female form instead of "Default"
 * (made by Utils/importdata.js), so stored ones move to the form matching
 * their gender.
 *
 * Needs the re-imported Data/Pokemon, so it refuses to run without it rather
 * than marking itself done.
 */
function splitGenderForms(handle) {
  const file = path.join(__dirname, '..', 'Data', 'Pokemon', 'index.json');
  const { forms } = JSON.parse(fs.readFileSync(file, 'utf8'));

  if (!forms.some((f) => f.slug === 'combee-female' && f.displayName === 'Combee')) {
    throw new Error('Data/Pokemon is out of date - run "npm run import:pokemon" first.');
  }

  const known = new Set(forms.map((f) => `${f.speciesId}/${f.folder}`));
  const gendered = new Map();
  for (const form of forms) {
    if (form.genderLock && form.percentage > 0) gendered.set(`${form.speciesId}/${form.genderLock}`, form);
  }

  const rows = handle
    .prepare('SELECT id, species_id, form_folder, gender FROM pokemon')
    .all()
    .filter((row) => !known.has(`${row.species_id}/${row.form_folder}`));

  const update = handle.prepare(
    'UPDATE pokemon SET form_folder = ?, form_slug = ?, display_name = ? WHERE id = ?'
  );

  let moved = 0;
  for (const row of rows) {
    const gender = row.gender === 'female' ? 'female' : 'male';
    const form = gendered.get(`${row.species_id}/${gender}`);
    if (!form) continue;

    update.run(form.folder, form.slug, form.displayName, row.id);
    moved += 1;
  }

  // Gendered forms lost "Male"/"Female" from their names ("Pyroar", not
  // "Male Pyroar"), including the ones that were already split.
  const rename = handle.prepare(
    'UPDATE pokemon SET display_name = ? WHERE species_id = ? AND form_folder = ? AND display_name != ?'
  );
  let renamed = 0;
  for (const form of forms) {
    if (!/\b(Male|Female)\b/.test(form.folder)) continue;
    renamed += Number(rename.run(form.displayName, form.speciesId, form.folder, form.displayName).changes);
  }

  console.log(`Moved ${moved} stored Pokemon to their Male or Female form, renamed ${renamed}.`);
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

let db = null;

/** Has this database had the schema applied yet? */
function isEmpty(handle) {
  const row = handle
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'users'")
    .get();

  return row.n === 0;
}

/**
 * Create the schema on an empty database, or check the version on one that
 * already exists.
 *
 * Refuses to open a database built with a different schema version rather
 * than trying to patch it.
 */
function applySchema(handle) {
  if (isEmpty(handle)) {
    handle.exec('BEGIN');
    try {
      handle.exec(SCHEMA);
      handle.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      handle.exec('COMMIT');
    } catch (err) {
      handle.exec('ROLLBACK');
      throw new Error(`Could not create the schema: ${err.message}`);
    }
    return { created: true };
  }

  let version = handle.prepare('PRAGMA user_version').get().user_version;

  // Step an older database forward, one version at a time, each step in its
  // own transaction.
  while (version < SCHEMA_VERSION && MIGRATIONS[version]) {
    handle.exec('BEGIN');
    try {
      // A step is either SQL or a function given the handle (for data fixes).
      const step = MIGRATIONS[version];
      if (typeof step === 'function') step(handle);
      else handle.exec(step);
      handle.exec(`PRAGMA user_version = ${version + 1}`);
      handle.exec('COMMIT');
    } catch (err) {
      handle.exec('ROLLBACK');
      throw new Error(`Could not upgrade the schema from version ${version}: ${err.message}`);
    }

    console.log(`Upgraded Data/pokedropper.db from schema version ${version} to ${version + 1}.`);
    version += 1;
  }

  if (version !== SCHEMA_VERSION) {
    throw new Error(
      `Data/pokedropper.db was built by schema version ${version}, but this is version ` +
        `${SCHEMA_VERSION}, and there is no migration from it - run "node Utils/db.js --reset" to ` +
        'rebuild it. Player progress in it will be lost.'
    );
  }

  return { created: false };
}

/** Open the database, creating it on first use. */
function open() {
  if (db) return db;

  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

  db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');

  applySchema(db);
  return db;
}

function close() {
  if (db) db.close();
  db = null;
}

/** Delete the database and build it again. Everything in it is lost. */
function reset() {
  close();

  for (const suffix of ['', '-wal', '-shm']) {
    const file = DB_FILE + suffix;
    if (fs.existsSync(file)) fs.rmSync(file);
  }

  return open();
}

module.exports = { open, close, reset, applySchema, DB_FILE, SCHEMA, SCHEMA_VERSION };

// `node Utils/db.js [--reset]` - create, inspect, or rebuild the database.
if (require.main === module) {
  const handle = process.argv.includes('--reset') ? reset() : open();

  const tables = handle
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all()
    .map((row) => row.name);

  console.log(DB_FILE);
  console.log(`schema version ${handle.prepare('PRAGMA user_version').get().user_version}`);
  console.log(`tables: ${tables.join(', ')}`);
  close();
}
