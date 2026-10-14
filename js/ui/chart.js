// Plate I: the candlestick chart, set as an engraved plate (brief 5.4). Axis on the
// right only, hollow up and solid down candles, the forming candle screened with an
// ordered Bayer pattern inside its own body, 1 px barcode volume, dotted 24 h high
// and low, a dimension line for the visible range, and one red tick at the last price.
// Canvas, sized to the device pixel ratio and redrawn on resize.

import { formatNumber, formatPrice, formatCompact, formatUtcClock, formatUtcDate } from '../format.js';
import {
  bayerOn,
  candleAt,
  formingFraction,
  gridValues,
  niceStep,
  priceExtent,
  stepDecimals,
  timeLabel,
  visibleWindow,
} from './chart-scale.js';
import { $, pixelRatio, reducedMotion, setText } from './dom.js';
import { chartNote } from './kanji.js';

const INK = '#111111';
const PAPER = '#fbfbf9';
const RED = '#a3121c';
const INTERVAL_NAME = Object.freeze({
  '1m': '1 min',
  '5m': '5 min',
  '15m': '15 min',
  '1h': '1 hour',
  '4h': '4 hours',
  '1d': '1 day',
});

/** @typedef {import('../parse.js').Candle} Candle */
/** @typedef {import('../market.js').MarketState} MarketState */

/**
 * @param {HTMLElement} root the Plate I section
 * @param {{ serverNow: () => number }} clock
 */
