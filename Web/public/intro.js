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
              b.addEventListener('mouseenter', () => {
                if (at === i) return;
                at = i;
                draw();
              });
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
              at = i;
              draw();
              choose();
            });
            // Pointing at a starter shows it.
            cell.addEventListener('mouseenter', () => {
              if (at === i || !onKey) return;
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
          label.textContent = `${s.name}\n${s.region}`;
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

    /**
     * The professor's welcome and choosing how you look (the rest of the
     * opening is played out in the world: app.js). Resolves with the outfit.
     */
    async function welcome(data, current) {
      root.classList.remove('over');
      show();
      const name = hooks.name().toUpperCase();
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
        `${name}! Today is the day you get your very own POKéMON.`,
        "Come and find me outside. I'll be waiting!",
      ]);
      hide();
      return outfit;
    }

    /**
     * The lab's table, over the lab itself. Resolves with the one chosen and
     * the server's answer ({ok, pokemon, rival} or {ok: false, reason}).
     */
    async function pickStarter(data) {
      root.classList.add('over');
      show();
      stage.className = 'i-stage live';
      stage.style.backgroundImage = '';
      stage.replaceChildren();
      for (;;) {
        const chosen = await lab(data.regions);
        const result = await hooks.post('/api/intro', { action: 'starter', species: chosen.species });
        if (result.ok || result.reason === 'already') {
          hide();
          root.classList.remove('over');
          return { chosen, result };
        }
        await say(["Hmm, that didn't work. Let's try again."]);
      }
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
      welcome,
      pickStarter,
      changeOutfit,
      input,
      get open() {
        return open;
      },
    };
  }

  window.IntroScreen = { create };
})();
