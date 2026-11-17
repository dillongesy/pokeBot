'use strict';

/**
 * How much of each tile in a tileset is actually drawn, so collisions match
 * the picture: the see-through corners of a building aren't walls.
 *
 * Reads the tileset PNGs directly (8-bit, paletted or RGBA, which is what
 * Tuxemon's are). Results are cached per sheet.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DIR = path.join(__dirname, '..', 'sprites', 'tuxemon', 'tilesets');
const FILES = { o: 'core_outdoor.png', b: 'core_buildings.png', s: 'core_set_pieces.png' };

function readPng(file) {
  const b = fs.readFileSync(file);
  let p = 8;
  let width = 0;
  let height = 0;
  let type = 0;
  let depth = 0;
  let trns = null;
  const idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p);
    const kind = b.toString('ascii', p + 4, p + 8);
    const data = b.subarray(p + 8, p + 8 + len);
    if (kind === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      type = data[9];
    } else if (kind === 'tRNS') trns = data;
    else if (kind === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  if (depth !== 8 || (type !== 3 && type !== 6)) throw new Error(`${file}: unsupported PNG (depth ${depth}, type ${type})`);
  const bpp = type === 6 ? 4 : 1;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const alpha = new Uint8Array(width * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const up = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += up;
      else if (filter === 3) v += (a + up) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(up - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + up - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      line[i] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      alpha[y * width + x] = type === 6 ? line[x * 4 + 3] : trns && line[x] < trns.length ? trns[line[x]] : 255;
    }
    prev = line;
  }
  return { width, alpha };
}

const sheets = {};
function sheet(letter) {
  if (!sheets[letter]) sheets[letter] = readPng(path.join(DIR, FILES[letter]));
  return sheets[letter];
}

const cache = new Map();

/** The share of a tile's pixels that are drawn, 0 to 1. Unknown sheets count as solid. */
function opacity(tile) {
  if (!tile) return 0;
  if (cache.has(tile)) return cache.get(tile);
  let value = 1;
  const letter = tile[0];
  if (FILES[letter]) {
    const { width, alpha } = sheet(letter);
    const columns = Math.floor(width / 16);
    const id = Number(tile.slice(1));
    const x0 = (id % columns) * 16;
    const y0 = Math.floor(id / columns) * 16;
    let drawn = 0;
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (alpha[(y0 + y) * width + x0 + x] > 32) drawn += 1;
    value = drawn / 256;
  }
  cache.set(tile, value);
  return value;
}

module.exports = { opacity };
