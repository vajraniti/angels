// Geometry of the funding clock in the hero (critique: it replaces the gunsight).
// The dial is one UTC day. Its index is fixed (the page layout must not move with
// the time of day), so the dial turns under it like a bezel: "now" always sits at
// `nowAngle`, the elapsed part of the funding interval runs back from it, and the
// settlement hours are ticks wherever they fall. Angles are radians, clockwise from
// twelve o'clock. Pure functions, unit-tested.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TAU = Math.PI * 2;

/**
 * @typedef {Object} FundingDial
 * @property {number} remainingMs        Until the next settlement (0 once it is due).
 * @property {number|null} elapsedMs    Since the previous settlement; null without the interval.
 * @property {number|null} elapsedFrac  elapsedMs / interval, 0..1; null without the interval.
 * @property {number|null} arcStart     Angle of the previous settlement; null without the interval.
 * @property {number} arcEnd             Angle of now (= nowAngle).
 * @property {{ t: number, hour: string, angle: number, next: boolean, prev: boolean }[]} ticks
 *           Settlements within ±12 h of now, `hour` as "00".."23" UTC; `prev` is the one
 *           that opened the current interval, `next` the one it runs to.
 */

/**
 * @param {{ now: number, nextFundingTime: number|null, intervalHours: number|null, nowAngle?: number }} p
 *        `now` and `nextFundingTime` on the same (server) clock
 * @returns {FundingDial|null} null while the next funding time is unknown
 */
export function fundingDial({ now, nextFundingTime, intervalHours, nowAngle = 0 }) {
  if (typeof nextFundingTime !== 'number' || !Number.isFinite(nextFundingTime)) return null;
  const remainingMs = Math.max(0, nextFundingTime - now);
  const angleOf = (/** @type {number} */ t) => nowAngle + ((t - now) / DAY) * TAU;
  const interval =
    typeof intervalHours === 'number' && Number.isFinite(intervalHours) && intervalHours > 0
      ? intervalHours * HOUR
      : null;

  /** @type {FundingDial['ticks']} */
  const ticks = [];
  if (interval === null) {
    ticks.push({
      t: nextFundingTime,
      hour: utcHour(nextFundingTime),
      angle: angleOf(nextFundingTime),
      next: true,
      prev: false,
    });
  } else {
    // Walk the settlement grid anchored at nextFundingTime across the visible day.
    const first = nextFundingTime - Math.floor((nextFundingTime - (now - DAY / 2)) / interval) * interval;
    for (let t = first; t <= now + DAY / 2; t += interval) {
      if (t <= now - DAY / 2) continue;
      ticks.push({
        t,
        hour: utcHour(t),
        angle: angleOf(t),
        next: t === nextFundingTime,
        prev: t === nextFundingTime - interval,
      });
    }
  }

  if (interval === null) {
    return { remainingMs, elapsedMs: null, elapsedFrac: null, arcStart: null, arcEnd: nowAngle, ticks };
  }
  const elapsedMs = Math.min(interval, Math.max(0, interval - (nextFundingTime - now)));
  return {
    remainingMs,
    elapsedMs,
    elapsedFrac: elapsedMs / interval,
    arcStart: nowAngle - (elapsedMs / DAY) * TAU,
    arcEnd: nowAngle,
    ticks,
  };
}

/** @param {number} t */
function utcHour(t) {
  return String(new Date(t).getUTCHours()).padStart(2, '0');
}

/**
 * Point on the dial.
 * @param {number} cx
 * @param {number} cy
 * @param {number} r
 * @param {number} angle clockwise from twelve o'clock
 */
export function polar(cx, cy, r, angle) {
  return { x: cx + r * Math.sin(angle), y: cy - r * Math.cos(angle) };
}

/**
 * A hand-drawn hairline arc from a0 to a1 (clockwise): a polyline whose radius
 * trembles by up to `wobble` px. The same seed gives the same line, so it does not
 * shimmer when redrawn; two passes with different seeds make the doubled stroke.
 * @param {{ cx: number, cy: number, r: number, a0: number, a1: number, seed: number, wobble?: number }} p
 * @returns {string} SVG path data
 */
export function jitteredArc({ cx, cy, r, a0, a1, seed, wobble = 0.45 }) {
  if (!(a1 >= a0)) throw new RangeError(`jitteredArc: end angle ${a1} is before start ${a0}`);
  const span = a1 - a0;
  // About one vertex per 3 px of arc, at least two.
  const n = Math.max(2, Math.ceil((span * r) / 3));
  let s = seed >>> 0 || 1;
  const rnd = () => {
    // xorshift32: tiny, seeded, good enough for a tremor.
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
  let d = '';
  let drift = 0;
  for (let i = 0; i <= n; i++) {
    // A random walk, not white noise: a hand drifts, it does not buzz.
    drift = Math.max(-1, Math.min(1, drift + (rnd() - 0.5) * 0.6));
    const p = polar(cx, cy, r + drift * wobble, a0 + (span * i) / n);
    d += `${i ? 'L' : 'M'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
  }
  return d;
}
