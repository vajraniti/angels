import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStatus, createMarket } from '../js/market.js';
import { OI_POLL_MS, SILENT_RECONNECT_MS, STALE_AFTER_MS, SUBSCRIBE_DEBOUNCE_MS } from '../js/config.js';
import { ANCHOR, createSim } from './fixtures/market-sim.mjs';
import { advance, later, makeFakeFetch, makeFakeWebSocket, settle } from './support/fakes.js';

const sim = createSim();
const PROBE = 'https://data-api.binance.vision/api/v3/ping';
const MIN15 = 15 * 60_000;

/** Default fapi double: the simulator answers at the current (mocked) time. */
const simHandler = (/** @type {string} */ url) =>
  url.startsWith(PROBE) ? { status: 200, body: {} } : sim.handleRest(url, Date.now());

/**
 * @param {import('node:test').TestContext} t
 * @param {{ handler?: (url: string) => unknown, fetchImpl?: any, chart?: { symbol: string, interval: string }, now?: number }} [opts]
 */
function setup(t, { handler = simHandler, fetchImpl, chart, now = ANCHOR } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  const WS = makeFakeWebSocket();
  const fetch = fetchImpl ?? makeFakeFetch(handler);
  const market = createMarket({
    fetchImpl: fetch,
    WebSocketImpl: /** @type {any} */ (WS),
    now: () => Date.now(),
    random: () => 0.5,
    probeUrl: PROBE,
    ...(chart ? { chart } : {}),
  });
  /** @type {import('../js/market.js').MarketState[]} */
  const states = [];
  market.subscribe((s) => states.push(s));
  t.after(() => market.stop());
  return { market, WS, fetch, states };
}

/**
 * Push one combined-stream event built by the simulator at the current time.
 * @param {any} ws
 * @param {'ticker'|'markPrice'|'kline'} kind
 * @param {string} symbol
 * @param {{ interval?: string, final?: boolean, at?: number }} [o]
 */
function push(ws, kind, symbol, { interval = '15m', final = false, at = Date.now() } = {}) {
  const l = symbol.toLowerCase();
  if (kind === 'ticker') ws.serverSend({ stream: `${l}@ticker`, data: sim.tickerEvent(symbol, at) });
  if (kind === 'markPrice') ws.serverSend({ stream: `${l}@markPrice@1s`, data: sim.markPriceEvent(symbol, at) });
  if (kind === 'kline') {
    ws.serverSend({ stream: `${l}@kline_${interval}`, data: sim.klineEvent(symbol, interval, at, { final }) });
  }
}

test('computeStatus: connecting, live, stale and error', () => {
  const base = {
    hasData: true,
    fatal: false,
    connected: true,
    lastMessageAt: 1000,
    startedAt: 0,
    now: 2000,
    staleAfterMs: 8000,
  };
  assert.equal(computeStatus(base), 'live');
  assert.equal(computeStatus({ ...base, now: 9001 }), 'stale', 'silent longer than the threshold');
  assert.equal(computeStatus({ ...base, now: 9000 }), 'live', 'threshold is inclusive');
  assert.equal(computeStatus({ ...base, connected: false }), 'stale', 'data but no socket');
  assert.equal(computeStatus({ ...base, lastMessageAt: null }), 'connecting', 'REST data, stream in its grace period');
  assert.equal(computeStatus({ ...base, lastMessageAt: null, now: 8001 }), 'stale', 'stream never came');
  assert.equal(computeStatus({ ...base, hasData: false }), 'connecting');
  assert.equal(computeStatus({ ...base, hasData: false, fatal: true }), 'error');
  assert.equal(computeStatus({ ...base, fatal: true }), 'live', 'a failed reload does not hide live data');
});

