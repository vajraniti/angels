// Validation and normalisation of Binance payloads. Every parser accepts the exact
// documented shape (REST body or the `data` of a combined-stream event) and returns
// plain numbers; anything missing or non-numeric is a MarketError('parse') naming
// the field, never a NaN that silently reaches the page.
//
// Shapes checked against:
// REST  https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data
// WS    https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/ws-streams/market

import { MarketError } from './errors.js';

/**
 * Normalised 24 h rolling statistics (REST /fapi/v1/ticker/24hr or WS <sym>@ticker).
 * @typedef {Object} TickerStats
 * @property {string} symbol
 * @property {number} last
 * @property {number} open
 * @property {number} high
 * @property {number} low
 * @property {number} volume       Base asset volume (contracts).
 * @property {number} quoteVolume  USDT volume.
 * @property {number} at           Server time (ms) the statistics refer to.
 * @property {string[]} priceStrings Raw traded-price strings, for precision inference.
 */

/**
 * Normalised mark price and funding (REST /fapi/v1/premiumIndex or WS <sym>@markPrice@1s).
 * @typedef {Object} MarkInfo
 * @property {string} symbol
 * @property {number} markPrice
 * @property {number} indexPrice
 * @property {number} fundingRate      Fraction per interval (0.0001 = 0.01 %).
 * @property {number} nextFundingTime  Server time (ms).
 * @property {number} at               Server time (ms) of the values.
 */

/**
 * @typedef {Object} Candle
 * @property {number} t       Open time (ms, server clock). Unique key of a candle.
 * @property {number} T       Close time (ms), t + interval − 1.
 * @property {number} o
 * @property {number} h
 * @property {number} l
 * @property {number} c
 * @property {number} v       Base volume (contracts).
 * @property {number} q       Quote volume (USDT).
 * @property {number} n       Trade count; only grows while a candle forms, so it orders updates.
 * @property {boolean} closed
 */

/**
 * @param {unknown} value
 * @param {string} field
 * @param {string} ctx
 */
function num(value, field, ctx) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(n)) {
    throw new MarketError('parse', `${ctx}: field "${field}" is missing or not a number (${JSON.stringify(value)})`);
  }
  return n;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {string} ctx
 */
function str(value, field, ctx) {
  if (typeof value !== 'string' || value === '') {
    throw new MarketError('parse', `${ctx}: field "${field}" is missing or not a string (${JSON.stringify(value)})`);
  }
  return value;
}

/**
 * @param {unknown} body
 * @param {string} ctx
 * @returns {Record<string, unknown>}
 */
function obj(body, ctx) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new MarketError(
      'parse',
      `${ctx}: expected a JSON object, got ${Array.isArray(body) ? 'an array' : JSON.stringify(body)}`,
    );
  }
  return /** @type {Record<string, unknown>} */ (body);
}

/**
 * @param {unknown} body
 * @param {string} [expectSymbol]
 * @returns {TickerStats}
 */
export function parseTicker24hrRest(body, expectSymbol) {
  const ctx = `24h ticker${expectSymbol ? ` for ${expectSymbol}` : ''}`;
  const b = obj(body, ctx);
  const symbol = str(b.symbol, 'symbol', ctx);
  if (expectSymbol && symbol !== expectSymbol) {
    throw new MarketError('parse', `${ctx}: reply is for ${symbol}`);
  }
  return {
    symbol,
    last: num(b.lastPrice, 'lastPrice', ctx),
    open: num(b.openPrice, 'openPrice', ctx),
    high: num(b.highPrice, 'highPrice', ctx),
    low: num(b.lowPrice, 'lowPrice', ctx),
    volume: num(b.volume, 'volume', ctx),
    quoteVolume: num(b.quoteVolume, 'quoteVolume', ctx),
    at: num(b.closeTime, 'closeTime', ctx),
    priceStrings: [b.lastPrice, b.openPrice, b.highPrice, b.lowPrice].map(String),
  };
}

/**
 * `data` of a `<symbol>@ticker` event (e: "24hrTicker").
 * @param {unknown} data
 * @returns {TickerStats}
 */
