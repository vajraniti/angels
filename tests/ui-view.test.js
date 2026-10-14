import { test } from 'node:test';
import assert from 'node:assert/strict';
import { announceWorthy, announcement, directionOf, statusView, symbolView } from '../js/ui/view.js';
import { createAnnouncer } from '../js/ui/announce.js';
import { fundingNote, massNote, ordinal, settlementHours } from '../js/ui/imprint.js';
import { MINUS, PLACEHOLDER, THIN_SPACE } from '../js/format.js';

const T = THIN_SPACE;
const NOW = Date.UTC(2026, 9, 13, 20, 45, 0);
const NEXT = Date.UTC(2026, 9, 14, 0, 0, 0);

function sym(over = {}) {
  return {
    symbol: 'XAUUSDT',
    last: 4012.35,
    open24h: 3995.56,
    change24h: 16.79,
    changePct24h: 0.4202,
    high24h: 4031.1,
    low24h: 3987.4,
    quoteVolume24h: 1284512330,
    markPrice: 4012.3,
    indexPrice: 4011.9,
    fundingRate: 0.0001,
    nextFundingTime: NEXT,
    fundingIntervalHours: 8,
    openInterest: 41220.118,
    openInterestValue: 165389540,
    priceDecimals: 2,
    qtyDecimals: 3,
    rangePercentile30d: 30,
    updatedAt: NOW,
    ...over,
  };
}

function empty(symbol) {
  const s = sym({ symbol });
  for (const k of Object.keys(s)) if (k !== 'symbol') s[k] = null;
  return s;
}

function state(over = {}) {
  return {
    status: 'live',
    error: null,
    lastMessageAt: NOW,
    clockSkew: 0,
    symbols: { XAUUSDT: sym(), CLUSDT: sym({ symbol: 'CLUSDT', rangePercentile30d: 86.7 }) },
    chart: { symbol: 'XAUUSDT', interval: '15m', candles: [], loading: false, error: null },
    ...over,
  };
}

test('symbolView formats every figure with the brief’s typesetting', () => {
  const v = symbolView(sym(), NOW);
  assert.equal(v.base, 'XAU');
  assert.equal(v.last, `4${T}012.35`);
  assert.equal(v.change, '+16.79');
  assert.equal(v.changePct, '+0.42%');
  assert.equal(v.direction, 'up');
  assert.equal(v.volume, `1${T}284${T}512${T}330`);
  assert.equal(v.funding, '+0.0100%');
  assert.equal(v.fundingEvery, `8${T}h`);
  assert.equal(v.countdown, '03:15:00');
  assert.equal(v.countdownMs, 3.25 * 3_600_000);
  assert.equal(v.oi, `41${T}220.118`);
  assert.equal(v.oiValue, `165${T}389${T}540`);
  assert.equal(v.known, true);
});

test('symbolView prints the placeholder for every unknown value, never a number', () => {
  const v = symbolView(empty('CLUSDT'), NOW);
  for (const key of ['last', 'change', 'changePct', 'high', 'low', 'volume', 'funding', 'countdown', 'oi', 'oiValue']) {
    assert.equal(v[key], PLACEHOLDER, key);
  }
  assert.equal(v.fundingEvery, PLACEHOLDER);
  assert.equal(v.direction, null);
  assert.equal(v.known, false);
  assert.equal(v.countdownMs, null);
});

test('directionOf and a falling price use the true minus', () => {
  assert.equal(directionOf(-0.81), 'down');
  assert.equal(directionOf(0), 'flat');
  assert.equal(directionOf(null), null);
  const v = symbolView(sym({ symbol: 'CLUSDT', change24h: -0.81, changePct24h: -1.1267 }), NOW);
  assert.equal(v.change, `${MINUS}0.81`);
  assert.equal(v.changePct, `${MINUS}1.13%`);
});

test('statusView: live, with a quiet side problem passed through', () => {
  const s = statusView(state(), NOW);
  assert.equal(s.word, 'LIVE');
  assert.equal(s.headline, null);
  const side = statusView(
    state({ error: { kind: 'http', message: 'Loading open interest for CLUSDT: …', source: 'openInterest', at: NOW } }),
    NOW,
  );
  assert.equal(side.word, 'LIVE');
  assert.match(side.detail ?? '', /open interest/);
});