test('start() fills every field from REST, consistent with the fixtures', async (t) => {
  const { market, WS, states } = setup(t);
  assert.equal(states.length, 1, 'subscribe() delivers the current state at once');
  assert.equal(states[0].status, 'connecting');
  assert.equal(states[0].symbols.XAUUSDT.last, null, 'nothing is invented before data arrives');
  market.start();
  await settle(20);
  const s = market.getState();

  const tk = sim.ticker24hr('XAUUSDT', ANCHOR);
  const pi = sim.premiumIndex('XAUUSDT', ANCHOR);
  const x = s.symbols.XAUUSDT;
  assert.equal(x.last, 4012.35);
  assert.equal(x.open24h, Number(tk.openPrice));
  assert.equal(x.change24h, Number(tk.priceChange));
  assert.ok(Math.abs(/** @type {number} */ (x.changePct24h) - Number(tk.priceChangePercent)) < 0.001);
  assert.equal(x.high24h, Number(tk.highPrice));
  assert.equal(x.low24h, Number(tk.lowPrice));
  assert.equal(x.quoteVolume24h, Number(tk.quoteVolume));
  assert.equal(x.markPrice, Number(pi.markPrice));
  assert.equal(x.indexPrice, Number(pi.indexPrice));
  assert.equal(x.fundingRate, Number(pi.lastFundingRate));
  assert.equal(x.nextFundingTime, Date.UTC(2026, 9, 14, 0, 0, 0));
  assert.equal(x.fundingIntervalHours, 8, 'listed in fundingInfo');
  assert.equal(x.openInterest, 41220.118);
  assert.equal(x.openInterestValue, 41220.118 * Number(pi.markPrice), 'OI value uses the mark price');
  assert.equal(x.priceDecimals, 2);
  assert.equal(x.qtyDecimals, 3);
  assert.equal(x.updatedAt, ANCHOR);

  const c = s.symbols.CLUSDT;
  assert.equal(c.last, 71.08);
  assert.equal(c.fundingIntervalHours, 8, 'absent from fundingInfo: Binance default');
  assert.equal(c.qtyDecimals, 2);
  assert.ok(c.fundingRate !== null && c.fundingRate < 0);

  // Calm gold, stormy oil: the two masses must not share a blur.
  assert.ok(
    x.rangePercentile30d !== null && x.rangePercentile30d >= 20 && x.rangePercentile30d <= 40,
    `XAU ${x.rangePercentile30d}`,
  );
  assert.ok(c.rangePercentile30d !== null && c.rangePercentile30d >= 80, `CL ${c.rangePercentile30d}`);

  assert.equal(s.clockSkew, 0);
  assert.equal(market.serverNow(), Date.now());
  assert.equal(s.chart.symbol, 'XAUUSDT');
  assert.equal(s.chart.interval, '15m');
  assert.equal(s.chart.loading, false);
  assert.equal(s.chart.candles.length, 300);
  assert.equal(s.chart.candles.at(-1)?.closed, false);
  assert.equal(s.chart.candles.at(-1)?.c, 4012.35, 'forming candle closes at the last price');
  assert.equal(s.error, null);
  assert.equal(s.status, 'connecting', 'REST data but no stream message yet');

  assert.equal(WS.instances.length, 1);
  assert.deepEqual(WS.last().urlStreams, [
    'xauusdt@ticker',
    'xauusdt@markPrice@1s',
    'clusdt@ticker',
    'clusdt@markPrice@1s',
    'xauusdt@kline_15m',
  ]);
});

test('stream events make the market live, then silence makes it stale and forces a reconnect', async (t) => {
  const { market, WS, fetch } = setup(t);
  market.start();
  await settle(20);
  const ws = WS.last();
  ws.serverOpen();
  t.mock.timers.tick(1000);
  push(ws, 'markPrice', 'XAUUSDT');
  await settle(1);
  assert.equal(market.getState().status, 'live');
  assert.equal(market.getState().lastMessageAt, ANCHOR + 1000);

  t.mock.timers.tick(STALE_AFTER_MS + 1000);
  assert.equal(market.getState().status, 'stale');

  const klineCalls = () => fetch.calls.filter((u) => u.includes('/fapi/v1/klines') && u.includes('15m')).length;
  const before = klineCalls();
  t.mock.timers.tick(SILENT_RECONNECT_MS);
  assert.equal(ws.closed?.by, 'client', 'the silent socket was dropped');
  assert.equal(market.getState().error?.source, 'stream');
  t.mock.timers.tick(1000);
  assert.equal(WS.instances.length, 2);
  WS.last().serverOpen();
  await settle(20);
  assert.equal(klineCalls(), before + 1, 'reconnect resynchronises the chart from REST');
  push(WS.last(), 'markPrice', 'XAUUSDT');
  await settle(1);
  assert.equal(market.getState().status, 'live');
  assert.equal(market.getState().error, null, 'a delivered message clears the stream error');
});

