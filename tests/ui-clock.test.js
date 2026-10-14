import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fundingDial, jitteredArc, polar, tickSide } from '../js/ui/clock.js';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 13, 20, 45, 0);
const NEXT = Date.UTC(2026, 9, 14, 0, 0, 0);
const TAU = Math.PI * 2;
const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('fundingDial is null until the next funding time is known', () => {
  assert.equal(fundingDial({ now: NOW, nextFundingTime: null, intervalHours: 8 }), null);
});

test('elapsed part of an 8 h interval: 16:00 to 20:45 is 4 h 45 min', () => {
  const d = fundingDial({ now: NOW, nextFundingTime: NEXT, intervalHours: 8 });
  assert.ok(d);
  assert.equal(d.remainingMs, 3.25 * HOUR);
  assert.equal(d.elapsedMs, 4.75 * HOUR);
  assert.ok(close(d.elapsedFrac, 4.75 / 8));
  assert.equal(d.arcEnd, 0, 'now sits at the fixed index');
  assert.ok(close(d.arcStart, -(4.75 / 24) * TAU), 'the arc runs back to 16:00');
});

test('the dial lists the settlements of the surrounding day with prev and next marked', () => {
  const d = fundingDial({ now: NOW, nextFundingTime: NEXT, intervalHours: 8 });
  assert.ok(d);
  const hours = d.ticks.map((t) => t.hour);
  assert.deepEqual(hours, ['16', '00', '08']);
  const prev = d.ticks.find((t) => t.prev);
  const next = d.ticks.find((t) => t.next);
  assert.equal(prev?.hour, '16');
  assert.equal(next?.hour, '00');
  assert.ok(close(next.angle, (3.25 / 24) * TAU), 'next settlement ahead, clockwise');
  assert.equal(d.ticks.filter((t) => t.prev).length, 1);
});

test('without the interval the dial shows only the next settlement and no arc', () => {
  const d = fundingDial({ now: NOW, nextFundingTime: NEXT, intervalHours: null });
  assert.ok(d);
  assert.equal(d.elapsedMs, null);
  assert.equal(d.arcStart, null);
  assert.deepEqual(
    d.ticks.map((t) => [t.hour, t.next]),
    [['00', true]],
  );
});

test('an overdue settlement reads as a full interval, never negative', () => {
  const d = fundingDial({ now: NEXT + 2_000, nextFundingTime: NEXT, intervalHours: 8 });
  assert.ok(d);
  assert.equal(d.remainingMs, 0);
  assert.equal(d.elapsedMs, 8 * HOUR);
  assert.equal(d.elapsedFrac, 1);
});

test('a 4 h interval gives six settlements a day', () => {
  const d = fundingDial({ now: NOW, nextFundingTime: Date.UTC(2026, 9, 13, 24, 0, 0), intervalHours: 4 });
  assert.ok(d);
  assert.equal(d.ticks.length, 6);
  assert.ok(close(d.elapsedFrac, 0.75 / 4));
});

test('polar measures angles clockwise from twelve o’clock', () => {
  const top = polar(100, 100, 50, 0);
  assert.ok(close(top.x, 100) && close(top.y, 50));
  const right = polar(100, 100, 50, Math.PI / 2);
  assert.ok(close(right.x, 150) && close(right.y, 100));
});

test('jitteredArc is a deterministic polyline that stays near the circle', () => {
  const args = { cx: 200, cy: 200, r: 100, a0: -1, a1: 0, seed: 41 };
  const d = jitteredArc(args);
  assert.equal(d, jitteredArc(args));
  assert.notEqual(d, jitteredArc({ ...args, seed: 17 }));
  const pts = [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  assert.ok(pts.length > 10);
  for (const [x, y] of pts) assert.ok(Math.abs(Math.hypot(x - 200, y - 200) - 100) <= 0.6);
  const end = pts[pts.length - 1];
  assert.ok(Math.abs(end[0] - 200) < 1 && Math.abs(end[1] - 100) < 1, 'ends at the index');
  assert.throws(() => jitteredArc({ ...args, a0: 1, a1: 0 }), RangeError);
});

test('a settlement hour goes inside the ring when it would reach the funding figures', () => {
  // Mobile dial (r 45): 2 h 40 m before settlement the outside label met the countdown.
  const mobileAngle = ((2 * 60 + 40) / (24 * 60)) * Math.PI * 2;
  assert.equal(tickSide({ r: 45, angle: mobileAngle, reach: 28, capHeight: 9 }), -1);
  // Right by the index the label would sit on the figures at any radius.
  assert.equal(tickSide({ r: 120, angle: 0.1, reach: 28, capHeight: 9 }), -1);
  assert.equal(tickSide({ r: 120, angle: -0.1, reach: 28, capHeight: 9 }), -1);
});

test('a settlement hour stays outside the ring once it is clear of the figures', () => {
  assert.equal(tickSide({ r: 45, angle: Math.PI / 2, reach: 28, capHeight: 9 }), 1);
  assert.equal(tickSide({ r: 120, angle: -Math.PI / 2, reach: 28, capHeight: 9 }), 1);
  assert.equal(tickSide({ r: 120, angle: Math.PI, reach: 28, capHeight: 9 }), 1);
});
