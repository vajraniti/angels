// Pure candle bookkeeping: merging stream updates into a REST snapshot, and the
// 30-day range percentile. No I/O here, so every rule is unit-tested directly.

/** @typedef {import('./parse.js').Candle} Candle */

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/**
 * Length of a Binance kline interval in ms ('15m' → 900000). Months have no fixed
 * length and are not used by the screener.
 * @param {string} interval
 */
export function intervalMs(interval) {
  const m = /^(\d+)([mhdw])$/.exec(interval);
  if (!m) throw new RangeError(`Unsupported kline interval "${interval}"`);
  return Number(m[1]) * UNIT_MS[/** @type {'m'|'h'|'d'|'w'} */ (m[2])];
}

/**
 * Whether `incoming` should replace `existing` (same open time).
 * A closed candle is final: only another closed version (a fresh REST snapshot) may
 * replace it, so a late "still forming" update can never reopen it. Between two
 * forming versions the trade count decides, because it only grows while the candle
 * forms; this makes the merge independent of arrival order.
 * @param {Candle} existing
 * @param {Candle} incoming
 */
export function supersedes(existing, incoming) {
  if (existing.closed) return incoming.closed;
  if (incoming.closed) return true;
  return incoming.n >= existing.n;
}

/**
 * Merge one candle into an ascending list.
 * - same open time: replaced if `supersedes` says so;
 * - newer than the last: appended; a forming predecessor is marked closed, since a
 *   newer candle proves its period ended (its close event was missed);
 * - older than the last: inserted or replaced at its position (late REST/stream mix);
 * - the list is trimmed from the front to `maxLength`.
 * `gap` reports a jump of more than one interval at the end, i.e. candles were missed
 * and the caller should resynchronise from REST.
 * @param {readonly Candle[]} candles
 * @param {Candle} candle
 * @param {{ maxLength: number, intervalMs?: number }} options
 * @returns {{ candles: readonly Candle[], changed: boolean, gap: boolean }}
 */
export function mergeCandle(candles, candle, { maxLength, intervalMs: step }) {
  const n = candles.length;
  if (n === 0) return { candles: [candle], changed: true, gap: false };
  const last = candles[n - 1];

  if (candle.t > last.t) {
    const gap = step !== undefined && candle.t - last.t > step;
    const next = candles.slice();
    if (!last.closed) next[n - 1] = { ...last, closed: true };
    next.push(candle);
    return { candles: trim(next, maxLength), changed: true, gap };
  }

  const i = findIndex(candles, candle.t);
  if (i >= 0) {
    if (!supersedes(candles[i], candle)) return { candles, changed: false, gap: false };
    const next = candles.slice();
    next[i] = candle;
    return { candles: next, changed: true, gap: false };
  }
  // Older than everything we hold and the list is already full: it would be trimmed
  // straight away, so keep the list as it is.
  if (candle.t < candles[0].t && n >= maxLength) return { candles, changed: false, gap: false };
  const at = -i - 1;
  const next = candles.slice();
  next.splice(at, 0, candle);
  return { candles: trim(next, maxLength), changed: true, gap: false };
}

/**
 * Combine a fresh REST snapshot with what the stream delivered meanwhile. The snapshot
 * is the base; stream candles win only where `supersedes` allows (newer forming data,
 * or candles after the snapshot's end).
 * @param {readonly Candle[]} snapshot ascending
 * @param {readonly Candle[]} updates   in arrival order
 * @param {number} maxLength
 */
export function mergeSnapshot(snapshot, updates, maxLength) {
  let out = trim(snapshot.slice(), maxLength);
  for (const c of updates) out = mergeCandle(out, c, { maxLength }).candles;
  return out;
}

/**
 * Binary search by open time. Returns the index, or −(insertion point) − 1.
 * @param {readonly Candle[]} candles
 * @param {number} t
 */
function findIndex(candles, t) {
  let lo = 0;
  let hi = candles.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const mt = candles[mid].t;
    if (mt === t) return mid;
    if (mt < t) lo = mid + 1;
    else hi = mid - 1;
  }
  return -lo - 1;
}

/**
 * @template T
 * @param {T[]} list
 * @param {number} maxLength
 */
function trim(list, maxLength) {
  return list.length > maxLength ? list.slice(list.length - maxLength) : list;
}

/**
 * High−low ranges of the most recent `days` closed daily candles.
 * @param {readonly Candle[]} daily ascending 1d candles
 * @param {number} days
 */
export function dailyRanges(daily, days) {
  return daily
    .filter((c) => c.closed)
    .slice(-days)
    .map((c) => c.h - c.l);
}

/**
 * Percentile rank (0–100) of `range` among `ranges`, counting ties as half
 * ("mid-rank"), so a value equal to every sample sits at 50 rather than 0 or 100.
 * @param {number|null|undefined} range today's rolling 24 h high − low
 * @param {readonly number[]} ranges
 * @param {number} minSamples fewer samples than this gives null
 * @returns {number|null}
 */
export function rangePercentile(range, ranges, minSamples) {
  if (range === null || range === undefined || !Number.isFinite(range) || ranges.length < minSamples) return null;
  let below = 0;
  let equal = 0;
  for (const r of ranges) {
    if (r < range) below++;
    else if (r === range) equal++;
  }
  return ((below + equal / 2) / ranges.length) * 100;
}