test('ticker, mark and kline events update the symbol; older events never roll values back', async (t) => {
  const { market, WS } = setup(t);
  market.start();
  await settle(20);
  const ws = WS.last();
  ws.serverOpen();

  t.mock.timers.tick(2000);
  push(ws, 'ticker', 'CLUSDT');
  const cl = market.getState().symbols.CLUSDT;
  assert.equal(cl.last, sim.lastPrice('CLUSDT', ANCHOR + 2000));

  t.mock.timers.tick(250);
  push(ws, 'kline', 'XAUUSDT');
  const xau = market.getState().symbols.XAUUSDT;
  assert.equal(xau.last, sim.lastPrice('XAUUSDT', ANCHOR + 2250), 'the chart kline (250 ms) carries the last price');
  const chartLast = market.getState().chart.candles.at(-1);
  assert.equal(chartLast?.c, xau.last, 'chart and price agree');

  // A ticker stamped before that kline must not overwrite the newer last price.
  const old = sim.tickerEvent('XAUUSDT', ANCHOR + 2100);
  old.c = '1.00';
  ws.serverSend({ stream: 'xauusdt@ticker', data: old });
  assert.equal(market.getState().symbols.XAUUSDT.last, xau.last);

  const markBefore = market.getState().symbols.XAUUSDT.markPrice;
  const staleMark = sim.markPriceEvent('XAUUSDT', ANCHOR - 5000);
  staleMark.p = '1.00000000';
  ws.serverSend({ stream: 'xauusdt@markPrice@1s', data: staleMark });
  assert.equal(market.getState().symbols.XAUUSDT.markPrice, markBefore, 'older than the REST snapshot: ignored');
});

test('a candle close moves the forming candle into history and starts the next one', async (t) => {
  const { market, WS } = setup(t);
  market.start();
  await settle(20);
  const ws = WS.last();
  ws.serverOpen();
  const boundary = Math.ceil(ANCHOR / MIN15) * MIN15;
  t.mock.timers.tick(boundary - ANCHOR + 12);
  push(ws, 'kline', 'XAUUSDT', { final: true });
  let candles = market.getState().chart.candles;
  assert.equal(candles.length, 300);
  assert.equal(candles.at(-1)?.closed, true);
  assert.equal(candles.at(-1)?.t, boundary - MIN15);
  t.mock.timers.tick(250);
  push(ws, 'kline', 'XAUUSDT');
  candles = market.getState().chart.candles;
  assert.equal(candles.length, 301);
  assert.equal(candles.at(-1)?.t, boundary);
  assert.equal(candles.at(-1)?.closed, false);
});

