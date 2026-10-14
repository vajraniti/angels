// The fixtures must be what the simulator produces (so nobody hand-edits one file out
// of step with the rest) and must agree with each other the way real data does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ANCHOR, createSim, fixtureFiles } from './fixtures/market-sim.mjs';

const read = (/** @type {string} */ rel) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${rel}`, import.meta.url), 'utf8'));
const sim = createSim();
const MIN15 = 15 * 60_000;

test('fixture files on disk equal the simulator output (run `npm run fixtures` after changing it)', () => {
  for (const [rel, body] of fixtureFiles()) assert.deepEqual(read(rel), body, rel);
});

for (const symbol of ['XAUUSDT', 'CLUSDT']) {
  test(`${symbol}: the 24h ticker summarises exactly the 1m candles of its window`, () => {
    const tk = read(`rest/ticker24hr-${symbol}.json`);
    const decimals = sim.spec(symbol).priceDecimals;
    const minutes = sim
      .klines(symbol, '1m', { at: ANCHOR, limit: 1500 })
      .filter((/** @type {any[]} */ k) => k[0] >= tk.openTime);
    assert.equal(minutes[0][0], tk.openTime);
    const highs = minutes.map((/** @type {any[]} */ k) => Number(k[2]));
    const lows = minutes.map((/** @type {any[]} */ k) => Number(k[3]));
    assert.equal(Math.max(...highs).toFixed(decimals), tk.highPrice);
    assert.equal(Math.min(...lows).toFixed(decimals), tk.lowPrice);
    assert.equal(minutes[0][1], tk.openPrice);
    assert.equal(minutes.at(-1)[4], tk.lastPrice);
    const volume = minutes.reduce((/** @type {number} */ s, /** @type {any[]} */ k) => s + Number(k[5]), 0);
    assert.ok(Math.abs(volume - Number(tk.volume)) < 0.01, `volume ${volume} vs ${tk.volume}`);
    assert.equal((Number(tk.lastPrice) - Number(tk.openPrice)).toFixed(decimals), tk.priceChange);
    assert.equal(tk.closeTime, ANCHOR);
  });

  test(`${symbol}: chart, mark price, funding and open interest agree with the ticker`, () => {
    const tk = read(`rest/ticker24hr-${symbol}.json`);
    const pi = read(`rest/premiumIndex-${symbol}.json`);
    const k15 = read(`rest/klines-${symbol}-15m.json`);
    const forming = k15.at(-1);
    assert.equal(forming[4], tk.lastPrice, 'forming 15m candle closes at the last price');
    assert.ok(forming[6] > ANCHOR && forming[0] <= ANCHOR);
    assert.ok(Math.abs(Number(pi.markPrice) / Number(tk.lastPrice) - 1) < 0.001, 'mark within 0.1 % of last');
    assert.match(pi.markPrice, /^\d+\.\d{8}$/, 'mark padded to 8 decimals like fapi');
    assert.equal(pi.nextFundingTime - ANCHOR, (3 * 3600 + 15 * 60 + 4) * 1000, 'countdown 03:15:04');
    const daily = read(`rest/klines-${symbol}-1d.json`);
    assert.equal(daily.length, 31);
    assert.ok(daily.at(-1)[6] > ANCHOR, 'the last daily candle is today, still forming');
  });
}

test('XAU is the calm instrument and CL the stormy one, with opposite 24h moves', () => {
  const xau = read('rest/ticker24hr-XAUUSDT.json');
  const cl = read('rest/ticker24hr-CLUSDT.json');
  assert.equal(xau.lastPrice, '4012.35');
  assert.equal(cl.lastPrice, '71.08');
  assert.ok(Number(xau.priceChangePercent) > 0);
  assert.ok(Number(cl.priceChangePercent) < 0);
  const rel = (/** @type {any} */ t) => (Number(t.highPrice) - Number(t.lowPrice)) / Number(t.lastPrice);
  assert.ok(rel(cl) > 3 * rel(xau), 'oil range is several times wider than gold');
});

test('stream fixtures continue the REST snapshot', () => {
  const formingRest = read('rest/klines-XAUUSDT-15m.json').at(-1);
  const forming = read('ws/kline-XAUUSDT-15m-forming.json');
  const closed = read('ws/kline-XAUUSDT-15m-closed.json');
  const next = read('ws/kline-XAUUSDT-15m-next.json');
  assert.equal(forming.stream, 'xauusdt@kline_15m');
  assert.equal(forming.data.k.t, formingRest[0]);
  assert.equal(forming.data.k.x, false);
  assert.ok(forming.data.k.n >= formingRest[8], 'trade count only grows');
  assert.equal(closed.data.k.t, formingRest[0], 'the close event finishes the same candle');
  assert.equal(closed.data.k.x, true);
  assert.ok(closed.data.E > closed.data.k.T);
  assert.equal(next.data.k.t, formingRest[0] + MIN15);
  assert.equal(next.data.k.x, false);
  const ticker = read('ws/ticker-XAUUSDT.json');
  assert.equal(ticker.data.E, ANCHOR + 2000);
  assert.equal(ticker.data.c, sim.lastPrice('XAUUSDT', ANCHOR + 2000).toFixed(2));
  const oi = read('rest/openInterest-XAUUSDT.json');
  assert.equal(oi.openInterest, '41220.118');
});
