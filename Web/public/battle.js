'use strict';

/**
 * The battle screen, drawn like the handheld games: the arena on a biome
 * background, the text box underneath, and the FIGHT / BAG / POKéMON / RUN
 * menu with moves in a 2x2 box.
 *
 * The battle itself is the bot's own (Commands/battle.js), run on the server.
 * This reads two things the server sends for the player's Battle channel:
 *
 *   the card       its text (what just happened), result and buttons. Every
 *                  choice here presses one of the card's buttons by its id
 *                  (bt:move:N, bt:switch, bt:send:N, bt:mega, bt:forfeit).
 *   the snapshot   the battle as data (webView): names, levels, HP, sprites,
 *                  moves and PP, the party.
 *
 * After the battle, the result and every message that follows (level-ups,
 * new moves, evolutions) play out in the text box, and any question among
 * them (forget a move? evolve?) becomes a menu.
 *
 * Controls: arrows move the cursor, Z / Enter / Space is A, X / Backspace is
 * B. Everything can be clicked or tapped too.
 */

(function () {
  const BACKGROUNDS = '/sprites/tuxemon/battle';
  /** How long a fully shown line stays before the next, when nobody presses A. */
  const LINE_MS = 1100;
  const TYPE_MS = 18;

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  /** Discord markdown and emoji out of a line, for the text box. */
  const plain = (text) =>
    String(text || '')
      // The trainer bar, said in words: Trainer EXP 2,040/3,200 (Trainer Lv. 8).
      .replace(/Trainer Lv\.(\d+)\s*`?[▰▱]+`?\s*([\d,]+)\s*\/\s*([\d,]+)/g, 'Trainer EXP $2/$3 (Trainer Lv. $1)')
      .replace(/[▰▱█░●○]+/g, '')
      .replace(/<a?:\w+:\d+>/g, '')
      .replace(/<@!?\d+>/g, 'you')
      .replace(/\*\*|__|`|~~/g, '')
      .replace(/(^|\s)\*(\S[^*]*?)\*/g, '$1$2')
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();

  const linesOf = (text) => String(text || '').split('\n').map(plain).filter(Boolean);

  const isCard = (m) => {
    const e = m && m.embeds && m.embeds[0];
    return Boolean(e && e.fields && e.fields.length >= 2 && e.fields[0].inline && e.fields[1].inline);
  };
  const buttonsOf = (m) => (m.components || []).flatMap((row) => row.components || []);
  const hasLiveButtons = (m) => buttonsOf(m).some((c) => c.custom_id && !['bt:log', 'bt:again'].includes(c.custom_id) && !c.disabled);

  const STATUS = { paralysis: 'PAR', poison: 'PSN', burn: 'BRN', sleep: 'SLP', freeze: 'FRZ' };
  const GENDER = { male: '♂', female: '♀' };

  /**
   * @param {HTMLElement} root  an empty element covering the game screen
   * @param {object} hooks
   * @param {(messageId: string, customId: string, values?: string[]) => Promise<object>} hooks.press
   * @param {() => void} hooks.closed   the player has seen everything
   * @param {() => string} hooks.background   the battle background's name
   */
  function create(root, hooks) {
    root.classList.add('bscreen');
    root.hidden = true;

    const arena = el('div', 'b-arena');
    const foeBox = el('div', 'b-hp foe');
    const mineBox = el('div', 'b-hp mine');
    const foeMon = el('img', 'b-mon foe');
    const mineMon = el('img', 'b-mon mine');
    foeMon.alt = '';
    mineMon.alt = '';
    // The opponent trainer, standing on their base at the start; the balls
    // POKéMON come out of; each side's party as a row of balls.
    const trainer = el('div', 'b-trainer');
    trainer.hidden = true;
    const foeBall = el('div', 'b-ball foe');
    const mineBall = el('div', 'b-ball mine');
    const foeLine = el('div', 'b-lineup foe');
    const mineLine = el('div', 'b-lineup mine');
    arena.append(el('div', 'b-base foe'), el('div', 'b-base mine'), trainer, foeMon, mineMon, foeBall, mineBall, foeLine, mineLine, foeBox, mineBox);

    const bottom = el('div', 'b-bottom');
    const textBox = el('div', 'b-text');
    const text = el('p');
    const more = el('span', 'b-more', '▼');
    textBox.append(text, more);
    const menu = el('div', 'b-menu');
    bottom.append(textBox, menu);

    const party = el('div', 'b-party');
    party.hidden = true;

    root.append(arena, bottom, party);

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------

    let open = false;
    /** A card id to ignore: the last battle's, until the new one arrives. */
    let staleId = null;
    let card = null;
    let snap = null;
    let feedAfter = [];
    /** Lines waiting for the text box, and what has been queued already. */
    const queue = [];
    const seen = new Set();
    let typing = null;
    /** 'wait' (text only), 'command', 'fight', 'party', 'bag', 'choice', 'done' */
    let mode = 'wait';
    let cursor = 0;
    let sending = false;
    /** A bench slot to send in once the card shows the switch buttons. */
    let pendingSend = null;
    let megaArmed = false;
    /** The opening is playing: sprites appear on cue, not as the snapshot says. */
    let introducing = false;
    /** A cue's wait before the next line. */
    let cueTimer = null;
    let closing = false;

    // -----------------------------------------------------------------------
    // Drawing
    // -----------------------------------------------------------------------

    function hpBox(box, mon, mine) {
      const pct = mon.maxHp ? Math.max(0, Math.min(100, (mon.hp / mon.maxHp) * 100)) : 0;
      const tone = pct > 50 ? 'good' : pct > 20 ? 'mid' : 'low';
      box.replaceChildren();
      const top = el('div', 'b-hp-top');
      top.append(el('b', null, mon.name), el('span', 'b-gender', GENDER[mon.gender] || ''), el('span', 'b-lv', `Lv${mon.level}`));
      const bar = el('div', 'b-hp-bar');
      bar.append(el('span', 'b-hp-label', 'HP'));
      const track = el('div', 'b-hp-track');
      const fill = el('div', `b-hp-fill ${tone}`);
      fill.style.width = `${pct}%`;
      track.append(fill);
      bar.append(track);
      box.append(top, bar);
      if (mon.status) box.append(el('span', `b-status ${mon.status}`, STATUS[mon.status] || mon.status.slice(0, 3).toUpperCase()));
      if (mine) {
        box.append(el('div', 'b-hp-num', `${mon.hp}/ ${mon.maxHp}`));
        if (mon.exp != null) {
          const exp = el('div', 'b-exp');
          const fillExp = el('div', 'b-exp-fill');
          fillExp.style.width = `${Math.round(mon.exp * 100)}%`;
          exp.append(fillExp);
          box.append(exp);
        }
      }
    }

    function drawArena() {
      arena.style.backgroundImage = `url(${BACKGROUNDS}/${snap && snap.kind === 'milestone' ? 'stadium' : hooks.background() || 'grass'}.png)`;
      if (!snap) return;
      hpBox(foeBox, snap.foe, false);
      hpBox(mineBox, snap.mine, true);
      // A new POKéMON in (a switch, or the trainer's next one) comes out of its ball.
      for (const [img, ball, mon, box] of [[foeMon, foeBall, snap.foe, foeBox], [mineMon, mineBall, snap.mine, mineBox]]) {
        const src = mon.sprite || '';
        if (img.getAttribute('src') === src) continue;
        const had = img.hasAttribute('src');
        img.src = src;
        if (had && !introducing && mon.hp > 0) sendOut(img, ball, box);
      }
      foeMon.classList.toggle('fainted', snap.foe.hp <= 0);
      mineMon.classList.toggle('fainted', snap.mine.hp <= 0);
    }

    /** The menu on the right (or across the bottom, for moves). */
    function drawMenu() {
      menu.replaceChildren();
      menu.className = `b-menu ${mode}`;
      bottom.classList.toggle('fight', mode === 'fight');
      party.hidden = mode !== 'party';
      if (mode === 'party') drawParty();

      const items = menuItems();
      items.forEach((item, i) => {
        const b = el('button', `b-item${i === cursor ? ' on' : ''}${item.disabled ? ' off' : ''}`, item.label);
        b.type = 'button';
        b.addEventListener('click', () => {
          cursor = i;
          choose();
        });
        menu.append(b);
      });

      if (mode === 'fight') {
        const info = el('div', 'b-moveinfo');
        const move = snap && snap.moves[cursor];
        if (move) {
          info.append(el('div', null, `PP ${move.pp}/${move.maxPp}`), el('div', null, `TYPE/${move.type.toUpperCase()}`));
        }
        if (canMega()) {
          const m = el('button', `b-mega${megaArmed ? ' on' : ''}`, megaArmed ? 'MEGA: ON' : 'MEGA: OFF');
          m.type = 'button';
          m.addEventListener('click', toggleMega);
          info.append(m);
        }
        menu.append(info);
      }
      textBox.hidden = mode === 'fight';
      more.hidden = !(mode === 'wait' && typing && typing.done && queue.length);
    }

    function drawParty() {
      party.replaceChildren();
      const head = el('p', 'b-party-head', forcedSwitch() ? 'Choose a POKéMON.' : 'Choose a POKéMON.');
      party.append(head);
      const grid = el('div', 'b-party-grid');
      const team = (snap && snap.team) || [];
      team.forEach((mon, i) => {
        const slot = el('button', `b-slot${i === cursor ? ' on' : ''}${mon.fainted ? ' fainted' : ''}${mon.active ? ' active' : ''}`);
        slot.type = 'button';
        const img = el('img');
        img.src = mon.sprite || '';
        img.alt = '';
        const pct = mon.maxHp ? Math.max(0, (mon.hp / mon.maxHp) * 100) : 0;
        const tone = pct > 50 ? 'good' : pct > 20 ? 'mid' : 'low';
        const info = el('div', 'b-slot-info');
        info.append(el('b', null, mon.name), el('span', null, `Lv${mon.level}`));
        const track = el('div', 'b-hp-track');
        const fill = el('div', `b-hp-fill ${tone}`);
        fill.style.width = `${pct}%`;
        track.append(fill);
        info.append(track, el('span', 'b-slot-hp', `${mon.hp}/ ${mon.maxHp}`));
        slot.append(img, info);
        slot.addEventListener('click', () => {
          cursor = i;
          choose();
        });
        grid.append(slot);
      });
      party.append(grid);
      if (!forcedSwitch()) {
        const cancel = el('button', `b-cancel${cursor === team.length ? ' on' : ''}`, 'CANCEL');
        cancel.type = 'button';
        cancel.addEventListener('click', back);
        party.append(cancel);
      }
    }

    /**
     * A milestone opens like a stadium battle: bars sweep in, the leader and
     * their name, VS. Official trainer art can be dropped in at
     * /sprites/trainers/<name>.png; otherwise their overworld look stands in.
     */
    function stadiumIntro(fight) {
      const splash = el('div', 'b-vs');
      const art = el('div', 'b-vs-art');
      const figure = () => {
        const f = el('div', 'b-vs-figure');
        f.style.backgroundImage = `url(/sprites/tuxemon/characters/${fight.look}.png)`;
        art.append(f);
      };
      if (fight.slug) {
        const img = el('img', 'b-vs-pic');
        img.alt = '';
        img.onerror = () => {
          img.remove();
          figure();
        };
        img.src = `/sprites/trainers/${fight.slug}.png`;
        art.append(img);
      } else figure();
      splash.append(el('div', 'b-vs-bar top'), art, el('b', 'b-vs-name', String(fight.title || '').toUpperCase()), el('span', 'b-vs-vs', 'VS'), el('div', 'b-vs-bar bottom'));
      root.append(splash);
      setTimeout(() => splash.remove(), 2800);
    }

    /** A ball flies out, pops open with a flash, and the POKéMON grows out of it. */
    function sendOut(img, ball, box) {
      img.classList.remove('out', 'dark', 'pop', 'fainted');
      img.classList.add('waiting');
      ball.classList.remove('throw');
      void ball.offsetWidth;
      ball.classList.add('throw');
      setTimeout(() => {
        img.classList.remove('waiting');
        img.classList.add('pop');
        if (box) box.classList.remove('off');
      }, 520);
      setTimeout(() => img.classList.remove('pop'), 1150);
    }

    /** A hit POKéMON blinks. */
    function blink(img) {
      img.classList.remove('hit');
      void img.offsetWidth;
      img.classList.add('hit');
      setTimeout(() => img.classList.remove('hit'), 600);
    }

    /** Each side's party as a row of balls (trainer battles open with them). */
    function lineups() {
      const fill = (row, alive) => {
        row.replaceChildren();
        for (let i = 0; i < 6; i++) row.append(el('span', i < alive.length ? (alive[i] ? 'ok' : 'down') : 'none'));
      };
      fill(foeLine, (snap && snap.foeTeam) || []);
      fill(mineLine, ((snap && snap.team) || []).map((m) => !m.fainted));
    }

    /**
     * The start of a battle, as in the games: the arena opens, the bases
     * slide in, then
     *   wild      the POKéMON is a dark shape until it "appears"
     *   trainer   the trainer stands there, then sends out their POKéMON
     * and your POKéMON comes out of its ball.
     */
    function opening(title) {
      const kind = (snap && snap.kind) || 'wild';
      const trainerLike = kind !== 'wild';
      introducing = true;
      root.dataset.kind = kind;
      root.classList.remove('opening');
      root.classList.add('covered');
      foeMon.classList.remove('pop', 'waiting', 'hit');
      mineMon.classList.remove('pop', 'waiting', 'hit');
      foeMon.classList.toggle('dark', !trainerLike);
      foeMon.classList.toggle('out', trainerLike);
      mineMon.classList.add('out');
      foeBox.classList.add('off');
      mineBox.classList.add('off');
      trainer.classList.remove('leave');
      trainer.hidden = !trainerLike;
      const look = (hooks.foeLook && hooks.foeLook()) || 'cooldude';
      trainer.style.backgroundImage = `url(/sprites/tuxemon/characters/${look}.png)`;
      lineups();
      root.classList.toggle('lineups', trainerLike);
      if (kind === 'milestone') stadiumIntro((hooks.milestone && hooks.milestone()) || { title: snap.foeName, look, slug: '' });

      queue.push({
        cue: () => {
          root.classList.remove('covered');
          void root.offsetWidth;
          root.classList.add('opening');
        },
        ms: (kind === 'milestone' ? 2700 : 0) + 950,
      });
      if (!trainerLike) {
        queue.push({ cue: () => { foeMon.classList.remove('dark'); foeBox.classList.remove('off'); }, ms: 250 });
        if (title) queue.push({ line: title });
      } else {
        if (title) queue.push({ line: title });
        queue.push({
          cue: () => {
            trainer.classList.add('leave');
            root.classList.remove('lineups');
            setTimeout(() => sendOut(foeMon, foeBall, foeBox), 250);
          },
          ms: 0,
        });
        if (snap) queue.push({ line: `${snap.foeName} sent out ${snap.foe.name}!` });
      }
      if (snap) {
        queue.push({ cue: () => sendOut(mineMon, mineBall, mineBox), ms: 0 });
        queue.push({ line: `Go! ${snap.mine.name}!` });
      }
      queue.push({ cue: () => { introducing = false; }, ms: 0 });
    }

    // -----------------------------------------------------------------------
    // Keeping the end of a battle short, like the games
    // -----------------------------------------------------------------------

    /** The result: who won, then coins and TRAINER EXP in one line. */
    function resultLines(lines) {
      const out = [];
      let coins = null;
      let exp = null;
      for (const line of lines) {
        const c = /earned ([\d,]+) coins/i.exec(line);
        const x = /\+?([\d,]+) trainer exp/i.exec(line);
        if (c) coins = c[1];
        else if (x && !/\//.test(line)) exp = x[1];
        else if (/^Trainer EXP [\d,]+\/|Trainer Lv/i.test(line)) continue;
        else out.push(line);
      }
      if (coins || exp) out.push(`You got ${[coins && `${coins} coins`, exp && `${exp} TRAINER EXP`].filter(Boolean).join(' and ')}!`);
      return out;
    }

    /** EXP lines: only the POKéMON that's out, and never "earned nothing". */
    function expWorthSaying(line) {
      if (/earned nothing/i.test(line)) return false;
      if (/gained [\d,]+ (exp|experience)/i.test(line) || /\+[\d,]+ exp/i.test(line)) {
        return Boolean(snap && line.toLowerCase().includes(String(snap.mine.name).toLowerCase()));
      }
      return true;
    }

    /** After the battle: level-ups, moves, evolutions and unlocks; not quest or streak news. */
    function worthSaying(line) {
      return !/quest|daily|streak|overdrive|gold|leaderboard/i.test(line);
    }

    // -----------------------------------------------------------------------
    // Menus
    // -----------------------------------------------------------------------

    const buttons = () => (card ? buttonsOf(card) : []);
    const button = (id) => buttons().find((c) => c.custom_id === id) || null;
    const canMega = () => Boolean(button('bt:mega'));
    const moveButtons = () => buttons().filter((c) => /^bt:move:\d+$/.test(c.custom_id));
    const forcedSwitch = () => buttons().some((c) => /^bt:send:/.test(c.custom_id)) && !button('bt:back') && !moveButtons().length;
    const isWild = () => snap && snap.kind === 'wild';

    function menuItems() {
      if (mode === 'command') {
        return [{ label: 'FIGHT' }, { label: 'BAG' }, { label: 'POKéMON' }, { label: 'RUN' }];
      }
      if (mode === 'fight') {
        const btns = moveButtons();
        // Out of PP everywhere: the card offers Struggle alone.
        if (btns.length === 1 && /struggle/i.test(btns[0].label || '')) return [{ label: 'STRUGGLE', id: btns[0].custom_id }];
        return ((snap && snap.moves) || []).slice(0, 4).map((m, i) => {
          const b = button(`bt:move:${i}`);
          return { label: m.name.toUpperCase(), id: `bt:move:${i}`, disabled: !b || b.disabled };
        });
      }
      if (mode === 'bag') return [{ label: 'CANCEL' }];
      if (mode === 'choice') return choiceItems();
      return [];
    }

    /** A question after the battle: its buttons and menu options as choices. */
    function choiceItems() {
      const m = pendingQuestion();
      if (!m) return [];
      const items = [];
      for (const c of buttonsOf(m)) {
        if (c.type === 2 && !c.disabled && c.custom_id) items.push({ label: plain(c.label || '').toUpperCase() || '...', message: m, id: c.custom_id });
        if (c.type === 3 && !c.disabled) {
          for (const o of c.options || []) items.push({ label: plain(o.label).toUpperCase(), message: m, id: c.custom_id, values: [o.value] });
        }
      }
      return items;
    }

    /** The first message after the card that is still asking something. */
    const pendingQuestion = () => feedAfter.find((m) => hasLiveButtons(m)) || null;

    const columns = () => (mode === 'command' || mode === 'fight' ? 2 : 1);

    function moveCursor(dir) {
      const count = mode === 'party' ? ((snap && snap.team.length) || 0) + (forcedSwitch() ? 0 : 1) : menuItems().length;
      if (!count) return;
      const cols = mode === 'party' ? 2 : columns();
      const step = { left: -1, right: 1, up: -cols, down: cols }[dir];
      if (cols === 1 && (dir === 'left' || dir === 'right')) return;
      const next = cursor + step;
      if (next >= 0 && next < count) cursor = next;
      else if (mode === 'party' && dir === 'down') cursor = count - 1;
      drawMenu();
    }

    /** A press that came up while another was still on its way; sent next. */
    let queuedPress = null;

    async function pressCard(id, values) {
      if (!card) return;
      if (sending) {
        // The card can change before the last press is answered (Switch,
        // then who to send in): send this one straight after.
        queuedPress = [id, values];
        return;
      }
      sending = true;
      mode = 'wait';
      drawMenu();
      try {
        await hooks.press(card.id, id, values);
      } finally {
        sending = false;
      }
      if (queuedPress) {
        const [nextId, nextValues] = queuedPress;
        queuedPress = null;
        pressCard(nextId, nextValues);
      }
    }

    function say(lines, then) {
      for (const line of lines) queue.push({ line });
      if (then) queue.push({ then });
      if ((!typing || typing.done) && !cueTimer) next();
    }

    async function choose() {
      if (sending) return;
      const items = menuItems();
      if (mode === 'command') {
        const pick = ['fight', 'bag', 'party', 'run'][cursor];
        if (pick === 'fight') {
          mode = 'fight';
          cursor = 0;
        } else if (pick === 'bag') {
          // The real bag (menu.js), read-only: items aren't used in battles here.
          if (hooks.bag) {
            hooks.bag().then(() => drawMenu());
            return;
          }
          mode = 'bag';
          cursor = 0;
        } else if (pick === 'party') {
          mode = 'party';
          cursor = Math.max(0, ((snap && snap.team) || []).findIndex((m) => m.active));
        } else if (pick === 'run') {
          if (!isWild()) {
            mode = 'wait';
            say(["No! There's no running from a trainer battle!"], () => toCommand());
            return;
          }
          pressCard('bt:forfeit');
          return;
        }
        drawMenu();
        return;
      }
      if (mode === 'fight') {
        const item = items[cursor];
        if (!item || item.disabled) return;
        if (megaArmed && button('bt:mega')) {
          // Mega first (it lights up), then the move goes with it.
          pendingMove = item.id;
          pressCard('bt:mega');
          return;
        }
        pressCard(item.id);
        return;
      }
      if (mode === 'bag') {
        back();
        return;
      }
      if (mode === 'party') {
        const team = (snap && snap.team) || [];
        if (cursor >= team.length) return back();
        const mon = team[cursor];
        if (!mon || mon.fainted) return say([`${mon ? mon.name : 'It'} has no energy left to battle!`], () => (mode = 'party', drawMenu()));
        if (mon.active) return say([`${mon.name} is already in battle!`], () => (mode = 'party', drawMenu()));
        if (button(`bt:send:${mon.index}`)) {
          pressCard(`bt:send:${mon.index}`);
          return;
        }
        if (button('bt:switch')) {
          pendingSend = mon.index;
          pressCard('bt:switch');
        }
        return;
      }
      if (mode === 'choice') {
        const item = items[cursor];
        if (!item || sending) return;
        sending = true;
        mode = 'wait';
        drawMenu();
        try {
          await hooks.press(item.message.id, item.id, item.values || []);
        } finally {
          sending = false;
        }
        return;
      }
      if (mode === 'done') close();
    }

    let pendingMove = null;

    function toggleMega() {
      megaArmed = !megaArmed;
      drawMenu();
    }

    function back() {
      if (mode === 'fight' || mode === 'bag' || (mode === 'party' && !forcedSwitch())) toCommand();
    }

    function toCommand() {
      if (!card || !hasLiveButtons(card)) return;
      if (forcedSwitch()) {
        mode = 'party';
        cursor = Math.max(0, ((snap && snap.team) || []).findIndex((m) => !m.fainted && !m.active));
        drawMenu();
        return;
      }
      if (!moveButtons().length) return; // a locked-in turn plays out on its own
      mode = 'command';
      cursor = 0;
      if (snap) setText(`What will ${snap.mine.name} do?`, true);
      drawMenu();
    }

    // -----------------------------------------------------------------------
    // The text box
    // -----------------------------------------------------------------------

    function setText(line, instant) {
      clearInterval(typing && typing.timer);
      typing = { line, shown: instant ? line.length : 0, done: instant, timer: null };
      text.textContent = instant ? line : '';
      if (instant) return;
      typing.timer = setInterval(() => {
        typing.shown += 1;
        text.textContent = line.slice(0, typing.shown);
        if (typing.shown >= line.length) {
          clearInterval(typing.timer);
          typing.done = true;
          typing.at = Date.now();
          more.hidden = !queue.length;
          // Lines move on by themselves during a turn; at the end, A is needed.
          if (queue.length && mode === 'wait') typing.auto = setTimeout(next, LINE_MS);
          else if (!queue.length) settle();
        }
      }, TYPE_MS);
    }

    function next() {
      clearTimeout(typing && typing.auto);
      clearTimeout(cueTimer);
      cueTimer = null;
      const item = queue.shift();
      if (!item) return settle();
      if (item.then) {
        item.then();
        return;
      }
      if (item.cue) {
        item.cue();
        if (item.ms) {
          cueTimer = setTimeout(() => {
            cueTimer = null;
            next();
          }, item.ms);
        } else next();
        return;
      }
      if (item.apply) {
        const before = snap;
        snap = item.apply;
        drawArena();
        // Whoever just lost HP blinks.
        if (before) {
          if (snap.foe.name === before.foe.name && snap.foe.hp < before.foe.hp) blink(foeMon);
          if (snap.mine.name === before.mine.name && snap.mine.hp < before.mine.hp) blink(mineMon);
        }
        next();
        return;
      }
      setText(item.line);
    }

    /** Everything said: offer the menu, a question, or the way out. */
    function settle() {
      if (queue.length) return;
      if (finished()) {
        const q = pendingQuestion();
        if (q) {
          if (mode !== 'choice') {
            mode = 'choice';
            cursor = 0;
          }
        } else {
          mode = 'done';
        }
        drawMenu();
        return;
      }
      if (mode === 'wait') toCommand();
    }

    const finished = () => Boolean(card && card.embeds[0].fields.length >= 3);

    // -----------------------------------------------------------------------
    // Input
    // -----------------------------------------------------------------------

    function input(key) {
      if (!open) return false;
      if (closing) return true;
      // While the opening plays out (no line on screen), A waits for it.
      if (cueTimer && key === 'a') return true;
      if (key === 'a') {
        if (typing && !typing.done) {
          clearInterval(typing.timer);
          typing.done = true;
          text.textContent = typing.line;
          if (!queue.length) settle();
          return true;
        }
        if (mode === 'wait' || (mode === 'done' && queue.length)) {
          next();
          return true;
        }
        choose();
        return true;
      }
      if (key === 'b') {
        back();
        return true;
      }
      if (['up', 'down', 'left', 'right'].includes(key)) {
        moveCursor(key);
        return true;
      }
      return true;
    }

    // -----------------------------------------------------------------------
    // Updates from the server
    // -----------------------------------------------------------------------

    /**
     * The player's battle messages changed.
     *
     * @param {object[]} feed      the Battle channel's messages, oldest first
     * @param {object|null} state  the latest snapshot (null once it's over)
     */
    function update(feed, state) {
      if (!open) return;
      let at = -1;
      for (let i = feed.length - 1; i >= 0; i--) {
        if (isCard(feed[i])) {
          at = i;
          break;
        }
      }
      const latest = at >= 0 ? feed[at] : null;
      if (!latest || latest.id === staleId) {
        // Not started yet, or refused (no Pokemon that will fight).
        const after = feed.slice(at + 1);
        const refusal = after.find((m) => m.content && !seen.has(`m:${m.id}`));
        if (refusal) {
          seen.add(`m:${refusal.id}`);
          mode = 'wait';
          say(linesOf(refusal.content), () => {
            mode = 'done';
            drawMenu();
          });
        }
        return;
      }

      const newBattle = !card || card.id !== latest.id;
      card = latest;
      feedAfter = feed.slice(at + 1);
      // A new battle shows at once; later changes wait for the turn's text.
      let later = null;
      if (state && (newBattle || !snap)) snap = state;
      else if (state) later = state;
      if (newBattle) {
        megaArmed = false;
        pendingSend = null;
        pendingMove = null;
        seen.add(`t:${latest.id}`);
        if (!later) drawArena();
        opening(plain(latest.embeds[0].title));
      }
      if (!later) drawArena();

      // Waiting on a two-step choice: Switch, then the one picked.
      if (pendingSend != null && button(`bt:send:${pendingSend}`)) {
        const id = `bt:send:${pendingSend}`;
        pendingSend = null;
        pressCard(id);
        return;
      }
      if (pendingMove && button('bt:mega') === null) {
        // Mega went through (its button is gone): now the move.
        const id = pendingMove;
        pendingMove = null;
        megaArmed = false;
        pressCard(id);
        return;
      }
      if (pendingMove && button(pendingMove)) {
        const id = pendingMove;
        pendingMove = null;
        megaArmed = false;
        pressCard(id);
        return;
      }

      // What happened this turn.
      const e = latest.embeds[0];
      const turnKey = `d:${latest.id}:${(e.footer && e.footer.text) || ''}:${e.description || ''}`;
      if (e.description && !seen.has(turnKey)) {
        seen.add(turnKey);
        const turn = linesOf(e.description).filter((l) => !/^what will/i.test(l)).filter(expWorthSaying);
        // HP drops after the first line (the attack), the rest after it all.
        if (later && turn.length) {
          queue.push({ line: turn[0] }, { apply: later }, ...turn.slice(1).map((line) => ({ line })));
          later = null;
        } else {
          queue.push(...turn.map((line) => ({ line })));
        }
      }
      if (later) queue.push({ apply: later });
      // The result, then everything posted after it.
      if (e.fields[2] && !seen.has(`r:${latest.id}`)) {
        seen.add(`r:${latest.id}`);
        queue.push(...resultLines(linesOf(e.fields[2].value)).map((line) => ({ line })));
      }
      for (const m of feedAfter) {
        const key = `m:${m.id}:${m.content || ''}:${(m.embeds || []).map((x) => x.title + x.description).join()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const lines = [...linesOf(m.content), ...(m.embeds || []).flatMap((x) => [...linesOf(x.title), ...linesOf(x.description)])];
        queue.push(...lines.filter(worthSaying).map((line) => ({ line })));
      }

      if (mode !== 'wait' && mode !== 'done' && mode !== 'choice') {
        // A new turn's text interrupts the menu.
        if (queue.length) mode = 'wait';
      }
      if (mode === 'choice' && !pendingQuestion()) mode = 'wait';
      if (mode === 'done' && queue.length) mode = 'wait';
      drawMenu();
      // (A cue still playing moves the queue on by itself.)
      if ((!typing || typing.done) && !cueTimer) {
        if (queue.length) next();
        else settle();
      }
    }

    function show(stale) {
      open = true;
      staleId = stale || null;
      card = null;
      snap = null;
      feedAfter = [];
      queue.length = 0;
      seen.clear();
      mode = 'wait';
      cursor = 0;
      sending = false;
      typing = null;
      text.textContent = '';
      foeBox.replaceChildren();
      mineBox.replaceChildren();
      foeMon.removeAttribute('src');
      mineMon.removeAttribute('src');
      introducing = false;
      clearTimeout(cueTimer);
      cueTimer = null;
      trainer.hidden = true;
      root.classList.remove('opening', 'lineups', 'closing');
      // Black until the opening plays (the transition left the screen black).
      root.classList.add('covered');
      foeBox.classList.add('off');
      mineBox.classList.add('off');
      arena.style.backgroundImage = `url(${BACKGROUNDS}/${hooks.background() || 'grass'}.png)`;
      root.hidden = false;
      drawMenu();
    }

    function close() {
      if (closing) return;
      closing = true;
      clearInterval(typing && typing.timer);
      clearTimeout(typing && typing.auto);
      clearTimeout(cueTimer);
      // Fade to black, then back to the world.
      root.classList.add('closing');
      setTimeout(() => {
        closing = false;
        open = false;
        root.hidden = true;
        root.classList.remove('closing');
        hooks.closed();
      }, 420);
    }

    return {
      show,
      update,
      input,
      close,
      get open() {
        return open;
      },
      /** The battle on screen is over and nothing is left to read or answer. */
      get finished() {
        return mode === 'done';
      },
    };
  }

  window.BattleScreen = { create, isCard, hasLiveButtons };
})();