export function parseTickerEvent(data) {
  const ctx = '24h ticker stream event';
  const d = obj(data, ctx);
  if (d.e !== '24hrTicker') throw new MarketError('parse', `${ctx}: unexpected event type ${JSON.stringify(d.e)}`);
  return {
    symbol: str(d.s, 's', ctx),
    last: num(d.c, 'c', ctx),
    open: num(d.o, 'o', ctx),
    high: num(d.h, 'h', ctx),
    low: num(d.l, 'l', ctx),
    volume: num(d.v, 'v', ctx),
    quoteVolume: num(d.q, 'q', ctx),
    at: num(d.E, 'E', ctx),
    priceStrings: [d.c, d.o, d.h, d.l].map(String),
  };
}

/**
 * @param {unknown} body
 * @param {string} [expectSymbol]
 * @returns {MarkInfo}
 */
export function parsePremiumIndexRest(body, expectSymbol) {
  const ctx = `mark price${expectSymbol ? ` for ${expectSymbol}` : ''}`;
  const b = obj(body, ctx);
  const symbol = str(b.symbol, 'symbol', ctx);
  if (expectSymbol && symbol !== expectSymbol) {
    throw new MarketError('parse', `${ctx}: reply is for ${symbol}`);
  }
  return {
    symbol,
    markPrice: num(b.markPrice, 'markPrice', ctx),
    indexPrice: num(b.indexPrice, 'indexPrice', ctx),
    fundingRate: num(b.lastFundingRate, 'lastFundingRate', ctx),
    nextFundingTime: num(b.nextFundingTime, 'nextFundingTime', ctx),
    at: num(b.time, 'time', ctx),
  };
}

/**
 * `data` of a `<symbol>@markPrice@1s` event (e: "markPriceUpdate").
 * @param {unknown} data
 * @returns {MarkInfo}
 */
export function parseMarkPriceEvent(data) {
  const ctx = 'mark price stream event';
  const d = obj(data, ctx);
  if (d.e !== 'markPriceUpdate') throw new MarketError('parse', `${ctx}: unexpected event type ${JSON.stringify(d.e)}`);
  return {
    symbol: str(d.s, 's', ctx),
    markPrice: num(d.p, 'p', ctx),
    indexPrice: num(d.i, 'i', ctx),
    fundingRate: num(d.r, 'r', ctx),
    nextFundingTime: num(d.T, 'T', ctx),
    at: num(d.E, 'E', ctx),
  };
}

/**
 * @param {unknown} body
 * @param {string} [expectSymbol]
 * @returns {{ symbol: string, openInterest: number, qtyDecimals: number, at: number }}
 */
export function parseOpenInterest(body, expectSymbol) {
  const ctx = `open interest${expectSymbol ? ` for ${expectSymbol}` : ''}`;
  const b = obj(body, ctx);
  const symbol = str(b.symbol, 'symbol', ctx);
  if (expectSymbol && symbol !== expectSymbol) {
    throw new MarketError('parse', `${ctx}: reply is for ${symbol}`);
  }
  return {
    symbol,
    openInterest: num(b.openInterest, 'openInterest', ctx),
    // fapi prints open interest at the contract's quantity step, unpadded
    // ("144427.392" for XAUUSDT, "2516235.78" for CLUSDT, 2026-10-14), so the string's
    // own length is right here; exchangeInfo's LOT_SIZE step overrides it when known.
    qtyDecimals: fractionLength(String(b.openInterest)),
    at: num(b.time, 'time', ctx),
  };
}

/**
 * /fapi/v1/fundingInfo returns only symbols with adjusted settings; a symbol that is
 * absent maps to null and the caller applies Binance's default interval.
 * @param {unknown} body
 * @param {readonly string[]} symbols
 * @returns {Record<string, number|null>} funding interval in hours per symbol
 */
