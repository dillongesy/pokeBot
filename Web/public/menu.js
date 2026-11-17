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

    const STOP_COLORS = { town: '#f8f8f8', reward: '#f8c838', boss: '#e86040', landmark: '#b890f8' };
    const GATE_FILLS = ['#4c8c48', '#c8b070', '#2e7a52', '#7a6a5a', '#b88848', '#3868a0', '#9ab0c4', '#c8d4e0'];

    async function townMap(alone = false) {
      if (alone) show();
      const data = await hooks.get('/api/townmap');
      // Everywhere you've been, in a ring you can step through.
      const places = [
        ...data.intro.filter((p) => p.visited).map((p) => ({ ...p })),
        ...(data.city.visited ? [data.city] : []),
        ...data.gates.flatMap((g) => g.stops.flatMap((s) => [s.route, s.stop]).filter((p) => p.visited)),
      ];
      let at = Math.max(0, places.findIndex((p) => p.id === data.here));
      const blink = setInterval(() => redraw(), 500);
      push({
        draw() {
          const page = el('div', 'm-page m-map');
          const canvas = el('canvas', 'm-map-canvas');
          canvas.width = 480;
          canvas.height = 300;
          const g = canvas.getContext('2d');
          g.fillStyle = '#16314a';
          g.fillRect(0, 0, 480, 300);
          const cx = 240;
          const cy = 135;
          const spots = {};
          // Gates: wedges of land, routes as a winding line, stops as dots.
          data.gates.forEach((gate, gi) => {
            const a = ((-90 + 22.5 + 45 * gi) * Math.PI) / 180;
            g.fillStyle = GATE_FILLS[gi % GATE_FILLS.length];
            g.beginPath();
            g.moveTo(cx, cy);
            g.arc(cx, cy, 128, a - 0.36, a + 0.36);
            g.closePath();
            g.fill();
            let prev = { x: cx + Math.cos(a) * 26, y: cy + Math.sin(a) * 26 };
            gate.stops.forEach((s, i) => {
              const r = 34 + i * 9.5;
              const wob = (i % 2 ? 1 : -1) * 0.1;
              const p = { x: cx + Math.cos(a + wob) * r, y: cy + Math.sin(a + wob) * r };
              g.strokeStyle = s.route.visited ? '#f3e2b4' : 'rgba(243,226,180,.35)';
              g.lineWidth = 2;
              g.beginPath();
              g.moveTo(prev.x, prev.y);
              g.lineTo(p.x, p.y);
              g.stroke();
              spots[s.route.id] = { x: (prev.x + p.x) / 2, y: (prev.y + p.y) / 2 };
              spots[s.stop.id] = p;
              g.fillStyle = s.stop.visited ? STOP_COLORS[s.stop.kind] || '#fff' : 'rgba(255,255,255,.25)';
              g.fillRect(p.x - 2, p.y - 2, 4, 4);
              prev = p;
            });
            const lp = { x: cx + Math.cos(a) * 140, y: cy + Math.sin(a) * 140 };
            g.fillStyle = '#fff';
            g.font = '9px monospace';
            g.textAlign = 'center';
            g.fillText(`G${gate.number}`, lp.x, lp.y + 3);
          });
          // The way in, from the south.
          const south = Math.PI / 2;
          const intro = data.intro.slice().reverse();
          intro.forEach((p, i) => {
            const r = 40 + i * 22;
            spots[p.id] = { x: cx + Math.cos(south) * r, y: cy + Math.sin(south) * r };
          });
          g.strokeStyle = '#f3e2b4';
          g.setLineDash([2, 3]);
          g.beginPath();
          g.moveTo(cx, cy + 26);
          g.lineTo(spots['town-1'].x, spots['town-1'].y);
          g.stroke();
          g.setLineDash([]);
          for (const p of data.intro) {
            const s = spots[p.id];
            g.fillStyle = p.visited ? '#f8f8f8' : 'rgba(255,255,255,.3)';
            if (/^town/.test(p.id)) g.fillRect(s.x - 3, s.y - 3, 6, 6);
          }
          // The city.
          spots['main-city'] = { x: cx, y: cy };
          g.fillStyle = '#4b5568';
          g.beginPath();
          g.arc(cx, cy, 24, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = '#f2c14e';
          g.fillRect(cx - 3, cy - 10, 6, 16);
          // You are here, blinking.
          const me = spots[data.here];
          if (me && Math.floor(Date.now() / 500) % 2) {
            g.strokeStyle = '#ff3030';
            g.lineWidth = 2;
            g.strokeRect(me.x - 5, me.y - 5, 10, 10);
          }
          // The place under the cursor.
          const chosen = places[at];
          if (chosen && spots[chosen.id]) {
            const c = spots[chosen.id];
            g.strokeStyle = '#ffffff';
            g.lineWidth = 1;
            g.strokeRect(c.x - 7, c.y - 7, 14, 14);
          }
          page.append(canvas);
          const label = el('div', 'm-desc');
          const hereName = (places.find((p) => p.id === data.here) || {}).name || data.here;
          label.append(el('p', null, chosen ? `${chosen.name.toUpperCase()}${chosen.id === data.here ? '  (you are here)' : ''}` : `You are in ${String(hereName).toUpperCase()}.`));
          page.append(label);
          root.append(page);
        },
        key(k) {
          if (k === 'a' || k === 'b') {
            clearInterval(blink);
            if (alone) return close();
            return pop();
          }
          if (places.length) {
            if (k === 'right' || k === 'down') at = (at + 1) % places.length;
            if (k === 'left' || k === 'up') at = (at - 1 + places.length) % places.length;
          }
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
      const items = () => {
        const d = state();
        return [
          { label: `EXPLORE     ${d.exploring ? 'ON' : 'OFF'}`, go: () => hooks.dev.run('explore', !d.exploring) },
          { label: `NOCLIP      ${d.noclip ? 'ON' : 'OFF'}`, go: () => hooks.dev.run('noclip', !d.noclip) },
          { label: `OVERLAY     ${d.overlay ? 'ON' : 'OFF'}`, go: () => hooks.dev.run('overlay', !d.overlay) },
          { label: `SPEED       x${hooks.dev.speed()}`, go: () => hooks.dev.speed(hooks.dev.speed() >= 4 ? 1 : hooks.dev.speed() * 2) },
          { label: 'WARP...', go: () => warp() },
          { label: 'ALL OFF', go: () => hooks.dev.run('off') },
          { label: 'CLOSE', go: () => pop() },
        ];
      };
      push({
        draw() {
          const box = list(items(), at, { className: 'm-dev', onPick: (i) => { at = i; this.key('a'); } });
          root.append(box, el('p', 'm-dev-note', 'DEV TOOLS: nothing done while exploring is saved or counts.'));
        },
        async key(k) {
          const all = items();
          if (k === 'b') return pop();
          if (k === 'a') {
            await all[at].go();
            return redraw();
          }
          at = step(at, k, all.length);
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
