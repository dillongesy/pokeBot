'use strict';

/**
 * Inside buildings. Every door gets its own copy of a Tuxemon room
 * (Web/maps/tuxemon, read by tmx.js), so the way out leads back to that door.
 *
 *   home      your house: MOM, who can help you change clothes
 *   lab       PROF. A's lab
 *   center    a POKéMON CENTER: the NURSE behind the counter
 *   mart      a MART: the CLERK opens the shop
 *   battle    the BATTLE TOWER lobby: the RECEPTIONIST sends you up to
 *             the battle room ("tower-arena") when a milestone is ready
 *   (other)   a house, a cafe: whoever lives there says the door's lines
 *
 * Map ids: "in:<outside map>:<door x>,<door y>". Built on first use.
 */

const { load } = require('./tmx');

const ROOMS = {
  home: 'player_house_downstairs',
  lab: 'professor_lab',
  center: 'healing_center',
  mart: 'tuxe_mart_taba',
  battle: '37707_tower',
  // PROF. A and AIDE's house: a home with bookshelves.
  rival: 'taba_house2',
  // Restaurants and cafes.
  restaurant: 'taba_house3',
};
/** Homes (taba_house3 and 4 are set out like restaurants, so they aren't). */
const HOUSES = ['taba_house1', 'taba_house2'];

/**
 * Who stands where in each room, by Tuxemon's name for the spot.
 * `action` is what talking to them does (the browser handles it).
 */
const CAST = {
  player_house_downstairs: {
    callie_wren: { name: 'MOM', sprite: 'homemaker', action: 'mom', lines: ['MOM: Off to see the world? Be careful out there!'] },
  },
  professor_lab: {
    kay_wren: { name: 'PROF. A', sprite: 'professor', action: 'professor', lines: ['PROF. A: How is your POKéMON doing?', 'The MAIN CITY is north, past TOWN 2. That is where your journey really begins!'] },
    // Off to the side, never in the doorway or the walk up from it.
    allie: { name: 'Assistant', sprite: 'scientist', wander: 1, at: { x: 10, y: 13 }, lines: ["ASSISTANT: The PROF. has POKéMON from every region. Isn't that amazing?"] },
  },
  healing_center: {
    tabanurse: { name: 'NURSE', sprite: 'nurse', action: 'nurse', lines: [] },
    happy_guy: { name: 'Trainer', sprite: 'cooldude_blonde', wander: 2, lines: ['I always stop by the POKéMON CENTER in every town. If I white out, I wake up here!'] },
    shady_guy: { name: 'Hiker', sprite: 'miner', wander: 1, lines: ['The routes past the MAIN CITY gates get longer the further you go.'] },
  },
  tuxe_mart_taba: {
    tuxemart_keeper: { name: 'CLERK', sprite: 'shopkeeper', action: 'shop', lines: [] },
    // Moved off the spot in front of the counter, into the aisle.
    kay_wren: { name: 'Shopper', sprite: 'homemaker_blonde', wander: 2, at: { x: 6, y: 6 }, lines: ['Everything here costs the same as the shop on Discord. Handy!'] },
  },
};

/** House residents: whichever of these spots the room has. */
const RESIDENT_SPOTS = ['taba_house1_husband', 'taba_house1_wife', 'taba_house2_owner', 'taba_house3_owner', 'taba_house4_owner'];
const RESIDENTS = ['granny', 'homemaker', 'cooldude', 'heroine', 'fisher', 'florist', 'postboy', 'monk', 'barmaid'];

/**
 * Books in rooms: the open books on a table and the shelves, by room file.
 * Tiles are the solid table or shelf tiles you face to read them.
 */
const READABLE = {
  taba_house2: [
    { kind: 'book', tiles: [[0, 4], [1, 4], [2, 4], [3, 4], [0, 5], [1, 5], [2, 5], [3, 5]] },
    { kind: 'shelf', tiles: [[0, 2], [1, 2], [2, 2], [3, 2]] },
  ],
};

