'use strict';

/**
 * What the website's menus show, read from the bot's own data so it always
 * matches Discord:
 *
 *   party     the first six, in battle order (.party)
 *   bag       .inventory, grouped into pockets
 *   trainer   the trainer card (.me)
 *   tower     the next milestone, and whether it's ready
 *   shop      the MART: .shop's catalogue and the gold counter, bought with
 *             the same purchase() .buy uses
 */

const fs = require('fs');

const store = require('../Utils/store');
const content = require('../Utils/content');
const milestones = require('../Utils/milestones');

const titleCase = (s) => String(s || '').replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const spriteUrl = (slug) => `/api/item-sprite/${encodeURIComponent(slug)}`;

function describe(slug) {
  try {
    const text = require('../Utils/itemtext').describe(slug);
    if (text) return text;
  } catch {
    // Fall back to the item's own text.
  }
  const meta = content.item(slug);
  return (meta && meta.shortEffect) || '';
}

// ---------------------------------------------------------------------------

function party(userId) {
  const battleCommand = require('../Commands/battle');
  const { refused, cap } = store.battleTeam(userId);
  const wontObey = new Set(refused.map((r) => r.row.id));
  const account = store.ensureUser(userId);
  const rows = store.listParty(userId, { sort: account.party_sort || 'party', direction: account.party_direction || 'asc', limit: 6 });
  return {
    cap,
    team: rows.map((row) => {
      const art = battleCommand.spritesFor(row.species_id, row.form_folder, Boolean(row.shiny));
      return {
        id: row.id,
        number: row.party_number,
        name: row.nickname || row.display_name,
        species: row.display_name,
        level: row.level,
        gender: row.gender,
        shiny: Boolean(row.shiny),
        types: String(row.types || '').split(',').filter(Boolean),
        nature: row.nature,
        ability: titleCase(row.ability),
        item: row.equipped_item ? titleCase(row.equipped_item) : null,
        stats: {
          hp: row.stat_hp,
          attack: row.stat_attack,
          defense: row.stat_defense,
          spAttack: row.stat_special_attack,
          spDefense: row.stat_special_defense,
          speed: row.stat_speed,
        },
        moves: store.movesOf(row.id).map((m) => {
          const data = require('../Utils/learnset').move(m.move);
          return { name: (data && data.displayName) || titleCase(m.move), type: (data && data.type) || 'normal' };
        }),
        sprite: art.front,
        obeys: !wontObey.has(row.id),
      };
    }),
  };
}

function bag(userId) {
  const rows = require('../Utils/inventory').bagRows(userId);
  const pockets = new Map();
  for (const row of rows) {
    if (!pockets.has(row.category)) pockets.set(row.category, []);
    pockets.get(row.category).push({ item: row.item, name: row.displayName, qty: row.quantity, desc: describe(row.item), sprite: spriteUrl(row.item) });
  }
  return { pockets: [...pockets].map(([name, items]) => ({ name, items })) };
}

function trainer(userId) {
  const user = store.ensureUser(userId);
  const p = store.trainerProgress(userId);
  return {
    level: p.level,
    exp: p.exp,
    needed: p.needed,
    cap: p.cap,
    milestones: p.milestonesCleared,
    totalMilestones: p.totalMilestones,
    prestige: p.prestige,
    pending: p.pending,
    next: p.next ? milestones.title(p.next) : null,
    coins: user.coins,
    gold: user.gold,
    caught: user.total_caught || 0,
  };
}

/** The next milestone, for the Battle Tower. */
function tower(userId) {
  const p = store.trainerProgress(userId);
  const next = p.next;
  return {
    ready: Boolean(next && p.pending),
    remaining: p.remaining,
    cleared: p.milestonesCleared,
    next: next
      ? { title: milestones.title(next), name: next.name, kind: next.kind, type: next.type, region: next.region, order: next.order }
      : null,
  };
}

// ---------------------------------------------------------------------------
// The MART
// ---------------------------------------------------------------------------

let catalogCache = null;
function catalog() {
  if (catalogCache) return catalogCache;
  const shop = content.shop();
  const sections = shop.sections.map((s) => ({
    name: s.name,
    currency: 'coins',
    items: s.items.map((i) => {
      const meta = content.item(i.item);
      return { id: i.item, name: (meta && meta.displayName) || titleCase(i.item), price: i.price, desc: describe(i.item), sprite: spriteUrl(i.item) };
    }),
  }));
  const gold = content.goldShop();
  if (gold && gold.items && gold.items.length) {
    sections.push({
      name: 'Gold Counter',
      currency: 'gold',
      items: gold.items.map((g) => ({ id: g.id, name: g.name, price: g.price, desc: g.description, sprite: null })),
    });
  }
  catalogCache = sections;
  return sections;
}

function shop(userId) {
  const user = store.ensureUser(userId);
  return { coins: user.coins, gold: user.gold, sections: catalog() };
}

