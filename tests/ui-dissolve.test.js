import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BLUR_STEPS,
  ECHO,
  INK,
  PAPER,
  SOLID_AT,
  blurK,
  blurStep,
  boxesForGauss,
  echoBucket,
  gaussBlur,
  hash01,
  massKey,
  massParams,
  moveOf,
  renderDissolve,
  renderLayers,
  smear,
  trailOf,
} from '../js/ui/dissolve.js';

/** A w×h field with a solid rectangle of coverage 1. */
function block(w, h, x0, y0, x1, y1) {
  const a = new Float32Array(w * h);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) a[y * w + x] = 1;
  return a;
}

/**
 * Count and centroid of the INK pixels.
 * @param {Uint8Array} out
 * @param {number} w
 */
function inkStats(out, w) {
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

/** A Move as a fresh reading of `changePct`. */
const mv = (/** @type {number|null} */ changePct) => moveOf(null, changePct);

test('blurStep quantises the 0–100 percentile into 8 steps and refuses unknown values', () => {
  assert.equal(blurStep(0), 0);
  assert.equal(blurStep(12.4), 0);
  assert.equal(blurStep(12.5), 1);
  assert.equal(blurStep(30), 2);
  assert.equal(blurStep(86.7), 6);
  assert.equal(blurStep(100), BLUR_STEPS - 1);
  assert.equal(blurStep(140), BLUR_STEPS - 1, 'clamped above');
  assert.equal(blurStep(-5), 0, 'clamped below');
  assert.equal(blurStep(null), null);
  assert.equal(blurStep(undefined), null);
  assert.equal(blurStep(Number.NaN), null);
});

test('blurK runs from calm 0.02 to storm 0.12 of the type size (brief 4.1)', () => {
  assert.equal(blurK(0), 0.02);
  assert.ok(Math.abs(blurK(BLUR_STEPS - 1) - 0.12) < 1e-12);
  for (let s = 1; s < BLUR_STEPS; s++) assert.ok(blurK(s) > blurK(s - 1), 'monotonic');
});

test('the trail runs behind the 24 h move, with time running to the right', () => {
  assert.deepEqual(trailOf(0.42), { x: -1, y: 1 }, 'up: leads up-right, trails down-left');
  assert.deepEqual(trailOf(-1.13), { x: -1, y: -1 }, 'down: leads down-right, trails up-left');
  assert.deepEqual(trailOf(0), { x: -1, y: 0 });
  assert.deepEqual(trailOf(null), { x: -1, y: 0 });
});

test('echoBucket only moves in 0.75 % steps, so ticks never re-render the mass', () => {
  assert.equal(echoBucket(null), 0);
  assert.equal(echoBucket(0), 1);
  assert.equal(echoBucket(0.74), 1);
  assert.equal(echoBucket(-0.75), 2, 'sign does not matter');
  assert.equal(echoBucket(2.6), 4);
  assert.equal(echoBucket(40), 4, 'capped');
});

test('massKey is stable within a step and changes across steps or move direction', () => {
  const k = (percentile, changePct) => massKey({ percentile, move: mv(changePct) });
  assert.equal(k(30, 0.42), k(31, 0.43), 'a tick inside the same buckets');
  assert.notEqual(k(30, 0.42), k(40, 0.42), 'next blur step');
  assert.notEqual(k(30, 0.42), k(30, -0.42), 'direction flips');
  assert.notEqual(k(null, 0.42), k(30, 0.42), 'unknown percentile is its own state');
});

test('massParams: a stormy market blurs further and trails longer than a calm one', () => {
  const calm = massParams({ percentile: 30, move: mv(0.7), size: 400, massWidth: 1000 });
  const storm = massParams({ percentile: 87, move: mv(-2.6), size: 400, massWidth: 1000 });
  assert.ok(storm.sigma > 2 * calm.sigma, `storm sigma ${storm.sigma} vs calm ${calm.sigma}`);
  assert.ok(storm.trailLength > 2 * calm.trailLength);
  assert.equal(calm.latent, false);
  // The echo sits behind the move by at least 3 % of the mass width (critique).
  assert.ok(Math.abs(calm.echo.x) >= 30);
  assert.ok(calm.echo.x < 0 && calm.echo.y > 0, 'up: echo down-left');
  assert.ok(storm.echo.x < 0 && storm.echo.y < 0, 'down: echo up-left');
});

test('massParams with an unknown percentile asks for a latent impression, no encoding', () => {
  const p = massParams({ percentile: null, move: mv(null), size: 400, massWidth: 1000 });
  assert.equal(p.latent, true);
  assert.equal(p.step, null);
  assert.equal(p.trailLength, 0);
  assert.deepEqual(p.echo, { x: 0, y: 0 });
});

test('hash01 is deterministic, in [0, 1) and differs by seed', () => {
  const a = hash01(10, 20, 1498);
  assert.equal(a, hash01(10, 20, 1498));
  assert.ok(a >= 0 && a < 1);
  assert.notEqual(a, hash01(10, 20, 1617));
  // Roughly uniform: the mean of many samples is near one half.
  let sum = 0;
  for (let i = 0; i < 20_000; i++) sum += hash01(i % 200, Math.floor(i / 200), 7);
  assert.ok(Math.abs(sum / 20_000 - 0.5) < 0.01);
});

test('boxesForGauss gives three odd box widths', () => {
  const b = boxesForGauss(10, 3);
  assert.equal(b.length, 3);
  for (const w of b) assert.equal(w % 2, 1);
});

test('gaussBlur keeps the total coverage and spreads it out', () => {
  const w = 64;
  const h = 64;
  const a = block(w, h, 28, 28, 36, 36);
  const b = gaussBlur(a, w, h, 4);
  const sum = (arr) => arr.reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(sum(b) - sum(a)) < 1e-3, 'mass is conserved away from the edges');
  assert.ok(b[20 * w + 32] > 0, 'reaches outside the block');
  assert.ok(b[32 * w + 32] < 1, 'centre is softened');
  assert.deepEqual(gaussBlur(a, w, h, 0.2), a, 'a sub-pixel sigma is a no-op');
});

