'use strict';

/**
 * The opening, drawn over the game screen: Professor A's welcome, choosing
 * how you look, then the lab and a starter from any region.
 *
 * The server decides whether it's needed and hands the starter over (once per
 * prestige; see Web/intro.js). This only shows it.
 *
 * The outfit picker is also used on its own (the wardrobe at home).
 *
 * Controls: arrows move, Z / Enter / Space is A, X / Backspace is B.
 */

(function () {
  const CHARACTERS = '/sprites/tuxemon/characters';
  const TYPE_MS = 22;
  const GRID_COLS = 8;

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  /** "cooldude_blue" -> "Cooldude Blue". */
  const outfitName = (name) => name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  /**
   * A character sprite (16x32 frames, 3 across, rows down/left/right/up),
   * one frame, scaled with crisp pixels.
   */
  function figure(sprite, className) {
    const node = el('div', `i-figure ${className || ''}`);
    node.style.backgroundImage = `url(${CHARACTERS}/${sprite}.png)`;
    return node;
  }
  const FACINGS = ['down', 'left', 'up', 'right'];
  const ROW = { down: 0, left: 1, right: 2, up: 3 };
  function pose(node, facing, column = 1) {
    node.style.backgroundPosition = `${column * 50}% ${(ROW[facing] / 3) * 100}%`;
  }

  /**
   * @param {HTMLElement} root  an empty element covering the game screen
   * @param {object} hooks
   * @param {(path: string, body: object) => Promise<object>} hooks.post
   * @param {() => string} hooks.name  the player's name
   */
  function create(root, hooks) {
    root.classList.add('iscreen');
    root.hidden = true;

    const stage = el('div', 'i-stage');
    const box = el('div', 'i-text');
    const text = el('p');
    const more = el('span', 'i-more', '▼');
    box.append(text, more);
    const choices = el('div', 'i-choices');
    root.append(stage, box, choices);

    let open = false;
    let typing = null;
    /** Pictures of the real rooms (the lab, AIDE's house), loaded once. */
    const rooms = {};
    const pictures = new Map();
    function picture(src) {
      if (!pictures.has(src)) {
        pictures.set(src, new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => resolve(null);
          img.src = src;
        }));
      }
      return pictures.get(src);
    }

    /**
     * A room, drawn exactly as walking around in it looks: real scale,
     * centred on `focus`, dark round the edges where the room ends, with
     * everyone standing where they are.
     *
     * @param {'lab'|'rival'} kind
     * @param {{x,y}} focus   the tile in the middle of the view
     * @param {Array<{sprite,x,y,facing}>} cast
     */
    async function roomScene(kind, focus, cast) {
      if (!rooms[kind] && hooks.scene) rooms[kind] = await hooks.scene(kind);
      const room = rooms[kind];
      const w = 240;
      const h = Math.max(80, Math.round((240 * stage.clientHeight) / Math.max(1, stage.clientWidth)));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const g = canvas.getContext('2d');
      g.imageSmoothingEnabled = false;
      g.fillStyle = '#000';
      g.fillRect(0, 0, w, h);
      const camX = focus.x * 16 + 8 - w / 2;
      const camY = focus.y * 16 + 8 - h / 2;
      if (room) g.drawImage(room, -camX, -camY);
      for (const who of [...cast].sort((a, b) => a.y - b.y)) {
        const img = await picture(`${CHARACTERS}/${who.sprite}.png`);
        if (img) g.drawImage(img, 16, ROW[who.facing] * 32, 16, 32, who.x * 16 - camX, who.y * 16 - 16 - camY, 16, 32);
      }
      stage.className = 'i-stage room';
      stage.style.backgroundImage = `url(${canvas.toDataURL()})`;
      stage.replaceChildren();
    }
    /** The current step's key handler and its "A when the text is done". */
    let onKey = null;
    let onDone = null;

    // -----------------------------------------------------------------------
    // Text
    // -----------------------------------------------------------------------

    /** Show lines one at a time (A for the next); resolves after the last. */
    function say(lines) {
      return new Promise((resolve) => {
        const queue = [...lines];
        const nextLine = () => {
          const line = queue.shift();
          if (line == null) {
            onDone = null;
            resolve();
            return;
          }
          type(line, () => {
            more.hidden = false;
            onDone = nextLine;
          });
        };
        choices.replaceChildren();
        choices.hidden = true;
        nextLine();
      });
    }

    function type(line, then) {
      clearInterval(typing && typing.timer);
      more.hidden = true;
      onDone = null;
      typing = { line, shown: 0, then, timer: null };
      text.textContent = '';
      typing.timer = setInterval(() => {
        typing.shown += 1;
        text.textContent = line.slice(0, typing.shown);
        if (typing.shown >= line.length) finishTyping();
      }, TYPE_MS);
    }

    function finishTyping() {
      if (!typing || typing.finished) return;
      clearInterval(typing.timer);
      typing.finished = true;
      text.textContent = typing.line;
      typing.then();
    }

    /** A YES / NO (or any) menu under the text; resolves with the index. */
    function ask(question, options = ['YES', 'NO']) {
      return new Promise((resolve) => {
        type(question, () => {
          let at = 0;
          const draw = () => {
            choices.replaceChildren(...options.map((o, i) => {
              const b = el('button', `i-choice${i === at ? ' on' : ''}`, o);
              b.type = 'button';
              b.addEventListener('click', () => pick(i));
              return b;
            }));
          };
          const pick = (i) => {
            onKey = null;
            choices.hidden = true;
            resolve(i);
          };
          choices.hidden = false;
          draw();
          onKey = (key) => {
            if (key === 'up' || key === 'left') at = Math.max(0, at - 1);
            if (key === 'down' || key === 'right') at = Math.min(options.length - 1, at + 1);
            if (key === 'a') return pick(at);
            if (key === 'b') return pick(options.length - 1);
            draw();
          };
        });
      });
    }

    // -----------------------------------------------------------------------
    // Scenes
    // -----------------------------------------------------------------------

    function professorScene() {
      stage.className = 'i-stage dark';
      stage.style.backgroundImage = '';
      const prof = figure('professor', 'big');
      pose(prof, 'down');
      stage.replaceChildren(prof);
    }

    /** Choose how you look. Resolves with the outfit's name. */
    function wardrobe(outfits, current) {
      return new Promise((resolve) => {
        let at = Math.max(0, outfits.indexOf(current));
        stage.className = 'i-stage wardrobe';
        const preview = figure(outfits[at], 'big');
        const label = el('p', 'i-outfit-name');
        const grid = el('div', 'i-grid');
        const cells = outfits.map((name, i) => {
          const cell = el('button', 'i-cell');
          cell.type = 'button';
          cell.title = outfitName(name);
          const f = figure(name, 'small');
          pose(f, 'down');
          cell.append(f);
          cell.addEventListener('click', () => {
            at = i;
            draw();
          });
          cell.addEventListener('dblclick', () => confirm());
          return cell;
        });
        grid.append(...cells);
        const prev = el('button', 'i-arrow', '◀');
        const next = el('button', 'i-arrow', '▶');
        prev.type = next.type = 'button';
        prev.addEventListener('click', () => { at = (at - 1 + outfits.length) % outfits.length; draw(); });
        next.addEventListener('click', () => { at = (at + 1) % outfits.length; draw(); });
        const pick = el('div', 'i-pick');
        pick.append(prev, preview, next);
        const left = el('div', 'i-wardrobe-left');
        left.append(pick, label);
        stage.replaceChildren(left, grid);

        let spin = 0;
        const spinner = setInterval(() => {
          spin = (spin + 1) % FACINGS.length;
          pose(preview, FACINGS[spin]);
        }, 650);

        function draw() {
          preview.style.backgroundImage = `url(${CHARACTERS}/${outfits[at]}.png)`;
          pose(preview, FACINGS[spin]);
          label.textContent = `${outfitName(outfits[at])}  (${at + 1}/${outfits.length})`;
          cells.forEach((c, i) => c.classList.toggle('on', i === at));
          cells[at].scrollIntoView({ block: 'nearest' });
        }

        async function confirm() {
          onKey = null;
          const yes = (await ask('So this is what you look like?')) === 0;
          if (yes) {
            clearInterval(spinner);
            resolve(outfits[at]);
          } else {
            text.textContent = 'Choose how you look.';
            onKey = keys;
          }
        }

        function keys(key) {
          const step = { left: -1, right: 1, up: -GRID_COLS, down: GRID_COLS }[key];
          if (step) at = (at + step + outfits.length) % outfits.length;
          if (key === 'a') return confirm();
          draw();
        }

        type('Choose how you look.', () => {});
        draw();
        onKey = keys;
      });
    }

    /** The lab's table: every region's starters. Resolves with the chosen one. */
    function lab(regions) {
      return new Promise((resolve) => {
        const all = regions.flatMap((r) => r.starters.map((s) => ({ ...s, region: r.region })));
        let at = 0;
        // Over the lab as it is: the room stays behind the table.
        stage.classList.add('choosing');
        const show = el('div', 'i-show');
        const big = el('img', 'i-mon');
        big.alt = '';
        const label = el('p', 'i-mon-name');
        show.append(big, label);
        const table = el('div', 'i-table');
        const cells = [];
        for (const r of regions) {
          const row = el('div', 'i-region');
          row.append(el('span', 'i-region-name', r.region.toUpperCase()));
          for (const s of r.starters) {
            const i = cells.length;
            const cell = el('button', 'i-ball');
            cell.type = 'button';
            const img = el('img');
            img.src = s.sprite || '';
            img.alt = s.name;
            cell.append(img);
            cell.addEventListener('click', () => {
              if (at === i) choose();
              at = i;
              draw();
            });
            cells.push(cell);
            row.append(cell);
          }
          table.append(row);
        }
        stage.replaceChildren(show, table);

        function draw() {
          const s = all[at];
          big.src = s.sprite || '';
          label.textContent = `${s.name.toUpperCase()} · ${s.types.map((t) => t.toUpperCase()).join('/')} · ${s.region.toUpperCase()}`;
          cells.forEach((c, i) => c.classList.toggle('on', i === at));
          cells[at].scrollIntoView({ block: 'nearest' });
        }

        async function choose() {
          onKey = null;
          const s = all[at];
          const type1 = (s.types[0] || 'normal').toUpperCase();
          const yes = (await ask(`So, you want ${s.name.toUpperCase()}, the ${type1}-type POKéMON?`)) === 0;
          if (yes) {
            stage.classList.remove('choosing');
            resolve(s);
          }
          else {
            text.textContent = 'Choose a POKéMON.';
            onKey = keys;
          }
        }

        function keys(key) {
          const step = { left: -1, right: 1, up: -3, down: 3 }[key];
          if (step) at = Math.max(0, Math.min(all.length - 1, at + step));
          if (key === 'a') return choose();
          draw();
        }

        type('Choose a POKéMON.', () => {});
        draw();
        onKey = keys;
      });
    }

    // -----------------------------------------------------------------------
    // The whole opening
    // -----------------------------------------------------------------------

    async function play(data, current) {
      show();
      const name = hooks.name().toUpperCase();
      const RIVAL = 'AIDE';
      const RIVAL_LOOK = 'cooldude_red';
      professorScene();
      await say([
        'Hello there! Welcome to the world of POKéMON!',
        'My name is A. People call me the POKéMON PROF!',
        'This world is inhabited by creatures called POKéMON!',
        'For some people, POKéMON are pets. Others use them for battles.',
        'But first, tell me a little about yourself.',
      ]);
      const outfit = await wardrobe(data.outfits, current);
      await hooks.post('/api/intro', { action: 'outfit', outfit });
      professorScene();
      const me = figure(outfit, 'big me');
      pose(me, 'down');
      stage.append(me);
      await say([
        `Right! So your name is ${name}!`,
        `${name}, my son ${RIVAL} lives right next door to you. He has been waiting all morning!`,
        "Let's go and get him first.",
      ]);

      // AIDE's house: PROF. A's family home.
      await roomScene('rival', { x: 5, y: 3 }, [
        { sprite: RIVAL_LOOK, x: 4, y: 4, facing: 'right' },
        { sprite: 'professor', x: 6, y: 5, facing: 'up' },
        { sprite: outfit, x: 7, y: 5, facing: 'up' },
      ]);
      await say([
        `${RIVAL}: Dad! Is this the new trainer?`,
        `${RIVAL}: So you're ${name}. I'm ${RIVAL}. Today we BOTH get our first POKéMON!`,
        `${RIVAL}: Race you to the lab!`,
      ]);

      // The lab.
      const labCast = (rivalFacing = 'up') => [
        { sprite: 'professor', x: 10, y: 6, facing: 'down' },
        { sprite: outfit, x: 9, y: 9, facing: 'up' },
        { sprite: RIVAL_LOOK, x: 11, y: 9, facing: rivalFacing },
      ];
      await roomScene('lab', { x: 10, y: 7 }, labCast());
      await say([
        'PROF. A: Here we are. These POKéMON come from every region there is.',
        `PROF. A: Each of them is LV${data.level}. ${name}, you choose first!`,
      ]);
      for (;;) {
        const chosen = await lab(data.regions);
        const result = await hooks.post('/api/intro', { action: 'starter', species: chosen.species });
        await roomScene('lab', { x: 10, y: 7 }, labCast());
        if (result.ok) {
          const got = el('img', 'i-mon got');
          got.src = chosen.sprite || '';
          got.alt = '';
          stage.append(got);
          await say([`${name} received the ${result.pokemon.name.toUpperCase()} from PROF. A!`]);
          if (result.rival) {
            await roomScene('lab', { x: 10, y: 7 }, labCast('left'));
            const his = el('img', 'i-mon got rival');
            his.src = result.rival.sprite || '';
            his.alt = '';
            stage.append(his);
            const mine = (chosen.types[0] || 'normal').toUpperCase();
            const theirs = (result.rival.types[0] || 'normal').toUpperCase();
            await say([
              `${RIVAL}: Then I'll take this one!`,
              `${RIVAL} received the ${result.rival.name.toUpperCase()} from PROF. A!`,
              `${RIVAL}: Heh. ${theirs} beats ${mine}! You'll need more than that to keep up with me.`,
              `${RIVAL}: I'll be waiting for you out past the gates of the MAIN CITY. Every single one. Don't fall behind!`,
            ]);
          }
          break;
        }
        if (result.reason === 'already') {
          await say(["Oh? It looks like you've already been given a POKéMON."]);
          break;
        }
        await say(["Hmm, that didn't work. Let's try again."]);
      }
      await roomScene('lab', { x: 10, y: 7 }, labCast('up'));
      await say([
        `PROF. A: ${name}! Your very own POKéMON legend is about to unfold!`,
        "PROF. A: A world of dreams and adventures with POKéMON awaits! Let's go!",
      ]);
      hide();
    }

    /** Just the wardrobe (at home). Resolves with the outfit, or null. */
    async function changeOutfit(outfits, current) {
      show();
      const outfit = await wardrobe(outfits, current);
      await hooks.post('/api/intro', { action: 'outfit', outfit });
      hide();
      return outfit;
    }

    function show() {
      open = true;
      root.hidden = false;
      choices.hidden = true;
    }

    function hide() {
      open = false;
      root.hidden = true;
      clearInterval(typing && typing.timer);
      onKey = null;
      onDone = null;
    }

    function input(key) {
      if (!open) return false;
      if (typing && !typing.finished && key === 'a') {
        finishTyping();
        return true;
      }
      if (onKey) {
        onKey(key);
        return true;
      }
      if (key === 'a' && onDone) onDone();
      return true;
    }

    root.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      input('a');
    });

    return {
      play,
      changeOutfit,
      input,
      get open() {
        return open;
      },
    };
  }

  window.IntroScreen = { create };
})();
