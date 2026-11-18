'use strict';

/**
 * The menus, drawn like the handheld games over the game screen:
 *
 *   pause     POKéMON / BAG / TRAINER / FLY / EXIT (Esc, or START on a phone)
 *   party     the first six (.party), and a summary of each
 *   bag       .inventory, in pockets; in battle it's read-only
 *   trainer   the trainer card (.me)
 *   shop      the MART: categories, items and prices, a quantity, then
 *             "That will be ... OK?". Buying is .buy, so it's the same
 *             shop as Discord's.
 *
 * Everything comes from the server (Web/menus.js). Arrows move, A picks,
 * B goes back. Everything can be clicked or tapped too.
 */

(function () {
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };
  const fmt = (n) => Number(n || 0).toLocaleString('en-US');
  const TYPE_COLORS = {
    normal: '#a8a878', fire: '#f08030', water: '#6890f0', grass: '#78c850', electric: '#f8d030', ice: '#98d8d8',
    fighting: '#c03028', poison: '#a040a0', ground: '#e0c068', flying: '#a890f0', psychic: '#f85888', bug: '#a8b820',
    rock: '#b8a038', ghost: '#705898', dragon: '#7038f8', dark: '#705848', steel: '#b8b8d0', fairy: '#ee99ac',
  };
  const typeTag = (t) => {
    const tag = el('span', 'm-type', t.toUpperCase());
    tag.style.background = TYPE_COLORS[t] || '#888';
    return tag;
  };

  /**
   * @param {HTMLElement} root  an empty element covering the game screen
   * @param {object} hooks
   * @param {(path: string, body?: object) => Promise<object>} hooks.post
   * @param {(path: string) => Promise<object>} hooks.get
   * @param {() => void} hooks.fly   open FLY
   * @param {() => string} hooks.name
   */
  function create(root, hooks) {
    root.classList.add('mscreen');
    root.hidden = true;

    let open = false;
    /** The screen stack: each { draw(), key(k) }. */
    const stack = [];
    let resolveClose = null;

    function show() {
      open = true;
      root.hidden = false;
    }
    function close() {
      open = false;
      root.hidden = true;
      stack.length = 0;
      root.replaceChildren();
      if (resolveClose) resolveClose();
      resolveClose = null;
    }
    const top = () => stack[stack.length - 1];
    function push(screen) {
      stack.push(screen);
      redraw();
    }
    function pop() {
      stack.pop();
      if (!stack.length) close();
      else redraw();
    }
    /** The top page, with any boxes (messages, YES/NO, quantity) drawn over it. */
    function redraw() {
      root.replaceChildren();
      let i = stack.length - 1;
      while (i > 0 && stack[i].overlay) i -= 1;
      for (let j = Math.max(0, i); j < stack.length; j++) stack[j].draw();
    }
    const waitClose = () => new Promise((r) => { resolveClose = r; });

    /** A box with lines of text, typed out, A to go on; resolves when read. */
    function message(lines) {
      return new Promise((resolve) => {
        let at = 0;
        const screen = {
          overlay: true,
          draw() {
            const box = el('div', 'm-message');
            box.append(el('p', null, lines[at]));
            box.append(el('span', 'm-more', '▼'));
            box.addEventListener('click', () => screen.key('a'));
            root.append(box);
          },
          key(k) {
            if (k !== 'a' && k !== 'b') return;
            at += 1;
            if (at >= lines.length) {
              stack.splice(stack.indexOf(screen), 1);
              redraw();
              resolve();
            } else redraw();
          },
        };
        stack.push(screen);
        redraw();
      });
    }

    /** A little YES / NO box; resolves true for YES. */
    function confirm(question) {
      return new Promise((resolve) => {
        let at = 0;
        const screen = {
          overlay: true,
          draw() {
            const box = el('div', 'm-message');
            box.append(el('p', null, question));
            const choices = el('div', 'm-yesno');
            ['YES', 'NO'].forEach((label, i) => {
              const b = el('button', `m-item${i === at ? ' on' : ''}`, label);
              b.type = 'button';
              b.addEventListener('click', () => pick(i === 0));
              b.addEventListener('mouseenter', () => {
                if (at === i) return;
                at = i;
                redraw();
              });
              choices.append(b);
            });
            root.append(box, choices);
          },
          key(k) {
            if (k === 'up' || k === 'down') at = 1 - at;
            if (k === 'a') return pick(at === 0);
            if (k === 'b') return pick(false);
            redraw();
          },
        };
        const pick = (yes) => {
          stack.splice(stack.indexOf(screen), 1);
          redraw();
          resolve(yes);
        };
        stack.push(screen);
        redraw();
      });
    }

    /** A vertical list with a cursor. */
    function list(items, at, { className = '', onPick, render } = {}) {
      const box = el('div', `m-list ${className}`);
      items.forEach((item, i) => {
        const b = el('button', `m-item${i === at ? ' on' : ''}${item.disabled ? ' off' : ''}`);
        b.type = 'button';
        if (render) render(b, item, i);
        else b.textContent = item.label;
        b.addEventListener('click', () => onPick(i));
        // Pointing at an item moves the cursor there (as the arrow keys would).
        b.addEventListener('mouseenter', () => {
          const cur = [...box.children].findIndex((c) => c.classList.contains('on'));
          const screen = top();
          if (cur < 0 || cur === i || !screen || !screen.key || !box.isConnected) return;
          const k = i > cur ? 'down' : 'up';
          for (let n = 0; n < Math.abs(i - cur); n++) screen.key(k);
        });
        box.append(b);
      });
      queueMicrotask(() => {
        const on = box.querySelector('.on');
        if (on) on.scrollIntoView({ block: 'nearest' });
      });
      return box;
    }
    const step = (at, k, count) => (k === 'up' ? Math.max(0, at - 1) : k === 'down' ? Math.min(count - 1, at + 1) : at);

    // -----------------------------------------------------------------------
    // The pause menu
    // -----------------------------------------------------------------------

    function pause() {
      show();
      let at = 0;
      const items = [
        { label: 'POKéMON', go: () => party() },
        { label: 'BAG', go: () => bag() },
        { label: 'MAP', go: () => townMap() },
        { label: hooks.name().toUpperCase(), go: () => trainerCard() },
        { label: 'FLY', go: () => { close(); hooks.fly(); } },
        // Only for the owner (the server checks it too).
        ...(hooks.dev ? [{ label: 'DEV TOOLS', go: () => devTools() }] : []),
        { label: 'EXIT', go: () => close() },
      ];
      push({
        draw() {
          root.append(list(items, at, { className: 'm-pause', onPick: (i) => { at = i; items[i].go(); } }));
        },
        key(k) {
          if (k === 'a') return items[at].go();
          if (k === 'b') return close();
          at = step(at, k, items.length);
          redraw();
        },
      });
      return waitClose();
    }

    // -----------------------------------------------------------------------
    // POKéMON
    // -----------------------------------------------------------------------

    async function party() {
      const data = await hooks.get('/api/party');
      let at = 0;
      const team = data.team || [];
      push({
        chosen: () => team[at],
        draw() {
          const page = el('div', 'm-page m-party');
          page.append(el('p', 'm-head', team.length ? 'Choose a POKéMON.' : 'You have no POKéMON.'));
          const grid = el('div', 'm-party-grid');
          team.forEach((mon, i) => {
            const slot = el('button', `m-slot${i === at ? ' on' : ''}${mon.obeys ? '' : ' wont'}`);
            slot.type = 'button';
            const img = el('img');
            img.src = mon.sprite || '';
            img.alt = '';
            const info = el('div', 'm-slot-info');
            info.append(el('b', null, mon.name), el('span', null, `Lv${mon.level}`));
            info.append(el('span', 'm-slot-sub', mon.obeys ? `HP ${mon.stats.hp}` : "WON'T OBEY"));
            slot.append(img, info);
            slot.addEventListener('click', () => { at = i; options(mon); });
            slot.addEventListener('mouseenter', () => { if (at !== i) { at = i; redraw(); } });
            grid.append(slot);
          });
          page.append(grid, el('p', 'm-hint', `Trainer level commands up to Lv${data.cap}. Change order with .swap on Discord.`));
          root.append(page);
        },
        key(k) {
          if (k === 'b') return pop();
          if (!team.length) return;
          if (k === 'a') return options(team[at]);
          const delta = { left: -1, right: 1, up: -2, down: 2 }[k];
          if (delta) at = Math.max(0, Math.min(team.length - 1, at + delta));
          redraw();
        },
      });
    }

    /** What to do with one of the six: like the games' POKéMON menu, plus the PC. */
    function options(mon) {
      let at = 0;
      const items = [
        { label: 'SUMMARY', go: () => { pop(); summary(mon); } },
        { label: 'SWITCH', go: () => { pop(); switchWith(mon); } },
        { label: 'PC', go: () => { pop(); pcBox(mon); } },
        { label: 'CANCEL', go: () => pop() },
      ];
      push({
        overlay: true,
        draw() {
          root.append(list(items, at, { className: 'm-options', onPick: (i) => items[i].go() }));
        },
        key(k) {
          if (k === 'a') return items[at].go();
          if (k === 'b') return pop();
          at = step(at, k, items.length);
          redraw();
        },
      });
    }

    /** Swap two party slots (and redraw the party). */
    async function swapSlots(a, b) {
      const r = await hooks.post('/api/swap', { a, b });
      if (!r.ok) await message([r.text]);
      // Back to a fresh party screen.
      stack.length = Math.max(0, stack.length - 1);
      await party();
    }

    /** SWITCH: pick another of the six to trade places with. */
    function switchWith(mon) {
      const screen = top();
      const head = document.querySelector('.m-party .m-head');
      if (head) head.textContent = `Move ${mon.name} where?`;
      const pick = screen.key;
      screen.key = async (k) => {
        if (k === 'b') {
          screen.key = pick;
          redraw();
          return;
        }
        if (k === 'a') {
          const other = screen.chosen();
          screen.key = pick;
          if (other && other.id !== mon.id) return swapSlots(mon.number, other.number);
          redraw();
          return;
        }
        pick.call(screen, k);
        const h = document.querySelector('.m-party .m-head');
        if (h) h.textContent = `Move ${mon.name} where?`;
      };
    }

    /** The PC: everything you own, strongest first; pick one to swap in. */
    async function pcBox(mon) {
      let page = 0;
      let at = 0;
      let data = await hooks.get('/api/pc?page=0');
      const load = async (n) => {
        data = await hooks.get(`/api/pc?page=${n}`);
        page = data.page;
        at = Math.min(at, Math.max(0, data.mons.length - 1));
        redraw();
      };
      push({
        draw() {
          const page_ = el('div', 'm-page m-pc');
          const head = el('div', 'm-pocket');
          const prev = el('button', 'm-arrow', '\u25C0');
          const next = el('button', 'm-arrow', '\u25B6');
          prev.type = next.type = 'button';
          prev.addEventListener('click', () => this.key('left'));
          next.addEventListener('click', () => this.key('right'));
          head.append(prev, el('b', null, `PC  BOX ${data.page + 1}/${data.pages}  (${data.total.toLocaleString()} POKéMON)`), next);
          const grid = el('div', 'm-pc-grid');
          data.mons.forEach((p, i) => {
            const cell = el('button', `m-pc-cell${i === at ? ' on' : ''}${p.tooHigh ? ' wont' : ''}`);
            cell.type = 'button';
            const img = el('img');
            img.src = p.sprite || '';
            img.alt = '';
            cell.append(img, el('span', null, `Lv${p.level}`));
            cell.addEventListener('click', () => { at = i; this.key('a'); });
            cell.addEventListener('mouseenter', () => { if (at !== i) { at = i; redraw(); } });
            grid.append(cell);
          });
          const chosen = data.mons[at];
          const desc = el('div', 'm-desc');
          desc.append(el('p', null, chosen ? `${chosen.name}  Lv${chosen.level}${chosen.tooHigh ? '  (too high to obey yet)' : ''}. A: swap in for ${mon.name}.` : 'Nothing here.'));
          page_.append(head, grid, desc);
          root.append(page_);
        },
        async key(k) {
          if (k === 'b') return pop();
          const cols = 6;
          if (k === 'left') {
            if (at % cols === 0 && page > 0) { at = 0; return load(page - 1); }
            at = Math.max(0, at - 1);
          } else if (k === 'right') {
            if ((at % cols === cols - 1 || at === data.mons.length - 1) && page < data.pages - 1) { at = 0; return load(page + 1); }
            at = Math.min(data.mons.length - 1, at + 1);
          } else if (k === 'up') at = Math.max(0, at - cols);
          else if (k === 'down') at = Math.min(data.mons.length - 1, at + cols);
          else if (k === 'a') {
            const pick = data.mons[at];
            if (!pick) return;
            if (pick.id === mon.id) return message([`${mon.name} is already on your team!`]);
            const yes = await confirm(`Swap ${mon.name} for ${pick.name}?`);
            if (!yes) return;
            pop();
            return swapSlots(mon.number, pick.number);
          }
          redraw();
        },
      });
    }

    // -----------------------------------------------------------------------
    // The Town Map
    // -----------------------------------------------------------------------

    // The whole world, drawn as on the world plan: the MAIN CITY in the
    // middle, the eight gates as lands round it with their routes and stops,
    // and the way in from TOWN 1, due south. Islands in a sea, with a bit of
    // each land's scenery drawn on. Point at a place to read about it; click
    // it to zoom in (or the arrow keys and A).
    const GATE_FILL = ['#3f8a45', '#c2a05e', '#2c7a4f', '#7d6a58', '#c4893e', '#3d7fb5', '#9fb2c4', '#d6e0ea'];
    const GATE_SHADE = ['#2f6b35', '#a48a52', '#1f5a3c', '#5e5246', '#9a6c2e', '#235684', '#7d93a8', '#aab8c8'];
    const SVGNS = 'http://www.w3.org/2000/svg';
    const svgEl = (tag, attrs, parent) => {
      const e = document.createElementNS(SVGNS, tag);
      for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
      if (parent) parent.appendChild(e);
      return e;
    };
    const STOP_WORDS = { town: 'TOWN', reward: 'POINT OF INTEREST', boss: 'BOSS TRAINER', landmark: 'LANDMARK' };
    /** A steady pseudo-random number in [0, 1) for each i (the map never changes). */
    const rnd = (i) => {
      const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
      return x - Math.floor(x);
    };
    const r1 = (v) => Math.round(v * 10) / 10;
    /** A smooth closed outline through the points (Catmull-Rom as cubic Beziers). */
    const blob = (pts) => {
      const n = pts.length;
      let d = `M${r1(pts[0].x)},${r1(pts[0].y)}`;
      for (let i = 0; i < n; i++) {
        const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
        d += ` C${r1(p1.x + (p2.x - p0.x) / 6)},${r1(p1.y + (p2.y - p0.y) / 6)} ${r1(p2.x - (p3.x - p1.x) / 6)},${r1(p2.y - (p3.y - p1.y) / 6)} ${r1(p2.x)},${r1(p2.y)}`;
      }
      return `${d}Z`;
    };
    /** A word on the map, with a dark edge so it reads on land and sea. */
    const label = (parent, x, y, text, { size = 11, fill = '#eef1f6', anchor = 'middle', cls = '' } = {}) => {
      const t = svgEl('text', { x: r1(x), y: r1(y), 'text-anchor': anchor, 'font-size': size, fill, class: `m-label ${cls}` }, parent);
      t.textContent = text;
      return t;
    };

    /** A little picture of a kind of land, centred on (x, y). */
    function scenery(g, kind, x, y, s = 1) {
      const at = (d) => d.replace(/(-?\d+(\.\d+)?),(-?\d+(\.\d+)?)/g, (m, a, _b, c) => `${r1(x + a * s)},${r1(y + c * s)}`);
      const art = {
        tree: () => {
          svgEl('rect', { x: r1(x - 1.2 * s), y: r1(y + 2 * s), width: r1(2.4 * s), height: r1(3 * s), fill: '#4a3424' }, g);
          svgEl('path', { d: at('M0,-7 L5,3 L-5,3Z'), fill: '#1d4d2a' }, g);
          svgEl('path', { d: at('M0,-9 L3.5,-1 L-3.5,-1Z'), fill: '#2c6b3a' }, g);
        },
        palm: () => {
          svgEl('path', { d: at('M0,5 Q1,0 0,-4'), stroke: '#6b4a2c', 'stroke-width': r1(1.6 * s), fill: 'none' }, g);
          svgEl('path', { d: at('M0,-4 Q-4,-7 -7,-3 M0,-4 Q4,-7 7,-3 M0,-4 Q-2,-8 -1,-9 M0,-4 Q3,-8 4,-8'), stroke: '#2f7a3a', 'stroke-width': r1(1.8 * s), fill: 'none', 'stroke-linecap': 'round' }, g);
        },
        tuft: () => svgEl('path', { d: at('M-4,3 L-3,-2 M0,3 L0,-4 M4,3 L3,-2'), stroke: '#a8d88a', 'stroke-width': r1(1.4 * s), 'stroke-linecap': 'round' }, g),
        peak: () => {
          svgEl('path', { d: at('M-8,5 L0,-8 L8,5Z'), fill: '#6d625a' }, g);
          svgEl('path', { d: at('M-3,-3 L0,-8 L3,-3 L1,-2 L0,-3 L-1,-2Z'), fill: '#f4f4f0' }, g);
        },
        cave: () => {
          svgEl('path', { d: at('M-8,5 Q-7,-6 0,-7 Q7,-6 8,5Z'), fill: '#5e5246' }, g);
          svgEl('path', { d: at('M-3,5 Q-3,-1 0,-1 Q3,-1 3,5Z'), fill: '#1a1612' }, g);
        },
        dune: () => svgEl('path', { d: at('M-8,3 Q-3,-3 1,2 Q4,-2 8,3'), stroke: '#e8c98a', 'stroke-width': r1(1.6 * s), fill: 'none', 'stroke-linecap': 'round' }, g),
        mesa: () => svgEl('path', { d: at('M-8,5 L-5,-3 L5,-3 L8,5Z'), fill: '#b5652e' }, g),
        wave: () => svgEl('path', { d: at('M-7,1 Q-5,-2 -3,1 Q-1,4 1,1 Q3,-2 5,1'), stroke: '#cfe6f5', 'stroke-width': r1(1.4 * s), fill: 'none', 'stroke-linecap': 'round', opacity: 0.85 }, g),
        fish: () => {
          svgEl('ellipse', { cx: r1(x), cy: r1(y), rx: r1(4 * s), ry: r1(2.4 * s), fill: '#f2a35a' }, g);
          svgEl('path', { d: at('M3,0 L7,-3 L7,3Z'), fill: '#f2a35a' }, g);
        },
        flake: () => svgEl('path', { d: at('M0,-6 L0,6 M-5,-3 L5,3 M-5,3 L5,-3'), stroke: '#ffffff', 'stroke-width': r1(1.4 * s), 'stroke-linecap': 'round' }, g),
        river: () => svgEl('path', { d: at('M-7,-4 Q-2,-4 -2,0 Q-2,4 3,4 L7,4'), stroke: '#6fb3e6', 'stroke-width': r1(2 * s), fill: 'none', 'stroke-linecap': 'round' }, g),
      };
      (art[kind] || art.tuft)();
    }
    const BIOME_ART = {
      meadow: 'tuft', forest: 'tree', jungle: 'palm', 'river valley': 'river', beach: 'palm', coast: 'wave',
      mountain: 'peak', summit: 'peak', cave: 'cave', 'ice cave': 'cave', desert: 'dune', canyon: 'mesa',
      'open sea': 'wave', reef: 'fish', snowfield: 'flake', blizzard: 'flake',
    };

    /** The map as SVG, plus where each place is on it (for the cursor and "you are here"). */
    function drawWorld(data) {
      const C = { x: 500, y: 455 };
      const CITY_R = 74;
      const RING_IN = 104;
      const STEP = 34.5;
      const gateAngle = (g) => ((-90 + 22.5 + 45 * g) * Math.PI) / 180;
      const at = (r, a) => ({ x: C.x + r * Math.cos(a), y: C.y + r * Math.sin(a) });
      const svg = svgEl('svg', { viewBox: '0 0 1000 1000', class: 'm-world' });
      const spots = {};

      // The sea: deep blue, lighter near the land, with waves and a few clouds.
      const defs = svgEl('defs', {}, svg);
      const sea = svgEl('radialGradient', { id: 'm-sea', cx: '50%', cy: '46%', r: '62%' }, defs);
      svgEl('stop', { offset: '0%', 'stop-color': '#2a6f9e' }, sea);
      svgEl('stop', { offset: '100%', 'stop-color': '#123552' }, sea);
      svgEl('rect', { x: 0, y: 0, width: 1000, height: 1000, fill: 'url(#m-sea)' }, svg);
      const waves = svgEl('g', { class: 'm-waves' }, svg);
      for (let i = 0; i < 70; i++) scenery(waves, 'wave', 20 + rnd(i) * 960, 20 + rnd(i + 500) * 960, 1.1);

      // Each gate's land: an island round its routes, with a sandy shore.
      const half = (20 * Math.PI) / 180;
      const lands = svgEl('g', {}, svg);
      data.gates.forEach((gate, g) => {
        const a = gateAngle(g);
        const reach = RING_IN + STEP * gate.stops.length + 34;
        const pts = [];
        const N = 9;
        for (let i = 0; i <= N; i++) {
          const t = a - half + (2 * half * i) / N;
          pts.push(at(reach + (rnd(g * 40 + i) - 0.5) * 34, t));
        }
        for (let i = 1; i < 6; i++) {
          const r = reach - ((reach - CITY_R - 10) * i) / 6;
          pts.push(at(r, a + half - 0.02 - rnd(g * 40 + 20 + i) * 0.07));
        }
        pts.push(at(CITY_R + 6, a + half * 0.6), at(CITY_R + 6, a - half * 0.6));
        for (let i = 5; i >= 1; i--) {
          const r = reach - ((reach - CITY_R - 10) * i) / 6;
          pts.push(at(r, a - half + 0.02 + rnd(g * 40 + 30 + i) * 0.07));
        }
        const d = blob(pts);
        svgEl('path', { d, fill: '#e9d9a6', stroke: '#e9d9a6', 'stroke-width': 10, 'stroke-linejoin': 'round' }, lands);
        svgEl('path', { d, fill: GATE_FILL[g % 8], stroke: GATE_SHADE[g % 8], 'stroke-width': 2 }, lands);
      });
      // The way in from TOWN 1: a long green island to the south.
      const south = Math.PI / 2;
      {
        const pts = [];
        for (let i = 0; i <= 8; i++) pts.push(at(CITY_R + 4 + (i * 400) / 8, south - 0.16 - (rnd(900 + i) - 0.5) * 0.08));
        for (let i = 8; i >= 0; i--) pts.push(at(CITY_R + 4 + (i * 400) / 8, south + 0.16 + (rnd(950 + i) - 0.5) * 0.08));
        const d = blob(pts);
        svgEl('path', { d, fill: '#e9d9a6', stroke: '#e9d9a6', 'stroke-width': 10, 'stroke-linejoin': 'round' }, lands);
        svgEl('path', { d, fill: '#4f9a4f', stroke: '#3b7a3d', 'stroke-width': 2 }, lands);
      }

      // Scenery, then the routes, then the stops on top.
      const art = svgEl('g', { class: 'm-art' }, svg);
      const roads = svgEl('g', {}, svg);
      const dots = svgEl('g', {}, svg);
      data.gates.forEach((gate, g) => {
        const a = gateAngle(g);
        let prev = at(CITY_R, a);
        gate.stops.forEach(({ route, stop }, i) => {
          const n = Number(route.id.split('-')[1]);
          const wobble = (i % 2 ? 1 : -1) * 0.12 * (0.6 + ((n * 37) % 10) / 25);
          const p = at(RING_IN + STEP * (i + 1), a + wobble);
          // A winding trail, not a straight line.
          const mx = (prev.x + p.x) / 2, my = (prev.y + p.y) / 2;
          const nx = -(p.y - prev.y), ny = p.x - prev.x, len = Math.hypot(nx, ny) || 1;
          const bend = (i % 2 ? 1 : -1) * (8 + rnd(n) * 8);
          const cx = mx + (bend * nx) / len, cy = my + (bend * ny) / len;
          const d = `M${r1(prev.x)},${r1(prev.y)} Q${r1(cx)},${r1(cy)} ${r1(p.x)},${r1(p.y)}`;
          svgEl('path', { d, stroke: '#2b2a24', 'stroke-width': 7, fill: 'none', 'stroke-linecap': 'round', opacity: 0.35 }, roads);
          svgEl('path', route.visited
            ? { d, stroke: '#f6e7b8', 'stroke-width': 4, fill: 'none', 'stroke-linecap': 'round' }
            : { d, stroke: '#f6e7b8', 'stroke-width': 3.5, fill: 'none', 'stroke-linecap': 'round', 'stroke-dasharray': '0.1 7', opacity: 0.9 }, roads);
          const mid = { x: (mx + cx) / 2, y: (my + cy) / 2 };
          spots[route.id] = mid;
          // A bit of the land either side of the trail.
          const kind = BIOME_ART[route.biome] || 'tuft';
          for (const side of [1, -1]) {
            const off = side * (17 + rnd(n * 3 + side) * 8);
            scenery(art, kind, mid.x + (off * nx) / len, mid.y + (off * ny) / len, 0.9 + rnd(n * 7) * 0.4);
          }
          if (route.hidden) svgEl('circle', { cx: r1(cx), cy: r1(cy), r: 3, fill: '#fff6c8', class: 'm-sparkle' }, dots);
          prev = p;
          const k = stop.kind;
          const dim = stop.visited ? 1 : 0.7;
          if (k === 'town') {
            svgEl('rect', { x: p.x - 8, y: p.y - 6, width: 16, height: 12, rx: 2, fill: '#eef1f6', stroke: '#0e1420', 'stroke-width': 2, opacity: dim }, dots);
            svgEl('path', { d: `M${r1(p.x - 10)},${r1(p.y - 5)} L${r1(p.x)},${r1(p.y - 13)} L${r1(p.x + 10)},${r1(p.y - 5)}Z`, fill: '#d6453d', stroke: '#0e1420', 'stroke-width': 2, opacity: dim }, dots);
          } else if (k === 'boss') svgEl('path', { d: `M${r1(p.x)} ${r1(p.y - 9)} L${r1(p.x + 9)} ${r1(p.y)} L${r1(p.x)} ${r1(p.y + 9)} L${r1(p.x - 9)} ${r1(p.y)}Z`, fill: '#e2603a', stroke: '#0e1420', 'stroke-width': 2, opacity: dim }, dots);
          else if (k === 'landmark') {
            svgEl('path', { d: `M${r1(p.x)} ${r1(p.y - 10)} L${r1(p.x + 3)} ${r1(p.y - 3)} L${r1(p.x + 10)} ${r1(p.y - 3)} L${r1(p.x + 4)} ${r1(p.y + 2)} L${r1(p.x + 6)} ${r1(p.y + 9)} L${r1(p.x)} ${r1(p.y + 5)} L${r1(p.x - 6)} ${r1(p.y + 9)} L${r1(p.x - 4)} ${r1(p.y + 2)} L${r1(p.x - 10)} ${r1(p.y - 3)} L${r1(p.x - 3)} ${r1(p.y - 3)}Z`, fill: '#b48cf2', stroke: '#0e1420', 'stroke-width': 2, opacity: dim }, dots);
          } else svgEl('circle', { cx: r1(p.x), cy: r1(p.y), r: 6, fill: '#f2c14e', stroke: '#0e1420', 'stroke-width': 2, opacity: dim }, dots);
          spots[stop.id] = p;
        });
        // The gate's name out at the far end of its land, kept on the map.
        const lp = at(RING_IN + STEP * gate.stops.length + 52, a);
        const lx = Math.max(70, Math.min(930, lp.x));
        const ly = Math.max(30, Math.min(960, lp.y));
        label(svg, lx, ly, `GATE ${gate.number}`, { size: 14, fill: gate.open ? '#ffe9a8' : '#f0a59c' });
        label(svg, lx, ly + 15, gate.region.toUpperCase(), { size: 9, fill: '#d8e2ee' });
        // Closed: a padlock on the land by the city.
        if (!gate.open) {
          const lk = at(CITY_R + 22, a);
          const lock = svgEl('g', { class: 'm-lock' }, svg);
          svgEl('path', { d: `M${r1(lk.x - 4)},${r1(lk.y - 1)} V${r1(lk.y - 5)} A4,4 0 0 1 ${r1(lk.x + 4)},${r1(lk.y - 5)} V${r1(lk.y - 1)}`, stroke: '#0e1420', 'stroke-width': 2.4, fill: 'none' }, lock);
          svgEl('rect', { x: r1(lk.x - 6), y: r1(lk.y - 2), width: 12, height: 9, rx: 1.5, fill: '#f2c14e', stroke: '#0e1420', 'stroke-width': 1.6 }, lock);
        }
      });

      // TOWN 1 -> PATH A -> TOWN 2 -> PATH B -> MAIN CITY, south to north, winding.
      const t1 = at(450, south), pa = at(360, south), t2 = at(265, south), pb = at(170, south), gateIn = at(CITY_R, south);
      const sway = (p, dx) => ({ x: p.x + dx, y: p.y });
      const way = [t1, sway(pa, 18), t2, sway(pb, -18), gateIn];
      let d = `M${r1(way[0].x)},${r1(way[0].y)}`;
      for (let i = 1; i < way.length; i++) {
        const a0 = way[i - 1], b0 = way[i];
        d += ` C${r1(a0.x)},${r1((a0.y + b0.y) / 2)} ${r1(b0.x)},${r1((a0.y + b0.y) / 2)} ${r1(b0.x)},${r1(b0.y)}`;
      }
      svgEl('path', { d, stroke: '#2b2a24', 'stroke-width': 7, fill: 'none', 'stroke-linecap': 'round', opacity: 0.35 }, roads);
      svgEl('path', { d, stroke: '#f6e7b8', 'stroke-width': 4, fill: 'none', 'stroke-linecap': 'round' }, roads);
      for (let i = 0; i < 6; i++) scenery(art, i % 2 ? 'tree' : 'tuft', C.x + (i % 2 ? -38 : 36) + rnd(800 + i) * 6, 560 + i * 62, 1);
      const byId = Object.fromEntries(data.intro.map((p) => [p.id, p]));
      [['town-1', t1], ['town-2', t2]].forEach(([id, p]) => {
        svgEl('rect', { x: p.x - 9, y: p.y - 7, width: 18, height: 14, rx: 2, fill: '#eef1f6', stroke: '#0e1420', 'stroke-width': 2 }, dots);
        svgEl('path', { d: `M${r1(p.x - 12)},${r1(p.y - 6)} L${r1(p.x)},${r1(p.y - 15)} L${r1(p.x + 12)},${r1(p.y - 6)}Z`, fill: '#d6453d', stroke: '#0e1420', 'stroke-width': 2 }, dots);
        label(svg, p.x - 20, p.y + 4, (byId[id] ? byId[id].name : id).toUpperCase(), { anchor: 'end' });
        spots[id] = p;
      });
      [['path-a', sway(pa, 18)], ['path-b', sway(pb, -18)]].forEach(([id, p]) => {
        const info = byId[id];
        label(svg, p.x + (id === 'path-a' ? 14 : -14), p.y + 4, (info ? info.name : id).toUpperCase(), { size: 10, fill: '#d6e7cf', anchor: id === 'path-a' ? 'start' : 'end' });
        spots[id] = p;
      });

      // The MAIN CITY: a ring of buildings round the BATTLE TOWER.
      svgEl('circle', { cx: C.x, cy: C.y, r: CITY_R, fill: '#5d6678', stroke: '#0e1420', 'stroke-width': 3 }, svg);
      svgEl('circle', { cx: C.x, cy: C.y, r: CITY_R - 22, fill: '#8c96a8', stroke: '#4b5568', 'stroke-width': 2 }, svg);
      for (let i = 0; i < 22; i++) {
        const a = (i / 22) * Math.PI * 2;
        const p = at(CITY_R - 11 + (rnd(i + 60) - 0.5) * 4, a);
        const w = 7 + rnd(i + 70) * 5, h = 6 + rnd(i + 80) * 8;
        svgEl('rect', { x: r1(p.x - w / 2), y: r1(p.y - h / 2), width: r1(w), height: r1(h), fill: ['#e8ecf2', '#c9a46a', '#d6453d', '#4f7fc4', '#f2c14e'][i % 5], stroke: '#0e1420', 'stroke-width': 1.2 }, svg);
      }
      svgEl('path', { d: `M${C.x - 13} ${C.y + 24} L${C.x - 9} ${C.y - 22} L${C.x} ${C.y - 38} L${C.x + 9} ${C.y - 22} L${C.x + 13} ${C.y + 24}Z`, fill: '#f2c14e', stroke: '#0e1420', 'stroke-width': 2 }, svg);
      svgEl('circle', { cx: C.x, cy: C.y - 26, r: 4, fill: '#d6453d', stroke: '#0e1420', 'stroke-width': 1.5, class: 'm-beacon' }, svg);
      label(svg, C.x, C.y + 42, 'MAIN CITY', { size: 12 });
      spots['main-city'] = { x: C.x, y: C.y };

      // A compass, and the map's name on a scroll.
      const rose = svgEl('g', { transform: 'translate(925 925)' }, svg);
      svgEl('circle', { r: 30, fill: 'none', stroke: '#e9d9a6', 'stroke-width': 1.5, opacity: 0.7 }, rose);
      svgEl('path', { d: 'M0,-34 L6,-6 L34,0 L6,6 L0,34 L-6,6 L-34,0 L-6,-6Z', fill: '#e9d9a6', stroke: '#6b5a3a', 'stroke-width': 1.2 }, rose);
      svgEl('path', { d: 'M0,-34 L6,-6 L0,0 L-6,-6Z', fill: '#d6453d' }, rose);
      label(rose, 0, -40, 'N', { size: 11, fill: '#ffe9a8' });
      const scroll = svgEl('g', { transform: 'translate(24 22)' }, svg);
      svgEl('rect', { width: 170, height: 34, rx: 6, fill: '#efe2bd', stroke: '#6b5a3a', 'stroke-width': 2 }, scroll);
      svgEl('text', { x: 85, y: 23, 'text-anchor': 'middle', 'font-size': 13, fill: '#4a3a22', class: 'm-plain' }, scroll).textContent = 'WORLD MAP';

      // You are here (blinks, by CSS).
      const me = spots[data.here];
      if (me) {
        svgEl('circle', { cx: r1(me.x), cy: r1(me.y), r: 16, fill: 'none', stroke: '#ff3b30', 'stroke-width': 4, class: 'm-here-ring' }, svg);
        svgEl('circle', { cx: r1(me.x), cy: r1(me.y), r: 6, fill: '#ff3b30', stroke: '#fff', 'stroke-width': 2, class: 'm-here' }, svg);
      }
      const hits = svgEl('g', { class: 'm-hits' }, svg);
      const cursor = svgEl('rect', { width: 30, height: 30, rx: 6, fill: 'none', stroke: '#fff', 'stroke-width': 3, 'stroke-dasharray': '7 4', class: 'm-map-cursor' }, svg);
      // The name of the place pointed at, in a box over the map.
      const tip = svgEl('g', { class: 'm-tip', visibility: 'hidden' }, svg);
      const tipBox = svgEl('rect', { rx: 4, height: 22, fill: '#0e1420', stroke: '#f2c14e', 'stroke-width': 2, opacity: 0.94 }, tip);
      const tipText = svgEl('text', { 'font-size': 11, fill: '#ffe9a8', class: 'm-plain' }, tip);
      return { svg, spots, cursor, hits, tip, tipBox, tipText };
    }

    async function townMap(alone = false) {
      if (alone) show();
      const data = await hooks.get('/api/townmap');
      // Every place in order, from home to the far end of each gate.
      const places = [
        ...data.intro.map((p) => ({ ...p, kind: /^town/.test(p.id) ? 'town' : 'path' })),
        { ...data.city, kind: 'city' },
        ...data.gates.flatMap((g) => g.stops.flatMap((s) => [
          { ...s.route, kind: 'route', gate: g },
          { ...s.stop, kind: s.stop.kind, gate: g, after: s.route },
        ])),
      ];
      let at = Math.max(0, places.findIndex((p) => p.id === data.here));
      let zoom = 1;
      let pointing = false;
      let holdHover = 0;
      const world = drawWorld(data);
      /** What's said about a place: a title and rows of facts. */
      const describe = (p) => {
        if (!p) return { title: '', rows: [] };
        const seen = p.visited ? 'Visited' : 'Not visited yet';
        if (p.kind === 'city') return { title: 'MAIN CITY', rows: [['', 'The BATTLE TOWER, the DROP STATION and the eight gates.']] };
        if (p.kind === 'town' && !p.gate) return { title: p.name.toUpperCase(), rows: [['', p.id === 'town-1' ? "Home: your house and PROF. A's lab." : 'The last town before the MAIN CITY.']] };
        if (p.kind === 'path') return { title: p.name.toUpperCase(), rows: [['LEVELS', p.levels ? `${p.levels.lo}-${p.levels.hi}` : '-']] };
        if (p.kind === 'route') {
          return {
            title: p.name.toUpperCase(),
            rows: [
              ['GATE', `${p.gate.number} · ${p.gate.region}${p.gate.open ? '' : ' (closed)'}`],
              ['LAND', p.biome],
              ['LEVELS', `${p.levels.lo}-${p.levels.hi}`],
              ['THEN', p.milestone],
              ...(p.hidden ? [['ITEMS', 'Something is hidden here']] : []),
              ['', seen],
            ],
          };
        }
        return { title: p.name.toUpperCase(), rows: [['', `${STOP_WORDS[p.kind] || 'STOP'} at the end of ${p.after.name}`], ['', seen]] };
      };
      // The side panel's parts, kept so pointing at a place only changes them.
      let side = null;
      const fillSide = () => {
        if (!side) return;
        const p = places[at];
        const { title, rows } = describe(p);
        side.title.textContent = title;
        side.here.hidden = !(p && p.id === data.here);
        side.facts.replaceChildren(...rows.map(([k, v]) => {
          const r = el('div', 'm-map-row');
          if (k) r.append(el('b', '', k));
          r.append(el('span', '', v));
          return r;
        }));
      };
      // The view: all of it, or zoomed in on a place. Slides there.
      let view = { x: 0, y: 0, size: 1000 };
      let anim = 0;
      const aim = () => {
        const s = world.spots[(places[at] || {}).id];
        const size = 1000 / zoom;
        const c = s && zoom > 1 ? s : { x: 500, y: 500 };
        return { x: Math.max(0, Math.min(1000 - size, c.x - size / 2)), y: Math.max(0, Math.min(1000 - size, c.y - size / 2)), size };
      };
      const glide = () => {
        const from = { ...view };
        const to = aim();
        const start = performance.now();
        cancelAnimationFrame(anim);
        const tick = (now) => {
          const t = Math.min(1, (now - start) / 260);
          const e = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
          view = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, size: from.size + (to.size - from.size) * e };
          world.svg.setAttribute('viewBox', `${r1(view.x)} ${r1(view.y)} ${r1(view.size)} ${r1(view.size)}`);
          if (t < 1) anim = requestAnimationFrame(tick);
        };
        anim = requestAnimationFrame(tick);
      };
      /** The cursor and the name box on the place. */
      const mark = () => {
        const p = places[at];
        const s = p && world.spots[p.id];
        if (!s) return;
        world.cursor.setAttribute('x', r1(s.x - 15));
        world.cursor.setAttribute('y', r1(s.y - 15));
        world.tipText.textContent = describe(p).title;
        let w = world.tipText.textContent.length * 11 + 14;
        try {
          w = world.tipText.getComputedTextLength() + 14;
        } catch {}
        const x = Math.max(4, Math.min(996 - w, s.x - w / 2));
        const y = s.y - 44 < 4 ? s.y + 20 : s.y - 44;
        world.tipBox.setAttribute('x', r1(x));
        world.tipBox.setAttribute('y', r1(y));
        world.tipBox.setAttribute('width', r1(w));
        world.tipText.setAttribute('x', r1(x + 7));
        world.tipText.setAttribute('y', r1(y + 15));
        world.tip.setAttribute('visibility', pointing ? 'visible' : 'hidden');
      };
      const choose = (i) => {
        at = i;
        fillSide();
        mark();
      };
      // A target to point at and click for every place.
      places.forEach((p, i) => {
        const s = world.spots[p.id];
        if (!s) return;
        const hit = svgEl('circle', { cx: r1(s.x), cy: r1(s.y), r: p.kind === 'city' ? CITY_HIT : 15, class: 'm-hit' }, world.hits);
        hit.addEventListener('pointerenter', () => {
          // Not while the view slides after a click (the place under the
          // pointer changes as it moves).
          if (performance.now() < holdHover) return;
          pointing = true;
          if (at !== i) choose(i);
          else mark();
        });
        hit.addEventListener('pointerleave', () => {
          pointing = false;
          mark();
        });
        hit.addEventListener('click', (e) => {
          e.stopPropagation();
          const again = at === i && zoom > 1;
          holdHover = performance.now() + 400;
          choose(i);
          zoom = again ? 1 : 2.6;
          glide();
          if (side) side.keys.textContent = keysText();
        });
      });
      // Clicking the sea zooms back out; the wheel zooms in and out.
      world.svg.addEventListener('click', () => {
        if (zoom === 1) return;
        zoom = 1;
        glide();
        if (side) side.keys.textContent = keysText();
      });
      world.svg.addEventListener('wheel', (e) => {
        e.preventDefault();
        const next = e.deltaY < 0 ? 2.6 : 1;
        if (next === zoom) return;
        zoom = next;
        glide();
        if (side) side.keys.textContent = keysText();
      }, { passive: false });
      const keysText = () => `POINT OR ◀▶ · CLICK OR A: ZOOM ${zoom > 1 ? 'OUT' : 'IN'} · B CLOSE`;
      push({
        draw() {
          const page = el('div', 'm-page m-map');
          const frame = el('div', 'm-map-frame');
          frame.append(world.svg);
          const panel = el('div', 'm-map-side');
          side = {
            title: el('b', 'm-map-title'),
            here: el('p', 'm-map-here', 'YOU ARE HERE'),
            facts: el('div', 'm-map-facts'),
            keys: el('p', 'm-map-keys', keysText()),
          };
          panel.append(side.title, side.here, side.facts, side.keys);
          page.append(frame, panel);
          root.append(page);
          fillSide();
          mark();
          world.svg.setAttribute('viewBox', `${r1(view.x)} ${r1(view.y)} ${r1(view.size)} ${r1(view.size)}`);
        },
        key(k) {
          if (k === 'b') {
            if (alone) return close();
            return pop();
          }
          pointing = false;
          if (k === 'a') {
            zoom = zoom > 1 ? 1 : 2.6;
            side.keys.textContent = keysText();
          }
          if (k === 'right' || k === 'down') at = (at + 1) % places.length;
          if (k === 'left' || k === 'up') at = (at - 1 + places.length) % places.length;
          fillSide();
          mark();
          glide();
          return undefined;
        },
      });
      if (alone) return waitClose();
      return undefined;
    }
    const CITY_HIT = 40;

    // -----------------------------------------------------------------------
    // DEV TOOLS (the owner only; the server checks every call)
    // -----------------------------------------------------------------------

    function devTools() {
      let at = 0;
      const WARPS = [
        ['Town 1', 'town-1'], ['Path a', 'path-a'], ['Town 2', 'town-2'], ['Path b', 'path-b'], ['Main City', 'main-city'],
        ['Battle Tower lobby', 'in:main-city:29,31'], ['Route 1', 'route-1'], ['Route 10 (rival)', 'route-10'], ['Route 11', 'route-11'],
        ['Route 21', 'route-21'], ['Route 31', 'route-31'], ['Route 41', 'route-41'], ['Route 51 (sea)', 'route-51'],
        ['Route 61 (snow)', 'route-61'], ['Route 71', 'route-71'], ['Test Route', 'testroute'], ['Dev Town', 'devtown'],
      ];
      const state = () => hooks.dev.state() || {};
      const onOff = (v) => (v ? 'ON' : 'OFF');
      const items = () => {
        const d = state();
        return [
          {
            label: 'RESTART GAME', value: '',
            help: 'Play the opening again and start from Town 1, with every patch, trainer and item back. Your Discord profile is not touched, and the starter is only given once per prestige.',
            go: async () => {
              if (!(await confirm('Restart the web game from the very beginning?'))) return;
              const r = await hooks.dev.run('restart');
              if (r && r.restart) location.reload();
              else if (r) await message([r.text]);
            },
          },
          { label: 'NOCLIP', value: onOff(d.noclip), help: 'Walk through walls, buildings, trainers, water and ledges. Turns EXPLORE on.', go: () => hooks.dev.run('noclip', !d.noclip) },
          { label: 'EXPLORE', value: onOff(d.exploring), help: 'Nothing is saved or counts: no battles, trainers ignore you, doors open. Turning it off puts you back where you really are.', go: () => hooks.dev.run('explore', !d.exploring) },
          { label: 'WARP', value: '...', help: 'Jump to any town or route (turns EXPLORE on).', go: () => warp() },
          { label: 'SHOW HIDDEN', value: onOff(d.overlay), help: "Red: one-battle grass. Yellow: where trainers can see you.", go: () => hooks.dev.run('overlay', !d.overlay) },
          { label: 'WALK SPEED', value: `x${hooks.dev.speed()}`, help: 'Walk faster, in this tab only.', go: () => hooks.dev.speed(hooks.dev.speed() >= 4 ? 1 : hooks.dev.speed() * 2) },
          { label: 'ALL OFF', value: '', help: 'Everything off, back where you really are.', go: () => hooks.dev.run('off') },
        ];
      };
      push({
        draw() {
          const all = items();
          const page = el('div', 'm-page m-devpage');
          page.append(el('p', 'm-head', 'DEV TOOLS'));
          const rows = el('div', 'm-dev-rows');
          all.forEach((item, i) => {
            const b = el('button', `m-dev-row${i === at ? ' on' : ''}`);
            b.type = 'button';
            b.append(el('span', null, item.label), el('b', item.value === 'ON' ? 'is-on' : null, item.value));
            b.addEventListener('click', () => { at = i; this.key('a'); });
            b.addEventListener('mouseenter', () => { if (at !== i) { at = i; redraw(); } });
            rows.append(b);
          });
          const d = state();
          const tags = [d.exploring && 'EXPLORING', d.noclip && 'NOCLIP', d.overlay && 'SHOWING HIDDEN'].filter(Boolean);
          page.append(rows, el('div', 'm-desc', null));
          page.lastChild.append(el('p', null, all[at].help));
          page.append(el('p', 'm-hint', tags.length ? `Now: ${tags.join(' · ')}. Only you (DISCORD_OWNER_ID) see this.` : 'Playing for real. Only you (DISCORD_OWNER_ID) see this.'));
          root.append(page);
        },
        async key(k) {
          const all = items();
          if (k === 'b') return pop();
          if (k === 'a') {
            await all[at].go();
            if (top() && top().draw === this.draw) redraw();
            return undefined;
          }
          const move = { up: -2, down: 2, left: -1, right: 1 }[k] || 0;
          if (at + move >= 0 && at + move < all.length) at += move;
          redraw();
        },
      });

      function warp() {
        let w = 0;
        push({
          draw() {
            root.append(list(WARPS.map(([label]) => ({ label: label.toUpperCase() })), w, { className: 'm-dev m-dev-warp', onPick: (i) => { w = i; this.key('a'); } }));
          },
          async key(k) {
            if (k === 'b') return pop();
            if (k === 'a') {
              await hooks.dev.run('warp', WARPS[w][1]);
              return close();
            }
            w = step(w, k, WARPS.length);
            redraw();
          },
        });
      }
    }

    function summary(mon) {
      push({
        draw() {
          const page = el('div', 'm-page m-summary');
          const left = el('div', 'm-sum-left');
          const img = el('img', 'm-sum-mon');
          img.src = mon.sprite || '';
          img.alt = '';
          left.append(el('b', 'm-sum-name', `${mon.name}${mon.gender === 'male' ? ' ♂' : mon.gender === 'female' ? ' ♀' : ''}`), img);
          const types = el('div', 'm-types');
          mon.types.forEach((t) => types.append(typeTag(t)));
          left.append(el('span', null, `Lv${mon.level} ${mon.species !== mon.name ? mon.species : ''}`), types);
          const right = el('div', 'm-sum-right');
          const rows = [
            ['NATURE', String(mon.nature || '').toUpperCase()],
            ['ABILITY', mon.ability],
            ['ITEM', mon.item || 'NONE'],
            ['HP', mon.stats.hp], ['ATTACK', mon.stats.attack], ['DEFENSE', mon.stats.defense],
            ['SP. ATK', mon.stats.spAttack], ['SP. DEF', mon.stats.spDefense], ['SPEED', mon.stats.speed],
          ];
          const table = el('div', 'm-stats');
          for (const [k, v] of rows) table.append(el('span', null, k), el('b', null, String(v)));
          const moves = el('div', 'm-moves');
          for (const m of mon.moves) {
            const row = el('div', 'm-move');
            row.append(typeTag(m.type), el('span', null, m.name.toUpperCase()));
            moves.append(row);
          }
          right.append(table, moves);
          page.append(left, right);
          page.addEventListener('click', () => pop());
          root.append(page);
        },
        key(k) {
          if (k === 'a' || k === 'b') pop();
        },
      });
    }

    // -----------------------------------------------------------------------
    // BAG (.inventory)
    // -----------------------------------------------------------------------

    /**
     * @param {boolean} inBattle  read-only: items aren't used in battles here
     */
    async function bag(inBattle = false) {
      if (inBattle) show();
      const data = await hooks.get('/api/bag');
      const pockets = data.pockets.length ? data.pockets : [{ name: 'Items', items: [] }];
      let pocket = 0;
      let at = 0;
      const items = () => [...pockets[pocket].items, { name: 'CANCEL', cancel: true }];
      push({
        draw() {
          const page = el('div', 'm-page m-bag');
          const head = el('div', 'm-pocket');
          const prev = el('button', 'm-arrow', '◀');
          const next = el('button', 'm-arrow', '▶');
          prev.type = next.type = 'button';
          prev.addEventListener('click', () => this.key('left'));
          next.addEventListener('click', () => this.key('right'));
          head.append(prev, el('b', null, `${pockets[pocket].name.toUpperCase()}  ${pocket + 1}/${pockets.length}`), next);
          const rows = items();
          const box = list(rows, at, {
            className: 'm-bag-list',
            onPick: (i) => { at = i; this.key('a'); },
            render: (b, item) => {
              b.append(el('span', null, item.cancel ? 'CANCEL' : item.name.toUpperCase()));
              if (!item.cancel) b.append(el('span', 'm-qty', `x${item.qty}`));
            },
          });
          const chosen = rows[at];
          const desc = el('div', 'm-desc');
          if (chosen && !chosen.cancel) {
            const img = el('img');
            img.src = chosen.sprite;
            img.alt = '';
            img.onerror = () => img.remove();
            desc.append(img, el('p', null, chosen.desc || ''));
          } else {
            desc.append(el('p', null, inBattle ? 'Close the bag.' : 'Close the bag. Use items with .useitem on Discord.'));
          }
          page.append(head, box, desc);
          root.append(page);
        },
        key(k) {
          const rows = items();
          if (k === 'b') return inBattle ? close() : pop();
          if (k === 'left' || k === 'right') {
            pocket = (pocket + (k === 'left' ? -1 : 1) + pockets.length) % pockets.length;
            at = 0;
          } else if (k === 'a') {
            if (rows[at].cancel) return inBattle ? close() : pop();
            return message([inBattle ? "There's a time and place for everything! But not now." : `Use ${rows[at].name} with .useitem on Discord for now.`]);
          } else at = step(at, k, rows.length);
          redraw();
        },
      });
      if (inBattle) return waitClose();
      return undefined;
    }

    // -----------------------------------------------------------------------
    // The trainer card (.me)
    // -----------------------------------------------------------------------

    async function trainerCard() {
      const t = await hooks.get('/api/trainer');
      push({
        draw() {
          const card = el('div', 'm-page m-card');
          card.append(el('p', 'm-card-title', 'TRAINER CARD'));
          const rows = [
            ['NAME', hooks.name()],
            ['TRAINER LV', `${t.level}${t.prestige ? `  (PRESTIGE ${t.prestige})` : ''}`],
            ['TRAINER EXP', `${fmt(t.exp)} / ${fmt(t.needed)}`],
            ['OBEDIENCE', `up to Lv${t.cap}`],
            ['MILESTONES', `${t.milestones} / ${t.totalMilestones}`],
            ['NEXT', t.next ? `${t.next}${t.pending ? ' (READY!)' : ''}` : 'All beaten'],
            ['COINS', fmt(t.coins)],
            ['GOLD', fmt(t.gold)],
            ['CAUGHT', fmt(t.caught)],
          ];
          const grid = el('div', 'm-stats m-card-grid');
          for (const [k, v] of rows) grid.append(el('span', null, k), el('b', null, v));
          const bar = el('div', 'm-expbar');
          const fill = el('div');
          fill.style.width = `${Math.min(100, (t.exp / Math.max(1, t.needed)) * 100)}%`;
          bar.append(fill);
          card.append(grid, bar);
          card.addEventListener('click', () => pop());
          root.append(card);
        },
        key(k) {
          if (k === 'a' || k === 'b') pop();
        },
      });
    }

    // -----------------------------------------------------------------------
    // The MART
    // -----------------------------------------------------------------------

    async function shop() {
      show();
      // The stock loads while the clerk says hello.
      const loading = hooks.get('/api/shop');
      await message(['Welcome! How may I serve you?']);
      let data = await loading;
      const money = () => `COINS ${fmt(data.coins)}   GOLD ${fmt(data.gold)}`;
      let section = 0;
      push({
        draw() {
          const page = el('div', 'm-page m-shop');
          page.append(el('div', 'm-money', money()));
          const sections = [...data.sections.map((s) => ({ label: s.name.toUpperCase() })), { label: 'QUIT' }];
          page.append(list(sections, section, { className: 'm-shop-sections', onPick: (i) => { section = i; this.key('a'); } }));
          page.append(el('div', 'm-desc', null));
          page.lastChild.append(el('p', null, section < data.sections.length ? `${data.sections[section].items.length} items. A to look.` : 'See you again!'));
          root.append(page);
        },
        key(k) {
          if (k === 'b') return leave();
          if (k === 'a') {
            if (section >= data.sections.length) return leave();
            return items(data.sections[section]);
          }
          section = step(section, k, data.sections.length + 1);
          redraw();
        },
      });

      async function leave() {
        stack.length = 0;
        await message(['Please come again!']);
        close();
      }

      function items(sec) {
        let at = 0;
        const unit = sec.currency === 'gold' ? 'gold' : 'coins';
        push({
          draw() {
            const page = el('div', 'm-page m-shop');
            page.append(el('div', 'm-money', money()));
            const rows = [...sec.items, { name: 'CANCEL', cancel: true }];
            page.append(list(rows, at, {
              className: 'm-shop-items',
              onPick: (i) => { at = i; this.key('a'); },
              render: (b, item) => {
                b.append(el('span', null, item.cancel ? 'CANCEL' : item.name.toUpperCase()));
                if (!item.cancel) b.append(el('span', 'm-qty', `${fmt(item.price)}${sec.currency === 'gold' ? 'g' : ''}`));
              },
            }));
            const chosen = rows[at];
            const desc = el('div', 'm-desc');
            if (!chosen.cancel) {
              if (chosen.sprite) {
                const img = el('img');
                img.src = chosen.sprite;
                img.alt = '';
                img.onerror = () => img.remove();
                desc.append(img);
              }
              desc.append(el('p', null, chosen.desc || ''));
            } else desc.append(el('p', null, 'Back to the counter.'));
            page.append(desc);
            root.append(page);
          },
          async key(k) {
            const rows = [...sec.items, { cancel: true }];
            if (k === 'b') return pop();
            if (k === 'a') {
              if (rows[at].cancel) return pop();
              return quantity(sec, rows[at], unit);
            }
            at = step(at, k, rows.length);
            redraw();
          },
        });
      }

      function quantity(sec, item, unit) {
        let qty = 1;
        const max = sec.currency === 'gold' ? 1 : 99;
        push({
          overlay: true,
          draw() {
            const box = el('div', 'm-qtybox');
            box.append(el('span', null, `x${String(qty).padStart(2, '0')}`), el('b', null, `${fmt(item.price * qty)} ${unit}`));
            const up = el('button', 'm-arrow', '▲');
            const down = el('button', 'm-arrow', '▼');
            up.type = down.type = 'button';
            up.addEventListener('click', () => this.key('up'));
            down.addEventListener('click', () => this.key('down'));
            const ok = el('button', 'm-item on', 'OK');
            ok.type = 'button';
            ok.addEventListener('click', () => this.key('a'));
            box.append(up, down, ok);
            root.append(box);
          },
          async key(k) {
            if (k === 'b') return pop();
            if (k === 'up') qty = Math.min(max, qty + 1);
            if (k === 'down') qty = Math.max(1, qty - 1);
            if (k === 'right') qty = Math.min(max, qty + 10);
            if (k === 'left') qty = Math.max(1, qty - 10);
            if (k === 'a') {
              pop();
              const name = item.name.toUpperCase();
              const yes = await confirm(`${name}${qty > 1 ? `, and you want ${qty}` : '? Certainly'}. That will be ${fmt(item.price * qty)} ${unit}. OK?`);
              if (!yes) return;
              const r = await hooks.post('/api/shop', { id: item.id, qty });
              data = { ...data, coins: r.coins, gold: r.gold };
              redraw();
              await message([r.ok ? 'Here you are! Thank you!' : r.text]);
              return;
            }
            redraw();
          },
        });
      }
      return waitClose();
    }

    function input(key) {
      if (!open) return false;
      const screen = top();
      if (screen) screen.key(key);
      return true;
    }

    /** A question on its own (MOM, the receptionist): resolves true for YES. */
    async function ask(question) {
      show();
      const yes = await confirm(question);
      close();
      return yes;
    }

    return {
      pause,
      shop,
      ask,
      map: () => townMap(true),
      bag: () => bag(true),
      input,
      close,
      get open() {
        return open;
      },
    };
  }

  window.MenuScreen = { create };
})();
