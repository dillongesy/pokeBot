'use strict';

/**
 * The first dev town: the Drop and Battle stations, a pond and some grass,
 * with a way out south to the test route.
 *
 * Kept for the owner's dev console (dev.warp('devtown')); players start in
 * Town 1 and use the stations in the Main City.
 */

const { MapBuilder } = require('./builder');
const { TILES, SHOP, HOUSE } = require('./tiles');

const map = new MapBuilder({ id: 'devtown', name: 'Dev Town', kind: 'town', width: 22, height: 18 });

// Pines all round, open at the bottom middle (tiles 10-11).
map.border([[5, 8]]);

map.building(SHOP, 3, 2, { station: 'drop' });
map.sign(9, 5, ['DROP STATION', 'Drop a wild Pokemon, then catch it by name.']);
map.building(HOUSE, 13, 2, { station: 'battle' });
map.sign(12, 5, ['BATTLE STATION', 'Take your team into a battle.']);

// The path along the front of both stations.
map.rect('ground', TILES.path, 3, 6, 16, 4);

// A pond: a shallow rim you can wade through, deep water in the middle.
map.rect('ground', TILES.shore, 3, 10, 7, 6, TILES.shallow);
for (let y = 10; y < 16; y++) for (let x = 3; x < 10; x++) map.terrain[y][x] = 'shallow';
for (let y = 12; y < 14; y++) {
  for (let x = 5; x < 8; x++) {
    map.set('ground', x, y, TILES.deep).block(x, y);
    map.terrain[y][x] = 'deep';
  }
}

// Tall grass (no battles in town), and flowers here and there.
for (let y = 11; y < 16; y++) {
  for (let x = 13; x < 19; x++) {
    map.set('objects', x, y, TILES.tallGrass);
    map.terrain[y][x] = 'tall';
  }
}
[[11, 3], [11, 4], [12, 10], [19, 10], [2, 7], [19, 15]].forEach(([x, y], i) => map.set('objects', x, y, TILES.flowers[i % 3]));

map.sign(12, 15, ['SOUTH: TEST ROUTE', 'Dev only: dev.warp("devtown") to get here.']);

// South to the test route.
map.warp(10, 17, { map: 'testroute', x: 6, y: 1, facing: 'down' });
map.warp(11, 17, { map: 'testroute', x: 7, y: 1, facing: 'down' });

map.spawn = { x: 11, y: 8, facing: 'up' };

// The town's grass is for show: a town never has wild Pokemon.
map.encounterRate = 0;

module.exports = map.build();
