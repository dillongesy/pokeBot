'use strict';

/**
 * The screen going into a battle, as in the handheld games. Drawn at the
 * GBA's 240 x 160 and scaled up, over the overworld:
 *
 *   wild      two white flashes, then black closing in from every edge with
 *             tall grass along its border (the Black/White way)
 *   trainer   two flashes, then black bars sliding in from alternate sides
 *
 * play() resolves once the screen is black. The black stays until the
 * battle screen is up; then call the handle's remove().
 */

(function () {
  const W = 240;
  const H = 160;
  const FLASH_MS = 360;
  const WIPE_MS = { wild: 820, trainer: 900 };
  const HOLD_MS = 120;

  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);
  const clamp = (v) => Math.max(0, Math.min(1, v));
  /** A steady pseudo-random number per blade, so the grass doesn't flicker. */
  const rand = (i) => {
    const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  };

  /** Two quick white flashes. */
  function flashes(g, t) {
    const phase = Math.floor(t / (FLASH_MS / 4));
    if (phase % 2 === 0) {
      g.fillStyle = 'rgba(248,248,248,0.92)';
      g.fillRect(0, 0, W, H);
    }
  }

  /** One blade of grass pointing inward from an edge. */
  function blade(g, x, y, dx, dy, length, lean, i) {
    // (dx, dy): the way it points; (px, py): along the edge.
    const px = -dy;
    const py = dx;
    const w = 3 + rand(i * 3) * 2;
    const tipX = x + dx * length + px * lean;
    const tipY = y + dy * length + py * lean;
    g.fillStyle = '#16381a';
    g.beginPath();
    g.moveTo(x - px * w, y - py * w);
    g.lineTo(tipX, tipY);
    g.lineTo(x + px * w, y + py * w);
    g.closePath();
    g.fill();
    // A lighter stripe down the middle of the blade.
    g.fillStyle = '#2f7a36';
    g.beginPath();
    g.moveTo(x - px * 1, y - py * 1);
    g.lineTo(x + dx * length * 0.8 + px * lean * 0.8, y + dy * length * 0.8 + py * lean * 0.8);
    g.lineTo(x + px * 1, y + py * 1);
    g.closePath();
    g.fill();
  }

  /** Wild: black closes in from all four edges, fringed with grass. */
  function grassWipe(g, p) {
    const e = ease(p);
    const dx = e * (W / 2 + 18);
    const dy = e * (H / 2 + 18);
    g.fillStyle = '#000';
    g.fillRect(0, 0, dx, H);
    g.fillRect(W - dx, 0, dx, H);
    g.fillRect(0, 0, W, dy);
    g.fillRect(0, H - dy, W, dy);
    const fadeOut = 1 - clamp((p - 0.82) / 0.18);
    if (fadeOut <= 0) return;
    g.globalAlpha = fadeOut;
    const sway = Math.sin(p * 9) * 2;
    let i = 0;
    for (let y = -4; y < H + 4; y += 6) {
      i += 1;
      blade(g, dx, y, 1, 0, 7 + rand(i) * 12, sway + (rand(i + 50) - 0.5) * 6, i);
      blade(g, W - dx, y, -1, 0, 7 + rand(i + 9) * 12, sway + (rand(i + 70) - 0.5) * 6, i + 9);
    }
    for (let x = -4; x < W + 4; x += 6) {
      i += 1;
      blade(g, x, dy, 0, 1, 6 + rand(i) * 10, sway + (rand(i + 30) - 0.5) * 6, i);
      blade(g, x, H - dy, 0, -1, 6 + rand(i + 5) * 10, sway + (rand(i + 90) - 0.5) * 6, i + 5);
    }
    g.globalAlpha = 1;
  }

  /**
   * Trainer: black bars slide in from alternate sides, each a little after
   * the one above, until the screen is shut. (No POKé BALL here: balls are
   * only ever thrown for POKéMON, in the battle itself.)
   */
  function barWipe(g, p) {
    const bars = 10;
    const bh = H / bars;
    g.fillStyle = '#000';
    for (let i = 0; i < bars; i++) {
      const q = ease(clamp(p * 1.6 - i * 0.06));
      const w = q * W;
      if (i % 2) g.fillRect(W - w, i * bh, w, bh + 0.5);
      else g.fillRect(0, i * bh, w, bh + 0.5);
    }
  }

  /**
   * @param {HTMLElement} container  the game screen
   * @param {'wild'|'trainer'|'milestone'} kind
   * @returns {Promise<{remove: () => void}>}
   */
  function play(container, kind) {
    const style = kind === 'wild' ? 'wild' : 'trainer';
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    canvas.className = 'transition';
    container.append(canvas);
    const g = canvas.getContext('2d');
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const total = reduced ? 300 : FLASH_MS + WIPE_MS[style] + HOLD_MS;
    const start = performance.now();
    const handle = { remove: () => canvas.remove() };
    return new Promise((resolve) => {
      function frame(now) {
        const t = now - start;
        g.clearRect(0, 0, W, H);
        if (reduced) {
          g.fillStyle = `rgba(0,0,0,${clamp(t / 300)})`;
          g.fillRect(0, 0, W, H);
        } else if (t < FLASH_MS) {
          flashes(g, t);
        } else {
          const p = clamp((t - FLASH_MS) / WIPE_MS[style]);
          if (style === 'wild') grassWipe(g, p);
          else barWipe(g, p);
        }
        if (t < total) {
          requestAnimationFrame(frame);
        } else {
          g.fillStyle = '#000';
          g.fillRect(0, 0, W, H);
          resolve(handle);
        }
      }
      requestAnimationFrame(frame);
    });
  }

  window.Transition = { play };
})();
