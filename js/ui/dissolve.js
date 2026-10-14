// The 1-bit "dissolve" of the instrument's letters (brief 4.1, 4.2). Pure and
// deterministic: alpha in, a byte per pixel out, no DOM, so it is unit-tested in
// Node and the page only has to paint the result.
//
// The market drives two things:
// - how far the letters fall apart: the 24 h range's percentile among the last 30
//   daily ranges, quantised to 8 steps so a tick never re-renders the mass;
// - which way they fall apart: the leading edge faces the 24 h move (up-right when
//   up, down-right when down) and stays hard, the grain trails behind it.

/** Output codes of renderDissolve. */
export const PAPER = 0;
export const INK = 1;
export const ECHO = 2;

export const BLUR_STEPS = 8;
/** Blur radius as a share of the type size: k in brief 4.1, from calm to storm. */
const K_CALM = 0.02;
const K_STORM = 0.12;
/** Alpha levels and gamma (brief 4.1, step 4): the gamma lengthens the tail. */
const LEVEL_LO = 0.08;
const LEVEL_HI = 0.85;
const GAMMA = 1.45;

/**
 * Quantised blur step 0..7 from a 0–100 percentile, or null when it is unknown.
 * @param {number|null|undefined} percentile
 */
export function blurStep(percentile) {
  if (typeof percentile !== 'number' || !Number.isFinite(percentile)) return null;
  const p = Math.min(100, Math.max(0, percentile));
  return Math.min(BLUR_STEPS - 1, Math.floor(p / (100 / BLUR_STEPS)));
}

/** @param {number} step 0..BLUR_STEPS-1 */
export function blurK(step) {
  return K_CALM + (step / (BLUR_STEPS - 1)) * (K_STORM - K_CALM);
}

/**
 * Direction the grain trails in: opposite to the move, with time running right.
 * Up: the mass leads up-right and trails down-left. Down: leads down-right, trails
 * up-left. Flat or unknown: trails straight left.
 * @param {number|null|undefined} changePct
 * @returns {{ x: -1|0|1, y: -1|0|1 }}
 */
export function trailOf(changePct) {
  if (typeof changePct !== 'number' || !Number.isFinite(changePct) || changePct === 0) return { x: -1, y: 0 };
  return changePct > 0 ? { x: -1, y: 1 } : { x: -1, y: -1 };
}

/**
 * Size of the grey echo's offset in 4 buckets of |24 h change| (0.75 % each), so a
 * tick does not move it; 0 when the change is unknown.
 * @param {number|null|undefined} changePct
 */
export function echoBucket(changePct) {
  if (typeof changePct !== 'number' || !Number.isFinite(changePct)) return 0;
  return 1 + Math.min(3, Math.floor(Math.abs(changePct) / 0.75));
}

/**
 * Every input that changes the picture, quantised. The page re-renders the mass only
 * when this key changes (or the layout does), never on a price tick.
 * @param {{ percentile: number|null, changePct: number|null }} p
 */
export function massKey({ percentile, changePct }) {
  const t = trailOf(changePct);
  return `${blurStep(percentile) ?? 'none'}|${t.x},${t.y}|${echoBucket(changePct)}`;
}

/**
 * Render parameters for a mass of type size `size` (px) and width `massWidth` (px).
 * Returns null blur when the percentile is unknown: the page then prints only a pale
 * latent impression instead of encoding a volatility it does not know.
 * @param {{ percentile: number|null, changePct: number|null, size: number, massWidth: number }} p
 */
export function massParams({ percentile, changePct, size, massWidth }) {
  const step = blurStep(percentile);
  const trail = trailOf(changePct);
  const bucket = echoBucket(changePct);
  // 3.7 % to 7.3 % of the mass width: the critique asked for at least 3–4 %.
  const echo = bucket === 0 ? 0 : (0.025 + 0.012 * bucket) * massWidth;
  if (step === null) return { step, sigma: size * 0.045, trailLength: 0, trail, echo: { x: 0, y: 0 }, latent: true };
  const k = blurK(step);
  return {
    step,
    // Part of the blur is isotropic, the rest is a one-sided trail.
    sigma: size * k * 0.5,
    trailLength: size * k * 1.15,
    trail,
    echo: { x: trail.x * echo, y: trail.y * echo * 0.4 },
    latent: false,
  };
}

