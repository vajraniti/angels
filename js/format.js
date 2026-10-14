// Number and time formatting with the brief's typesetting rules: thin space (U+2009)
// between thousands, a true minus (U+2212), decimals fixed per instrument, and a
// placeholder instead of a number whenever the value is unknown.

export const THIN_SPACE = ' ';
export const MINUS = '−';
/** Printed for any value that is null, undefined or not finite. Never a fake zero. */
export const PLACEHOLDER = '—';

/** @param {unknown} v */
function known(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Digits of |value| at `decimals` places, grouped by thin spaces; also whether the
 * rounded value is zero (so −0.004 at 2 places prints "0.00", not "−0.00").
 * @param {number} value
 * @param {number} decimals
 */
function digits(value, decimals) {
  const fixed = Math.abs(value).toFixed(decimals);
  const dot = fixed.indexOf('.');
  const int = dot === -1 ? fixed : fixed.slice(0, dot);
  const frac = dot === -1 ? '' : fixed.slice(dot);
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, THIN_SPACE);
  return { text: grouped + frac, zero: Number(fixed) === 0 };
}

/**
 * 4012.35 → "4 012.35" (thin space); −1234.5 → "−1 234.50".
 * @param {number|null|undefined} value
 * @param {number} decimals
 */
export function formatNumber(value, decimals) {
  if (!known(value)) return PLACEHOLDER;
  const d = digits(/** @type {number} */ (value), decimals);
  return /** @type {number} */ (value < 0 && !d.zero ? MINUS : '') + d.text;
}

/**
 * Price at the symbol's own precision. `decimals` null (not yet known) falls back to 2.
 * @param {number|null|undefined} value
 * @param {number|null|undefined} decimals SymbolState.priceDecimals
 */
export function formatPrice(value, decimals) {
  return formatNumber(value, decimals ?? 2);
}

/**
 * Always signed: "+16.79", "−0.81"; zero (after rounding) has no sign: "0.00".
 * @param {number|null|undefined} value
 * @param {number} decimals
 */
export function formatSigned(value, decimals) {
  if (!known(value)) return PLACEHOLDER;
  const d = digits(/** @type {number} */ (value), decimals);
  if (d.zero) return d.text;
  return /** @type {number} */ (value < 0 ? MINUS : '+') + d.text;
}

/**
 * Percent already in percent units: 0.42 → "+0.42%".
 * @param {number|null|undefined} value
 * @param {{ decimals?: number, signed?: boolean }} [options]
 */
export function formatPercent(value, { decimals = 2, signed = true } = {}) {
  if (!known(value)) return PLACEHOLDER;
  return `${signed ? formatSigned(value, decimals) : formatNumber(value, decimals)}%`;
}

/**
 * Funding rate given as a fraction per interval, printed the way Binance does:
 * 0.0001 → "+0.0100%", −0.000042 → "−0.0042%".
 * @param {number|null|undefined} rate
 */
export function formatFundingRate(rate) {
  if (!known(rate)) return PLACEHOLDER;
  return formatPercent(/** @type {number} */ (rate) * 100, { decimals: 4 });
}

const COMPACT_UNITS = [
  { at: 1, suffix: '' },
  { at: 1e3, suffix: 'K' },
  { at: 1e6, suffix: 'M' },
  { at: 1e9, suffix: 'B' },
  { at: 1e12, suffix: 'T' },
];

/**
 * Short volume: 1284512330 → "1.28B", 186402115 → "186.40M", 950 → "950".
 * A value that rounds up to 1000 of a unit moves to the next one ("1.00B", not "1000.00M").
 * @param {number|null|undefined} value
 * @param {number} [decimals] decimals for K and above; plain numbers print as integers
 */
export function formatCompact(value, decimals = 2) {
  if (!known(value)) return PLACEHOLDER;
  const v = /** @type {number} */ (value);
  const abs = Math.abs(v);
  let i = 0;
  while (i < COMPACT_UNITS.length - 1 && abs >= COMPACT_UNITS[i + 1].at) i++;
  for (;;) {
    const places = i === 0 ? 0 : decimals;
    const scaled = Number((abs / COMPACT_UNITS[i].at).toFixed(places));
    if (scaled >= 1000 && i < COMPACT_UNITS.length - 1) {
      i++;
      continue;
    }
    return formatNumber(Math.sign(v) * scaled, places) + COMPACT_UNITS[i].suffix;
  }
}

/** @param {number} n */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Time left as "HH:MM:SS" (hours can exceed 24: "26:00:00"). Negative or unknown
 * values print "00:00:00" / the placeholder respectively; seconds are floored so the
 * display reaches 00:00:00 exactly when the time is up.
 * @param {number|null|undefined} ms
 */
export function formatCountdown(ms) {
  if (!known(ms)) return PLACEHOLDER;
  const total = Math.max(0, Math.floor(/** @type {number} */ (ms) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

/**
 * UTC wall clock: "20:42:18" (or "20:42" without seconds).
 * @param {number|null|undefined} ms epoch milliseconds
 * @param {{ seconds?: boolean }} [options]
 */
export function formatUtcClock(ms, { seconds = true } = {}) {
  if (!known(ms)) return PLACEHOLDER;
  const d = new Date(/** @type {number} */ (ms));
  const hm = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  return seconds ? `${hm}:${pad2(d.getUTCSeconds())}` : hm;
}

/** English month abbreviations, shared with the chart's time axis. */
export const MONTHS = Object.freeze([
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]);

/**
 * UTC date for the imprint: "13 Oct 2026".
 * @param {number|null|undefined} ms
 */
export function formatUtcDate(ms) {
  if (!known(ms)) return PLACEHOLDER;
  const d = new Date(/** @type {number} */ (ms));
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * Elapsed time for "last update 41 s ago": "0 s", "41 s", "3 min", "2 h", "5 d".
 * @param {number|null|undefined} ms elapsed milliseconds
 */
export function formatAge(ms) {
  if (!known(ms)) return PLACEHOLDER;
  const s = Math.max(0, Math.floor(/** @type {number} */ (ms) / 1000));
  if (s < 60) return `${s}${THIN_SPACE}s`;
  if (s < 3600) return `${Math.floor(s / 60)}${THIN_SPACE}min`;
  if (s < 86400) return `${Math.floor(s / 3600)}${THIN_SPACE}h`;
  return `${Math.floor(s / 86400)}${THIN_SPACE}d`;
}