test('chart switch: the slow response of the previous chart is ignored even if it is not aborted', async (t) => {
  // A fetch that ignores AbortSignal, so only the generation check can protect us.
  /** @type {string[]} */
  const calls = [];
  const fetchImpl = async (/** @type {string} */ url) => {
    calls.push(url);
    if (url.includes('/fapi/v1/klines') && url.includes('XAUUSDT') && url.includes('15m')) await later(5000);
    const { status, body } = /** @type {any} */ (simHandler(url));
    return new Response(JSON.stringify(body), { status });
  };
  const { market, WS } = setup(t, { fetchImpl });
  market.start();
  await settle(20);
  assert.equal(market.getState().chart.loading, true);

  market.setChart({ symbol: 'CLUSDT', interval: '1h' });
  await settle(20);
  let chart = market.getState().chart;
  assert.equal(chart.symbol, 'CLUSDT');
  assert.equal(chart.loading, false);
  assert.ok(
    chart.candles.every((c) => c.c < 200),
    'oil prices',
  );

  t.mock.timers.tick(5000);
  await settle(20);
  chart = market.getState().chart;
  assert.equal(chart.symbol, 'CLUSDT');
  assert.equal(chart.interval, '1h');
  assert.ok(
    chart.candles.every((c) => c.c < 200),
    'the late gold snapshot did not land',
  );

  // Stream events of the old chart can still arrive before UNSUBSCRIBE takes effect.
  const ws = WS.last();
  ws.serverOpen();
  const len = chart.candles.length;
  push(ws, 'kline', 'XAUUSDT', { interval: '15m' });
  assert.equal(market.getState().chart.candles.length, len);
  assert.equal(market.getState().chart.candles.at(-1)?.c, chart.candles.at(-1)?.c);
  t.mock.timers.tick(SUBSCRIBE_DEBOUNCE_MS);
  assert.deepEqual(ws.sent, [
    { method: 'UNSUBSCRIBE', params: ['xauusdt@kline_15m'], id: 1 },
    { method: 'SUBSCRIBE', params: ['clusdt@kline_1h'], id: 2 },
  ]);
});

test('rapid switching aborts superseded loads, lands only the last chart and keeps one socket', async (t) => {
  const { market, WS, fetch } = setup(t);
  market.start();
  await settle(20);
  WS.last().serverOpen();
  const sequence = [
    { symbol: 'CLUSDT', interval: '1m' },
    { symbol: 'XAUUSDT', interval: '4h' },
    { symbol: 'CLUSDT', interval: '1d' },
    { interval: '5m' },
  ];
  for (const next of sequence) market.setChart(next);
  await settle(20);
  const chart = market.getState().chart;
  assert.equal(chart.symbol, 'CLUSDT');
  assert.equal(chart.interval, '5m');
  assert.equal(chart.loading, false);
  const last = chart.candles.at(-1);
  assert.equal(last?.t, Math.floor(ANCHOR / 300_000) * 300_000);
  assert.equal(WS.open().length, 1);
  t.mock.timers.tick(SUBSCRIBE_DEBOUNCE_MS);
  assert.deepEqual(WS.last().sent, [
    { method: 'UNSUBSCRIBE', params: ['xauusdt@kline_15m'], id: 1 },
    { method: 'SUBSCRIBE', params: ['clusdt@kline_5m'], id: 2 },
  ]);
  assert.ok(fetch.calls.filter((u) => u.includes('klines')).length >= 4);
});

test('stream candles that arrive while the snapshot loads are merged into it', async (t) => {
  const fetchImpl = makeFakeFetch(async (url) => {
    if (url.includes('/fapi/v1/klines') && url.includes('15m')) {
      // Snapshot taken now, delivered 2 s later.
      const snapshot = simHandler(url);
      await later(2000);
      return snapshot;
    }
    return simHandler(url);
  });
  const { market, WS } = setup(t, { fetchImpl });
  market.start();
  await settle(20);
  const ws = WS.last();
  ws.serverOpen();
  t.mock.timers.tick(1000);
  push(ws, 'kline', 'XAUUSDT');
  assert.equal(market.getState().chart.loading, true);
  assert.equal(market.getState().chart.candles.length, 0);
  t.mock.timers.tick(1000);
  await settle(20);
  const chart = market.getState().chart;
  assert.equal(chart.loading, false);
  assert.equal(chart.candles.at(-1)?.c, sim.lastPrice('XAUUSDT', ANCHOR + 1000), 'the newer buffered update won');
});

test('a gap in the kline stream triggers a REST resync', async (t) => {
  const { market, WS, fetch } = setup(t);
  market.start();
  await settle(20);
  WS.last().serverOpen();
  const calls = () => fetch.calls.filter((u) => u.includes('interval=15m')).length;
  const before = calls();
  // 45 minutes in which the chart stream says nothing while the socket stays healthy.
  await advance(t, 3 * MIN15, { step: 5000, each: () => push(WS.last(), 'markPrice', 'XAUUSDT') });
  assert.equal(WS.instances.length, 1, 'no reconnect happened, so only the gap can trigger the resync');
  push(WS.last(), 'kline', 'XAUUSDT');
  await settle(20);
  assert.equal(calls(), before + 1);
  const candles = market.getState().chart.candles;
  for (let i = 1; i < candles.length; i++) assert.equal(candles[i].t - candles[i - 1].t, MIN15, `no hole at ${i}`);
  assert.ok(candles.slice(0, -1).every((c) => c.closed));
  assert.equal(candles.at(-1)?.t, Math.floor(Date.now() / MIN15) * MIN15);
});