// ------------------------------------------------------------------ noise

/**
 * Stateless hash noise in [0, 1). Fixed per (x, y, seed), so the grain does not
 * re-roll between renders: a new picture is a new impression of the same plate.
 * @param {number} x
 * @param {number} y
 * @param {number} seed
 */
export function hash01(x, y, seed) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Smooth value noise in [-0.5, 0.5] on a `cell`-px lattice; it makes the erosion of an
 * edge uneven along its length instead of the same everywhere.
 * @param {number} x
 * @param {number} y
 * @param {number} cell
 * @param {number} seed
 */
function valueNoise(x, y, cell, seed) {
  const gx = x / cell;
  const gy = y / cell;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash01(x0, y0, seed);
  const b = hash01(x0 + 1, y0, seed);
  const c = hash01(x0, y0 + 1, seed);
  const d = hash01(x0 + 1, y0 + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy - 0.5;
}

// ------------------------------------------------------------------ blurs

/**
 * Widths of `n` box blurs that together approximate a gaussian of `sigma`.
 * @param {number} sigma
 * @param {number} n
 */
export function boxesForGauss(sigma, n) {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  const sizes = [];
  for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
  return sizes;
}

/**
 * @param {Float32Array} src
 * @param {Float32Array} dst
 * @param {number} w
 * @param {number} h
 * @param {number} r
 */
function boxH(src, dst, w, h, r) {
  const k = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += src[o + Math.min(w - 1, Math.max(0, i))];
    for (let x = 0; x < w; x++) {
      dst[o + x] = acc * k;
      acc += src[o + Math.min(w - 1, x + r + 1)] - src[o + Math.max(0, x - r)];
    }
  }
}

/**
 * @param {Float32Array} src
 * @param {Float32Array} dst
 * @param {number} w
 * @param {number} h
 * @param {number} r
 */
function boxV(src, dst, w, h, r) {
  const k = 1 / (2 * r + 1);
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += src[Math.min(h - 1, Math.max(0, i)) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = acc * k;
      acc += src[Math.min(h - 1, y + r + 1) * w + x] - src[Math.max(0, y - r) * w + x];
    }
  }
}

/**
 * Gaussian blur by three box passes in each direction (brief 4.1: own code, not
 * ctx.filter, whose support and output differ between browsers).
 * @param {Float32Array} a
 * @param {number} w
 * @param {number} h
 * @param {number} sigma
 */
export function gaussBlur(a, w, h, sigma) {
  const s = Float32Array.from(a);
  if (!(sigma >= 0.5)) return s;
  const t = new Float32Array(a.length);
  for (const size of boxesForGauss(sigma, 3)) {
    const r = (size - 1) / 2;
    if (r < 1) continue;
    boxH(s, t, w, h, r);
    boxV(t, s, w, h, r);
  }
  return s;
}

/**
 * One-sided exponential smear: each pixel leaks into the pixels after it along
 * (dx, dy), so a shape keeps its edge on one side and grows a tail on the other.
 * Normalised (y = a·x + (1 − a)·y_prev), so a flat field stays flat.
 * @param {Float32Array} a
 * @param {number} w
 * @param {number} h
 * @param {-1|0|1} dx
 * @param {-1|0|1} dy
 * @param {number} length e-folding length of the tail in px
 */
