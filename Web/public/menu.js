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
    // middle, the eight gates as wedges of land with their routes and stops,
    // and the way in from TOWN 1, due south.
    const GATE_FILL = ['#2f6b35', '#a48a52', '#1f5a3c', '#5e5246', '#9a6c2e', '#235684', '#7d93a8', '#aab8c8'];
    const SVGNS = 'http://www.w3.org/2000/svg';
    const svgEl = (tag, attrs, parent) => {
      const e = document.createElementNS(SVGNS, tag);
      for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
      if (parent) parent.appendChild(e);
      return e;
    };
    const STOP_WORDS = { town: 'TOWN', reward: 'POINT OF INTEREST', boss: 'BOSS TRAINER', landmark: 'LANDMARK' };

    /** The map as SVG, plus where each place is on it (for the cursor and "you are here"). */
    function drawWorld(data) {
      const C = { x: 500, y: 455 };
      const CITY_R = 78;
      const RING_IN = 104;
      const STEP = 34.5;
      const gateAngle = (g) => ((-90 + 22.5 + 45 * g) * Math.PI) / 180;
      const at = (r, a) => ({ x: C.x + r * Math.cos(a), y: C.y + r * Math.sin(a) });
      const sector = (r0, r1, a0, a1) => {
        const A = at(r0, a0), B = at(r1, a0), D = at(r1, a1), E = at(r0, a1);
        return `M${A.x},${A.y} L${B.x},${B.y} A${r1},${r1} 0 0 1 ${D.x},${D.y} L${E.x},${E.y} A${r0},${r0} 0 0 0 ${A.x},${A.y}Z`;
      };
      const svg = svgEl('svg', { viewBox: '0 0 1000 1000', class: 'm-world' });
      const spots = {};
      svgEl('rect', { x: 0, y: 0, width: 1000, height: 1000, fill: '#16314a' }, svg);
      for (let i = 40; i < 1000; i += 40) {
        svgEl('line', { x1: i, y1: 0, x2: i, y2: 1000, stroke: '#1b3a56', 'stroke-width': 1 }, svg);
        svgEl('line', { x1: 0, y1: i, x2: 1000, y2: i, stroke: '#1b3a56', 'stroke-width': 1 }, svg);
      }
      const half = (21 * Math.PI) / 180;
      data.gates.forEach((gate, g) => {
        const a = gateAngle(g);
        svgEl('path', { d: sector(CITY_R + 4, RING_IN + STEP * gate.stops.length + 40, a - half, a + half), fill: GATE_FILL[g % 8], stroke: '#0e1420', 'stroke-width': 3 }, svg);
      });
      const south = Math.PI / 2;
      svgEl('path', { d: sector(CITY_R + 4, 480, south - 0.2, south + 0.2), fill: '#3f7f46', stroke: '#0e1420', 'stroke-width': 3 }, svg);

      data.gates.forEach((gate, g) => {
        const a = gateAngle(g);
        let prev = at(CITY_R, a);
        gate.stops.forEach(({ route, stop }, i) => {
          const n = Number(route.id.split('-')[1]);
          const wobble = (i % 2 ? 1 : -1) * 0.12 * (0.6 + ((n * 37) % 10) / 25);
          const p = at(RING_IN + STEP * (i + 1), a + wobble);
          svgEl('line', { x1: prev.x, y1: prev.y, x2: p.x, y2: p.y, stroke: route.visited ? '#f3e2b4' : '#c9bb94', 'stroke-width': 5, 'stroke-linecap': 'round', opacity: route.visited ? 1 : 0.55 }, svg);
          const mid = { x: (prev.x + p.x) / 2, y: (prev.y + p.y) / 2 };
          if (route.hidden) {
            const nx = -(p.y - prev.y), ny = p.x - prev.x, len = Math.hypot(nx, ny) || 1;
            svgEl('circle', { cx: mid.x + (11 * nx) / len, cy: mid.y + (11 * ny) / len, r: 3.4, fill: '#eef1f6', stroke: '#d6453d', 'stroke-width': 2 }, svg);
          }
          spots[route.id] = mid;
          prev = p;
          const k = stop.kind;
          const dim = stop.visited ? 1 : 0.6;
          if (k === 'town') svgEl('rect', { x: p.x - 7, y: p.y - 7, width: 14, height: 14, rx: 2, fill: '#eef1f6', stroke: '#0e1420', 'stroke-width': 2, opacity: dim }, svg);
          else if (k === 'boss') svgEl('path', { d: `M${p.x} ${p.y - 8} L${p.x + 8} ${p.y} L${p.x} ${p.y + 8} L${p.x - 8} ${p.y}Z`, fill: '#e2603a', stroke: '#0e1420', 'stroke-width': 2, opacity: dim }, svg);
          else if (k === 'landmark') svgEl('circle', { cx: p.x, cy: p.y, r: 9, fill: '#b48cf2', stroke: '#0e1420', 'stroke-width': 2, opacity: dim }, svg);
          else svgEl('circle', { cx: p.x, cy: p.y, r: 6, fill: '#f2c14e', stroke: '#0e1420', 'stroke-width': 2, opacity: dim }, svg);
          spots[stop.id] = p;
        });
        const lp = at(RING_IN + STEP * gate.stops.length + 22, a);
        svgEl('rect', { x: lp.x - 56, y: lp.y - 11, width: 112, height: 22, rx: 4, fill: '#0e1420', stroke: GATE_FILL[g % 8], 'stroke-width': 2 }, svg);
        const first = gate.stops[0].route.id.split('-')[1];
        const last = gate.stops[gate.stops.length - 1].route.id.split('-')[1];
        svgEl('text', { x: lp.x, y: lp.y + 4.5, 'text-anchor': 'middle', 'font-size': 12, fill: '#eef1f6' }, svg).textContent = `GATE ${gate.number} · ${first}-${last}`;
      });

      // TOWN 1 -> PATH A -> TOWN 2 -> PATH B -> MAIN CITY, south to north.
      const t1 = at(450, south), pa = at(360, south), t2 = at(265, south), pb = at(170, south);
      svgEl('line', { x1: t1.x, y1: t1.y, x2: C.x, y2: C.y + CITY_R, stroke: '#f3e2b4', 'stroke-width': 5, 'stroke-dasharray': '2 8', 'stroke-linecap': 'round' }, svg);
      const byId = Object.fromEntries(data.intro.map((p) => [p.id, p]));
      [['town-1', t1], ['town-2', t2]].forEach(([id, p]) => {
        svgEl('rect', { x: p.x - 9, y: p.y - 9, width: 18, height: 18, rx: 2, fill: '#eef1f6', stroke: '#0e1420', 'stroke-width': 2 }, svg);
        svgEl('text', { x: p.x - 16, y: p.y + 4, 'text-anchor': 'end', 'font-size': 12, fill: '#eef1f6' }, svg).textContent = (byId[id] ? byId[id].name : id).toUpperCase();
        spots[id] = p;
      });
      [['path-a', pa], ['path-b', pb]].forEach(([id, p]) => {
        const info = byId[id];
        svgEl('text', { x: p.x - 10, y: p.y + 4, 'text-anchor': 'end', 'font-size': 11, fill: '#d6e7cf' }, svg).textContent =
          `${(info ? info.name : id).toUpperCase()}${info && info.levels ? ` · Lv ${info.levels.lo}-${info.levels.hi}` : ''}`;
        spots[id] = p;
      });

      // The MAIN CITY and its BATTLE TOWER.
      svgEl('circle', { cx: C.x, cy: C.y, r: CITY_R, fill: '#4b5568', stroke: '#0e1420', 'stroke-width': 3 }, svg);
      svgEl('circle', { cx: C.x, cy: C.y, r: CITY_R - 16, fill: 'none', stroke: '#6b768c', 'stroke-width': 2, 'stroke-dasharray': '4 5' }, svg);
      svgEl('path', { d: `M${C.x - 14} ${C.y + 22} L${C.x - 9} ${C.y - 26} L${C.x} ${C.y - 38} L${C.x + 9} ${C.y - 26} L${C.x + 14} ${C.y + 22}Z`, fill: '#f2c14e', stroke: '#0e1420', 'stroke-width': 2 }, svg);
      svgEl('text', { x: C.x, y: C.y + 40, 'text-anchor': 'middle', 'font-size': 12, fill: '#eef1f6', 'font-weight': 600 }, svg).textContent = 'MAIN CITY';
      spots['main-city'] = { x: C.x, y: C.y };

      // You are here (blinks, by CSS), and the cursor.
      const me = spots[data.here];
      if (me) {
        svgEl('circle', { cx: me.x, cy: me.y, r: 16, fill: 'none', stroke: '#ff3b30', 'stroke-width': 4, class: 'm-here-ring' }, svg);
        svgEl('circle', { cx: me.x, cy: me.y, r: 6, fill: '#ff3b30', stroke: '#fff', 'stroke-width': 2, class: 'm-here' }, svg);
      }
      const cursor = svgEl('rect', { width: 30, height: 30, rx: 4, fill: 'none', stroke: '#fff', 'stroke-width': 3, 'stroke-dasharray': '7 4', class: 'm-map-cursor' }, svg);
      return { svg, spots, cursor };
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
      const world = drawWorld(data);
      const describe = (p) => {
        if (!p) return ['', ''];
        const here = p.id === data.here ? '  · YOU ARE HERE' : '';
        if (p.kind === 'city') return [`MAIN CITY${here}`, 'The BATTLE TOWER, the DROP STATION and the eight gates.'];
        if (p.kind === 'town' && !p.gate) return [`${p.name.toUpperCase()}${here}`, p.id === 'town-1' ? 'Home: your house and PROF. A\'s lab.' : 'The last stop before the MAIN CITY.'];
        if (p.kind === 'path') return [`${p.name.toUpperCase()}${here}`, p.levels ? `Wild POKéMON Lv ${p.levels.lo}-${p.levels.hi}.` : ''];
        if (p.kind === 'route') {
          return [
            `${p.name.toUpperCase()}${here}`,
            `GATE ${p.gate.number} (${p.gate.region}) · ${p.biome} · Lv ${p.levels.lo}-${p.levels.hi} · then ${p.milestone}${p.hidden ? ' · hidden item' : ''}${p.visited ? '' : ' · not visited'}`,
          ];
        }
        return [`${p.name.toUpperCase()}${here}`, `${STOP_WORDS[p.kind] || 'STOP'} at the end of ${p.after.name}${p.visited ? '' : ' · not visited'}`];
      };
      const place = () => {
        const p = places[at];
        const s = p && world.spots[p.id];
        if (s) {
          world.cursor.setAttribute('x', s.x - 15);
          world.cursor.setAttribute('y', s.y - 15);
        }
        const size = 1000 / zoom;
        const c = s && zoom > 1 ? s : { x: 500, y: 500 };
        const x = Math.max(0, Math.min(1000 - size, c.x - size / 2));
        const y = Math.max(0, Math.min(1000 - size, c.y - size / 2));
        world.svg.setAttribute('viewBox', `${x} ${y} ${size} ${size}`);
      };
      push({
        draw() {
          const page = el('div', 'm-page m-map');
          const frame = el('div', 'm-map-frame');
          frame.append(world.svg);
          const side = el('div', 'm-map-side');
          const [title, text] = describe(places[at]);
          side.append(el('b', 'm-map-title', title), el('p', 'm-map-text', text));
          const keys = el('p', 'm-map-keys', `◀▶ PLACE   A ZOOM ${zoom > 1 ? 'OUT' : 'IN'}   B CLOSE`);
          side.append(keys);
          page.append(frame, side);
          place();
          root.append(page);
        },
        key(k) {
          if (k === 'b') {
            if (alone) return close();
            return pop();
          }
          if (k === 'a') zoom = zoom > 1 ? 1 : 2.6;
          if (k === 'right' || k === 'down') at = (at + 1) % places.length;
          if (k === 'left' || k === 'up') at = (at - 1 + places.length) % places.length;
          redraw();
        },
      });
      if (alone) return waitClose();
      return undefined;
    }

    // -----------------------------------------------------------------------
    // DEV TOOLS (the owner only; the server checks every call)
    // -----------------------------------------------------------------------

    function devTools() {
      let at = 0;
      const WARPS = [
        ['Town 1', 'town-1'], ['Path a', 'path-a'], ['Town 2', 'town-2'], ['Path b', 'path-b'], ['Main City', 'main-city'],
        ['Battle Tower lobby', 'in:main-city:26,25'], ['Route 1', 'route-1'], ['Route 10 (rival)', 'route-10'], ['Route 11', 'route-11'],
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
