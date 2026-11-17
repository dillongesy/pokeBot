'use strict';

/**
 * A short route for trying the overworld rules: two one-battle grass patches
 * across the way, two trainers, and optional grass off to the side.
 *
 * Levels are Route 1's (Web/worldplan.js), so a Lv 5 starter is fine here.
 */

const { MapBuilder } = require('./builder');
const { TILES } = require('./tiles');
const { routeLevels } = require('../worldplan');

const { lo, hi } = routeLevels(1);

const map = new MapBuilder({
  id: 'testroute',
  name: 'Test Route',
  kind: 'route',
  width: 16,
  height: 30,
  levels: { lo, hi },
  background: 'grass',
});

// Pines all round, open at the top (tiles 6-7) back to town.
map.border([[3, 0]]);
map.tree(10, 16);

map.path(6, 0, 2, 8);
map.sign(4, 4, ['TEST ROUTE', 'North: Dev Town']);

// Grass right across the route: one battle each.
map.patch('a', 2, 8, 12, 3);

// Watches the middle of the route. Walk down the left side to get past.
map.trainer({
  id: 'youngster',
  name: 'Youngster a',
  sprite: 'cooldude',
  x: 12,
  y: 13,
  facing: 'left',
  sight: 5,
  team: [{ species: 19, level: 4 }, { species: 16, level: 5 }],
  before: ['Hey! You look like you could use a battle!'],
});

// Off to the side: wild battles for as long as you like.
map.grass(2, 15, 4, 5);

map.patch('b', 2, 21, 12, 2);

map.trainer({
  id: 'picnicker',
  name: 'Picnicker b',
  sprite: 'picnicker',
  x: 3,
  y: 25,
  facing: 'right',
  sight: 4,
  team: [{ species: 43, level: 5 }, { species: 10, level: 6 }],
  before: ['A trainer! Let\'s see what you\'ve got!'],
});

map.warp(6, 0, { map: 'devtown', x: 10, y: 16, facing: 'up' });
map.warp(7, 0, { map: 'devtown', x: 11, y: 16, facing: 'up' });

map.spawn = { x: 6, y: 1, facing: 'down' };

module.exports = map.build();