/** Open books: a tip each, or a bit of the world's story. */
const BOOK_LINES = [
  ['It\'s a notebook. "TRAINER EXP fills from every battle you win, wild or trainer. A full bar means your next milestone is ready at the BATTLE TOWER."'],
  ['It\'s a guide to grass. "Grass right across the way always hides exactly one POKéMON. Grass off to the side never runs out."'],
  ['It\'s a journal. "Day 41. The rocks on the routes can be smashed, the trees cut, the water crossed... but only once enough milestones are beaten."'],
  ['It\'s a book of legends. "Long ago, the BATTLE TOWER was a lighthouse. Its light guided trainers home from all eight lands."'],
  ['It\'s a list of rules. "A POKéMON above your obedience cap will not listen to you. Beat milestones to raise the cap."'],
  ['It\'s a field guide. "Each gate out of the MAIN CITY leads to the land of one region. Their POKéMON live there too."'],
  ['It\'s a scrapbook. "A photo of PROF. A and a very small AIDE, both holding POKé BALLS far too big for them."'],
  ['It\'s a page of notes. "If you are tired of a route, FLY back to town. Anything you have beaten stays beaten."'],
  ['It\'s a book about trainers. "Trainers on a route watch the whole way across. If you can see them, they can see you."'],
  ['It\'s a diary. "The DROP STATION in the MAIN CITY: drop a wild POKéMON, then catch it by name before anyone else does!"'],
];
/** Bookshelves: what's on them. */
const SHELF_LINES = [
  ['Rows of books on POKéMON from every region. "KANTO", "JOHTO", "HOENN"... they go on and on.'],
  ['A shelf of thick books about POKéMON types. One has a bookmark in "Why water beats fire".'],
  ["A shelf of PROF. A's research. The titles are far too long to read."],
  ['Old maps of the eight lands past the MAIN CITY, rolled up and tied with string.'],
];

const hash = (text) => [...text].reduce((h, c) => (Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0), 2166136261);

/** The first free tile near a spot, walking outwards. */
function freeNear(room, x0, y0) {
  for (let r = 0; r < 6; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = x0 + dx;
        const y = y0 + dy;
        if (room.solid[y] && room.solid[y][x] === false && !(x === room.exit.x && y === room.exit.y)) return { x, y };
      }
    }
  }
  return { x: x0, y: y0 };
}

/**
 * Build the room behind a door.
 *
 * @param {string} id      "in:<map>:<x>,<y>"
 * @param {object} outside the map the door is on
 * @param {object} door    { x, y, station?, room?, lines? }
 */
function buildRoom(id, outside, door) {
  const file = door.room || ROOMS[door.station] || HOUSES[hash(id) % HOUSES.length];
  const title = { home: 'Your house', lab: "PROF. A's LAB", center: 'POKéMON CENTER', mart: 'POKéMON MART', battle: 'BATTLE TOWER', rival: "PROF. A's HOUSE", restaurant: 'Restaurant' }[door.station] || `${outside.name}: a house`;
  const room = load(file, { id, name: title });
  room.file = file;

  // Out the door, back to where you came in.
  const out = { map: outside.id, x: door.x, y: door.y + 1, facing: 'down' };
  room.warps.push({ x: room.exit.x, y: room.exit.y, to: out });
  room.outside = out;

  // Stairs up to a bedroom: "<this room>:up".
  const stairs = STAIRS[file];
  if (stairs) {
    room.solid[stairs.down.y][stairs.down.x] = false;
    room.warps.push({ x: stairs.down.x, y: stairs.down.y, to: { map: `${id}:up`, ...stairs.arrive, facing: 'down' } });
  }

  const cast = CAST[file] || {};
  for (const [spot, person] of Object.entries(cast)) {
    const at = person.at || room.people[spot];
    if (!at) continue;
    const { at: _ignored, ...who } = person;
    room.npcs.push({ id: spot, facing: 'down', wander: 0, ...who, x: at.x, y: at.y });
  }
  if (!CAST[file] && door.station !== 'battle') {
    // A home: one resident, saying what the door said.
    const spot = RESIDENT_SPOTS.find((s) => room.people[s]);
    const at = spot ? room.people[spot] : freeNear(room, room.spawn.x, room.spawn.y - 2);
    room.npcs.push({
      id: 'resident',
      name: 'Resident',
      sprite: RESIDENTS[hash(`${id}:who`) % RESIDENTS.length],
      x: at.x,
      y: at.y,
      facing: 'down',
      wander: 2,
      lines: door.lines || ['Welcome! Make yourself at home.'],
    });
  }
  // Books you can read (A while facing them).
  for (const shelf of READABLE[file] || []) {
    shelf.tiles.forEach(([x, y], i) => {
      const pages = shelf.kind === 'shelf' ? SHELF_LINES : BOOK_LINES;
      room.signs.push({ x, y, lines: pages[(hash(`${id}:${x},${y}`) + i) % pages.length] });
    });
  }
  if (door.station === 'battle') {
    // Right inside the entrance, like a reception desk.
    const desk = freeNear(room, room.spawn.x, room.spawn.y - 1);
    room.npcs.push({ id: 'receptionist', name: 'RECEPTIONIST', sprite: 'nurse_blue', x: desk.x, y: desk.y, facing: 'down', wander: 0, action: 'tower', lines: [] });
  }
  return room;
}