test('smear is one-sided: the shape grows a tail only in its direction', () => {
  const w = 40;
  const h = 1;
  const a = block(w, h, 15, 0, 25, 1);
  const right = smear(a, w, h, 1, 0, 4);
  assert.equal(right[10], 0, 'nothing leaks before the shape');
  assert.ok(right[30] > 0.1, 'a tail after it');
  const left = smear(a, w, h, -1, 0, 4);
  assert.ok(left[10] > 0.1, 'mirrored direction');
  assert.equal(left[30], 0);
  const flat = new Float32Array(w).fill(0.5);
  assert.ok(
    smear(flat, w, h, 1, 0, 4).every((v) => Math.abs(v - 0.5) < 0.5),
    'stays bounded',
  );
});

test('renderDissolve is deterministic and keeps a solid core', () => {
  const w = 120;
  const h = 80;
  const alpha = block(w, h, 30, 20, 90, 60);
  const args = { alpha, width: w, height: h, sigma: 3, trailLength: 8, trail: { x: -1, y: 1 }, seed: 1498 };
  const a = renderDissolve(args);
  const b = renderDissolve(args);
  assert.deepEqual(a, b);
  assert.equal(a[40 * w + 60], INK, 'deep inside the letter is ink');
  assert.equal(a[2 * w + 117], PAPER, 'far corner is paper');
  for (const v of a) assert.ok(v === PAPER || v === INK || v === ECHO);
});

test('renderDissolve: the grain trails behind the move and the leading edge stays hard', () => {
  const w = 200;
  const h = 200;
  const alpha = block(w, h, 70, 70, 130, 130);
  const common = { alpha, width: w, height: h, sigma: 3, trailLength: 14, seed: 3 };
  const up = renderDissolve({ ...common, trail: { x: -1, y: 1 } });
  const down = renderDissolve({ ...common, trail: { x: -1, y: -1 } });
  const su = inkStats(up, w);
  const sd = inkStats(down, w);
  assert.ok(su.cx < 100 && sd.cx < 100, 'both trail left of the shape centre');
  assert.ok(su.cy > 100, `up trails downward (cy ${su.cy})`);
  assert.ok(sd.cy < 100, `down trails upward (cy ${sd.cy})`);
  // Leading edge (up-right for an up move): just outside it there is almost no ink.
  let lead = 0;
  let tail = 0;
  for (let y = 75; y < 125; y++) {
    if (up[y * w + 136] === INK) lead++;
    if (up[y * w + 64] === INK) tail++;
  }
  assert.ok(tail > lead * 2, `tail ${tail} vs lead ${lead}`);
});

test('renderDissolve: a stormier blur scatters more ink outside the letter', () => {
  const w = 160;
  const h = 160;
  const alpha = block(w, h, 50, 50, 110, 110);
  const outside = (out) => {
    let n = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const inside = x >= 50 && x < 110 && y >= 50 && y < 110;
        if (!inside && out[y * w + x] === INK) n++;
      }
    }
    return n;
  };
  const base = { alpha, width: w, height: h, trail: { x: -1, y: 0 }, seed: 11 };
  const calm = renderDissolve({ ...base, sigma: 1.5, trailLength: 3 });
  const storm = renderDissolve({ ...base, sigma: 6, trailLength: 14 });
  assert.ok(outside(storm) > 1.5 * outside(calm), `${outside(storm)} vs ${outside(calm)}`);
});

