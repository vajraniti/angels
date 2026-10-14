// Plate II: the second instrument (brief 5.3, rebuilt per the critique). The emblem
// bleeds off the left edge and the price straddles its edge, so on Fludd's darkness
// the figures print in paper and beyond it in ink. Below: the 24 h change, an agate
// list (no repeat of the price), and a flat 24 h range rule that echoes the hero's
// cross. Each figure appears here once.

import { $, fill, fillGrouped, setDirection, setText, svgEl } from './dom.js';
import { formatPrice } from '../format.js';
import { plateColumn } from './kanji.js';
import { symbolView } from './view.js';
import { SYMBOL_INFO } from '../config.js';

/** @typedef {import('../market.js').MarketState} MarketState */

const PLATE_TITLE = Object.freeze({
  XAUUSDT: 'XAUUSDT, gold, perpetual.',
  CLUSDT: 'CLUSDT, WTI crude oil, perpetual.',
});

const EMBLEMS = Object.freeze({
  CLUSDT: {
    tone: 'dark',
    file: 'fludd-darkness',
    size: [400, 403],
    sizeSm: [216, 217],
    alt: 'Robert Fludd, the Great Darkness, 1617: an etched black square with ‘Et sic in infinitum’ on its four sides',
    caption: ['R. Fludd, ', 'Utriusque Cosmi', ', 1617. The darkness before the first day.'],
  },
  XAUUSDT: {
    tone: 'light',
    file: 'durer-sun',
    size: [400, 400],
    sizeSm: [216, 216],
    alt: 'Albrecht Dürer, 1498: the sun with a human face, its halo and rays, from St John Devouring the Book',
    caption: ['A. Dürer, ', 'St John Devouring the Book', ', 1498, detail. The sun, sign of gold.'],
  },
});

/**
 * @param {HTMLElement} root the Plate II section
 */