export function parseFundingInfo(body, symbols) {
  const ctx = 'funding info';
  if (!Array.isArray(body)) throw new MarketError('parse', `${ctx}: expected a JSON array`);
  /** @type {Record<string, number|null>} */
  const out = Object.fromEntries(symbols.map((s) => [s, null]));
  for (const entry of body) {
    if (!entry || typeof entry !== 'object' || !symbols.includes(entry.symbol)) continue;
    const hours = num(entry.fundingIntervalHours, 'fundingIntervalHours', `${ctx} for ${entry.symbol}`);
    if (hours <= 0) throw new MarketError('parse', `${ctx} for ${entry.symbol}: fundingIntervalHours is ${hours}`);
    out[entry.symbol] = hours;
  }
  return out;
}

/**
 * @param {unknown} body
 * @returns {number} server time (ms)
 */
export function parseServerTime(body) {
  return num(obj(body, 'server time').serverTime, 'serverTime', 'server time');
}

/**
 * REST klines: arrays of 12 items, [openTime, o, h, l, c, v, closeTime, q, n, V, Q, ignore].
 * The last row is normally the candle still forming.
 * @param {unknown} body
 * @param {number} serverNow
 * @param {string} ctx e.g. "klines XAUUSDT 15m"
 * @returns {{ candles: Candle[], priceStrings: string[] }}
 */
export function parseKlinesRest(body, serverNow, ctx = 'klines') {
  if (!Array.isArray(body)) throw new MarketError('parse', `${ctx}: expected a JSON array`);
  /** @type {Candle[]} */
  const candles = [];
  /** @type {string[]} */
  const priceStrings = [];
  body.forEach((row, i) => {
    const rctx = `${ctx} row ${i}`;
    if (!Array.isArray(row) || row.length < 12) {
      throw new MarketError(
        'parse',
        `${rctx}: expected an array of 12 fields, got ${JSON.stringify(row)?.slice(0, 60)}`,
      );
    }
    const T = num(row[6], 'closeTime', rctx);
    candles.push({
      t: num(row[0], 'openTime', rctx),
      T,
      o: num(row[1], 'open', rctx),
      h: num(row[2], 'high', rctx),
      l: num(row[3], 'low', rctx),
      c: num(row[4], 'close', rctx),
      v: num(row[5], 'volume', rctx),
      q: num(row[7], 'quoteVolume', rctx),
      n: num(row[8], 'trades', rctx),
      // Every row but the last is history; the last one is the period in progress
      // unless its close time has already passed.
      closed: i < body.length - 1 || T < serverNow,
    });
    priceStrings.push(String(row[1]), String(row[2]), String(row[3]), String(row[4]));
  });
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].t <= candles[i - 1].t) {
      throw new MarketError('parse', `${ctx}: rows are not in ascending open-time order at row ${i}`);
    }
  }
  return { candles, priceStrings };
}

/**
 * `data` of a `<symbol>@kline_<interval>` event (e: "kline").
 * @param {unknown} data
 * @returns {{ symbol: string, interval: string, at: number, candle: Candle, priceStrings: string[] }}
 */
export function parseKlineEvent(data) {
  const ctx = 'kline stream event';
  const d = obj(data, ctx);
  if (d.e !== 'kline') throw new MarketError('parse', `${ctx}: unexpected event type ${JSON.stringify(d.e)}`);
  const k = obj(d.k, `${ctx} field "k"`);
  if (typeof k.x !== 'boolean') throw new MarketError('parse', `${ctx}: field "k.x" is not a boolean`);
  return {
    symbol: str(d.s, 's', ctx),
    interval: str(k.i, 'k.i', ctx),
    at: num(d.E, 'E', ctx),
    candle: {
      t: num(k.t, 'k.t', ctx),
      T: num(k.T, 'k.T', ctx),
      o: num(k.o, 'k.o', ctx),
      h: num(k.h, 'k.h', ctx),
      l: num(k.l, 'k.l', ctx),
      c: num(k.c, 'k.c', ctx),
      v: num(k.v, 'k.v', ctx),
      q: num(k.q, 'k.q', ctx),
      n: num(k.n, 'k.n', ctx),
      closed: k.x,
    },
    priceStrings: [k.o, k.h, k.l, k.c].map(String),
  };
}

