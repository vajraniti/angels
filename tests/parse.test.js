import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  inferDecimals,
  parseExchangeInfo,
  parseFundingInfo,
  parseKlineEvent,
  parseKlinesRest,
  parseMarkPriceEvent,
  parseOpenInterest,
  parsePremiumIndexRest,
  parseServerTime,
  parseTicker24hrRest,
  parseTickerEvent,
  stepDecimals,
} from '../js/parse.js';
import { symbolView } from '../js/ui/view.js';
import { MarketError } from '../js/errors.js';

const fixture = (/** @type {string} */ rel) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${rel}`, import.meta.url), 'utf8'));
const docs = fixture('docs-examples.json');
const live = fixture('live/fapi-2026-10-14.json');

/** @param {() => unknown} fn @param {RegExp} pattern */
function throwsParse(fn, pattern) {
  assert.throws(fn, (err) => err instanceof MarketError && err.kind === 'parse' && pattern.test(err.message));
}

test('24h ticker: official REST example', () => {
  const t = parseTicker24hrRest(docs.ticker24hr.body);
  assert.deepEqual(t, {
    symbol: 'BTCUSDT',
    last: 4.000002,
    open: 99,
    high: 100,
    low: 0.1,
    volume: 8913.3,
    quoteVolume: 15.3,
    at: 1499869899040,
    priceStrings: ['4.00000200', '99.00000000', '100.00000000', '0.10000000'],
  });
});

test('24h ticker: official stream example', () => {
  const t = parseTickerEvent(docs.tickerEvent.data);
  assert.equal(t.symbol, 'BNBUSDT');
  assert.equal(t.last, 0.0025);
  assert.equal(t.open, 0.001);
  assert.equal(t.high, 0.0025);
  assert.equal(t.low, 0.001);
  assert.equal(t.quoteVolume, 18);
  assert.equal(t.at, 123456789);
});

test('mark price: official REST and stream examples map to the same fields', () => {
  assert.deepEqual(parsePremiumIndexRest(docs.premiumIndex.body), {
    symbol: 'BTCUSDT',
    markPrice: 11793.63104562,
    indexPrice: 11781.8049597,
    fundingRate: 0.00038246,
    nextFundingTime: 1597392000000,
    at: 1597370495002,
  });
  assert.deepEqual(parseMarkPriceEvent(docs.markPriceEvent.data), {
    symbol: 'BTCUSDT',
    markPrice: 11794.15,
    indexPrice: 11784.62659091,
    fundingRate: 0.00038167,
    nextFundingTime: 1562306400000,
    at: 1562305380000,
  });
});

test('open interest: official example, quantity precision read from the string', () => {
  assert.deepEqual(parseOpenInterest(docs.openInterest.body), {
    symbol: 'BTCUSDT',
    openInterest: 10659.509,
    qtyDecimals: 3,
    at: 1589437530011,
  });
});

test('funding info: listed symbols get their hours, unlisted ones null', () => {
  assert.deepEqual(parseFundingInfo(docs.fundingInfo.body, ['BLZUSDT', 'CLUSDT']), { BLZUSDT: 8, CLUSDT: null });
  assert.deepEqual(parseFundingInfo(fixture('rest/fundingInfo.json'), ['XAUUSDT', 'CLUSDT', 'ETHUSDT']), {
    XAUUSDT: 4,
    CLUSDT: 4,
    ETHUSDT: null,
  });
  throwsParse(() => parseFundingInfo({}, ['XAUUSDT']), /expected a JSON array/);
  throwsParse(
    () => parseFundingInfo([{ symbol: 'XAUUSDT', fundingIntervalHours: 0 }], ['XAUUSDT']),
    /fundingIntervalHours is 0/,
  );
});

test('server time: official example', () => {
  assert.equal(parseServerTime(docs.serverTime.body), 1499827319559);
});

test('klines: official REST example; the only row is the forming one until its close time passes', () => {
  const body = docs.klines.body;
  const forming = parseKlinesRest(body, 1499644799999);
  assert.deepEqual(forming.candles, [
    {
      t: 1499040000000,
      T: 1499644799999,
      o: 0.0163479,
      h: 0.8,
      l: 0.015758,
      c: 0.015771,
      v: 148976.11427815,
      q: 2434.19055334,
      n: 308,
      closed: false,
    },
  ]);
  assert.equal(parseKlinesRest(body, 1499644800000).candles[0].closed, true);
  assert.deepEqual(forming.priceStrings, ['0.01634790', '0.80000000', '0.01575800', '0.01577100']);
});

test('klines: every row but the last is closed whatever the local clock says', () => {
  const body = fixture('rest/klines-XAUUSDT-15m.json');
  const { candles } = parseKlinesRest(body, 0);
  assert.equal(candles.length, 300);
  assert.ok(candles.slice(0, -1).every((c) => c.closed));
  assert.equal(candles[candles.length - 1].closed, false);
});

test('klines: rows out of order or malformed are rejected with the row number', () => {
  const body = fixture('rest/klines-XAUUSDT-15m.json').slice(0, 3);
  throwsParse(() => parseKlinesRest([body[1], body[0]], 0, 'klines XAUUSDT 15m'), /ascending open-time order at row 1/);
  throwsParse(() => parseKlinesRest([body[0], [1, '2']], 0, 'klines XAUUSDT 15m'), /row 1: expected an array of 12/);
  const bad = structuredClone(body);
  bad[2][4] = 'abc';
  throwsParse(() => parseKlinesRest(bad, 0, 'klines XAUUSDT 15m'), /row 2: field "close" is missing or not a number/);
  throwsParse(() => parseKlinesRest({ code: -1121 }, 0), /expected a JSON array/);
});

test('kline event: official stream example', () => {
  const ev = parseKlineEvent(docs.klineEvent.data);
  assert.equal(ev.symbol, 'BTCUSDT');
  assert.equal(ev.interval, '1m');
  assert.equal(ev.at, 1638747660000);
  assert.deepEqual(ev.candle, {
    t: 1638747660000,
    T: 1638747719999,
    o: 0.001,
    h: 0.0025,
    l: 0.0015,
    c: 0.002,
    v: 1000,
    q: 1,
    n: 100,
    closed: false,
  });
});

test('kline event: x must be a real boolean', () => {
  const data = structuredClone(docs.klineEvent.data);
  data.k.x = 'false';
  throwsParse(() => parseKlineEvent(data), /k\.x/);
});

test('simulated fixtures parse with the precision fapi really sends', () => {
  const xau = parseTicker24hrRest(fixture('rest/ticker24hr-XAUUSDT.json'), 'XAUUSDT');
  assert.equal(xau.last, 4012.35);
  assert.equal(inferDecimals(xau.priceStrings), 2);
  const mark = parsePremiumIndexRest(fixture('rest/premiumIndex-XAUUSDT.json'), 'XAUUSDT');
  assert.ok(Math.abs(mark.markPrice - xau.last) < 1);
  const oi = parseOpenInterest(fixture('rest/openInterest-CLUSDT.json'), 'CLUSDT');
  assert.equal(oi.qtyDecimals, 2);
  const ev = parseTickerEvent(fixture('ws/ticker-CLUSDT.json').data);
  assert.equal(ev.symbol, 'CLUSDT');
  const mp = parseMarkPriceEvent(fixture('ws/markPrice-XAUUSDT.json').data);
  assert.equal(mp.symbol, 'XAUUSDT');
});

test('a reply for another symbol is a parse error, not silently stored', () => {
  throwsParse(() => parseTicker24hrRest(fixture('rest/ticker24hr-CLUSDT.json'), 'XAUUSDT'), /reply is for CLUSDT/);
  throwsParse(() => parsePremiumIndexRest(fixture('rest/premiumIndex-CLUSDT.json'), 'XAUUSDT'), /reply is for CLUSDT/);
  throwsParse(() => parseOpenInterest(fixture('rest/openInterest-CLUSDT.json'), 'XAUUSDT'), /reply is for CLUSDT/);
});

test('missing or non-numeric fields name the field and the payload', () => {
  const body = { ...fixture('rest/ticker24hr-XAUUSDT.json') };
  delete body.lastPrice;
  throwsParse(() => parseTicker24hrRest(body, 'XAUUSDT'), /24h ticker for XAUUSDT: field "lastPrice" is missing/);
  throwsParse(() => parseTicker24hrRest({ ...body, lastPrice: '' }, 'XAUUSDT'), /lastPrice/);
  throwsParse(() => parsePremiumIndexRest([], 'XAUUSDT'), /expected a JSON object, got an array/);
  throwsParse(() => parseTicker24hrRest(null), /expected a JSON object/);
  throwsParse(() => parseMarkPriceEvent({ ...docs.markPriceEvent.data, r: null }), /field "r"/);
  throwsParse(() => parseTickerEvent(docs.markPriceEvent.data), /unexpected event type "markPriceUpdate"/);
  throwsParse(() => parseServerTime({ serverTime: 'soon' }), /serverTime/);
});

test('inferDecimals: every string counts only for its digits before trailing zeros', () => {
  assert.equal(inferDecimals(['4164.96', '4168.90', '4170.86']), 2);
  assert.equal(inferDecimals(['48.1200']), 2, 'padding of any length is ignored');
  assert.equal(inferDecimals(['93.66000', '94.43000', '91.06000']), 2, 'CLUSDT pads to 5 places on a 0.01 tick');
  assert.equal(inferDecimals(['4164.96000000']), 2);
  assert.equal(inferDecimals(['94.25400000']), 3);
  assert.equal(inferDecimals(['100.00000000', '0.10000000']), 1);
  assert.equal(inferDecimals(['0.00001234']), 8);
  assert.equal(inferDecimals(['4012']), 0);
  assert.equal(inferDecimals(['4012.3', '4012.35']), 2);
  assert.equal(inferDecimals(['-0.81']), 2);
  assert.equal(inferDecimals([]), null);
  assert.equal(inferDecimals(['abc', '', '1e5']), null);
});

test('stepDecimals reads a tick or step through its padding', () => {
  assert.equal(stepDecimals('0.01000'), 2);
  assert.equal(stepDecimals('0.01'), 2);
  assert.equal(stepDecimals('0.5'), 1);
  assert.equal(stepDecimals('1'), 0);
  assert.equal(stepDecimals('10.00'), 0);
  assert.equal(stepDecimals('0.00001000'), 5);
  assert.equal(stepDecimals(''), null);
  assert.equal(stepDecimals(0.01), null, 'a number is not what fapi sends');
});

test('live CLUSDT (2026-10-14): padded strings and the tick both give 2 decimals on the page', () => {
  const t = parseTicker24hrRest(live['ticker24hr-CLUSDT'], 'CLUSDT');
  assert.equal(live['ticker24hr-CLUSDT'].lastPrice, '93.26000');
  const k = parseKlinesRest(live['klines-CLUSDT-15m'], live.exchangeInfo.serverTime, 'klines CLUSDT 15m');
  assert.equal(inferDecimals([...t.priceStrings, ...k.priceStrings]), 2);
  const steps = parseExchangeInfo(live.exchangeInfo, ['XAUUSDT', 'CLUSDT']);
  assert.deepEqual(steps, {
    XAUUSDT: { priceDecimals: 2, qtyDecimals: 3 },
    CLUSDT: { priceDecimals: 2, qtyDecimals: 2 },
  });
  const v = symbolView(
    {
      symbol: 'CLUSDT',
      last: t.last,
      open24h: t.open,
      change24h: Number((t.last - t.open).toFixed(2)),
      changePct24h: ((t.last - t.open) / t.open) * 100,
      high24h: t.high,
      low24h: t.low,
      quoteVolume24h: t.quoteVolume,
      markPrice: null,
      indexPrice: null,
      fundingRate: null,
      nextFundingTime: null,
      fundingIntervalHours: 4,
      openInterest: null,
      openInterestValue: null,
      priceDecimals: steps.CLUSDT?.priceDecimals ?? null,
      qtyDecimals: 2,
      rangePercentile30d: null,
      updatedAt: 0,
    },
    0,
  );
  assert.equal(v.last, '93.26');
  assert.equal(v.change, '+1.92');
  assert.equal(v.high, '94.43');
});

test('live open interest and fundingInfo parse as the page expects', () => {
  assert.equal(parseOpenInterest(live['openInterest-CLUSDT'], 'CLUSDT').qtyDecimals, 2);
  assert.equal(parseOpenInterest(live['openInterest-XAUUSDT'], 'XAUUSDT').qtyDecimals, 3);
  assert.deepEqual(parseFundingInfo(live.fundingInfo, ['XAUUSDT', 'CLUSDT']), { XAUUSDT: 4, CLUSDT: 4 });
});

test('parseExchangeInfo: unknown symbols map to null, a broken tick is a parse error', () => {
  assert.deepEqual(parseExchangeInfo({ symbols: [] }, ['XAUUSDT']), { XAUUSDT: null });
  throwsParse(() => parseExchangeInfo({ symbols: 'x' }, ['XAUUSDT']), /"symbols" is not an array/);
  throwsParse(
    () =>
      parseExchangeInfo({ symbols: [{ symbol: 'XAUUSDT', filters: [{ filterType: 'PRICE_FILTER' }] }] }, ['XAUUSDT']),
    /PRICE_FILTER\.tickSize is missing/,
  );
});
