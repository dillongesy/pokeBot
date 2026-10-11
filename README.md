# PokeDropperV2

A Discord bot for catching, training and battling Pokemon. Players drop a wild
Pokemon, catch it by typing its name in chat, and build up a collection they
can level, evolve, trade and take into battles against wild Pokemon, trainers
and the gym leaders, Elite Four and champions of eight regions.

All game data (species, forms, moves, abilities, items) is imported once from
[PokeAPI](https://pokeapi.co) and stored locally, so the bot doesn't depend on
the API while it runs. Player data lives in a single SQLite file.

## Features

- Drops with rarity tiers, regional forms, shinies, repels and incenses
- Catch by name in any language (`pikachu`, `ピカチュウ` and `Glurak` all work)
- Turn-based battles with abilities, held items, weather, status conditions
  and type matchups
- Trainer levels, an obedience cap and a ladder of 79 milestone battles
- Evolution by level, item and trade, Mega Evolution and form changes
- 131 quests, a coin shop, a gold shop, lootboxes, TMs and leaderboards
- Trading, per-server channel restrictions and admin tools

## Requirements

- **Node.js 22.5 or newer.** The bot uses the built-in `node:sqlite` module,
  which older versions don't have. The current LTS release is recommended.
- **Git**, to clone the repository.
- A **Discord application** with a bot user.
- About **1 GB of free disk space** for the imported data.

## Setup

### 1. Install Node.js

**Windows / macOS:** download the LTS installer from
[nodejs.org](https://nodejs.org) and run it.

**Linux (Ubuntu/Debian):** the version in the default package repositories is
usually too old. Install it with [nvm](https://github.com/nvm-sh/nvm) instead:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# close and reopen your terminal, then:
nvm install --lts
```

Check that it worked:

```bash
node -v    # should print v22.5.0 or higher
npm -v
```

### 2. Get the code

Install Git if you don't have it ([git-scm.com](https://git-scm.com), or
`sudo apt install git` on Ubuntu), then clone the repository and install the
dependencies:

```bash
git clone <your-repo-url> PokeDropperV2
cd PokeDropperV2
npm install
```

### 3. Create the Discord bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
   and click **New Application**.
2. Under **General Information**, copy the **Application ID**. This is your
   `DISCORD_CLIENT_ID`.
3. Open the **Bot** tab and click **Reset Token**. Copy the token. This is
   your `DISCORD_TOKEN`. Keep it secret; anyone with it can control the bot.
4. Still on the **Bot** tab, under **Privileged Gateway Intents**, turn on
   **Message Content Intent**. Without it the bot can't read chat, so nobody
   can catch anything.
5. Open **OAuth2 > URL Generator**. Tick the `bot` and
   `applications.commands` scopes, then these bot permissions:
   - View Channels
   - Send Messages
   - Embed Links
   - Attach Files
6. Open the generated URL in your browser and add the bot to your server.

### 4. Configure the bot

Copy the example config and fill it in:

```bash
cp .env.example .env
```

```ini
DISCORD_TOKEN=your-bot-token
DISCORD_CLIENT_ID=your-application-id
DISCORD_OWNER_ID=your-discord-user-id
```

`DISCORD_OWNER_ID` is optional, but without it nobody can use the admin
commands (`.forcespawn`, `.give`, `.admin`). To find your user ID, turn on
**Developer Mode** in Discord (Settings > Advanced), then right-click your name
and choose **Copy User ID**.

`.env` is gitignored. Never commit it.

### 5. Import the game data from PokeAPI

```bash
npm run import
```

This downloads every species, form, move, ability, item, berry and TM from
PokeAPI and writes them to `Data/`. It also copies the quests and both shops
from `Utils/` into `Data/`.

The first run takes around **45 minutes**, because requests are rate-limited
to follow PokeAPI's [fair use policy](https://pokeapi.co/docs/v2#fairuse).
Every response is cached in `Data/.cache`, so if the import is interrupted
you can simply run it again and it will pick up where it left off. Later runs
take a few seconds.

You can also import specific sections:

```bash
node Utils/importdata.js pokemon items      # only these sections
node Utils/importdata.js quests shop        # just the hand-written content
node Utils/importdata.js --no-images        # skip artwork downloads
node Utils/importdata.js --help
```

Sections: `pokemon`, `items`, `moves`, `abilities`, `types`, `natures`,
`berries`, `machines`, `quests`, `shop`, `goldshop`.

### 6. Register the slash commands

```bash
npm run deploy
```

Global commands can take up to an hour to appear in Discord. To test on one
server straight away, register them for that server only:

```bash
npm run deploy -- <your-server-id>
```

You only need to run this again when a command's name, description or
options change. (`npm run setup` runs the import and the deploy in one go.)

### 7. Start the bot

```bash
npm start
```

You should see `Logged in as YourBot#1234` followed by the list of loaded
commands. Type `.d` in your server to drop your first Pokemon, then type its
name to catch it. `.help` lists everything else.

The player database (`Data/pokedropper.db`) is created automatically the first
time the bot starts.

## Running on a server

To keep the bot running after you log out and restart it if it crashes, run
it as a service.

**systemd (Linux):** from the bot's folder, as your normal user (not root):

```bash
chmod +x install-service.sh
./install-service.sh
```

This creates and starts a `pokedropper` service that runs on boot, using
whichever Node.js is on your PATH (including nvm installs). View the logs with
`sudo journalctl -u pokedropper -f` and restart with
`sudo systemctl restart pokedropper`. Re-run the script if you upgrade
Node.js.

### Moving an existing player database

If you already have players on another machine, copy their database across
instead of starting fresh:

1. Stop the bot on the old machine (Ctrl+C or `sudo systemctl stop pokedropper`).
   Shutting it down cleanly writes everything into the main database file.
2. Copy `Data/pokedropper.db` to the `Data/` folder on the new machine. If
   `pokedropper.db-wal` or `pokedropper.db-shm` files exist next to it, copy
   those too.
3. Run the import (step 5) on the new machine if you haven't already, then
   start the bot.

### Backups

All player data is in `Data/pokedropper.db`. Back it up regularly, ideally
while the bot is stopped. Everything else in `Data/` can be regenerated with
`npm run import`.

### Updating

```bash
git pull
npm install
npm run import:content    # if quests or shops changed
npm run deploy            # if any slash commands changed
sudo systemctl restart pokedropper
```

If the database schema changes in an update (`SCHEMA_VERSION` in
[Utils/db.js](Utils/db.js)), the bot will refuse to start with an old
database file rather than risk corrupting it.

## Commands

The prefix is `.`, and every command is also available as a slash command.
`.help` pages through everything in Discord, and `.help <command>` explains
one command.

| Command | Aliases | Description |
| --- | --- | --- |
| `.drop` | `.d` | Drop a wild Pokemon |
| *(type its name)* | | Catch the current drop |
| `.hint` | `.h` | Reveal some letters of the current drop |
| `.party [sort] [filter]` | `.p` | Your collection, e.g. `.p shiny`, `.p lvl 25-35`, `.p suggested` |
| `.view <id>` | `.v` `.info` | One Pokemon in full |
| `.nickname <id> <name>` | `.nick` | Rename a Pokemon |
| `.order <field>` | `.sort` `.o` | Rearrange your party, e.g. `.order battle` |
| `.count` | `.counts` | How many of each species you own |
| `.uncaught` | `.u` `.missing` | Species you haven't caught yet |
| `.release <id>` | `.r` | Release a Pokemon (asks for confirmation) |
| `.dex <name>` | `.pokedex` `.lookup` | Look up any Pokemon |
| `.moves <id>` | `.move` `.moveset` | A Pokemon's moves, and learning new ones |
| `.tm <id> [move] [slot]` | `.teach` `.hm` | Teach a move from a TM |
| `.battle [milestone]` | `.b` `.fight` | Start a battle |
| `.team [@user]` | | Your (or someone's) battle team |
| `.trade @user <id>` | `.t` | Offer a one-for-one trade |
| `.compare @user` | `.diff` | Species they have that you don't |
| `.shop [section\|pokemon]` | `.s` `.store` | Browse the coin shop |
| `.goldshop` | `.gs` | Browse the gold shop |
| `.buy <item> [n]` | `.purchase` | Buy from either shop |
| `.bag` | `.i` `.inventory` | Your items |
| `.inventorysort <mode>` | `.is` | Change your bag's order |
| `.examine <item>` | `.iv` | What an item does |
| `.useitem <id> <item>` | `.use` | Use or equip an item |
| `.take <id>` | `.unequip` | Take back a held item |
| `.trash <item> [n]` | `.discard` | Destroy items (asks for confirmation) |
| `.me` | `.profile` `.bal` | Your trainer card |
| `.questprogress` | `.qp` | Quest progress |
| `.leaderboard [board]` | `.lb` `.top` | Leaderboards |
| `.remind` | `.remindme` | Get pinged when your cooldown ends |
| `.help [command]` | `.commands` | Help |

**Server setup** (requires the Manage Server permission): `.setchannel`,
`.viewchannels`, `.resetchannels`. With no channels set, the bot works in every
channel.

**Admin** (owner and admins only, hidden from `.help` for everyone else):
`.forcespawn`, `.give`, `.admin`.

## npm scripts

| Script | What it does |
| --- | --- |
| `npm start` | Start the bot |
| `npm run setup` | Import all data, then register slash commands |
| `npm run import` | Import data from PokeAPI and the local content files |
| `npm run import:pokemon` | Re-import only the Pokemon data |
| `npm run import:content` | Re-import only quests and shops (no network) |
| `npm run deploy` | Register slash commands |
| `npm run db` | Create or inspect the database (`-- --reset` to rebuild it) |
| `npm run wipe` | Delete player data (see below) |
| `npm run drop` | Roll some drops in the terminal, for testing |

`npm run wipe` asks for confirmation before deleting anything:

```bash
npm run wipe -- --drops          # uncaught drops only
npm run wipe -- --user <id>      # one player and everything they own
npm run wipe -- --pokemon        # every Pokemon and drop, keep users
npm run wipe -- --users          # users, buffs, items and quest progress
npm run wipe -- --all            # everything
```

## Customising

Most tuning lives in a few files under `Utils/`:

| File | Contents |
| --- | --- |
| [rates.js](Utils/rates.js) | Drop rarity, shiny odds, cooldowns, wild levels, battle rewards, trainer progression |
| [formrates.js](Utils/formrates.js) | Per-form drop percentages |
| [shop.js](Utils/shop.js) | Coin shop stock and prices |
| [goldshop.js](Utils/goldshop.js) | Gold shop buffs |
| [quests.js](Utils/quests.js) | Quest definitions |
| [milestones.js](Utils/milestones.js) | Gym leaders, Elite Four and champions |
| [custom.js](Utils/custom.js), [artwork.js](Utils/artwork.js) | Extra forms and artwork PokeAPI doesn't have |

After editing quests or shops, run `npm run import:content` and restart the
bot. Many modules can also be run directly
(e.g. `node Utils/milestones.js`, `node Utils/damage.js`) to print a summary
or run a quick self-check.

## Project structure

```
index.js            Entry point: Discord client, message and interaction routing
Commands/           One file per command (prefix and slash handlers)
Utils/
  db.js             SQLite connection and schema
  store.js          All database reads and writes
  importdata.js     PokeAPI importer
  battle.js         Battle engine (pure, seeded)
  battleeffects.js  Abilities and held items in battle
  field.js          Weather, Protect, trapping, Leech Seed, Substitute
  damage.js         Damage formula
  ...               Game rules, content and helpers
Data/               Generated by the importer (gitignored), plus the database
```

## Credits

Game data and most artwork from [PokeAPI](https://pokeapi.co). Artwork for
some forms comes from [Bulbagarden Archives](https://archives.bulbagarden.net)
and fan-made shiny art; the sources are listed in
[Utils/artwork.js](Utils/artwork.js).

Quest contributions from Jack, Neil and Dillon.

Pokemon and Pokemon character names are trademarks of Nintendo, Game Freak and
Creatures Inc. This is an unofficial fan project and is not affiliated with or
endorsed by them.
