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
};
const HOUSES = ['taba_house1', 'taba_house2', 'taba_house3', 'taba_house4'];

/**
 * Who stands where in each room, by Tuxemon's name for the spot.
 * `action` is what talking to them does (the browser handles it).
 */
const CAST = {
  player_house_downstairs: {
    callie_wren: { name: 'MOM', sprite: 'homemaker', action: 'mom', lines: ['MOM: Off to see the world? Be careful out there!'] },
  },
  professor_lab: {
    kay_wren: { name: 'PROF. A', sprite: 'professor', action: 'professor', lines: ['PROF. A: How is your POKéMON doing?', 'The MAIN CITY is south, past TOWN 2. That is where your journey really begins!'] },
    allie: { name: 'Assistant', sprite: 'scientist', wander: 2, lines: ["ASSISTANT: The PROF. has POKéMON from every region. Isn't that amazing?"] },
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
  const title = { home: 'Your house', lab: "PROF. A's LAB", center: 'POKéMON CENTER', mart: 'POKéMON MART', battle: 'BATTLE TOWER' }[door.station] || `${outside.name}: a house`;
  const room = load(file, { id, name: title });

  // Out the door, back to where you came in.
  const out = { map: outside.id, x: door.x, y: door.y + 1, facing: 'down' };
  room.warps.push({ x: room.exit.x, y: room.exit.y, to: out });
  room.outside = out;

  // Stairs up (your house has a bedroom): "<this room>:up".
  for (const t of room.teleports) {
    if (UPSTAIRS[t.target]) room.warps.push({ x: t.x, y: t.y, to: { map: `${id}:up`, x: t.tx, y: t.ty, facing: 'down' } });
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
  if (door.station === 'battle') {
    // Right inside the entrance, like a reception desk.
    const desk = freeNear(room, room.spawn.x, room.spawn.y - 1);
    room.npcs.push({ id: 'receptionist', name: 'RECEPTIONIST', sprite: 'nurse_blue', x: desk.x, y: desk.y, facing: 'down', wander: 0, action: 'tower', lines: [] });
  }
  return room;
}

/**
 * Rooms upstairs, by file: where their stairs down are, and where you land
 * downstairs. (Tuxemon's bedroom has no events of its own.)
 */
const UPSTAIRS = {
  player_house_bedroom: { stairs: { x: 8, y: 1 }, landing: { x: 0, y: 2 }, name: 'Your room' },
};

/** The room upstairs from `downId` ("<downId>:up"). */
function buildUpstairs(id, down) {
  const t = down.teleports.find((x) => UPSTAIRS[x.target]);
  if (!t) return null;
  const up = UPSTAIRS[t.target];
  const room = load(t.target, { id, name: up.name, exit: up.stairs });
  room.warps.push({ x: up.stairs.x, y: up.stairs.y, to: { map: down.id, ...up.landing, facing: 'down' } });
  room.spawn = { x: t.tx, y: t.ty, facing: 'down' };
  room.outside = down.outside;
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