/** Buy, exactly as .buy does (same checks, same records, same quests). */
function buy(userId, id, qty) {
  const { purchase } = require('../Commands/buy');
  const result = purchase(userId, String(id || '').slice(0, 64), String(Math.max(1, Math.min(99, Number(qty) || 1))));
  const user = store.getUser(userId);
  if (result.embeds) {
    const title = result.embeds[0].data ? result.embeds[0].data.title : result.embeds[0].title;
    return { ok: true, text: String(title || 'Bought it!').replace(/\*/g, ''), coins: user.coins, gold: user.gold };
  }
  return { ok: false, text: String(result.content || "That didn't work.").replace(/\*\*|`/g, ''), coins: user.coins, gold: user.gold };
}

/** An item's picture, for the bag and the MART. */
function itemSprite(res, slug) {
  const file = content.itemSprite(String(slug));
  if (!file || !fs.existsSync(file)) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
  fs.createReadStream(file).pipe(res);
}

// ---------------------------------------------------------------------------
// The PC: every Pokemon you own, to swap into your team
// ---------------------------------------------------------------------------

const PC_PAGE = 30;

/** One page of everything you own, strongest first. */
function pc(userId, page = 0) {
  const battleCommand = require('../Commands/battle');
  const total = store.countParty(userId);
  const pages = Math.max(1, Math.ceil(total / PC_PAGE));
  const at = Math.max(0, Math.min(pages - 1, Number(page) || 0));
  const { cap } = store.battleTeam(userId);
  const rows = store.listParty(userId, { sort: 'level', direction: 'desc', limit: PC_PAGE, offset: at * PC_PAGE });
  return {
    page: at,
    pages,
    total,
    cap,
    mons: rows.map((row) => ({
      id: row.id,
      number: row.party_number,
      name: row.nickname || row.display_name,
      level: row.level,
      shiny: Boolean(row.shiny),
      sprite: battleCommand.spritesFor(row.species_id, row.form_folder, Boolean(row.shiny)).front,
      tooHigh: row.level > cap,
    })),
  };
}

/** Swap two party slots, exactly as .swap does (refused mid-battle or mid-trade). */
function swap(userId, a, b) {
  const text = require('../Commands/party').runSwap(userId, [Number(a), Number(b)]);
  return { ok: /^Moved/.test(text), text: String(text).replace(/\*\*|`/g, '') };
}

// ---------------------------------------------------------------------------
// The Town Map
// ---------------------------------------------------------------------------

/**
 * The world, for the Town Map: the way in, the eight gates with their routes
 * and stops, which of them you've been to, and where you are now (a room
 * counts as the place it's in).
 */
function townMap(userId) {
  const db = require('../Utils/db');
  const maps = require('./maps');
  const plan = require('./worldplan').plan();
  const row = store.getUser(userId);
  const prestige = (row && row.prestige) || 0;
  const visited = new Set(
    db.open()
      .prepare("SELECT key FROM web_progress WHERE discord_user_id = ? AND prestige = ? AND key LIKE 'visited:%'")
      .all(userId, prestige)
      .map((r) => r.key.split(':')[1])
  );
  const pos = db.open().prepare('SELECT map FROM web_position WHERE discord_user_id = ?').get(userId);
  let here = pos ? pos.map : 'town-1';
  // Indoors: the place the building is in.
  for (let i = 0; i < 3 && /^in:/.test(here); i++) here = here.split(':')[1];
  if (here === 'tower-arena') here = 'main-city';
  const name = (id) => {
    const m = maps.get(id);
    return m ? m.name : id;
  };
  const levels = (id) => {
    const m = maps.get(id);
    return m && m.levels ? { lo: m.levels.lo, hi: m.levels.hi } : null;
  };
  return {
    here,
    intro: ['town-1', 'path-a', 'town-2', 'path-b'].map((id) => ({ id, name: name(id), visited: visited.has(id), levels: /^path/.test(id) ? levels(id) : null })),
    gates: plan.gates.map((g) => ({
      number: g.number,
      region: g.region,
      biomes: g.biomes,
      milestones: g.milestones,
      stops: g.routes.map((r) => ({
        route: {
          id: `route-${r.number}`,
          name: r.name,
          visited: visited.has(`route-${r.number}`),
          levels: { lo: r.levels.lo, hi: r.levels.hi },
          biome: r.biome,
          milestone: r.milestone,
          hidden: r.pockets.length,
        },
        stop: { id: `stop-${r.number}`, name: r.stop.name, kind: r.stop.kind, visited: visited.has(`stop-${r.number}`) },
      })),
    })),
    city: { id: 'main-city', name: name('main-city'), visited: visited.has('main-city') },
  };
}

module.exports = { party, bag, trainer, tower, shop, buy, itemSprite, catalog, pc, swap, townMap };