export function createPlate2(root) {
  const title = $('[data-plate2="title"]', root);
  const baseLabel = $('[data-plate2="base"]', root);
  const mincho = $('[data-plate2-mincho]', root);
  const range = /** @type {SVGSVGElement} */ (/** @type {unknown} */ ($('[data-rangebar]', root)));
  const pic = $('[data-emblem-pic]', root);
  const cap = $('[data-emblem-cap]', root);
  let symbol = root.dataset.symbol ?? 'CLUSDT';
  let rangeKey = '';
  let minchoKey = '';
  /** @type {MarketState|null} */
  let last = null;

  function setSymbol(/** @type {string} */ sym) {
    if (sym === symbol) return;
    symbol = sym;
    root.dataset.symbol = sym;
    const info = SYMBOL_INFO[/** @type {keyof typeof SYMBOL_INFO} */ (sym)];
    setText(title, PLATE_TITLE[/** @type {keyof typeof PLATE_TITLE} */ (sym)]);
    setText(baseLabel, info.base);
    const e = EMBLEMS[/** @type {keyof typeof EMBLEMS} */ (sym)];
    root.dataset.emblem = e.tone;
    const source = $('source', pic);
    source.setAttribute('srcset', `assets/${e.file}-sm.png 1x, assets/${e.file}-sm@2x.png 2x`);
    source.setAttribute('width', String(e.sizeSm[0]));
    source.setAttribute('height', String(e.sizeSm[1]));
    const img = /** @type {HTMLImageElement} */ ($('img', pic));
    img.src = `assets/${e.file}.png`;
    img.srcset = `assets/${e.file}.png 1x, assets/${e.file}@2x.png 2x`;
    img.width = e.size[0];
    img.height = e.size[1];
    img.alt = e.alt;
    const i = document.createElement('i');
    i.textContent = e.caption[1];
    cap.replaceChildren(e.caption[0], i, e.caption[2]);
    rangeKey = '';
    minchoKey = '';
    if (last) update(last, Date.now());
  }

  /**
   * The 24 h range laid flat: low to high, the open as a short tick, the last price
   * as a bar. Drawn as a hand-ruled double hairline.
   * @param {import('../market.js').SymbolState} s
   */
  function drawRange(s) {
    const W = Math.round(range.clientWidth);
    const d = s.priceDecimals ?? 2;
    const key = [W, s.low24h, s.high24h, s.open24h, s.last, d].join('|');
    if (key === rangeKey) return;
    rangeKey = key;
    range.replaceChildren();
    if (!W) return;
    const H = 86;
    const y = 44;
    range.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const { low24h: lo, high24h: hi } = s;
    if (lo === null || hi === null || !(hi > lo)) {
      range.setAttribute('aria-label', '24 hour range: not yet known');
      return;
    }
    range.setAttribute(
      'aria-label',
      `24 hour range from ${formatPrice(lo, d)} to ${formatPrice(hi, d)}` +
        (s.last === null ? '' : `, last ${formatPrice(s.last, d)}`) +
        (s.open24h === null ? '' : `, open ${formatPrice(s.open24h, d)}`),
    );
    const X = (/** @type {number} */ v) => 1 + ((v - lo) / (hi - lo)) * (W - 2);
    svgEl(
      'path',
      { d: `M0.5 ${y - 0.3}L${W - 0.5} ${y + 0.2}`, stroke: '#111', 'stroke-width': 0.9, fill: 'none' },
      range,
    );
    svgEl(
      'path',
      { d: `M0.5 ${y + 0.5}L${W - 0.5} ${y + 0.1}`, stroke: '#111', 'stroke-width': 0.5, fill: 'none' },
      range,
    );
    for (const v of [lo, hi])
      svgEl('path', { d: `M${X(v)} ${y - 7}V${y + 7}`, stroke: '#111', 'stroke-width': 1 }, range);
    const text = (
      /** @type {number} */ x,
      /** @type {number} */ yy,
      /** @type {string} */ s2,
      /** @type {string} */ a,
      cls = '',
    ) => {
      const t = svgEl('text', { x, y: yy, 'text-anchor': a, class: cls }, range);
      t.textContent = s2;
    };
    text(0, y + 24, formatPrice(lo, d), 'start');
    text(0, y + 37, '24H LOW', 'start', 'cap');
    text(W, y + 24, formatPrice(hi, d), 'end');
    text(W, y + 37, '24H HIGH', 'end', 'cap');
    if (s.open24h !== null && s.open24h >= lo && s.open24h <= hi) {
      const xo = X(s.open24h);
      svgEl('path', { d: `M${xo} ${y}V${y + 9}`, stroke: '#111', 'stroke-width': 1 }, range);
      // Keep the italic "open" clear of the end figures.
      const anchor = xo < W * 0.2 ? 'start' : xo > W * 0.8 ? 'end' : 'middle';
      text(xo, y + 24, `open ${formatPrice(s.open24h, d)}`, anchor, 'it');
    }
    if (s.last !== null) {
      const xl = Math.min(W - 2, Math.max(2, X(s.last)));
      svgEl('rect', { x: xl - 1.5, y: y - 20, width: 3, height: 27, fill: '#111' }, range);
      const right = xl < W * 0.7;
      text(right ? xl + 8 : xl - 8, y - 10, `last ${formatPrice(s.last, d)}`, right ? 'start' : 'end', 'it');
    }
  }

  /**
   * @param {MarketState} state
   * @param {number} serverNow
   */
  function update(state, serverNow) {
    last = state;
    const s = state.symbols[symbol];
    const v = symbolView(s, serverNow);
    fill(root, 'v', /** @type {Record<string, string>} */ (/** @type {unknown} */ (v)));
    fillGrouped(root, /** @type {Record<string, string>} */ (/** @type {unknown} */ (v)));
    setDirection($('.p2__change .g', root), v.direction);
    const lines = plateColumn(symbol, s.fundingIntervalHours);
    const key = lines.join('|');
    if (key !== minchoKey) {
      minchoKey = key;
      mincho.replaceChildren(
        ...lines.map((line) => {
          const span = document.createElement('span');
          span.textContent = line;
          return span;
        }),
      );
    }
    drawRange(s);
  }

  new ResizeObserver(() => {
    rangeKey = '';
    if (last) drawRange(last.symbols[symbol]);
  }).observe(range);

  return { update, setSymbol };
}