test('regional block: no numbers, status error, region kind, automatic retry', async (t) => {
  const handler = (/** @type {string} */ url) => {
    if (url.startsWith(PROBE)) return { status: 200, body: {} };
    throw new TypeError('Failed to fetch');
  };
  const { market, WS, fetch } = setup(t, { handler });
  market.start();
  await settle(20);
  WS.last().serverClose(1006);
  await settle(1);
  const s = market.getState();
  assert.equal(s.status, 'error');
  assert.equal(s.error?.kind, 'region');
  assert.equal(s.error?.source, 'bootstrap');
  assert.equal(s.error?.inferred, true);
  assert.ok(s.error?.retryAt !== undefined && s.error.retryAt > Date.now());
  for (const sym of Object.values(s.symbols)) {
    for (const [k, v] of Object.entries(sym)) if (k !== 'symbol') assert.equal(v, null, `${sym.symbol}.${k}`);
  }
  assert.equal(s.chart.candles.length, 0);
  assert.equal(s.chart.loading, true);
  assert.equal(s.chart.error?.kind, 'region');

  const tickerCalls = () => fetch.calls.filter((u) => u.includes('ticker/24hr')).length;
  const before = tickerCalls();
  t.mock.timers.tick(/** @type {number} */ (s.error?.retryAt) - Date.now());
  await settle(20);
  assert.equal(tickerCalls(), before + 2, 'retried both symbols');
});

test('a readable HTTP 451 is reported as such', async (t) => {
  const handler = (/** @type {string} */ url) =>
    url.startsWith(PROBE) ? { status: 200, body: {} } : { status: 451, body: { code: 0, msg: 'restricted location' } };
  const { market } = setup(t, { handler });
  market.start();
  await settle(20);
  const err = market.getState().error;
  assert.equal(err?.kind, 'region');
  assert.equal(err?.status, 451);
  assert.equal(err?.inferred, undefined);
  assert.match(err?.message ?? '', /Binance does not serve this region \(HTTP 451\)/);
});

test('one failing symbol does not hide the other', async (t) => {
  const handler = (/** @type {string} */ url) =>
    url.includes('symbol=CLUSDT') && url.includes('ticker/24hr')
      ? { status: 400, body: { code: -1121, msg: 'Invalid symbol.' } }
      : simHandler(url);
  const { market, WS } = setup(t, { handler });
  market.start();
  await settle(20);
  WS.last().serverOpen();
  push(WS.last(), 'markPrice', 'XAUUSDT');
  const s = market.getState();
  assert.equal(s.status, 'live');
  assert.equal(s.symbols.XAUUSDT.last, 4012.35);
  assert.equal(s.symbols.CLUSDT.last, null);
  assert.equal(s.error?.source, 'bootstrap');
  assert.match(s.error?.message ?? '', /^Loading 24h statistics for CLUSDT: .*code -1121: Invalid symbol/);
});

test('open interest is polled and its USDT value follows the mark price', async (t) => {
  const { market, WS, fetch } = setup(t);
  market.start();
  await settle(20);
  WS.last().serverOpen();
  const oiCalls = () => fetch.calls.filter((u) => u.includes('openInterest')).length;
  assert.equal(oiCalls(), 2);
  await advance(t, OI_POLL_MS, { step: 1000, each: () => push(WS.last(), 'markPrice', 'XAUUSDT') });
  assert.equal(oiCalls(), 4);
  const oi = sim.openInterest('XAUUSDT', ANCHOR + OI_POLL_MS);
  assert.equal(market.getState().symbols.XAUUSDT.openInterest, Number(oi.openInterest), 'the poll result landed');
  const ev = sim.markPriceEvent('XAUUSDT', Date.now());
  ev.p = '4100.00000000';
  WS.last().serverSend({ stream: 'xauusdt@markPrice@1s', data: ev });
  const x = market.getState().symbols.XAUUSDT;
  assert.equal(x.markPrice, 4100);
  assert.equal(x.openInterestValue, /** @type {number} */ (x.openInterest) * 4100);
});