test('renderDissolve paints the echo only where there is no ink', () => {
  const w = 120;
  const h = 60;
  const alpha = block(w, h, 40, 15, 80, 45);
  const out = renderDissolve({
    alpha,
    width: w,
    height: h,
    sigma: 2,
    trailLength: 4,
    trail: { x: -1, y: 0 },
    echo: { x: -30, y: 0 },
    seed: 5,
  });
  let echo = 0;
  for (let y = 15; y < 45; y++) for (let x = 12; x < 38; x++) if (out[y * w + x] === ECHO) echo++;
  assert.ok(echo > 50, `echo dots left of the letter: ${echo}`);
});

test('renderDissolve rejects a coverage array of the wrong size', () => {
  assert.throws(
    () =>
      renderDissolve({
        alpha: new Float32Array(10),
        width: 4,
        height: 4,
        sigma: 1,
        trailLength: 0,
        trail: { x: -1, y: 0 },
        seed: 1,
      }),
    RangeError,
  );
});

test('moveOf: a price hovering at its 24 h open does not flip the trail on every tick', () => {
  let m = moveOf(null, 0.02);
  assert.deepEqual(m, { sign: 1, bucket: 1 });
  for (const c of [-0.01, 0.03, -0.04, 0.01, -0.049]) {
    m = moveOf(m, c);
    assert.equal(m.sign, 1, `${c} stays inside the dead band`);
  }
  m = moveOf(m, -0.05);
  assert.equal(m.sign, -1, 'past the band the side changes');
  assert.equal(moveOf(m, -0.01).sign, -1);
  assert.deepEqual(moveOf(m, null), { sign: 0, bucket: 0 }, 'unknown change');
});

test('moveOf: the echo bucket needs a margin past its boundary both ways', () => {
  let m = moveOf(null, 0.7);
  assert.equal(m.bucket, 1);
  m = moveOf(m, 0.8);
  assert.equal(m.bucket, 1, '0.80 % is past 0.75 by less than the margin');
  m = moveOf(m, 0.85);
  assert.equal(m.bucket, 2);
  m = moveOf(m, 0.7);
  assert.equal(m.bucket, 2, 'back under the boundary by less than the margin');
  m = moveOf(m, 0.64);
  assert.equal(m.bucket, 1);
  assert.equal(moveOf(moveOf(null, 0.2), 3).bucket, 4, 'a big jump moves straight to its bucket');
});

test('massKey stays put while the change oscillates around zero and a bucket edge', () => {
  let m = moveOf(null, 0.03);
  const key = massKey({ percentile: 40, move: m });
  for (let i = 0; i < 200; i++) {
    m = moveOf(m, (i % 2 ? 1 : -1) * 0.03);
    assert.equal(massKey({ percentile: 40, move: m }), key);
  }
});

test('renderLayers: RGBA for the canvases and one smooth solid region for the inversion', () => {
  const w = 120;
  const h = 80;
  const alpha = block(w, h, 30, 20, 90, 60);
  const args = { alpha, width: w, height: h, sigma: 3, trailLength: 8, trail: { x: -1, y: 1 }, seed: 1498 };
  const codes = renderDissolve(args);
  const colors = { echo: [0x61, 0x61, 0x61], latent: [0xdc, 0xdc, 0xdc] };
  const out = renderLayers({ ...args, latent: false, colors });
  assert.equal(out.ink.length, w * h * 4);
  for (let i = 0; i < codes.length; i++) {
    assert.equal(out.ink[i * 4 + 3] === 255, codes[i] === INK, `ink alpha at ${i}`);
  }
  const solid = /** @type {Uint8ClampedArray} */ (out.solid);
  const at = (/** @type {number} */ x, /** @type {number} */ y) => solid[(y * w + x) * 4 + 3] === 255;
  assert.ok(at(60, 40), 'the core is solid');
  assert.ok(!at(2, 2), 'the far corner is not');
  // Smooth: across the region there is no isolated pixel, unlike the dots.
  let isolated = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const c = at(x, y);
      if (c !== at(x - 1, y) && c !== at(x + 1, y) && c !== at(x, y - 1) && c !== at(x, y + 1)) isolated++;
    }
  }
  assert.equal(isolated, 0);
  // Solid means dense: inside the region at least SOLID_AT of the pixels are dots, on average.
  let n = 0;
  let ink = 0;
  for (let i = 0; i < codes.length; i++) {
    if (solid[i * 4 + 3] !== 255) continue;
    n++;
    if (codes[i] === INK) ink++;
  }
  assert.ok(ink / n >= SOLID_AT, `density inside ${ink / n}`);
  const latent = renderLayers({ ...args, density: 0.42, latent: true, colors });
  assert.equal(latent.solid, null, 'no inversion for the pale impression');
  assert.ok(
    latent.ink.every((v) => v === 0),
    'the latent impression has no black dots',
  );
});
