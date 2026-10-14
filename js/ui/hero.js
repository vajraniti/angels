// The first screen: a collage of the main instrument (brief 5.2, sketch v2 "Collage A").
// Depths, back to front: the 1-bit dissolve of its letters (blur = 24 h range
// percentile), the crisp Didone price cut by the right edge, the vertical script
// word, the data cross (stem = 24 h low to high, a notch at the last price), and the
// funding clock. Numbers sit on the perimeter. The second instrument is a small block
// with a pointer to Plate II; the switch swaps the two roles. The sharp layer is set
// twice, in ink and in paper; js/ui/mass.js masks the two copies to the mass.

import { $, $$, fill, fillGrouped, setDirection, setText } from './dom.js';
import { createMass, measureGlyphs } from './mass.js';
import { fundingDial, jitteredArc, polar } from './clock.js';
import { heroColumn } from './kanji.js';
import { symbolView } from './view.js';
import { SYMBOL_INFO } from '../config.js';
import { PLACEHOLDER } from '../format.js';

const SCRIPT_WORD = Object.freeze({ XAUUSDT: 'aurum', CLUSDT: 'oleum' });
const MARGIN_NAME = Object.freeze({ XAUUSDT: 'XAUUSDT · gold, perpetual', CLUSDT: 'CLUSDT · WTI crude, perpetual' });
const SECOND_TITLE = Object.freeze({ XAUUSDT: 'XAUUSDT · gold', CLUSDT: 'CLUSDT · WTI crude' });
const SECTION_TITLE = Object.freeze({ XAUUSDT: 'XAUUSDT, gold perpetual', CLUSDT: 'CLUSDT, WTI crude oil perpetual' });
/** One noise seed per instrument: its plate. Dürer 1498 for gold, Fludd 1617 for oil. */
const SEEDS = Object.freeze({ XAUUSDT: 1498, CLUSDT: 1617 });
/**
 * Letter spacing of the mass, in em. Two letters set tight are too narrow to reach
 * under the price; spaced, they carry the script word between them as X and A do.
 */
const TRACKING = Object.freeze({ XAUUSDT: 0, CLUSDT: 0.24 });
/**
 * How far the price's top reaches up into the mass, as a share of its type size,
 * [desktop, mobile]. Oil's figures sit lower so the 7's bar lands in the solid foot
 * of the L rather than in the grain above it; on a phone gold's sit a little lower
 * too, so most of each digit stands below the mass's dithered foot.
 */
const PRICE_REACH = Object.freeze({ XAUUSDT: [0.56, 0.42], CLUSDT: [0.3, 0.3] });
const MOBILE_MAX = 760;
/**
 * A settlement tick closer than this to the dial's index (radians, about 25°) is set
 * inside the ring: outside it, its hour label would print over the funding rate or the
 * countdown, which sit just above the index.
 */
const NEAR_INDEX = 0.44;
const MINUTE = 60_000;

/** @typedef {import('../market.js').MarketState} MarketState */

/**
 * @typedef {Object} HeroLayout
 * @property {number} W
 * @property {number} H
 * @property {boolean} mobile
 * @property {{ size: number, x: number, baseline: number, width: number, tracking: number }} mass
 * @property {{ x: number, y0: number, y1: number, w: number }} cross
 * @property {{ cx: number, cy: number, r: number }} dial
 */

/**
 * @param {HTMLElement} root the .hero section
 */
