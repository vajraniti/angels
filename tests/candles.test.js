import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyRanges, intervalMs, mergeCandle, mergeSnapshot, rangePercentile, supersedes } from '../js/candles.js';

const M15 = 15 * 60_000;
const T0 = Date.UTC(2026, 9, 13, 20, 0);

/**
 * @param {number} i candle index from T0
 * @param {Partial<import('../js/parse.js').Candle>} [over]
 */
function candle(i, over = {}) {
  const t = T0 + i * M15;
  return { t, T: t + M15 - 1, o: 100, h: 101, l: 99, c: 100.5, v: 10, q: 1005, n: 10, closed: true, ...over };
}

const opts = { maxLength: 500, intervalMs: M15 };

test('intervalMs covers every chart interval and rejects others', () => {
  assert.deepEqual(
    ['1m', '5m', '15m', '1h', '4h', '1d'].map(intervalMs),
    [60_000, 300_000, 900_000, 3_600_000, 14_400_000, 86_400_000],
  );
  assert.throws(() => intervalMs('1M'), RangeError);
  assert.throws(() => intervalMs('fast'), RangeError);
});

test('forming candle: a later update of the same candle replaces it', () => {
  const list = [candle(0), candle(1, { closed: false, c: 100, n: 5 })];
  const r = mergeCandle(list, candle(1, { closed: false, c: 102, n: 8 }), opts);
  assert.equal(r.changed, true);
  assert.equal(r.candles.length, 2);
  assert.equal(r.candles[1].c, 102);
  assert.equal(list[1].c, 100, 'input list is not mutated');
});

test('forming candle: an older update (fewer trades) arriving late is ignored', () => {
  const list = [candle(1, { closed: false, c: 102, n: 8 })];
  const r = mergeCandle(list, candle(1, { closed: false, c: 100, n: 5 }), opts);
  assert.equal(r.changed, false);
  assert.equal(r.candles, list);
});

test('closing event replaces the forming candle and is final', () => {
  let list = [candle(1, { closed: false, n: 8 })];
  list = mergeCandle(list, candle(1, { closed: true, c: 103, n: 9 }), opts).candles;
  assert.equal(list[0].closed, true);
  const late = mergeCandle(list, candle(1, { closed: false, c: 99, n: 50 }), opts);
  assert.equal(late.changed, false, 'a forming update can never reopen a closed candle');
  const corrected = mergeCandle(list, candle(1, { closed: true, c: 104, n: 9 }), opts);
  assert.equal(corrected.candles[0].c, 104, 'a closed version (REST snapshot) may correct a closed one');
});

test('supersedes encodes the precedence rules', () => {
  const forming = (n) => candle(0, { closed: false, n });
  assert.equal(supersedes(forming(5), forming(5)), true);
  assert.equal(supersedes(forming(5), forming(4)), false);
  assert.equal(supersedes(forming(5), candle(0, { n: 1 })), true);
  assert.equal(supersedes(candle(0), forming(99)), false);
  assert.equal(supersedes(candle(0), candle(0)), true);
});

test('a new candle appends, and a forming predecessor whose close was missed is marked closed', () => {
  const list = [candle(0), candle(1, { closed: false })];
  const r = mergeCandle(list, candle(2, { closed: false }), opts);
  assert.deepEqual(
    r.candles.map((c) => [c.t, c.closed]),
    [
      [T0, true],
      [T0 + M15, true],
      [T0 + 2 * M15, false],
    ],
  );
  assert.equal(r.gap, false);
});

test('a jump of more than one interval is reported as a gap', () => {
  const r = mergeCandle([candle(0)], candle(3, { closed: false }), opts);
  assert.equal(r.gap, true);
  assert.equal(r.candles.length, 2);
  assert.equal(mergeCandle([candle(0)], candle(3), { maxLength: 500 }).gap, false, 'no interval, no gap check');
});

test('out-of-order candles are inserted at their position', () => {
  let list = [candle(0), candle(2), candle(3)];
  const r = mergeCandle(list, candle(1), opts);
  assert.deepEqual(
    r.candles.map((c) => c.t),
    [0, 1, 2, 3].map((i) => T0 + i * M15),
  );
  list = r.candles;
  const before = mergeCandle(list, candle(-1), opts);
  assert.equal(before.candles[0].t, T0 - M15);
});

test('the list stays bounded and drops the oldest candles', () => {
  let list = [];
  for (let i = 0; i < 10; i++) list = mergeCandle(list, candle(i), { maxLength: 4, intervalMs: M15 }).candles;
  assert.deepEqual(
    list.map((c) => c.t),
    [6, 7, 8, 9].map((i) => T0 + i * M15),
  );
  const tooOld = mergeCandle(list, candle(1), { maxLength: 4, intervalMs: M15 });
  assert.equal(tooOld.changed, false, 'a candle older than a full window is not inserted');
});

test('empty list accepts the first candle', () => {
  const r = mergeCandle([], candle(5, { closed: false }), opts);
  assert.equal(r.candles.length, 1);
  assert.equal(r.changed, true);
});

test('mergeSnapshot: stream candles buffered during the load extend or update the snapshot', () => {
  const snapshot = [candle(0), candle(1), candle(2, { closed: false, n: 5, c: 100 })];
  const buffered = [
    candle(2, { closed: false, n: 3, c: 98 }), // older than the snapshot's view: ignored
    candle(2, { closed: false, n: 9, c: 101 }), // newer: wins
    candle(2, { closed: true, n: 10, c: 101.5 }),
    candle(3, { closed: false, n: 1, c: 101.6 }),
  ];
  const out = mergeSnapshot(snapshot, buffered, 500);
  assert.deepEqual(
    out.map((c) => [c.t, c.c, c.closed]),
    [
      [T0, 100.5, true],
      [T0 + M15, 100.5, true],
      [T0 + 2 * M15, 101.5, true],
      [T0 + 3 * M15, 101.6, false],
    ],
  );
  assert.equal(mergeSnapshot(snapshot, [], 2).length, 2, 'snapshot itself is bounded');
});

test('dailyRanges keeps only closed days, newest N', () => {
  const days = [
    { ...candle(0), h: 10, l: 5 },
    { ...candle(1), h: 12, l: 9 },
    { ...candle(2), h: 20, l: 10, closed: false },
  ];
  assert.deepEqual(dailyRanges(days, 30), [5, 3]);
  assert.deepEqual(dailyRanges(days, 1), [3]);
});

test('rangePercentile ranks with ties counted half', () => {
  const ranges = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(rangePercentile(0.5, ranges, 10), 0);
  assert.equal(rangePercentile(11, ranges, 10), 100);
  assert.equal(rangePercentile(5.5, ranges, 10), 50);
  assert.equal(rangePercentile(5, ranges, 10), 45);
  assert.equal(rangePercentile(3, [3, 3, 3, 3, 3, 3, 3, 3, 3, 3], 10), 50);
});

test('rangePercentile returns null without enough history or a range', () => {
  assert.equal(rangePercentile(5, [1, 2, 3], 10), null);
  assert.equal(rangePercentile(null, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 10), null);
  assert.equal(rangePercentile(NaN, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 10), null);
});