export function smear(a, w, h, dx, dy, length) {
  const out = Float32Array.from(a);
  if (!(length >= 1)) return out;
  const k = 1 / length;
  if (dx !== 0) {
    for (let y = 0; y < h; y++) {
      const o = y * w;
      let acc = 0;
      for (let i = 0; i < w; i++) {
        const x = dx > 0 ? i : w - 1 - i;
        acc += (out[o + x] - acc) * k;
        out[o + x] = acc;
      }
    }
  }
  if (dy !== 0) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = 0; i < h; i++) {
        const y = dy > 0 ? i : h - 1 - i;
        const j = y * w + x;
        acc += (out[j] - acc) * k;
        out[j] = acc;
      }
    }
  }
  return out;
}

/** @param {number} v */
function level(v) {
  const t = (v - LEVEL_LO) / (LEVEL_HI - LEVEL_LO);
  return t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(t, GAMMA);
}

/**
 * Turn glyph coverage into a 1-bit impression.
 * @param {{
 *   alpha: Float32Array, width: number, height: number,
 *   sigma: number, trailLength: number, trail: { x: -1|0|1, y: -1|0|1 },
 *   echo?: { x: number, y: number }, echoDensity?: number,
 *   seed: number, farGain?: number, density?: number,
 * }} p  `alpha` is 0..1 coverage per pixel; `density` < 1 thins the whole mass
 *       (used for the latent impression before the market has answered).
 * @returns {Uint8Array} PAPER, INK or ECHO per pixel
 */
export function renderDissolve({
  alpha,
  width: w,
  height: h,
  sigma,
  trailLength,
  trail,
  echo = { x: 0, y: 0 },
  echoDensity = 0.33,
  seed,
  farGain = 1,
  density = 1,
}) {
  if (alpha.length !== w * h)
    throw new RangeError(`renderDissolve: alpha has ${alpha.length} values, expected ${w * h}`);
  const near = gaussBlur(alpha, w, h, sigma);
  // Leading edge keeps the isotropic blur only; the trailing side gets the smear.
  const field = trailLength >= 1 ? maxInto(near, smear(near, w, h, trail.x, trail.y, trailLength)) : near;
  // Stray dots: a wider, longer version of the same field, sampled very sparsely.
  const far =
    trailLength >= 1
      ? smear(gaussBlur(alpha, w, h, sigma * 3), w, h, trail.x, trail.y, trailLength * 3)
      : gaussBlur(alpha, w, h, sigma * 3);
  const ex = Math.round(echo.x);
  const ey = Math.round(echo.y);
  const hasEcho = ex !== 0 || ey !== 0;
  const cell = Math.max(8, sigma * 2.2);
  const out = new Uint8Array(w * h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = level(field[i]);
      if (v > 0 && v < 1) {
        // Uneven erosion: the edge bites deeper in some places than in others.
        v += valueNoise(x, y, cell, seed) * 0.9 * v * (1 - v);
      }
      if (v * density > hash01(x, y, seed)) {
        out[i] = INK;
        continue;
      }
      if (far[i] > 0.002 && hash01(x, y, seed ^ 0x5bd1e995) < 0.004 * far[i] * farGain * density) {
        out[i] = INK;
        continue;
      }
      if (hasEcho) {
        const sx = x - ex;
        const sy = y - ey;
        if (sx >= 0 && sx < w && sy >= 0 && sy < h) {
          const g = level(field[sy * w + sx]) * echoDensity * density;
          if (g > hash01(x, y, seed ^ 0x27220a95)) out[i] = ECHO;
        }
      }
    }
  }
  return out;
}

/**
 * @param {Float32Array} a
 * @param {Float32Array} b
 */
function maxInto(a, b) {
  for (let i = 0; i < a.length; i++) if (b[i] > a[i]) a[i] = b[i];
  return a;
}

/**
 * Bounding box and centroid of the INK pixels, for tests and layout checks.
 * @param {Uint8Array} out
 * @param {number} w
 */
export function inkStats(out, w) {
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== INK) continue;
    n++;
    sx += i % w;
    sy += Math.floor(i / w);
  }
  return { count: n, cx: n ? sx / n : NaN, cy: n ? sy / n : NaN };
}