export function createHero(root) {
  const inkLayer = $('[data-crisp]', root);
  const paperLayer = $('[data-crisp-paper]', root);
  // The paper copy is a clone, so both copies can never drift apart in structure.
  paperLayer.replaceChildren(...[...inkLayer.childNodes].map((n) => n.cloneNode(true)));
  const layers = [inkLayer, paperLayer];
  const sr = $('[data-hero-sr]', root);
  const peri = [$('.peri--vol', root), $('.peri--oi', root)];
  const second = $('[data-second]', root);
  const mincho = $('[data-hero-mincho]', root);
  const notice = $('[data-hero-notice]', root);
  const mass = createMass({
    echoCanvas: /** @type {HTMLCanvasElement} */ ($('[data-mass-echo]', root)),
    inkCanvas: /** @type {HTMLCanvasElement} */ ($('[data-mass-ink]', root)),
    inkLayer,
    paperLayer,
  });

  let main = 'XAUUSDT';
  let other = 'CLUSDT';
  /** @type {HeroLayout|null} */
  let layout = null;
  let fontsReady = false;
  /** @type {Record<string, ReturnType<typeof measureGlyphs>>} */
  const glyphs = {};
  let lastPriceText = '';
  let lastMinchoKey = '';
  /** @type {Record<string, string>} markup last written per geo group */
  const geoMarkup = { cross: '', dial: '' };
  /** --script-x from the mass's letters, before the cross's numbers push it right */
  let scriptBaseX = 0;
  let scriptX = '';
  /** @type {Element[]} the dial's funding figure in both copies of the sharp layer */
  let dialFunding = [];
  /** @type {Element[]} the dial's countdown in both copies */
  let dialCountdown = [];
  let crossNums = '';

  function base(/** @type {string} */ sym) {
    return SYMBOL_INFO[/** @type {keyof typeof SYMBOL_INFO} */ (sym)]?.base ?? sym;
  }

  function computeLayout() {
    const r = root.getBoundingClientRect();
    const W = Math.round(r.width);
    const H = Math.round(r.height);
    const mobile = W <= MOBILE_MAX;
    const text = base(main);
    // Mobile sets the letters tight: at 100vw they already reach under the price.
    const tracking = mobile ? 0 : (TRACKING[/** @type {keyof typeof TRACKING} */ (main)] ?? 0);
    const g = (glyphs[`${text}|${tracking}`] ??= measureGlyphs(text, tracking));
    const short = text.length < 3;

    let size;
    let x;
    let baseline;
    if (mobile) {
      // XAU about 120vw with part of the X cut by the left edge (critique, mobile).
      size = Math.min(((short ? 1.0 : 1.2) * W) / g.width, (0.19 * H) / g.ascent);
      x = -(short ? 0.08 : 0.15) * W - g.left * size;
      baseline = 0.55 * H;
    } else {
      size = Math.min(((short ? 0.8 : 0.79) * W) / g.width, (0.42 * H) / g.ascent);
      x = -(short ? 0.02 : 0.055) * W - g.left * size;
      baseline = 0.6 * H;
    }
    const capTop = baseline - g.ascent * size;
    const cross = mobile
      ? { x: Math.round(0.86 * W), y0: Math.round(0.085 * H), y1: Math.round(capTop - 0.02 * H), w: 8 }
      : { x: Math.round(0.136 * W), y0: Math.round(0.085 * H), y1: Math.round(0.93 * H), w: 12 };
    const dial = mobile
      ? { cx: Math.round(0.46 * W), cy: Math.round(0.22 * H), r: Math.round(0.12 * W) }
      : { cx: Math.round(0.745 * W), cy: Math.round(0.33 * H), r: Math.round(Math.min(0.1 * W, 0.19 * H)) };
    layout = { W, H, mobile, mass: { size, x, baseline, width: g.width * size, tracking }, cross, dial };

    // CSS positions that depend on the mass: the price's top third overlaps the
    // mass's foot, and the script word crosses between the first two letters.
    const priceFont = parseFloat(getComputedStyle($('.price', inkLayer)).fontSize) || 0.186 * W;
    const reach = (PRICE_REACH[/** @type {keyof typeof PRICE_REACH} */ (main)] ?? [0.5, 0.5])[mobile ? 1 : 0];
    root.style.setProperty('--price-top', `${Math.round(baseline - reach * priceFont)}px`);
    if (mobile) {
      scriptBaseX = Math.round(0.035 * W);
      root.style.setProperty('--script-y', `${Math.round(capTop - 0.2 * H)}px`);
    } else {
      // Desktop: the word crosses into the second letter where its ink is solid: the
      // gap after X for gold, the stem of the L for oil.
      const first = (glyphs[text[0]] ??= measureGlyphs(text[0]));
      const nudge = short ? 0.03 : -0.035;
      const secondStart = x + (first.width + first.left + tracking) * size;
      scriptBaseX = Math.round(secondStart + nudge * W);
      root.style.setProperty('--script-y', '8%');
    }
    setScriptX(scriptBaseX);
    // Mobile stacks open interest and the status notice under the price block.
    const box = $('[data-pricebox]', inkLayer).getBoundingClientRect();
    root.style.setProperty('--below-price', `${Math.round(box.bottom - r.top + 0.035 * H)}px`);
    for (const layer of layers) $('[data-geo]', layer).setAttribute('viewBox', `0 0 ${W} ${H}`);
    // Geometry depends on the layout: rewrite it on the next update.
    geoMarkup.cross = '';
    geoMarkup.dial = '';
    crossNums = '';
  }

  // ------------------------------------------------------------ geometry markup

  /** @param {number} px */
  function setScriptX(px) {
    const v = `${Math.round(px)}px`;
    if (v === scriptX) return;
    scriptX = v;
    root.style.setProperty('--script-x', v);
  }

  /**
   * The data cross: a Latin cross whose stem spans the 24 h low (foot) to high
   * (head). The crossbar stays in the upper third whatever the price does (critique:
   * no upside-down cross); the last price is a notch in the stem with a hairline.
   * @param {HeroLayout} L
   * @param {{ high: string, low: string, f: number|null }} d
   */
  function crossMarkup(L, d) {
    const { x, y0, y1, w } = L.cross;
    const len = y1 - y0;
    const yBar = Math.round(y0 + 0.27 * len);
    const half = w / 2;
    // On a narrow desktop the stem stands close to the left edge: the left arm stops
    // 16 px short of it instead of being cut, and the right one matches it.
    const arm = Math.max(half + 8, Math.min(Math.round(len / 6), x - 16));
    // Numbers sit right of the stem on desktop, left of it on mobile, where the stem
    // stands near the right edge.
    const side = L.mobile ? -1 : 1;
    const rect = (
      /** @type {number} */ x0,
      /** @type {number} */ ya,
      /** @type {number} */ x1,
      /** @type {number} */ yb,
    ) => (yb > ya ? `M${x0} ${ya}H${x1}V${yb}H${x0}Z` : '');
    let parts = '';
    let live = '';
    if (d.f === null) {
      parts = rect(x - half, y0, x + half, y1);
    } else {
      const yl = Math.round(y1 - d.f * len);
      parts = rect(x - half, y0, x + half, yl - 2) + rect(x - half, yl + 2, x + half, y1);
      // A hairline out of the notch on the side away from the HIGH/LOW labels, so a
      // price at a 24 h extreme never strikes through them.
      live = `<path class="stroke" stroke-width="1" d="M${x - side * (half + 3)} ${yl + 0.5}H${x - side * (half + 20)}"/>`;
    }
    parts += rect(x - arm, yBar - half, x - half, yBar + half) + rect(x + half, yBar - half, x + arm, yBar + half);
    const labelX = x + side * (half + 12);
    const numX = labelX + side * 16;
    const anchor = L.mobile ? 'end' : 'start';
    const lab = (
      /** @type {number} */ y,
      /** @type {string} */ word,
      /** @type {string} */ value,
      /** @type {boolean} */ head,
    ) =>
      `<text class="l" transform="translate(${labelX} ${y}) rotate(-90)" text-anchor="${head ? 'end' : 'start'}" dy="${
        L.mobile ? '0' : '0.8em'
      }">${word}</text>` +
      `<text class="n" x="${numX}" y="${head ? y + 12 : y}" text-anchor="${anchor}">${escapeXml(value)}</text>`;
    return `<path d="${parts}"/>` + live + lab(y0, 'High', d.high, true) + lab(y1, 'Low', d.low, false);
  }

  /**
   * The funding clock: elapsed part of the funding interval as a doubled, trembling
   * hairline; settlement hours as ticks; one short red radial tick at now with the
   * funding rate and its red † right beside it, the countdown on the other side.
   * The geometry is drawn from a time rounded to the minute (the arc moves a quarter
   * of a degree a minute), and the two figures that change every second are text
   * nodes updated in place (dialFigures), so the group is rebuilt once a minute
   * rather than on every tick.
   * @param {HeroLayout} L
   * @param {ReturnType<typeof fundingDial>} dial
   * @param {{ every: string }} d
   */
  function dialMarkup(L, dial, d) {
    const { cx, cy, r } = L.dial;
    const top = polar(cx, cy, r, 0);
    let out = '';
    if (dial) {
      if (dial.arcStart !== null && dial.arcEnd > dial.arcStart) {
        out += `<path class="stroke" stroke-width="0.9" d="${jitteredArc({ cx, cy, r, a0: dial.arcStart, a1: dial.arcEnd, seed: 41 })}"/>`;
        out += `<path class="stroke" stroke-width="0.6" d="${jitteredArc({
          cx: cx + 0.5,
          cy: cy - 0.4,
          r: r * 1.006,
          a0: dial.arcStart + 0.004,
          a1: dial.arcEnd - 0.003,
          seed: 17,
        })}"/>`;
      }
      // Only the settlement that opened this interval and the one it runs to: the
      // others would land in the price and say nothing the countdown does not.
      for (const t of dial.ticks) {
        if (!t.next && !t.prev) continue;
        const len = t.next ? 13 : 8;
        // Near the index the tick and its hour go inside the ring, clear of the figures.
        const dir = Math.abs(t.angle) < NEAR_INDEX ? -1 : 1;
        const a = polar(cx, cy, r + dir * 4, t.angle);
        const b = polar(cx, cy, r + dir * (4 + len), t.angle);
        out += `<path class="stroke" stroke-width="${t.next ? 1.1 : 0.8}" d="M${a.x.toFixed(1)} ${a.y.toFixed(1)}L${b.x.toFixed(
          1,
        )} ${b.y.toFixed(1)}"/>`;
        const p = polar(cx, cy, r + dir * (4 + len + 11), t.angle);
        out += `<text class="h" x="${p.x.toFixed(1)}" y="${(p.y + 4).toFixed(1)}" text-anchor="middle">${t.hour}${
          t.next ? '\u2009UTC' : ''
        }</text>`;
      }
      // Now: the dial's fixed index, the first red mark of this screen.
      out += `<path class="redstroke" stroke-width="1.5" d="M${top.x} ${top.y + 8}V${top.y - 9}"/>`;
    }
    const valueY = top.y - 10;
    const labelY = valueY - 19;
    // Funding ends with † right against the red tick: one meaning, two red marks.
    const known = d.every !== PLACEHOLDER;
    const label = L.mobile || !known ? 'Funding' : `Funding, ${escapeXml(d.every)}`;
    out += `<text class="l" x="${top.x - 9}" y="${labelY}" text-anchor="end">${label}</text>`;
    out += `<text class="n" x="${top.x - 8}" y="${valueY}" text-anchor="end"><tspan data-dial="funding">${PLACEHOLDER}</tspan>${
      dial ? '<tspan class="red dag" dx="1">†</tspan>' : ''
    }</text>`;
    out += `<text class="l" x="${top.x + 9}" y="${labelY}">Next</text>`;
    out += `<text class="n" x="${top.x + 9}" y="${valueY}" data-dial="countdown">${PLACEHOLDER}</text>`;
    return out;
  }

  /**
   * The dial's two live figures, set in place in both copies of the sharp layer.
   * @param {{ funding: string, countdown: string }} d
   */
  function dialFigures(d) {
    for (const el of dialFunding) setText(el, d.funding);
    for (const el of dialCountdown) setText(el, d.countdown);
  }

  /**
   * @param {'cross'|'dial'} group
   * @param {string} markup
   * @returns {boolean} whether the markup changed
   */
  function writeGeo(group, markup) {
    if (geoMarkup[group] === markup) return false;
    geoMarkup[group] = markup;
    for (const layer of layers) {
      const g = layer.querySelector(`[data-geo-${group}]`);
      if (g) g.innerHTML = markup;
    }
    if (group === 'dial') {
      dialFunding = layers.flatMap((l) => $$('[data-dial="funding"]', l));
      dialCountdown = layers.flatMap((l) => $$('[data-dial="countdown"]', l));
    }
    return true;
  }

  /**
   * Desktop: the vertical script word stands right of the cross's numbers. On a narrow
   * window the place the mass gives it would put it on the HIGH figure.
   */
  function clearScriptOfCross() {
    const L = /** @type {HeroLayout} */ (layout);
    if (L.mobile) return;
    let right = 0;
    for (const t of inkLayer.querySelectorAll('[data-geo-cross] text.n')) {
      const box = /** @type {SVGGraphicsElement} */ (t).getBBox();
      right = Math.max(right, box.x + box.width);
    }
    setScriptX(Math.max(scriptBaseX, right + 10));
  }

  // ------------------------------------------------------------ updates

  /**
   * @param {string} text
   */
  function setPrice(text) {
    if (text === lastPriceText) return;
    lastPriceText = text;
    for (const layer of layers) fillGrouped(layer, { last: text });
  }

  /**
   * @param {MarketState} state
   * @param {number} serverNow
   */
  function update(state, serverNow) {
    if (!layout) computeLayout();
    const L = /** @type {HeroLayout} */ (layout);
    const s = state.symbols[main];
    const v = symbolView(s, serverNow);
    const strings = /** @type {Record<string, string>} */ (/** @type {unknown} */ (v));

    setPrice(v.last);
    // Without a price the giant slot stays empty paper: a 270 px em dash cut by the
    // edge reads as a stray rule, and the notice already says what is missing.
    root.classList.toggle('is-empty', !v.known);
    for (const layer of layers) {
      fill(layer, 'v', strings);
      setDirection($('.change .g', layer), v.direction);
    }
    fill(sr, 'v', strings);
    for (const p of peri) fill(p, 'v', strings);

    const v2 = symbolView(state.symbols[other], serverNow);
    fill(second, 'v', /** @type {Record<string, string>} */ (/** @type {unknown} */ (v2)));
    fillGrouped(second, /** @type {Record<string, string>} */ (/** @type {unknown} */ (v2)));
    setDirection($('.g', second), v2.direction);

    // The cross: where the last price sits between the 24 h low and high.
    const f =
      s.last !== null && s.high24h !== null && s.low24h !== null && s.high24h > s.low24h
        ? Math.min(1, Math.max(0, (s.last - s.low24h) / (s.high24h - s.low24h)))
        : null;
    writeGeo('cross', crossMarkup(L, { high: v.high, low: v.low, f }));
    // The numbers' width moves the script word, not the notch: measure only when they change.
    const nums = `${v.high}|${v.low}|${L.W}x${L.H}`;
    if (nums !== crossNums) {
      crossNums = nums;
      clearScriptOfCross();
    }
    const dial = fundingDial({
      now: Math.floor(serverNow / MINUTE) * MINUTE,
      nextFundingTime: s.nextFundingTime,
      intervalHours: s.fundingIntervalHours,
    });
    writeGeo('dial', dialMarkup(L, dial, { every: v.fundingEvery }));
    dialFigures({ funding: v.funding, countdown: v.countdown });

    const column = heroColumn(main, v.countdownMs);
    const minchoKey = column.join('|');
    if (minchoKey !== lastMinchoKey) {
      lastMinchoKey = minchoKey;
      mincho.replaceChildren(
        ...column.map((line) => {
          const span = document.createElement('span');
          span.textContent = line;
          return span;
        }),
      );
    }

    if (fontsReady) {
      mass
        .render({
          text: base(main),
          tracking: L.mass.tracking,
          seed: SEEDS[/** @type {keyof typeof SEEDS} */ (main)] ?? 1,
          width: L.W,
          height: L.H,
          size: L.mass.size,
          x: L.mass.x,
          baseline: L.mass.baseline,
          massWidth: L.mass.width,
          percentile: s.rangePercentile30d,
          changePct: s.changePct24h,
        })
        .catch((err) => {
          console.error('Rendering the dissolve mass failed', err);
        });
    }
  }

  /**
   * @param {import('./view.js').StatusView} st
   */
  function setNotice(st) {
    // While live, a side problem (open interest not refreshed) is shown as a quiet
    // detail line only.
    const show = st.headline !== null || st.detail !== null;
    notice.hidden = !show;
    if (!show) return;
    setText($('[data-notice="headline"]', notice), st.headline ?? '');
    // Each part is its own sentence; the data layer's messages carry no full stop.
    const sentence = (/** @type {string|null} */ t) =>
      t ? `${t[0].toUpperCase()}${t.slice(1)}${/[.!?…]$/.test(t) ? '' : '.'}` : null;
    const detail = [sentence(st.age), sentence(st.detail), sentence(st.retry)].filter(Boolean).join(' ');
    setText($('[data-notice="detail"]', notice), detail);
  }

  /**
   * @param {string} symbol
   */
  function setMain(symbol) {
    if (symbol === main) return;
    other = main;
    main = symbol;
    root.dataset.main = symbol;
    lastPriceText = '';
    for (const layer of layers)
      setText($('[data-hero-script]', layer), SCRIPT_WORD[/** @type {keyof typeof SCRIPT_WORD} */ (symbol)]);
    setText($('[data-hero="marg"]', root), MARGIN_NAME[/** @type {keyof typeof MARGIN_NAME} */ (symbol)]);
    setText($('[data-hero="title"]', root), SECTION_TITLE[/** @type {keyof typeof SECTION_TITLE} */ (symbol)]);
    setText($('[data-hero="oiUnit"]', root), base(symbol));
    setText($('[data-second="title"]', root), SECOND_TITLE[/** @type {keyof typeof SECOND_TITLE} */ (other)]);
    layout = null;
  }

  return {
    update,
    setNotice,
    setMain,
    /** Re-measure after a resize; the next update redraws what depends on size. */
    relayout: computeLayout,
    /** Fonts arrived: glyph metrics change, so measure and draw the mass again. */
    fontsLoaded() {
      fontsReady = true;
      for (const k of Object.keys(glyphs)) delete glyphs[k];
      mass.invalidate();
      computeLayout();
    },
  };
}

/** @param {string} s */
function escapeXml(s) {
  return s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] ?? c);
}