test('statusView: stale says how old the figures are and when it retries', () => {
  const s = statusView(
    state({
      status: 'stale',
      lastMessageAt: NOW - 41_000,
      dataAt: NOW - 41_000 + 5_000, // Binance clock, 5 s ahead of the local one
      clockSkew: 5_000,
      error: { kind: 'stream', message: 'Live stream closed (1006)', source: 'stream', at: NOW, retryAt: NOW + 2_400 },
    }),
    NOW,
  );
  assert.equal(s.word, 'STALE');
  assert.equal(s.age, `last update 41${T}s ago`);
  assert.equal(s.retry, `retrying in 3${T}s`, 'rounded up');
  assert.match(s.headline ?? '', /stream/);
});

test('statusView: the REST fallback says DELAYED, how old the figures are, and why', () => {
  const never = statusView(state({ status: 'polling', lastMessageAt: null, dataAt: NOW - 7_000 }), NOW);
  assert.equal(never.word, 'DELAYED');
  assert.equal(never.tone, 'stale');
  assert.equal(never.age, `last update 7${T}s ago`);
  assert.match(never.headline ?? '', /could not be opened; the figures are fetched every 12/);
  const dropped = statusView(state({ status: 'polling', lastMessageAt: NOW - 60_000, dataAt: NOW - 3_000 }), NOW);
  assert.match(dropped.headline ?? '', /has dropped/);
  const stale = statusView(state({ status: 'stale', lastMessageAt: null, dataAt: NOW - 90_000 }), NOW);
  assert.match(stale.headline ?? '', /could not be opened; these are the last figures/);
  assert.equal(stale.age, `last update 1${T}min ago`);
});

test('statusView drops the stream message\u2019s frozen delay in favour of the live countdown', () => {
  const s = statusView(
    state({
      status: 'stale',
      lastMessageAt: NOW - 9_000,
      error: {
        kind: 'stream',
        message: 'Live stream: connection closed (1006); reconnecting in 4 s',
        source: 'stream',
        at: NOW - 1_000,
        retryAt: NOW + 3_000,
      },
    }),
    NOW,
  );
  assert.equal(s.detail, 'Live stream: connection closed (1006)');
  assert.equal(s.retry, `retrying in 3${T}s`);
});

test('statusView: a retry that is due never reads "0 s"', () => {
  const s = statusView(
    state({
      status: 'error',
      error: { kind: 'network', message: 'x', source: 'bootstrap', at: NOW, retryAt: NOW - 5 },
    }),
    NOW,
  );
  assert.equal(s.retry, `retrying in 1${T}s`);
});

test('statusView: a regional block is named honestly, inferred or read', () => {
  const inferred = statusView(
    state({
      status: 'error',
      error: { kind: 'region', inferred: true, message: 'Loading…', source: 'bootstrap', at: NOW },
    }),
    NOW,
  );
  assert.equal(inferred.word, 'BLOCKED');
  assert.match(inferred.headline ?? '', /does not serve this region/);
  assert.match(inferred.headline ?? '', /451/);
  const read = statusView(
    state({ status: 'error', error: { kind: 'region', status: 451, message: 'x', source: 'bootstrap', at: NOW } }),
    NOW,
  );
  assert.match(read.headline ?? '', /answered HTTP 451/);
});

test('statusView: other failures are OFFLINE with a plain headline per kind', () => {
  for (const kind of ['network', 'timeout', 'http', 'parse', 'stream', 'internal']) {
    const s = statusView(state({ status: 'error', error: { kind, message: 'm', source: 'bootstrap', at: NOW } }), NOW);
    assert.equal(s.word, 'OFFLINE', kind);
    assert.ok(s.headline && s.headline.length > 10, kind);
    assert.equal(s.detail, 'm');
  }
});

test('statusView: connecting shows a headline until something fails', () => {
  assert.equal(statusView(state({ status: 'connecting' }), NOW).word, 'CONNECTING');
  assert.match(statusView(state({ status: 'connecting' }), NOW).headline ?? '', /Connecting/);
});