export function createChart(root, { serverNow }) {
  const canvas = /** @type {HTMLCanvasElement} */ ($('[data-chart]', root));
  const msg = $('[data-chart-msg]', root);
  const ohlc = $('[data-chart-ohlc]', root);
  const title = $('[data-plate1="title"]', root);
  const mincho = $('[data-plate1="mincho"]', root);

  /** @type {MarketState|null} */
  let state = null;
  /** @type {{ x: number, y: number }|null} */
  let pointer = null;
  let queued = false;
  /** @type {{ offset: number, step: number, count: number, start: number, P: { l: number, r: number, t: number }, priceH: number, min: number, max: number }|null} */
  let geom = null;
  let revealUntil = 0;
  let wasLoading = true;

  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      try {
        draw();
      } catch (err) {
        console.error('Drawing Plate I failed', err);
      }
    });
  }

  function draw() {
    if (!state) return;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    if (!W || !H) return;
    const dpr = pixelRatio();
    const bw = Math.round(W * dpr);
    const bh = Math.round(H * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Plate I: this browser gives no 2D canvas');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const ch = state.chart;
    const sym = state.symbols[ch.symbol];
    const dec = sym.priceDecimals ?? 2;
    const mobile = W < 600;
    const all = ch.candles;

    if (all.length === 0) {
      geom = null;
      msg.hidden = false;
      setText(msg, chartMessage(ch));
      setText(ohlc, '');
      return;
    }
    msg.hidden = true;

    const P = { l: mobile ? 12 : 22, r: mobile ? 58 : 74, t: 30, b: 26 };
    const plotW = W - P.l - P.r;
    const win = visibleWindow(all.length, plotW, mobile ? 6 : 9);
    const cs = all.slice(win.start);
    const step = win.step;
    const offset = P.l + (plotW - step * cs.length);
    const volH = Math.round((H - P.t - P.b) * 0.17);
    const gapH = 16;
    const priceH = H - P.t - P.b - volH - gapH;
    const ext = priceExtent(cs);
    if (!ext) return;
    const { min, max } = ext;
    const Y = (/** @type {number} */ v) => P.t + ((max - v) / (max - min)) * priceH;
    const X = (/** @type {number} */ i) => offset + (i + 0.5) * step;
    geom = { offset, step, count: cs.length, start: win.start, P, priceH, min, max };

    ctx.fillStyle = INK;
    ctx.textBaseline = 'alphabetic';
    setFont(ctx, 500, mobile ? 10.5 : 11, 'condensed');

    // Grid values stand on dotted lines; the axis is on the right only.
    const gstep = niceStep(max - min, mobile ? 5 : 6);
    const gdec = Math.max(stepDecimals(gstep), 0);
    const lastY = sym.last === null ? null : Y(sym.last);
    for (const v of gridValues(min, max, gstep)) {
      const y = Math.round(Y(v));
      ctx.globalAlpha = 0.55;
      dotted(ctx, P.l, W - P.r + 6, y);
      ctx.globalAlpha = 1;
      ctx.textAlign = 'right';
      if (lastY === null || Math.abs(y - 3 - (lastY + 4)) > 13) ctx.fillText(formatNumber(v, gdec), W - 8, y - 3);
    }

    // Panel names inside the frame.
    ctx.save();
    setFont(ctx, 600, 10, 'expanded');
    ctx.letterSpacing = '2px';
    ctx.textAlign = 'left';
    ctx.fillText('PRICE, USDT', P.l + (mobile ? 6 : 24), P.t - 13);
    ctx.restore();

    // 24 h high and low as dotted rules; their italic labels go on after the candles.
    /** @type {{ label: string, x: number, y: number }[]} */
    const rangeLabels = [];
    for (const [v, name, above] of /** @type {[number|null, string, boolean][]} */ ([
      [sym.high24h, '24h high', true],
      [sym.low24h, '24h low', false],
    ])) {
      if (v === null || v < min || v > max) continue;
      const y = Math.round(Y(v));
      dashed(ctx, P.l, W - P.r, y, [2, 3]);
      rangeLabels.push({
        label: `${name} ${formatPrice(v, dec)}`,
        x: P.l + (mobile ? 8 : 34),
        y: above ? y - 5 : y + 14,
      });
    }

    // Candles and their volume strokes.
    const body = Math.max(1, Math.floor(step * 0.62) | 1);
    let vmax = 0;
    for (const c of cs) if (c.q > vmax) vmax = c.q;
    const volBase = P.t + priceH + gapH + volH;
    const now = serverNow();
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i];
      const x = Math.round(X(i));
      const yo = Y(c.o);
      const yc = Y(c.c);
      const yh = Math.round(Y(c.h));
      const yl = Math.round(Y(c.l));
      const top = Math.round(Math.min(yo, yc));
      const bot = Math.max(top + 1, Math.round(Math.max(yo, yc)));
      const bx = x - (body - 1) / 2;
      ctx.fillStyle = INK;
      ctx.fillRect(x, yh, 1, Math.max(0, top - yh));
      ctx.fillRect(x, bot, 1, Math.max(0, yl - bot + 1));
      if (!c.closed) {
        // Forming: outlined body screened at the share of its period already gone
        // (critique: the screen stays inside the candle's own high-low span and
        // width; above and below the body it is a third as dense).
        const level = formingFraction(c, now);
        for (let yy = yh; yy <= yl; yy++) {
          const lv = yy > top && yy < bot ? level : level * 0.35;
          for (let xx = bx + 1; xx < bx + body - 1; xx++) if (bayerOn(xx, yy, lv)) ctx.fillRect(xx, yy, 1, 1);
        }
        outline(ctx, bx, top, body, bot);
      } else if (c.c >= c.o) {
        outline(ctx, bx, top, body, bot);
      } else {
        ctx.fillRect(bx, top, body, bot - top + 1);
      }
      // Volume capped at 80 % of its panel so the tallest stroke clears the label.
      const vh = vmax > 0 ? Math.max(1, Math.round((c.q / vmax) * (volH - 4) * 0.8)) : 0;
      ctx.fillRect(x, volBase - vh, c.c >= c.o ? 1 : 2, vh);
    }

    // Range labels, knocked out of the candles as an engraver letters inside a plate.
    ctx.save();
    ctx.font = 'italic 400 12px "Bodoni Moda", serif';
    ctx.textAlign = 'left';
    for (const r of rangeLabels) {
      ctx.fillStyle = PAPER;
      ctx.fillRect(r.x - 3, r.y - 10, ctx.measureText(r.label).width + 6, 13);
      ctx.fillStyle = INK;
      ctx.fillText(r.label, r.x, r.y);
    }
    ctx.restore();

    // Volume scale: one number, the tallest stroke.
    ctx.save();
    setFont(ctx, 500, 10.5, 'condensed');
    ctx.textAlign = 'right';
    const vTop = volBase - Math.round((volH - 4) * 0.8);
    ctx.fillText(formatCompact(vmax), W - 8, vTop + 4);
    ctx.globalAlpha = 0.55;
    dotted(ctx, P.l, W - P.r + 6, vTop);
    ctx.restore();
    ctx.save();
    setFont(ctx, 600, 10, 'expanded');
    ctx.letterSpacing = '2px';
    ctx.textAlign = 'left';
    ctx.fillText('VOLUME, USDT', P.l + (mobile ? 6 : 24), P.t + priceH + gapH + 2);
    ctx.restore();
    // 2 px rule between the panels.
    ctx.fillRect(P.l - (mobile ? 6 : 12), P.t + priceH + 4, W - P.l - P.r + (mobile ? 6 : 12) + 4, 2);

    // Dimension line: the visible range, high to low.
    {
      const x = P.l - (mobile ? 4 : 8);
      const y0 = Math.round(Y(ext.hi));
      const y1 = Math.round(Y(ext.lo));
      ctx.fillRect(x, y0, 1, y1 - y0);
      ctx.fillRect(x - 3, y0, 7, 1);
      ctx.fillRect(x - 3, y1, 7, 1);
      if (!mobile) {
        ctx.save();
        ctx.translate(x + 10, (y0 + y1) / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.font = 'italic 400 11.5px "Bodoni Moda", serif';
        ctx.textAlign = 'center';
        const label = `range ${formatPrice(ext.hi - ext.lo, dec)}`;
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = PAPER;
        ctx.fillRect(-tw / 2 - 4, -10, tw + 8, 14);
        ctx.fillStyle = INK;
        ctx.fillText(label, 0, 0);
        ctx.restore();
      }
    }

    // Time axis.
    ctx.fillStyle = INK;
    ctx.textAlign = 'center';
    setFont(ctx, 500, 10.5, 'condensed');
    const every = Math.max(1, Math.round((mobile ? 72 : 100) / step));
    for (let i = cs.length - 1; i >= 0; i -= every) {
      const x = Math.round(X(i));
      if (x < P.l + 24) break;
      ctx.fillRect(x, H - P.b + 2, 1, 4);
      ctx.fillText(timeLabel(cs[i].t, ch.interval), x, H - 8);
    }

    // The last price: this screen's one red mark.
    const lastPrice = cs[cs.length - 1].c;
    {
      const y = Math.round(Y(lastPrice));
      ctx.fillStyle = RED;
      ctx.fillRect(W - P.r + 2, y, mobile ? 6 : 12, 1);
      ctx.textAlign = 'right';
      setFont(ctx, 600, 11.5, 'condensed');
      ctx.fillText(formatPrice(lastPrice, dec), W - 8, y + 4);
    }

    // Pointer: two hairlines to the frame and a ring, value on the axis.
    const hover = pointer && geom ? candleAt(pointer.x, geom) : -1;
    if (hover >= 0 && pointer) {
      const x = Math.round(X(hover)) + 0.5;
      const yy = Math.round(Math.max(P.t, Math.min(P.t + priceH, pointer.y))) + 0.5;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(x, 4);
      ctx.lineTo(x, H - P.b);
      ctx.moveTo(4, yy);
      ctx.lineTo(W - P.r + 2, yy);
      ctx.stroke();
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.arc(x, yy, 6, 0, Math.PI * 2);
      ctx.stroke();
      const v = max - ((yy - P.t) / priceH) * (max - min);
      ctx.fillStyle = INK;
      ctx.fillRect(W - P.r + 2, yy - 8, P.r - 4, 16);
      ctx.fillStyle = PAPER;
      ctx.textAlign = 'right';
      setFont(ctx, 500, 11, 'condensed');
      ctx.fillText(formatPrice(v, dec), W - 8, yy + 4);
      showOhlc(cs[hover], dec, false);
    } else {
      showOhlc(cs[cs.length - 1], dec, true);
    }

    // First data after loading comes in through a Bayer screen, not a skeleton.
    const t = performance.now();
    if (t < revealUntil) {
      const left = (revealUntil - t) / 600;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = PAPER;
      const cell = Math.max(1, Math.round(2 * dpr));
      for (let yy = 0; yy < bh; yy += cell) {
        for (let xx = 0; xx < bw; xx += cell) {
          if (bayerOn(xx / cell, yy / cell, left)) ctx.fillRect(xx, yy, cell, cell);
        }
      }
      ctx.restore();
      schedule();
    }
  }

  /**
   * @param {Candle} c
   * @param {number} dec
   * @param {boolean} isLast
   */
  function showOhlc(c, dec, isLast) {
    const when = `${formatUtcDate(c.t)}, ${formatUtcClock(c.t, { seconds: false })} UTC`;
    const label = isLast && !c.closed ? 'Forming candle of' : 'Candle of';
    const parts = [
      ['O', formatPrice(c.o, dec)],
      ['H', formatPrice(c.h, dec)],
      ['L', formatPrice(c.l, dec)],
      ['C', formatPrice(c.c, dec)],
      ['Vol', `${formatNumber(c.q, 0)} USDT`],
    ];
    const key = `${label}|${when}|${parts.map((p) => p[1]).join('|')}`;
    if (ohlc.dataset.key === key) return;
    ohlc.dataset.key = key;
    const nodes = [document.createTextNode(`${label} ${when}`)];
    for (const [k, v] of parts) {
      const span = document.createElement('span');
      const b = document.createElement('b');
      b.textContent = k;
      span.append(b, v);
      // The space sits between the spans, where the line may break.
      nodes.push(document.createTextNode(' '), span);
    }
    ohlc.replaceChildren(...nodes);
  }

  /**
   * @param {MarketState['chart']} ch
   */
  function chartMessage(ch) {
    if (ch.error) {
      const retry = typeof ch.error.retryAt === 'number' ? ' Retrying shortly.' : '';
      return `No candles: ${ch.error.message}.${retry}`;
    }
    return `Loading ${INTERVAL_NAME[/** @type {keyof typeof INTERVAL_NAME} */ (ch.interval)] ?? ch.interval} candles for ${ch.symbol} from Binance…`;
  }

  /** @param {PointerEvent} e */
  function onPointer(e) {
    const r = canvas.getBoundingClientRect();
    pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
    schedule();
  }
  canvas.addEventListener('pointermove', onPointer);
  canvas.addEventListener('pointerdown', onPointer);
  canvas.addEventListener('pointerleave', () => {
    pointer = null;
    schedule();
  });
  // A finger lifted from a touch screen leaves no hover; keep the last read-out.
  canvas.addEventListener('pointercancel', () => {
    pointer = null;
    schedule();
  });

  new ResizeObserver(() => schedule()).observe(canvas);

  return {
    /** @param {MarketState} next */
    update(next) {
      const prev = state;
      state = next;
      const ch = next.chart;
      if (!prev || prev.chart.symbol !== ch.symbol || prev.chart.interval !== ch.interval) {
        setText(
          title,
          `${ch.symbol}, perpetual, ${INTERVAL_NAME[/** @type {keyof typeof INTERVAL_NAME} */ (ch.interval)] ?? ch.interval}.`,
        );
        setText(mincho, chartNote(ch.symbol, ch.interval));
        for (const b of root.querySelectorAll('[data-interval]')) {
          b.setAttribute('aria-pressed', String(/** @type {HTMLElement} */ (b).dataset.interval === ch.interval));
        }
        pointer = null;
      }
      const loading = ch.candles.length === 0;
      if (wasLoading && !loading && !reducedMotion()) revealUntil = performance.now() + 600;
      wasLoading = loading;
      schedule();
    },
    /** The forming candle's screen darkens with time even without trades. */
    tick() {
      schedule();
    },
  };
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} weight
 * @param {number} size
 * @param {'condensed'|'expanded'|'normal'} stretch
 */
