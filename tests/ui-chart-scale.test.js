import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BAYER4,
  bayerOn,
  candleAt,
  formingFraction,
  gridValues,
  niceStep,
  priceExtent,
  stepDecimals,
  timeLabel,
  visibleWindow,
} from '../js/ui/chart-scale.js';

test('niceStep picks 1, 2, 2.5, 5 or 10 times a power of ten', () => {
  assert.equal(niceStep(43.7, 6), 5);
  assert.equal(niceStep(4.6, 5), 1);
  assert.equal(niceStep(0.9, 6), 0.1);
  assert.equal(niceStep(1200, 5), 250);
  assert.throws(() => niceStep(0, 5), RangeError);
});

test('stepDecimals prints a step without losing digits', () => {
  assert.equal(stepDecimals(5), 0);
  assert.equal(stepDecimals(2.5), 1);
  assert.equal(stepDecimals(0.25), 2);
  assert.equal(stepDecimals(0.1), 1);
});

test('gridValues are the multiples of the step inside the range', () => {
  assert.deepEqual(gridValues(3972.1, 4021.7, 10), [3980, 3990, 4000, 4010, 4020]);
  assert.deepEqual(gridValues(70.27, 70.9, 0.25), [70.5, 70.75]);
  assert.deepEqual(gridValues(0.1, 0.3, 0.1), [0.1, 0.2, 0.3], 'no floating point drift');
});

test('visibleWindow keeps the newest candles that fit, at the exact pitch', () => {
  assert.deepEqual(visibleWindow(300, 1200, 9), { start: 167, count: 133, step: 1200 / 133 });
  // Fewer candles than fit: keep the preferred pitch, do not stretch them.
  assert.deepEqual(visibleWindow(20, 1200, 9), { start: 0, count: 20, step: 9 });
  assert.deepEqual(visibleWindow(0, 1200, 9), { start: 0, count: 0, step: 9 });
});

test('priceExtent pads the range and survives a flat market', () => {
  const e = priceExtent([
    { h: 10, l: 8 },
    { h: 12, l: 9 },
  ]);
  assert.ok(e);
  assert.equal(e.hi, 12);
  assert.equal(e.lo, 8);
  assert.ok(e.max > 12 && e.min < 8);
  const flat = priceExtent([{ h: 71.08, l: 71.08 }]);
  assert.ok(flat && flat.max > flat.min);
  assert.equal(priceExtent([]), null);
});

test('timeLabel: clock times, dates at midnight and on long intervals', () => {
  assert.equal(timeLabel(Date.UTC(2026, 9, 13, 20, 45), '15m'), '20:45');
  assert.equal(timeLabel(Date.UTC(2026, 9, 13, 0, 0), '15m'), '13 Oct');
  assert.equal(timeLabel(Date.UTC(2026, 9, 13, 8, 0), '4h'), '13 Oct 08h');
  assert.equal(timeLabel(Date.UTC(2026, 9, 13), '1d'), '13 Oct');
});

test('candleAt maps a pointer to the candle under it, clamped to the plot', () => {
  const w = { count: 10, step: 8, offset: 20 };
  assert.equal(candleAt(20, w), 0);
  assert.equal(candleAt(27.9, w), 0);
  assert.equal(candleAt(28, w), 1);
  assert.equal(candleAt(5, w), 0, 'left of the plot');
  assert.equal(candleAt(500, w), 9, 'right of the plot');
  assert.equal(candleAt(30, { ...w, count: 0 }), -1);
});

test('formingFraction is the share of the period gone, clamped', () => {
  const c = { t: 1000, T: 1999 };
  assert.equal(formingFraction(c, 1000), 0);
  assert.equal(formingFraction(c, 1500), 0.5);
  assert.equal(formingFraction(c, 5000), 1);
  assert.equal(formingFraction(c, 0), 0);
});

test('the Bayer screen inks exactly k of 16 pixels at level k/16', () => {
  assert.deepEqual(
    [...BAYER4].sort((a, b) => a - b),
    [...Array(16).keys()],
  );
  for (let k = 0; k <= 16; k++) {
    let on = 0;
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) if (bayerOn(x, y, k / 16)) on++;
    assert.equal(on, k);
  }
});
