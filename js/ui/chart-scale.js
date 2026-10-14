// Pure layout arithmetic of Plate I: which candles fit, the price scale, the grid
// values, time labels, and pointer-to-candle mapping. The canvas code only paints.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A round grid step (1, 2, 2.5, 5 × 10^k) giving about `count` lines over `range`.
 * @param {number} range
 * @param {number} count
 */
export function niceStep(range, count) {
  if (!(range > 0) || !(count > 0)) throw new RangeError(`niceStep: range ${range} and count ${count} must be > 0`);
  const raw = range / count;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 2.25 ? 2 : m < 3.5 ? 2.5 : m < 7.5 ? 5 : 10) * p;
}

/**
 * Decimals needed to print multiples of `step` without losing digits (2.5 → 1).
 * @param {number} step
 */
export function stepDecimals(step) {
  for (let d = 0; d <= 8; d++) if (Math.abs(Math.round(step * 10 ** d) - step * 10 ** d) < 1e-6) return d;
  return 8;
}

/**
 * Grid values inside [min, max], multiples of `step`.
 * @param {number} min
 * @param {number} max
 * @param {number} step
 */
export function gridValues(min, max, step) {
  const out = [];
  const first = Math.ceil(min / step);
  for (let k = first; k * step <= max + step * 1e-9; k++) out.push(Number((k * step).toFixed(10)));
  return out;
}

/**
 * The most recent candles that fit `plotWidth` at about `pitch` px each.
 * @param {number} total candles available
 * @param {number} plotWidth
 * @param {number} pitch preferred px per candle
 * @returns {{ start: number, count: number, step: number }} `step` is the exact px per candle
 */
export function visibleWindow(total, plotWidth, pitch) {
  if (total <= 0 || plotWidth <= 0) return { start: 0, count: 0, step: pitch };
  const fit = Math.max(1, Math.floor(plotWidth / pitch));
  const count = Math.min(total, fit);
  // Few candles (a fresh listing, a long interval) keep the preferred pitch and sit at
  // the right, where the newest data is, instead of stretching into fat bars.
  return { start: total - count, count, step: count === fit ? plotWidth / count : pitch };
}

/**
 * Price extent of the visible candles with a margin, so wicks never touch the frame.
 * @param {readonly { h: number, l: number }[]} candles
 * @param {number} [pad] share of the range added above and below
 */
export function priceExtent(candles, pad = 0.07) {
  let hi = -Infinity;
  let lo = Infinity;
  for (const c of candles) {
    if (c.h > hi) hi = c.h;
    if (c.l < lo) lo = c.l;
  }
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  // A flat market still needs a non-zero scale.
  const span = hi - lo || Math.abs(hi) * 0.001 || 1;
  return { hi, lo, max: hi + span * pad, min: lo - span * pad };
}

/**
 * Label under a candle on the time axis.
 * @param {number} t open time, ms UTC
 * @param {string} interval
 */
export function timeLabel(t, interval) {
  const d = new Date(t);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  if (interval === '1d') return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  if (interval === '4h') return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${hh}h`;
  // At midnight a date says more than "00:00".
  if (hh === '00' && mm === '00') return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return `${hh}:${mm}`;
}

/**
 * Index of the candle under a pointer at `x` (px from the plot's left edge), or −1.
 * @param {number} x
 * @param {{ count: number, step: number, offset: number }} w offset: px before the first candle
 */
export function candleAt(x, { count, step, offset }) {
  if (count <= 0) return -1;
  const i = Math.floor((x - offset) / step);
  return Math.max(0, Math.min(count - 1, i));
}

/**
 * Share of a forming candle's period that has passed, 0..1.
 * @param {{ t: number, T: number }} candle
 * @param {number} now server time
 */
export function formingFraction(candle, now) {
  const len = candle.T + 1 - candle.t;
  if (!(len > 0)) return 0;
  return Math.min(1, Math.max(0, (now - candle.t) / len));
}

/** Ordered 4×4 Bayer matrix (brief 4.5), values 0..15. */
export const BAYER4 = Object.freeze([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]);

/**
 * Whether pixel (x, y) is inked at screen density `level` (0..1).
 * @param {number} x
 * @param {number} y
 * @param {number} level
 */
export function bayerOn(x, y, level) {
  return (BAYER4[(y & 3) * 4 + (x & 3)] + 0.5) / 16 < level;
}