test('server time sets clockSkew and serverNow()', async (t) => {
  const handler = (/** @type {string} */ url) =>
    url.includes('/fapi/v1/time') ? { status: 200, body: { serverTime: Date.now() + 5000 } } : simHandler(url);
  const { market } = setup(t, { handler });
  market.start();
  await settle(20);
  assert.equal(market.getState().clockSkew, 5000);
  assert.equal(market.serverNow(), Date.now() + 5000);
});

test('a failing auxiliary source is retried on its own and shows as the active error', async (t) => {
  let fail = true;
  const handler = (/** @type {string} */ url) =>
    fail && url.includes('fundingInfo')
      ? { status: 503, body: { code: -1001, msg: 'Service Unavailable.' } }
      : simHandler(url);
  const { market } = setup(t, { handler });
  market.start();
  await settle(20);
  let s = market.getState();
  assert.equal(s.error?.source, 'fundingInfo');
  assert.equal(s.symbols.XAUUSDT.fundingIntervalHours, null);
  fail = false;
  t.mock.timers.tick(/** @type {number} */ (s.error?.retryAt) - Date.now());
  await settle(20);
  s = market.getState();
  assert.equal(s.error, null);
  assert.equal(s.symbols.XAUUSDT.fundingIntervalHours, 8);
});

test('setChart validates input and ignores a no-op switch', async (t) => {
  const { market, fetch } = setup(t);
  market.start();
  await settle(20);
  assert.throws(() => market.setChart({ symbol: 'BTCUSDT' }), RangeError);
  assert.throws(() => market.setChart({ interval: '3m' }), RangeError);
  const calls = fetch.calls.length;
  market.setChart({ symbol: 'XAUUSDT', interval: '15m' });
  await settle(5);
  assert.equal(fetch.calls.length, calls);
  assert.throws(() => createMarket({ chart: { symbol: 'XAUUSDT', interval: '2h' } }), RangeError);
});

test('listeners: batched per microtask, unsubscribe works, a throwing listener does not break others', async (t) => {
  const errorLog = t.mock.method(console, 'error', () => {});
  const { market } = setup(t);
  let a = 0;
  let b = 0;
  const offA = market.subscribe(() => {
    a++;
    throw new Error('listener bug');
  });
  market.subscribe(() => b++);
  assert.equal(a, 1);
  assert.equal(b, 1);
  market.start();
  await settle(20);
  assert.ok(b > 1);
  assert.ok(b < 40, `updates are batched (${b} notifications)`);
  assert.equal(a, b, 'the throwing listener kept being called');
  assert.ok(errorLog.mock.callCount() >= 1);
  offA();
  const seen = a;
  market.setChart({ interval: '1h' });
  await settle(20);
  assert.equal(a, seen);
});

test('stop() aborts in-flight work, closes the socket and stays quiet; start() resumes', async (t) => {
  const fetchImpl = makeFakeFetch(async (url) => {
    await later(1000);
    return simHandler(url);
  });
  const { market, WS, states } = setup(t, { fetchImpl });
  market.start();
  await settle(5);
  market.stop();
  await settle(5);
  const count = states.length;
  t.mock.timers.tick(120_000);
  await settle(20);
  assert.equal(states.length, count, 'no updates after stop()');
  assert.equal(market.getState().symbols.XAUUSDT.last, null);
  assert.equal(WS.open().length, 0);

  market.start();
  await advance(t, 3000);
  assert.equal(market.getState().symbols.XAUUSDT.last, sim.lastPrice('XAUUSDT', ANCHOR + 121_000));
  assert.equal(WS.open().length, 1);
});