test('announcement is short, uses plain digits and is empty without data', () => {
  assert.equal(announcement(symbolView(sym(), NOW)), 'XAUUSDT 4012.35, +0.42% in 24 hours');
  assert.equal(announcement(symbolView(empty('XAUUSDT'), NOW)), '');
});

test('createAnnouncer speaks at most once per interval, always the latest text', () => {
  let now = 0;
  const said = [];
  const timers = [];
  const a = createAnnouncer({
    write: (t) => said.push(t),
    intervalMs: 1000,
    now: () => now,
    setTimer: (fn, ms) => {
      timers.push({ fn, at: now + ms });
      return timers.length - 1;
    },
    clearTimer: (id) => {
      timers[id] = null;
    },
  });
  a.push('a');
  a.push('b');
  a.push('c');
  assert.deepEqual(said, ['a'], 'first one immediately, the rest wait');
  now = 1000;
  for (const t of timers.splice(0)) if (t && t.at <= now) t.fn();
  assert.deepEqual(said, ['a', 'c'], 'the latest text after the interval');
  a.push('c');
  now = 5000;
  a.push('c');
  assert.deepEqual(said, ['a', 'c'], 'unchanged text is not repeated');
  a.urgent('Live stream stopped.');
  assert.deepEqual(said, ['a', 'c', 'Live stream stopped.']);
});

test('imprint: ordinals and settlement hours', () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 30, 87, 101, 111].map(ordinal), [
    '1st',
    '2nd',
    '3rd',
    '4th',
    '11th',
    '12th',
    '13th',
    '21st',
    '22nd',
    '30th',
    '87th',
    '101st',
    '111th',
  ]);
  assert.equal(settlementHours(NEXT, 8), '00:00, 08:00 and 16:00');
  assert.equal(settlementHours(Date.UTC(2026, 9, 14, 4, 0), 8), '04:00, 12:00 and 20:00');
  assert.equal(settlementHours(NEXT, 24), '00:00');
});

test('imprint: the funding note follows the real schedule of each instrument', () => {
  assert.match(fundingNote(state()), new RegExp(`every 8${T}h, at 00:00, 08:00 and 16:00 UTC`));
  const mixed = state();
  mixed.symbols.CLUSDT = sym({ symbol: 'CLUSDT', fundingIntervalHours: 4, nextFundingTime: NEXT });
  assert.match(fundingNote(mixed), /XAU every 8.h .*CL every 4.h/);
  const unknown = state();
  unknown.symbols = { XAUUSDT: empty('XAUUSDT'), CLUSDT: empty('CLUSDT') };
  assert.match(fundingNote(unknown), /at each settlement/);
});

test('imprint: the mass note gives each percentile, or says it is not available', () => {
  assert.match(massNote(state()), /XAU at the 30th percentile, CL at the 87th percentile/);
  const s = state();
  s.symbols.CLUSDT = sym({ symbol: 'CLUSDT', rangePercentile30d: null });
  assert.match(massNote(s), /CL not available yet/);
});

test('announceWorthy: the first price, another instrument, a new extreme or a 0.25 % move', () => {
  const s = (/** @type {object} */ o = {}) => ({ symbol: 'XAUUSDT', last: 4000, high24h: 4050, low24h: 3950, ...o });
  assert.equal(announceWorthy(null, s()), true);
  assert.equal(announceWorthy(null, s({ last: null })), false, 'nothing to say without a price');
  assert.equal(announceWorthy(s(), s({ last: 4009 })), false, '0.22 %: not news');
  assert.equal(announceWorthy(s(), s({ last: 4010 })), true, '0.25 %');
  assert.equal(announceWorthy(s(), s({ last: 3990 })), true, 'down as well');
  assert.equal(announceWorthy(s(), s({ symbol: 'CLUSDT', last: 71 })), true, 'the main instrument changed');
  assert.equal(announceWorthy(s(), s({ last: 4051, high24h: 4051 })), true, 'a new 24 h high');
  assert.equal(announceWorthy(s({ last: 4051, high24h: 4051 }), s({ last: 4051, high24h: 4051 })), false);
  assert.equal(announceWorthy(s(), s({ last: 3949, low24h: 3949 })), true, 'a new 24 h low');
});