/**
 * Houses with an upstairs, by the downstairs room's file. Tuxemon's bedroom
 * has no events of its own, so its stairs are placed by hand: the top step,
 * walked into from the right, and where you land beside it coming up.
 *   down     the stairs tile downstairs (walk up into it)
 *   landing  where you land downstairs coming back down, below the stairs
 *   room     the bedroom's file
 *   up       the stairs tile in the bedroom
 *   arrive   where you land in the bedroom, beside its stairs
 */
const STAIRS = {
  player_house_downstairs: {
    down: { x: 0, y: 1 }, landing: { x: 0, y: 2 },
    room: 'player_house_bedroom', up: { x: 7, y: 2 }, arrive: { x: 8, y: 2 }, name: 'Your room',
  },
  taba_house2: {
    down: { x: 5, y: 1 }, landing: { x: 5, y: 2 },
    room: 'player_house_bedroom', up: { x: 7, y: 2 }, arrive: { x: 8, y: 2 }, name: "AIDE's room",
    // AIDE's things: what's on the desk and the bed.
    signs: [
      { x: 3, y: 2, lines: ["It's AIDE's computer. A battle video is paused on the screen. AIDE is losing in it."] },
      { x: 4, y: 2, lines: ["It's AIDE's computer. A battle video is paused on the screen. AIDE is losing in it."] },
      { x: 0, y: 2, lines: ["AIDE's bed. It hasn't been made in weeks."] },
      { x: 0, y: 3, lines: ["AIDE's bed. It hasn't been made in weeks."] },
      { x: 1, y: 2, lines: ["A note on the nightstand: \"Beat the PROF's new trainer. EASY.\""] },
    ],
  },
};

/** The room upstairs from `downId` ("<downId>:up"). */
function buildUpstairs(id, down) {
  const stairs = STAIRS[down.file];
  if (!stairs) return null;
  const room = load(stairs.room, { id, name: stairs.name, exit: stairs.up });
  room.warps.push({ x: stairs.up.x, y: stairs.up.y, to: { map: down.id, ...stairs.landing, facing: 'down' } });
  room.spawn = { ...stairs.arrive, facing: 'down' };
  room.outside = down.outside;
  for (const sign of stairs.signs || []) room.signs.push(sign);
  return room;
}

/** The battle room upstairs in the BATTLE TOWER, where the milestone waits. */
let arenaCache = null;
function arena() {
  if (arenaCache) return arenaCache;
  const room = load('classic_gym_granite', { id: 'tower-arena', name: 'BATTLE TOWER: Battle Room' });
  room.background = 'stadium';
  room.leaderSpot = room.people.classic_gym_leader_granite || { x: 10, y: 5 };
  // You come in a few steps from the leader's end; leaving goes back down to the lobby.
  room.spawn = { x: room.leaderSpot.x, y: room.leaderSpot.y + 9, facing: 'up' };
  room.warps.push({ x: room.exit.x, y: room.exit.y, to: { map: 'lobby', x: 0, y: 0, facing: 'down' } });
  arenaCache = room;
  return room;
}

module.exports = { buildRoom, buildUpstairs, arena, ROOMS };
