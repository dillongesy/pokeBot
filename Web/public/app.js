'use strict';

/**
 * The page around the overworld: login, the live link to the bot, the HUD,
 * signs, and the screens inside each station.
 *
 * The stations show what the bot's own commands post (Web/virtual.js on the
 * server), so a drop card or a battle card here is the same card Discord
 * would get, drawn for the browser. Buttons send the press back to the bot.
 */

(function () {
  const $ = (id) => document.getElementById(id);

  const STATION_NAMES = { drop: 'DROP STATION', battle: 'BATTLE TOWER', fly: 'FLY', mart: 'POKéMON MART' };

  let me = null;
  let world = null;
  const feeds = { drop: [], battle: [], mart: [] };
  let status = { dropReadyIn: 0, inBattle: false, busy: null };
  let statusAt = Date.now();
  let station = null;
  /** How the open station was reached: 'door', or 'encounter' for a battle the world started. */
  let stationFrom = null;
  let dialog = null;

  // -------------------------------------------------------------------------
  // Talking to the bot
  // -------------------------------------------------------------------------

  async function post(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 401) location.reload();
    return res.json().catch(() => ({}));
  }

  function connect() {
    const events = new EventSource('/api/stream');

    events.addEventListener('snapshot', (e) => {
      const data = JSON.parse(e.data);
      feeds.drop = data.stations.drop || [];
      feeds.battle = data.stations.battle || [];
      feeds.mart = data.stations.mart || [];
      setStatus(data.status);
      renderPanel();
      // Reloaded mid-battle: straight back into it.
      const card = lastCard();
      battleSnap = data.battle || null;
      if (data.battle && card && window.BattleScreen.hasLiveButtons(card) && !battleUI.open) openBattle();
    });

    events.addEventListener('update', (e) => {
      const update = JSON.parse(e.data);
      const feed = feeds[update.station];
      if (!feed) return;

      if (update.type === 'message') {
        const at = feed.findIndex((m) => m.id === update.message.id);
        if (at >= 0) feed[at] = update.message;
        else feed.push(update.message);
        while (feed.length > 25) feed.shift();
      } else if (update.type === 'remove') {
        feeds[update.station] = feed.filter((m) => m.id !== update.id);
      } else if (update.type === 'clear') {
        feeds[update.station] = [];
      }
      if (update.station === station) renderPanel();
      if (update.station === 'battle') {
        battleSnap = update.battle || null;
        battleUI.update(feeds.battle, battleSnap);
      }
    });

    // The overworld moved you (a battle ended, you whited out). Its words
    // wait until the battle screen is closed.
    events.addEventListener('world', (e) => {
      const data = JSON.parse(e.data);
      if (world) world.sync(data.player, data.refresh);
      if (data.message) {
        if (battleUI.open) afterBattle.push(data.message);
        else showDialog([data.message]);
      }
    });

    events.addEventListener('status', (e) => {
      setStatus(JSON.parse(e.data));
      if (station) renderFoot();
    });

    events.onopen = () => { $('connection').hidden = true; };
    events.onerror = () => {
      $('connection').hidden = false;
      // Logged out, or the server went away for good: start over.
      if (events.readyState === EventSource.CLOSED) setTimeout(() => location.reload(), 5000);
    };
  }

  function setStatus(next) {
    status = next;
    statusAt = Date.now();
    renderHud();
  }

  const dropWait = () => Math.max(0, status.dropReadyIn - (Date.now() - statusAt));

  function clock(ms) {
    const total = Math.ceil(ms / 1000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  // -------------------------------------------------------------------------
  // HUD
  // -------------------------------------------------------------------------

  function renderHud() {
    const wait = dropWait();
    const pill = $('hud-drop');
    pill.textContent = wait > 0 ? `Drop in ${clock(wait)}` : 'Drop ready';
    pill.classList.toggle('cooling', wait > 0);
    $('hud-battle').hidden = !status.inBattle;
  }

  // Ticks the drop timer between updates from the server.
  let wasWaiting = false;
  setInterval(() => {
    if (!me) return;
    renderHud();
    const waiting = dropWait() > 0;
    if (station === 'drop') {
      const timer = document.querySelector('.panel-head .timer');
      if (timer) timer.textContent = waiting ? `Next drop ${clock(dropWait())}` : 'Drop ready';
      if (waiting !== wasWaiting) renderFoot();
    }
    wasWaiting = waiting;
  }, 250);

  // -------------------------------------------------------------------------
  // Text
  // -------------------------------------------------------------------------

  const escape = (text) =>
    String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  /** The Markdown the bot uses: bold, italics, code, links, mentions. */
  function md(text) {
    let html = escape(text || '');
    const codes = [];
    html = html.replace(/`([^`]+)`/g, (_, code) => {
      codes.push(code);
      return `\u0000${codes.length - 1}\u0000`;
    });
    html = html
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/__(.+?)__/g, '<u>$1</u>')
      .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1<i>$2</i>')
      .replace(/~~(.+?)~~/g, '<s>$1</s>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/&lt;@!?(\d+)&gt;/g, (_, id) => (me && id === me.id ? '<b>@you</b>' : '<b>@someone</b>'))
      .replace(/&lt;a?:(\w+):\d+&gt;/g, ':$1:')
      .replace(/&lt;t:(\d+)(?::\w)?&gt;/g, (_, s) => new Date(Number(s) * 1000).toLocaleString());
    return html.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  const STYLE = { 1: 'btn-primary', 2: 'btn-secondary', 3: 'btn-success', 4: 'btn-danger', 5: 'btn-secondary' };

  function el(tag, className, html) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (html != null) node.innerHTML = html;
    return node;
  }

  /** A message's buttons and menus. Pressing one goes back to the bot. */
  function components(message, where) {
    if (!message.components || !message.components.length) return null;
    const rows = el('div', 'rows');

    for (const row of message.components) {
      const line = el('div', 'row');
      for (const c of row.components || []) {
        if (c.type === 2) {
          if (c.style === 5 && c.url) {
            const a = el('a', 'btn btn-secondary', escape(c.label || 'Open'));
            a.href = c.url;
            a.target = '_blank';
            a.rel = 'noopener';
            line.append(a);
            continue;
          }
          const label = `${c.emoji && c.emoji.name && !c.emoji.id ? `${c.emoji.name} ` : ''}${c.label || ''}`;
          const button = el('button', `btn ${STYLE[c.style] || 'btn-secondary'}`, escape(label || '•'));
          button.disabled = Boolean(c.disabled);
          button.addEventListener('click', () => press(where, message, c.custom_id, [], rows));
          line.append(button);
        } else if (c.type === 3) {
          const select = el('select');
          select.append(new Option(c.placeholder || 'Choose…', ''));
          for (const o of c.options || []) select.append(new Option(o.label, o.value, false, Boolean(o.default)));
          select.disabled = Boolean(c.disabled);
          select.addEventListener('change', () => {
            if (select.value) press(where, message, c.custom_id, [select.value], rows);
          });
          line.append(select);
        }
      }
      rows.append(line);
    }
    return rows;
  }

  async function press(where, message, customId, values, rows) {
    // One press at a time per message; the bot's answer redraws it.
    rows.querySelectorAll('button, select').forEach((b) => { b.disabled = true; });
    const result = await post('/api/press', { station: where, messageId: message.id, customId, values });
    if (!result.ok) {
      toast(result.reason === 'expired' ? 'These buttons have expired.' : 'That did not go through.');
      renderPanel();
    }
    // Nothing came back (an ignored press): don't leave it greyed out.
    setTimeout(() => { if (rows.isConnected) renderPanel(); }, 4000);
  }

  function embed(e) {
    const box = el('div', 'embed');
    if (e.color != null) box.style.borderLeftColor = `#${e.color.toString(16).padStart(6, '0')}`;
    const main = el('div', 'embed-main');
    if (e.author && e.author.name) main.append(el('div', 'embed-footer', escape(e.author.name)));
    if (e.title) main.append(el('div', 'embed-title', md(e.title)));
    if (e.description) main.append(el('div', 'embed-desc', md(e.description)));
    if (e.fields && e.fields.length) {
      const fields = el('div', 'embed-fields');
      for (const f of e.fields) {
        const field = el('div', `embed-field${f.inline ? ' inline' : ''}`);
        field.append(el('b', null, md(f.name)), el('div', null, md(f.value)));
        fields.append(field);
      }
      main.append(fields);
    }
    box.append(main);
    if (e.thumbnail && e.thumbnail.url) {
      const img = el('img', 'embed-thumb');
      img.src = e.thumbnail.url;
      img.alt = '';
      box.append(img);
    }
    if (e.image && e.image.url) {
      const img = el('img', 'embed-image');
      img.src = e.image.url;
      img.alt = '';
      box.append(img);
    }
    if (e.footer && e.footer.text) box.append(el('div', 'embed-footer', escape(e.footer.text)));
    return box;
  }

  function messageView(message, where) {
    const box = el('div', `msg${message.ephemeral ? ' ephemeral' : ''}`);
    if (message.content) box.append(el('p', 'msg-text', md(message.content)));
    for (const e of message.embeds || []) box.append(embed(e));
    for (const f of message.files || []) {
      const a = el('a', 'btn btn-secondary', escape(f.name === 'file' ? 'Open file' : f.name));
      a.href = f.url;
      a.target = '_blank';
      box.append(a);
    }
    const rows = components(message, where);
    if (rows) box.append(rows);
    return box;
  }

  // -------------------------------------------------------------------------
  // Battles: the full-screen battle (battle.js)
  // -------------------------------------------------------------------------

  /** The newest battle card in the Battle channel, or null. */
  function lastCard() {
    for (let i = feeds.battle.length - 1; i >= 0; i--) if (window.BattleScreen.isCard(feeds.battle[i])) return feeds.battle[i];
    return null;
  }

  /** Words from the world (a white-out) that wait for the battle screen to close. */
  const afterBattle = [];
  /** The latest battle snapshot from the server, for opening the screen mid-battle. */
  let battleSnap = null;

  let battleUI = null;
  /** The pause menu, the bag, the MART (menu.js). */
  let menuUI = null;

  function openMenu() {
    if (station || dialog || battleUI.open || introUI.open || menuUI.open || world.busy) return;
    world.releaseAll();
    menuUI.pause();
  }

  /** The inside of PROF. A's lab, as a picture, for the opening's lab scene. */
  let labPicture = null;
  async function labBackground() {
    if (labPicture) return labPicture;
    try {
      const map = await fetch('/api/scene/lab').then((r) => r.json());
      const canvas = await window.World.preview(map);
      labPicture = canvas.toDataURL();
    } catch {
      labPicture = null;
    }
    return labPicture;
  }
  /** The opening and the wardrobe (intro.js). */
  let introUI = null;
  function makeBattleUI() {
    battleUI = window.BattleScreen.create($('battle'), {
      press: (messageId, customId, values = []) => post('/api/press', { station: 'battle', messageId, customId, values }),
      background: () => (world && world.background) || 'grass',
      bag: () => menuUI.bag(),
      milestone: () => towerFight,
      closed: () => {
        document.body.classList.remove('in-battle');
        leaveArena();
        if (afterBattle.length) showDialog(afterBattle.splice(0));
      },
    });
  }

  /**
   * Go to the battle screen. `stale` is a card already in the feed that
   * belongs to an earlier battle, so it isn't shown while the new one starts.
   */
  function openBattle() {
    if (station) closePanel();
    world.releaseAll();
    document.body.classList.add('in-battle');
    // A finished card is the last battle's. A live one is this battle's: a
    // trainer's starts while they walk up, so it can be here already.
    const card = lastCard();
    battleUI.show(card && !window.BattleScreen.hasLiveButtons(card) ? card.id : null);
    battleUI.update(feeds.battle, battleSnap);
  }

  // -------------------------------------------------------------------------
  // Station screens
  // -------------------------------------------------------------------------

  function openPanel(which, from = 'door') {
    station = which;
    stationFrom = from;
    world.releaseAll();
    const panel = $('panel');
    panel.dataset.station = which;
    panel.hidden = false;
    document.body.classList.add('in-station');
    $('panel-title').textContent = STATION_NAMES[which];
    footBuilt = null;
    renderPanel();
    if (which === 'drop') {
      const input = document.querySelector('.catch input');
      if (input && feeds.drop.length && matchMedia('(hover: hover)').matches) input.focus();
    }
  }

  function closePanel() {
    if (!station) return;
    const was = station;
    station = null;
    $('panel').hidden = true;
    document.body.classList.remove('in-station');
    if (stationFrom === 'door') world.leave(was);
    footBuilt = null;
  }

  function renderPanel() {
    if (!station) return;
    const body = $('panel-body');
    if (station === 'fly') {
      body.replaceChildren();
      $('panel-foot').replaceChildren();
      const list = el('div', 'fly-list');
      if (!flyPlaces.length) list.append(el('p', 'hint', "You haven't been anywhere you can fly to yet."));
      for (const place of flyPlaces) {
        const b = el('button', 'btn btn-secondary', escape(place.name));
        b.addEventListener('click', async () => {
          const r = await post('/api/fly', { key: place.key });
          closePanel();
          if (r.ok) await world.refresh();
          else if (r.text) showDialog([r.text]);
        });
        list.append(b);
      }
      body.append(list);
      return;
    }
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    const scrolled = body.scrollTop;
    body.replaceChildren();

    // A timer in the drop station's title bar.
    const head = document.querySelector('.panel-head');
    let timer = head.querySelector('.timer');
    if (station === 'drop' && !timer) {
      timer = el('span', 'timer');
      head.insertBefore(timer, $('panel-close'));
    } else if (station !== 'drop' && timer) {
      timer.remove();
    }

    if (station === 'mart') {
      const recent = feeds.mart.slice(-4);
      if (!recent.length) body.append(el('p', 'hint', `${CLERK[0]} Press <b>Show stock</b> to see what's for sale, then type an item's id (like fire-stone) to buy it.`));
      for (const m of recent) body.append(messageView(m, 'mart'));
    } else if (station === 'drop') {
      const recent = feeds.drop.slice(-6);
      if (!recent.length) {
        body.append(el('p', 'hint', 'Press <b>Drop</b> to find a wild Pokemon, then type its name below to catch it.'));
      }
      for (const m of recent) body.append(messageView(m, 'drop'));
    } else {
      const card = lastCard();
      if (status.inBattle && !(card && window.BattleScreen.hasLiveButtons(card))) {
        body.append(el('p', 'hint', "You're in a battle on Discord. Finish it there, or wait for it to time out."));
      } else {
        body.append(el('p', 'hint', 'Every milestone is fought here. <b>Milestone</b> takes on your next Gym Leader, Elite Four or Champion once your Trainer EXP bar is full. Fill it on the routes outside the gates (or with .b on Discord).'));
      }
    }

    renderFoot();
    // The drop station follows the newest message; a battle stays where it
    // was, so the arena doesn't jump away each turn.
    if (station === 'drop' || (atBottom && scrolled > 0)) body.scrollTop = body.scrollHeight;
    else body.scrollTop = scrolled;
  }

  let footBuilt = null;

  /** The station's own controls. Built once per visit so typing isn't lost. */
  function renderFoot() {
    const foot = $('panel-foot');
    if (footBuilt !== station) {
      foot.replaceChildren();
      footBuilt = station;

      if (station === 'drop') {
        const drop = el('button', 'btn btn-success btn-big', 'Drop');
        drop.id = 'drop-button';
        drop.addEventListener('click', async () => {
          drop.disabled = true;
          await post('/api/run', { station: 'drop', action: 'drop' });
          const input = foot.querySelector('input');
          if (input) input.focus();
        });

        const form = el('form', 'catch');
        const input = el('input');
        input.placeholder = 'Type its name to catch it';
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.maxLength = 48;
        const go = el('button', 'btn btn-primary', 'Catch');
        go.type = 'submit';
        form.append(input, go);
        const note = el('p', 'catch-note');

        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const text = input.value.trim();
          if (!text) return;
          const result = await post('/api/run', { station: 'drop', action: 'catch', text });
          note.className = 'catch-note';
          if (result.ok) {
            input.value = '';
            note.textContent = '';
          } else if (result.reason === 'nothing') {
            note.textContent = 'There is nothing to catch. Drop one first.';
            note.classList.add('bad');
          } else if (result.reason === 'wrong') {
            note.textContent = "That's not it.";
            note.classList.add('bad');
            input.select();
          }
        });

        foot.append(drop, form, note);
      } else if (station === 'mart') {
        const stock = el('button', 'btn btn-primary btn-big', 'Show stock');
        stock.addEventListener('click', () => post('/api/run', { station: 'mart', action: 'shop' }));
        const form = el('form', 'catch');
        const input = el('input');
        input.placeholder = 'Item id, e.g. fire-stone';
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.maxLength = 48;
        const qty = el('input');
        qty.type = 'number';
        qty.min = '1';
        qty.max = '99';
        qty.value = '1';
        qty.className = 'qty';
        const buy = el('button', 'btn btn-success', 'Buy');
        buy.type = 'submit';
        form.append(input, qty, buy);
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          if (!input.value.trim()) return;
          await post('/api/run', { station: 'mart', action: 'buy', text: input.value, qty: qty.value });
          input.value = '';
        });
        foot.append(stock, form);
      } else if (station === 'battle') {
        const milestone = el('button', 'btn btn-primary btn-big', 'Milestone');
        milestone.id = 'milestone-button';
        const go = (action) => {
          openBattle();
          post('/api/run', { station: 'battle', action });
        };
        milestone.addEventListener('click', () => go('milestone'));
        foot.append(milestone);
      }
    }

    // Kept up to date with the cooldown and battles, from either side.
    const drop = $('drop-button');
    if (drop) {
      const wait = dropWait();
      drop.disabled = wait > 0;
      drop.textContent = wait > 0 ? `Drop in ${clock(wait)}` : 'Drop';
    }
    for (const id of ['battle-button', 'milestone-button']) {
      const b = $(id);
      if (b) b.hidden = status.inBattle;
    }
    foot.hidden = station === 'battle' && status.inBattle;
  }

  // -------------------------------------------------------------------------
  // Signs
  // -------------------------------------------------------------------------

  function showDialog(lines, done = null) {
    world.releaseAll();
    if (dialog) {
      clearInterval(dialog.timer);
      if (dialog.done) dialog.done();
    }
    // Pages of what fits the box: two short lines, or one long one. A turns the page.
    const pages = [];
    for (const line of lines) {
      const last = pages[pages.length - 1];
      if (last && last.length < 2 && last[0].length + line.length <= 70) last.push(line);
      else pages.push([line]);
    }
    dialog = { pages, page: -1, text: '', shown: 0, timer: null, done };
    $('dialog').hidden = false;
    nextPage();
  }

  function nextPage() {
    dialog.page += 1;
    const text = dialog.pages[dialog.page].join('\n');
    Object.assign(dialog, { text, shown: 0 });
    const p = $('dialog-text');
    p.textContent = '';
    clearInterval(dialog.timer);
    dialog.timer = setInterval(() => {
      dialog.shown += 1;
      p.textContent = text.slice(0, dialog.shown);
      if (dialog.shown >= text.length) clearInterval(dialog.timer);
    }, 22);
  }

  function advanceDialog() {
    if (!dialog) return;
    if (dialog.shown < dialog.text.length) {
      clearInterval(dialog.timer);
      dialog.shown = dialog.text.length;
      $('dialog-text').textContent = dialog.text;
      return;
    }
    if (dialog.page < dialog.pages.length - 1) {
      nextPage();
      return;
    }
    clearInterval(dialog.timer);
    const done = dialog.done;
    dialog = null;
    $('dialog').hidden = true;
    if (done) done();
  }

  // -------------------------------------------------------------------------
  // Controls
  // -------------------------------------------------------------------------

  const KEY_DIRS = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    w: 'up', s: 'down', a: 'left', d: 'right', W: 'up', S: 'down', A: 'left', D: 'right',
  };
  const A_KEYS = new Set(['z', 'Z', 'Enter', ' ']);
  const B_KEYS = new Set(['x', 'X', 'Shift', 'Backspace']);

  function buttonA() {
    if (dialog) return advanceDialog();
    if (!station) world.interact();
  }

  function buttonB() {
    if (dialog) return advanceDialog();
    if (station) closePanel();
  }

  function bindControls() {
    const typing = () => ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement && document.activeElement.tagName);

    window.addEventListener('keydown', (e) => {
      if (menuUI.open && !typing()) {
        const key = KEY_DIRS[e.key] || (A_KEYS.has(e.key) ? 'a' : B_KEYS.has(e.key) || e.key === 'Escape' ? 'b' : null);
        if (key) {
          e.preventDefault();
          if (!e.repeat || KEY_DIRS[e.key]) menuUI.input(key);
        }
        return;
      }
      if (introUI.open && !typing()) {
        const key = KEY_DIRS[e.key] || (A_KEYS.has(e.key) ? 'a' : B_KEYS.has(e.key) || e.key === 'Escape' ? 'b' : null);
        if (key) {
          e.preventDefault();
          if (!e.repeat || KEY_DIRS[e.key]) introUI.input(key);
        }
        return;
      }
      if (battleUI.open && !typing()) {
        const key = KEY_DIRS[e.key] || (A_KEYS.has(e.key) ? 'a' : B_KEYS.has(e.key) || e.key === 'Escape' ? 'b' : null);
        if (key) {
          e.preventDefault();
          if (!e.repeat || KEY_DIRS[e.key]) battleUI.input(key);
        }
        return;
      }
      if (e.key === 'Escape') {
        if (dialog) advanceDialog();
        else if (station) closePanel();
        else openMenu();
        return;
      }
      if (typing() || e.ctrlKey || e.metaKey || e.altKey) return;
      // Buttons in a station screen keep Enter and Space.
      if (station && (e.key === 'Enter' || e.key === ' ') && document.activeElement && document.activeElement.tagName === 'BUTTON') return;

      const dir = KEY_DIRS[e.key];
      if (dir) {
        e.preventDefault();
        if (!station && !dialog) world.press(dir);
        return;
      }
      if ((e.key === 'm' || e.key === 'M') && !e.repeat) {
        e.preventDefault();
        if (station === 'fly') closePanel();
        else openFly();
        return;
      }
      if (A_KEYS.has(e.key)) {
        e.preventDefault();
        if (!e.repeat) buttonA();
      } else if (B_KEYS.has(e.key)) {
        e.preventDefault();
        world.setRunning(true);
        if (!e.repeat && e.key !== 'Shift') buttonB();
      }
    });

    window.addEventListener('keyup', (e) => {
      const dir = KEY_DIRS[e.key];
      if (dir) world.release(dir);
      if (B_KEYS.has(e.key)) world.setRunning(false);
    });

    window.addEventListener('blur', () => {
      world.releaseAll();
      world.setRunning(false);
    });

    $('panel-close').addEventListener('click', closePanel);
    $('dialog').addEventListener('click', advanceDialog);

    // Touch: hold a direction to walk; hold B to run.
    for (const button of document.querySelectorAll('.dpad button')) {
      const dir = button.dataset.dir;
      const up = () => world.release(dir);
      button.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (menuUI.open) return menuUI.input(dir);
        if (introUI.open) return introUI.input(dir);
        if (battleUI.open) return battleUI.input(dir);
        button.setPointerCapture(e.pointerId);
        if (!station && !dialog) world.press(dir);
      });
      button.addEventListener('pointerup', up);
      button.addEventListener('pointercancel', up);
      button.addEventListener('lostpointercapture', up);
    }
    const a = document.querySelector('.btn-a');
    const b = document.querySelector('.btn-b');
    a.addEventListener('pointerdown', (e) => { e.preventDefault(); if (menuUI.open) menuUI.input('a'); else if (introUI.open) introUI.input('a'); else if (battleUI.open) battleUI.input('a'); else buttonA(); });
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); if (menuUI.open) return menuUI.input('b'); if (introUI.open) return introUI.input('b'); if (battleUI.open) return battleUI.input('b'); world.setRunning(true); buttonB(); });
    const startButton = document.querySelector('.btn-start');
    if (startButton) startButton.addEventListener('pointerdown', (e) => { e.preventDefault(); openMenu(); });
    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
      b.addEventListener(type, () => world.setRunning(false));
    }
  }

  let toastTimer = null;
  function toast(text) {
    const box = $('connection');
    box.textContent = text;
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      box.hidden = true;
      box.textContent = 'Reconnecting…';
    }, 2500);
  }

  // -------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // The owner's dev console (browser console: dev.help()). The server checks
  // it's the owner on every call; this only adds the shortcuts.
  // -------------------------------------------------------------------------

  function installDev() {
    const call = async (cmd, ...args) => {
      const r = await post('/api/dev', { cmd, args });
      if (r.reload && world) await world.refresh();
      showDevTag();
      console.log(r.text || r.error || r);
      return undefined;
    };
    window.dev = {
      help() {
        console.log([
          'dev.explore()          explore on/off: nothing you do is saved, no battles, doors shut',
          'dev.noclip()           walk through anything (turns exploring on)',
          'dev.warp(map, x, y)    jump to a map (x, y optional; turns exploring on)',
          'dev.maps()             every map',
          'dev.where()            where you are, exploring and for real',
          'dev.overlay()          show one-battle grass (red) and trainer sight (yellow)',
          'dev.speed(n)           walk n times faster in this tab (1 = normal)',
          'dev.off()              all off, back where you really are',
          'Each toggle takes true/false too: dev.noclip(false).',
        ].join('\n'));
      },
      explore: (on) => call('explore', on),
      noclip: (on) => call('noclip', on),
      overlay: (on) => call('overlay', on),
      warp: (map, x, y) => call('warp', map, x, y),
      maps: () => call('maps'),
      where: () => call('where'),
      off: () => call('off'),
      speed(n = 1) {
        world.setSpeed(Math.max(0.25, Math.min(8, Number(n) || 1)));
        console.log(`Speed x${world.speed}.`);
        showDevTag();
      },
    };
    console.log('%cDev console ready: dev.help()', 'color:#f2c14e;font-weight:bold');
  }

  /** "Dev Build A" in the corner, plus what dev mode is doing. */
  function showDevTag() {
    const tag = document.querySelector('.build-tag');
    if (!tag || !world) return;
    const d = world.dev || {};
    const bits = [d.exploring && 'EXPLORING', d.noclip && 'NOCLIP', d.overlay && 'OVERLAY', world.speed !== 1 && `x${world.speed}`].filter(Boolean);
    tag.textContent = ['Dev Build A', ...bits].join(' · ');
    tag.classList.toggle('dev-on', bits.length > 0);
  }

  // -------------------------------------------------------------------------
  // FLY (after the Main City's taxi driver)
  // -------------------------------------------------------------------------

  let flyPlaces = [];

  async function refreshFly() {
    const r = await fetch('/api/fly').then((x) => x.json()).catch(() => null);
    $('hud-fly').hidden = !(r && r.unlocked);
    return r;
  }

  async function openFly() {
    if (station || dialog || battleUI.open || introUI.open || world.busy) return;
    const r = await refreshFly();
    if (!r || !r.unlocked) return showDialog(["You don't have a way to FLY yet. Reach the MAIN CITY first."]);
    flyPlaces = r.places;
    openPanel('fly', 'menu');
  }

  // -------------------------------------------------------------------------
  // Buildings without a screen of their own
  // -------------------------------------------------------------------------

  const NURSE = [
    'Welcome to our POKéMON CENTER!',
    'Your POKéMON are fighting fit! If you are ever out of usable POKéMON, you will wake up here.',
    'We hope to see you again!',
  ];

  /** The Drop Station is a counter, not a room. */
  function enterBuilding(which) {
    if (which === 'drop') openPanel('drop', 'door');
  }

  /**
   * Talking to someone. Most just talk; some do something (world.js tells us
   * who, and `done` lets them get back to wandering).
   */
  async function talk(npc, done) {
    const finish = () => done && done();
    switch (npc.action) {
      case 'nurse':
        return showDialog(NURSE, finish);
      case 'shop':
        world.setFrozen(true);
        await menuUI.shop();
        world.setFrozen(false);
        return finish();
      case 'mom':
        return showDialog(npc.lines, async () => {
          if (await menuUI.ask('MOM: Do you want to change your clothes?')) await changeClothes();
          finish();
        });
      case 'tower':
        return towerDesk(finish);
      default:
        return showDialog(npc.lines && npc.lines.length ? npc.lines : ['...'], finish);
    }
  }

  async function changeClothes() {
    world.releaseAll();
    const outfits = await fetch('/api/intro').then((r) => r.json()).then((d) => d.outfits).catch(() => null);
    const current = await fetch('/api/world').then((r) => r.json()).then((w) => w.player.outfit).catch(() => 'adventurer');
    if (outfits) {
      await introUI.changeOutfit(outfits, current);
      await world.refresh();
    }
  }

  // -------------------------------------------------------------------------
  // The BATTLE TOWER
  // -------------------------------------------------------------------------

  /** Who stands in for each kind of leader on the overworld (Tuxemon characters). */
  const LEADER_LOOKS = {
    rock: 'miner', ground: 'miner_yellow', water: 'swimmer_blue', grass: 'florist', electric: 'scientist', fire: 'firefighter',
    psychic: 'magician', poison: 'ninja_red', ghost: 'goth', ice: 'knight_yellow', fighting: 'monk', flying: 'postboy',
    bug: 'childactor', dragon: 'dragonrider', dark: 'rogue', steel: 'knight', fairy: 'catgirl', normal: 'cooldude',
  };
  const leaderLook = (next) => LEADER_LOOKS[next.type] || (next.kind === 'champion' ? 'knightlord' : 'ceo');
  /** The milestone being fought, for the battle's opening (battle.js). */
  let towerFight = null;

  async function towerDesk(done) {
    const t = await fetch('/api/tower').then((r) => r.json());
    if (!t.next) return showDialog(['RECEPTIONIST: Welcome to the BATTLE TOWER!', 'You have beaten every milestone there is. Amazing!'], done);
    if (!t.ready) {
      return showDialog([
        'RECEPTIONIST: Welcome to the BATTLE TOWER!',
        `Your next challenge is ${t.next.title.toUpperCase()}.`,
        `Come back when your TRAINER EXP bar is full. ${t.remaining.toLocaleString()} TRAINER EXP to go!`,
      ], done);
    }
    showDialog(['RECEPTIONIST: Welcome to the BATTLE TOWER!', `${t.next.title.toUpperCase()} is waiting for you upstairs.`], async () => {
      done();
      if (!(await menuUI.ask('Are you ready to battle?'))) return showDialog(['RECEPTIONIST: Come back when you are ready!']);
      const r = await post('/api/tower', { action: 'enter' });
      if (!r.ok) return showDialog([r.text]);
      await world.refresh();
      world.setFrozen(true);
      towerFight = { title: t.next.title, name: t.next.name, look: leaderLook(t.next), slug: String(t.next.name).toLowerCase().replace(/[^a-z0-9]+/g, '-') };
      world.addNpc({ id: 'leader', name: t.next.name, sprite: towerFight.look, x: r.leader.x, y: r.leader.y, facing: 'down' });
      world.walkUp('leader', [`${t.next.title.toUpperCase()}: So you're the challenger everyone is talking about.`, 'Show me what you have!'], () => {
        openBattle();
        post('/api/run', { station: 'battle', action: 'milestone' });
      });
    });
  }

  /** After a milestone: back down to the lobby. */
  async function leaveArena() {
    if (world.mapId !== 'tower-arena') return;
    await post('/api/tower', { action: 'leave' });
    towerFight = null;
    world.setFrozen(false);
    await world.refresh();
  }

  function avatarOf(user) {
    if (user.avatar) return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`;
    const index = Number((BigInt(user.id) >> 22n) % 6n);
    return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
  }

  async function start() {
    const res = await fetch('/api/me');
    if (res.status === 401) {
      $('login').hidden = false;
      $('login-error').hidden = !location.search.includes('login=failed');
      $('login-locked').hidden = !location.search.includes('login=locked');
      return;
    }
    const data = await res.json();
    me = data.user;

    $('game').hidden = false;
    $('hud-name').textContent = me.globalName || me.username;
    $('hud-avatar').src = avatarOf(me);
    setStatus(data.status);

    if (data.owner) installDev();

    world = window.World.create($('world'), {
      enter: (which) => enterBuilding(which),
      talk,
      read: showDialog,
      paused: () => Boolean(station || dialog),
      // Grass or a trainer: the battle is already running on the server.
      encounter: () => openBattle(),
      loaded: () => showDevTag(),
      unlocked: () => refreshFly(),
      post,
    });
    makeBattleUI();
    introUI = window.IntroScreen.create($('intro'), { post, name: () => me.globalName || me.username, labBackground });
    menuUI = window.MenuScreen.create($('menu'), {
      post,
      get: (p) => fetch(p).then((r) => r.json()),
      fly: () => openFly(),
      name: () => me.globalName || me.username,
    });
    $('hud-menu').addEventListener('click', openMenu);
    $('hud-fly').addEventListener('click', openFly);
    refreshFly();
    bindControls();
    connect();

    // The opening, for anyone who hasn't had their starter (this prestige).
    const opening = await fetch('/api/intro').then((r) => r.json()).catch(() => null);
    if (opening && opening.needed) {
      const current = await fetch('/api/world').then((r) => r.json()).then((w) => w.player.outfit).catch(() => 'adventurer');
      await introUI.play(opening, current);
      await world.refresh();
    }
  }

  start();
})();
