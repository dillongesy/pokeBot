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

  const STATION_NAMES = { drop: 'DROP STATION', battle: 'BATTLE STATION' };

  let me = null;
  let world = null;
  const feeds = { drop: [], battle: [] };
  let status = { dropReadyIn: 0, inBattle: false, busy: null };
  let statusAt = Date.now();
  let station = null;
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
      setStatus(data.status);
      renderPanel();
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
  // Battles
  // -------------------------------------------------------------------------

  /** The battle card: two side-by-side fields and both sprites. */
  const isBattleCard = (m) => {
    const e = m.embeds && m.embeds[0];
    return Boolean(e && e.fields && e.fields.length >= 2 && e.fields[0].inline && e.fields[1].inline && (e.image || e.thumbnail));
  };

  /** Still being played: it has buttons other than the finished card's. */
  const isLive = (m) =>
    (m.components || []).some((row) =>
      (row.components || []).some((c) => c.custom_id && !['bt:log', 'bt:again'].includes(c.custom_id))
    );

  /** One side's lines on the card, read back into numbers. */
  function sideOf(field) {
    const lines = String(field.value || '').split('\n');
    const first = lines[0] || '';
    const hpLine = lines.find((l) => /[█░]/.test(l)) || '';
    const hp = /(\d+)\/(\d+)/.exec(hpLine);
    const expLine = lines.find((l) => l.startsWith('EXP')) || null;
    let exp = null;
    if (expLine) {
      const full = (expLine.match(/▰/g) || []).length;
      const empty = (expLine.match(/▱/g) || []).length;
      exp = full + empty ? full / (full + empty) : 0;
    }
    return {
      trainer: field.name,
      name: (/\*\*(.+?)\*\*/.exec(first) || [, first])[1],
      shiny: first.startsWith('✨'),
      level: (/Lv\.(\d+)/.exec(first) || [])[1] || '?',
      status: (/`([A-Z]{3})`/.exec(first) || [])[1] || null,
      hp: hp ? Number(hp[1]) : 0,
      maxHp: hp ? Number(hp[2]) : 1,
      exp,
      dots: lines.find((l) => /^[●○]+$/.test(l.trim())) || '',
    };
  }

  function infoBox(side, which) {
    const box = el('div', `info ${which}`);
    const pct = Math.max(0, Math.min(100, (side.hp / side.maxHp) * 100));
    const tone = pct > 50 ? '' : pct > 20 ? ' mid' : ' low';
    box.innerHTML =
      `<div class="info-name"><b>${side.shiny ? '✨ ' : ''}${escape(side.name)}</b>` +
      `<span>${side.status ? `<span class="status-tag">${side.status}</span> ` : ''}Lv${escape(side.level)}</span></div>` +
      `<div class="hp"><span>HP</span><div class="hp-track"><div class="hp-fill${tone}" style="width:${pct}%"></div></div></div>` +
      (which === 'mine' ? `<div class="hp-num">${side.hp}/${side.maxHp}</div>` : '') +
      (side.exp != null ? `<div class="exp-track"><div class="exp-fill" style="width:${side.exp * 100}%"></div></div>` : '') +
      `<div class="dots">${escape(side.dots)}</div>`;
    return box;
  }

  function battleView(message) {
    const e = message.embeds[0];
    const mine = sideOf(e.fields[0]);
    const foe = sideOf(e.fields[1]);
    const result = e.fields[2] || null;

    const wrap = el('div', 'battle');
    const field = el('div', `field${e.color === 0xf1c40f ? ' milestone' : ''}`);
    field.append(el('div', 'base foe'), el('div', 'base mine'));
    if (e.thumbnail && e.thumbnail.url) {
      const img = el('img', 'sprite foe');
      img.src = e.thumbnail.url;
      img.alt = foe.name;
      field.append(img);
    }
    if (e.image && e.image.url) {
      const img = el('img', 'sprite mine');
      img.src = e.image.url;
      img.alt = mine.name;
      field.append(img);
    }
    field.append(infoBox(foe, 'foe'), infoBox(mine, 'mine'));
    wrap.append(el('div', 'embed-title', md(e.title || 'Battle!')), field);

    if (result) {
      wrap.append(el('div', 'battle-log battle-result', `<b>${md(result.name)}</b>${md(result.value)}`));
    }
    wrap.append(el('div', 'battle-log', md(e.description || 'What will you do?')));
    if (e.footer && e.footer.text) wrap.append(el('p', 'turn', escape(e.footer.text)));

    const rows = components(message, 'battle');
    if (rows) wrap.append(rows);
    return wrap;
  }

  // -------------------------------------------------------------------------
  // Station screens
  // -------------------------------------------------------------------------

  function openPanel(which) {
    station = which;
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
    world.leave(was);
  }

  function renderPanel() {
    if (!station) return;
    const body = $('panel-body');
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

    if (station === 'drop') {
      const recent = feeds.drop.slice(-6);
      if (!recent.length) {
        body.append(el('p', 'hint', 'Press <b>Drop</b> to find a wild Pokemon, then type its name below to catch it.'));
      }
      for (const m of recent) body.append(messageView(m, 'drop'));
    } else {
      const feed = feeds.battle;
      let last = -1;
      for (let i = feed.length - 1; i >= 0; i--) {
        if (isBattleCard(feed[i])) { last = i; break; }
      }
      const liveHere = last >= 0 && isLive(feed[last]);

      if (status.inBattle && !liveHere) {
        body.append(el('p', 'hint', "You're in a battle on Discord. Finish it there, or wait for it to time out."));
      }
      if (last < 0) {
        const before = feed.slice(-4);
        if (!before.length) {
          body.append(el('p', 'hint', 'Take your team into a battle. <b>Milestone</b> takes on your next Gym Leader, Elite Four or Champion when one is ready.'));
        }
        for (const m of before) body.append(messageView(m, 'battle'));
      } else {
        body.append(battleView(feed[last]));
        for (const m of feed.slice(last + 1)) body.append(messageView(m, 'battle'));
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
      } else if (station === 'battle') {
        const battle = el('button', 'btn btn-danger btn-big', 'Battle');
        battle.id = 'battle-button';
        const milestone = el('button', 'btn btn-primary btn-big', 'Milestone');
        milestone.id = 'milestone-button';
        battle.addEventListener('click', () => post('/api/run', { station: 'battle', action: 'battle' }));
        milestone.addEventListener('click', () => post('/api/run', { station: 'battle', action: 'milestone' }));
        foot.append(battle, milestone);
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

  function showDialog(lines) {
    world.releaseAll();
    const text = lines.join('\n');
    dialog = { text, shown: 0, timer: null };
    $('dialog').hidden = false;
    const p = $('dialog-text');
    p.textContent = '';
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
    clearInterval(dialog.timer);
    dialog = null;
    $('dialog').hidden = true;
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
      if (e.key === 'Escape') {
        if (dialog) advanceDialog();
        else closePanel();
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
        button.setPointerCapture(e.pointerId);
        if (!station && !dialog) world.press(dir);
      });
      button.addEventListener('pointerup', up);
      button.addEventListener('pointercancel', up);
      button.addEventListener('lostpointercapture', up);
    }
    const a = document.querySelector('.btn-a');
    const b = document.querySelector('.btn-b');
    a.addEventListener('pointerdown', (e) => { e.preventDefault(); buttonA(); });
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); world.setRunning(true); buttonB(); });
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
      return;
    }
    const data = await res.json();
    me = data.user;

    $('game').hidden = false;
    $('hud-name').textContent = me.globalName || me.username;
    $('hud-avatar').src = avatarOf(me);
    setStatus(data.status);

    world = window.World.create($('world'), {
      enter: openPanel,
      read: showDialog,
      paused: () => Boolean(station || dialog),
    });
    bindControls();
    connect();
  }

  start();
})();