function setFont(ctx, weight, size, stretch) {
  ctx.font = `${weight} ${size}px Archivo, "Helvetica Neue", Arial, sans-serif`;
  if ('fontStretch' in ctx) /** @type {any} */ (ctx).fontStretch = stretch;
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x0
 * @param {number} x1
 * @param {number} y
 */
function dotted(ctx, x0, x1, y) {
  for (let x = Math.ceil(x0); x <= x1; x += 3) ctx.fillRect(x, y, 1, 1);
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x0
 * @param {number} x1
 * @param {number} y
 * @param {number[]} pattern
 */
function dashed(ctx, x0, x1, y, pattern) {
  let x = x0;
  let i = 0;
  while (x < x1) {
    const len = pattern[i % pattern.length];
    if (i % 2 === 0) ctx.fillRect(x, y, Math.min(len, x1 - x), 1);
    x += len;
    i++;
  }
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} bx
 * @param {number} top
 * @param {number} body
 * @param {number} bot
 */
function outline(ctx, bx, top, body, bot) {
  ctx.fillRect(bx, top, body, 1);
  ctx.fillRect(bx, bot, body, 1);
  ctx.fillRect(bx, top, 1, bot - top + 1);
  ctx.fillRect(bx + body - 1, top, 1, bot - top + 1);
}