/**
 * Fallback for the decimals a price prints with, read from the strings Binance sends,
 * used only until /fapi/v1/exchangeInfo has given the tick size.
 *
 * fapi pads its price strings beyond the tick: XAUUSDT trades at a 0.01 tick and
 * prints "4164.96", but CLUSDT, also at a 0.01 tick, prints "93.66000" (its
 * pricePrecision is 5), and mark/index prices are padded to 8 places. So no string's
 * length can be trusted: each counts only for the digits left after its trailing
 * zeros are stripped, and the maximum over all samples wins. A sample whose last
 * digit happens to be 0 ("4168.90") can under-count, which is why the caller keeps
 * the maximum over the session and the tick size overrides it.
 * (Live replies checked through www.binance.com/fapi, 2026-10-14.)
 * @param {Iterable<string>} strings
 * @returns {number|null} null when no sample is a number
 */
export function inferDecimals(strings) {
  let best = null;
  for (const s of strings) {
    if (typeof s !== 'string' || !/^-?\d+(\.\d+)?$/.test(s)) continue;
    best = Math.max(best ?? 0, Math.min(stepDecimals(s) ?? 0, 8));
  }
  return best;
}

/**
 * Digits after the decimal point as printed, padding included: "2516235.78" → 2.
 * @param {string} s
 */
function fractionLength(s) {
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

/**
 * Decimal places of a step or tick given as a decimal string, ignoring padding:
 * "0.01000" → 2, "0.5" → 1, "1" → 0, "10.00" → 0. Null for anything else.
 * @param {unknown} step
 * @returns {number|null}
 */
export function stepDecimals(step) {
  if (typeof step !== 'string' || !/^-?\d+(\.\d+)?$/.test(step)) return null;
  const dot = step.indexOf('.');
  return dot === -1 ? 0 : step.slice(dot + 1).replace(/0+$/, '').length;
}

/**
 * GET /fapi/v1/exchangeInfo: the tick size (PRICE_FILTER.tickSize) and quantity step
 * (LOT_SIZE.stepSize) of each wanted symbol, as decimal places. The tick is the only
 * reliable source for how many decimals a price has: Binance documents
 * pricePrecision as "please do not use it as tickSize", and the price strings are
 * padded to it (CLUSDT: pricePrecision 5, tickSize "0.01000").
 * A wanted symbol that is missing maps to null; the caller keeps its fallback.
 * @param {unknown} body
 * @param {readonly string[]} symbols
 * @returns {Record<string, { priceDecimals: number, qtyDecimals: number|null }|null>}
 */
export function parseExchangeInfo(body, symbols) {
  const ctx = 'exchange information';
  const b = obj(body, ctx);
  if (!Array.isArray(b.symbols)) throw new MarketError('parse', `${ctx}: field "symbols" is not an array`);
  /** @type {Record<string, { priceDecimals: number, qtyDecimals: number|null }|null>} */
  const out = Object.fromEntries(symbols.map((s) => [s, null]));
  for (const entry of b.symbols) {
    if (!entry || typeof entry !== 'object' || !symbols.includes(entry.symbol)) continue;
    const sctx = `${ctx} for ${entry.symbol}`;
    if (!Array.isArray(entry.filters)) throw new MarketError('parse', `${sctx}: field "filters" is not an array`);
    const filter = (/** @type {string} */ type) =>
      entry.filters.find((/** @type {any} */ f) => f && typeof f === 'object' && f.filterType === type);
    const price = filter('PRICE_FILTER');
    const priceDecimals = stepDecimals(price?.tickSize);
    if (priceDecimals === null) {
      throw new MarketError(
        'parse',
        `${sctx}: PRICE_FILTER.tickSize is missing or not a decimal (${JSON.stringify(price?.tickSize)})`,
      );
    }
    out[entry.symbol] = { priceDecimals, qtyDecimals: stepDecimals(filter('LOT_SIZE')?.stepSize) };
  }
  return out;
}
