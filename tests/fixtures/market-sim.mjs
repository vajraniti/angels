// Deterministic simulator of Binance USDⓈ-M public market data for XAUUSDT and CLUSDT.
// It produces REST bodies and stream events in the exact documented shapes, from one
// seeded price path, so every number agrees with every other (the 24 h ticker equals
// the klines it summarises, OI value = OI × mark, the countdown matches the clock).
// FOR TESTS AND THE DEV HARNESS ONLY: the live site never loads this file.
//
//   node tests/fixtures/market-sim.mjs --write   regenerates tests/fixtures/{rest,ws}/*.json
//
// String formats copy what fapi actually sends (live replies read through
// www.binance.com/fapi, 2026-10-14): traded prices at the symbol's pricePrecision with
// trailing zeros kept, which for CLUSDT is 5 places on a 0.01 tick ("93.66000"); mark,
// index and funding padded to 8 decimals and not rounded to the tick; quantities at
// the quantity step; priceChangePercent with 3 decimals; ticker quote volume at the
// price precision and kline quote volume at price + quantity precision.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Fixture "now": 20:44:56 UTC, 4 s before a 1m/5m/15m boundary, 3 h 15 m before the
 * 00:00 settlement and 44 m after the 20:00 one (both symbols settle every 4 h, as live).
 */
export const ANCHOR = Date.UTC(2026, 9, 13, 20, 44, 56);
/** Funding interval of both symbols, as /fapi/v1/fundingInfo listed it on 2026-10-14. */
export const FUNDING_HOURS = 4;

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const FINE_STEP = 2_000;
const COARSE_STEP = MINUTE;
const FINE_DAYS = 33;
const HISTORY_DAYS = 310;
const FUTURE_MS = 3 * HOUR;

/**
 * Per-symbol parameters. `lastDayVolMul` scales volatility over the 24 h before ANCHOR
 * (gold calm, oil stormy, so the two dissolve masses differ visibly) and
 * `lastDayDrift` adds a log-trend over the same 24 h so the change has a clear sign.
 */
export const SPECS = {
  XAUUSDT: {
    seed: 1498,
    tick: 0.01,
    tickSize: '0.01',
    pricePrecision: 2,
    qtyDecimals: 3,
    anchorPrice: 4012.35,
    dailyVol: 0.011,
    lastDayVolMul: 0.7,
    lastDayDrift: 0.0042,
    qtyPerMinute: 25,
    avgTradeQty: 0.16,
    openInterest: 41220.118,
    fundingRate: 0.0001,
    basis: -0.00011,
    activeHoursUtc: [7, 17],
  },
  CLUSDT: {
    seed: 1617,
    tick: 0.01,
    tickSize: '0.01000',
    pricePrecision: 5,
    qtyDecimals: 2,
    anchorPrice: 71.08,
    dailyVol: 0.022,
    lastDayVolMul: 2.7,
    lastDayDrift: -0.0113,
    qtyPerMinute: 1800,
    avgTradeQty: 14,
    openInterest: 2318640.37,
    fundingRate: -0.000042,
    basis: 0.00018,
    activeHoursUtc: [13, 19],
  },
};

export const SIM_SYMBOLS = Object.keys(SPECS);

/** @param {number} a */
function mulberry32(a) {
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @param {() => number} rnd */
function gauss(rnd) {
  let u = 0;
  while (u === 0) u = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

/**
 * Activity profile over the UTC day: busier inside the instrument's main session.
 * @param {number} t
 * @param {[number, number]} hours
 */
function session(t, [from, to]) {
  const h = (t % DAY) / HOUR;
  const mid = (from + to) / 2;
  const half = (to - from) / 2;
  return 0.55 + 0.9 * Math.exp(-((h - mid) ** 2) / (2 * half * half));
}

/**
 * Build one symbol's trade path: a time series of (price, qty, trades) steps.
 * @param {keyof typeof SPECS} symbol
 */
function buildPath(symbol) {
  const spec = SPECS[symbol];
  const rnd = mulberry32(spec.seed);
  const start = Math.floor((ANCHOR - HISTORY_DAYS * DAY) / DAY) * DAY;
  const fineStart = Math.floor((ANCHOR - FINE_DAYS * DAY) / DAY) * DAY;
  const end = ANCHOR + FUTURE_MS;
  const coarse = (fineStart - start) / COARSE_STEP;
  const fine = Math.ceil((end - fineStart) / FINE_STEP) + 1;
  const n = coarse + fine;

  const time = new Float64Array(n);
  const logp = new Float64Array(n);
  const qty = new Float64Array(n);
  const trades = new Float64Array(n);

  const days = Math.ceil((end - start) / DAY) + 1;
  const regime = Array.from({ length: days }, () => Math.exp(0.38 * gauss(rnd)));

  // Mean reversion with a ~45-day half-life keeps a 300-day history within a
  // believable band instead of a random walk drifting ±40 %.
  const kappa = Math.LN2 / 45;
  let x = 0;
  for (let i = 0; i < n; i++) {
    const t = i < coarse ? start + i * COARSE_STEP : fineStart + (i - coarse) * FINE_STEP;
    const step = i < coarse ? COARSE_STEP : FINE_STEP;
    time[i] = t;
    const inLastDay = t > ANCHOR - DAY && t <= ANCHOR + FUTURE_MS;
    const volMul = inLastDay ? spec.lastDayVolMul : regime[Math.floor((t - start) / DAY)];
    const act = session(t, spec.activeHoursUtc);
    const sigma = spec.dailyVol * Math.sqrt(step / DAY) * volMul * Math.sqrt(act);
    const drift = (inLastDay && t <= ANCHOR ? spec.lastDayDrift : 0) * (step / DAY) - kappa * x * (step / DAY);
    if (i > 0) x += drift + sigma * gauss(rnd);
    logp[i] = x;
    const q = spec.qtyPerMinute * (step / MINUTE) * act * volMul * Math.exp(0.6 * gauss(rnd) - 0.18);
    qty[i] = Number(q.toFixed(spec.qtyDecimals));
    trades[i] = Math.max(1, Math.round(q / spec.avgTradeQty));
  }

  // Pin the level so the trade at ANCHOR prints exactly the specified price.
  const ia = indexAtOrBefore(time, ANCHOR);
  const shift = Math.log(spec.anchorPrice) - logp[ia];
  const price = new Float64Array(n);
  for (let i = 0; i < n; i++) price[i] = Math.round(Math.exp(logp[i] + shift) / spec.tick) * spec.tick;

  // Prefix sums turn every window total into two lookups.
  const cumQty = new Float64Array(n + 1);
  const cumQuote = new Float64Array(n + 1);
  const cumTrades = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    cumQty[i + 1] = cumQty[i] + qty[i];
    cumQuote[i + 1] = cumQuote[i] + qty[i] * price[i];
    cumTrades[i + 1] = cumTrades[i] + trades[i];
  }
  return { spec, time, price, qty, trades, cumQty, cumQuote, cumTrades, firstTime: start, lastTime: time[n - 1] };
}

/**
 * Index of the last step at or before t (−1 if none).
 * @param {Float64Array} time
 * @param {number} t
 */
function indexAtOrBefore(time, t) {
  let lo = 0;
  let hi = time.length - 1;
  if (t < time[0]) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (time[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Index of the first step at or after t (length if none).
 * @param {Float64Array} time
 * @param {number} t
 */
function indexAtOrAfter(time, t) {
  const i = indexAtOrBefore(time, t);
  if (i >= 0 && time[i] === t) return i;
  return i + 1;
}

const INTERVAL_MS = { '1m': MINUTE, '5m': 5 * MINUTE, '15m': 15 * MINUTE, '1h': HOUR, '4h': 4 * HOUR, '1d': DAY };

/** @param {string} interval */
function intervalLength(interval) {
  const ms = INTERVAL_MS[/** @type {keyof typeof INTERVAL_MS} */ (interval)];
  if (!ms) throw new RangeError(`market-sim: unsupported interval ${interval}`);
  return ms;
}

const TRADE_ID_BASE = 56_000_000;

export function createSim() {
  /** @type {Record<string, ReturnType<typeof buildPath>>} */
  const paths = {};
  /** @param {string} symbol */
  function path(symbol) {
    if (!(symbol in SPECS)) return null;
    if (!paths[symbol]) paths[symbol] = buildPath(/** @type {keyof typeof SPECS} */ (symbol));
    return paths[symbol];
  }

  /** @param {string} symbol */
  function need(symbol) {
    const p = path(symbol);
    if (!p) throw new RangeError(`market-sim: unknown symbol ${symbol}`);
    return p;
  }

  /**
   * Aggregate steps with time in [from, to] (inclusive).
   * @param {ReturnType<typeof buildPath>} p
   * @param {number} from
   * @param {number} to
   */
  function window(p, from, to) {
    const i0 = indexAtOrAfter(p.time, from);
    const i1 = indexAtOrBefore(p.time, to);
    if (i1 < i0) return null;
    let h = -Infinity;
    let l = Infinity;
    for (let i = i0; i <= i1; i++) {
      if (p.price[i] > h) h = p.price[i];
      if (p.price[i] < l) l = p.price[i];
    }
    return {
      o: p.price[i0],
      h,
      l,
      c: p.price[i1],
      v: p.cumQty[i1 + 1] - p.cumQty[i0],
      q: p.cumQuote[i1 + 1] - p.cumQuote[i0],
      n: p.cumTrades[i1 + 1] - p.cumTrades[i0],
      firstId: TRADE_ID_BASE + p.cumTrades[i0],
      lastId: TRADE_ID_BASE + p.cumTrades[i1 + 1] - 1,
      lastQty: p.qty[i1],
    };
  }

  /** @param {number} at */
  function nextFundingTime(at) {
    const every = FUNDING_HOURS * HOUR;
    return Math.floor(at / every) * every + every;
  }

  /**
   * @param {string} symbol
   * @param {number} at
   */
  function lastPrice(symbol, at) {
    const p = need(symbol);
    return p.price[indexAtOrBefore(p.time, at)];
  }

  /**
   * Mark sits near the last trade but off the tick grid ("93.27009403"), index is the
   * spot basket a small basis away; both are padded to 8 decimals as fapi does.
   * @param {string} symbol
   * @param {number} at
   */
  function markParts(symbol, at) {
    const spec = need(symbol).spec;
    const last = lastPrice(symbol, at);
    const wobble = 1 + 0.00002 * Math.sin(at / 7_000);
    const mark = last * wobble;
    const index = mark * (1 + spec.basis + 0.00001 * Math.sin(at / 11_000));
    const rate = spec.fundingRate + 0.000003 * Math.sin(at / 600_000);
    return { mark, index, rate, settle: index * (1 + 0.00002) };
  }

  /**
   * @param {string} symbol
   * @param {number} at
   */
  function stats24h(symbol, at) {
    const p = need(symbol);
    // fapi's rolling window starts on a whole minute (openTime ...:00.000).
    const openTime = Math.floor((at - DAY) / MINUTE) * MINUTE;
    const w = window(p, openTime, at);
    if (!w) throw new RangeError(`market-sim: no data for ${symbol} at ${at}`);
    return { p, w, openTime };
  }

  return {
    ANCHOR,
    symbols: SIM_SYMBOLS,
    spec: (/** @type {string} */ symbol) => need(symbol).spec,
    lastPrice,

    /** GET /fapi/v1/time */
    serverTime: (/** @type {number} */ at) => ({ serverTime: at }),

    /**
     * GET /fapi/v1/ticker/24hr?symbol=
     * @param {string} symbol
     * @param {number} at
     */
    ticker24hr(symbol, at) {
      const { p, w, openTime } = stats24h(symbol, at);
      const d = p.spec.pricePrecision;
      const change = w.c - w.o;
      return {
        symbol,
        priceChange: change.toFixed(d),
        priceChangePercent: ((change / w.o) * 100).toFixed(3),
        weightedAvgPrice: (w.q / w.v).toFixed(d),
        lastPrice: w.c.toFixed(d),
        lastQty: w.lastQty.toFixed(p.spec.qtyDecimals),
        openPrice: w.o.toFixed(d),
        highPrice: w.h.toFixed(d),
        lowPrice: w.l.toFixed(d),
        volume: w.v.toFixed(p.spec.qtyDecimals),
        quoteVolume: w.q.toFixed(d),
        openTime,
        closeTime: at,
        firstId: w.firstId,
        lastId: w.lastId,
        count: w.n,
      };
    },

    /**
     * GET /fapi/v1/premiumIndex?symbol=
     * @param {string} symbol
     * @param {number} at
     */
    premiumIndex(symbol, at) {
      const m = markParts(symbol, at);
      return {
        symbol,
        markPrice: m.mark.toFixed(8),
        indexPrice: m.index.toFixed(8),
        estimatedSettlePrice: m.settle.toFixed(8),
        lastFundingRate: m.rate.toFixed(8),
        interestRate: '0.00010000',
        nextFundingTime: nextFundingTime(at),
        time: at,
      };
    },

    /**
     * GET /fapi/v1/openInterest?symbol=
     * @param {string} symbol
     * @param {number} at
     */
    openInterest(symbol, at) {
      const spec = need(symbol).spec;
      const drift = 1 + 0.004 * Math.sin((at - ANCHOR) / (6 * HOUR));
      return { openInterest: (spec.openInterest * drift).toFixed(spec.qtyDecimals), symbol, time: at };
    },

    /**
     * GET /fapi/v1/fundingInfo — only symbols with adjusted settings are listed, as on
     * Binance. Both instruments are listed at 4 h, as live on 2026-10-14; the
     * default-interval path for an unlisted symbol is covered by unit tests.
     */
    fundingInfo() {
      return [
        {
          symbol: 'BTCUSDT',
          adjustedFundingRateCap: '0.00300000',
          adjustedFundingRateFloor: '-0.00300000',
          fundingIntervalHours: 8,
          disclaimer: false,
          updateTime: 1758000000000,
        },
        {
          symbol: 'XAUUSDT',
          adjustedFundingRateCap: '0.00500000',
          adjustedFundingRateFloor: '-0.00500000',
          fundingIntervalHours: FUNDING_HOURS,
          disclaimer: false,
          updateTime: 1769796333728,
        },
        {
          symbol: 'CLUSDT',
          adjustedFundingRateCap: '0.00500000',
          adjustedFundingRateFloor: '-0.00500000',
          fundingIntervalHours: FUNDING_HOURS,
          disclaimer: false,
          updateTime: 1774959060359,
        },
      ];
    },

    /**
     * GET /fapi/v1/exchangeInfo, cut to the fields and symbols the page reads; the
     * symbol entries copy the live ones (2026-10-14) apart from order types and the like.
     * @param {number} at
     */
    exchangeInfo(at) {
      const entry = (/** @type {keyof typeof SPECS} */ symbol, /** @type {string} */ base) => {
        const spec = SPECS[symbol];
        const step = (10 ** -spec.qtyDecimals).toFixed(spec.qtyDecimals);
        return {
          symbol,
          pair: symbol,
          contractType: 'TRADIFI_PERPETUAL',
          status: 'TRADING',
          baseAsset: base,
          quoteAsset: 'USDT',
          marginAsset: 'USDT',
          pricePrecision: spec.pricePrecision,
          quantityPrecision: spec.qtyDecimals,
          filters: [
            { filterType: 'PRICE_FILTER', tickSize: spec.tickSize, minPrice: spec.tickSize, maxPrice: '200000' },
            { filterType: 'LOT_SIZE', stepSize: step, minQty: step, maxQty: '500000' },
            { filterType: 'MIN_NOTIONAL', notional: '5' },
          ],
        };
      };
      return {
        timezone: 'UTC',
        serverTime: at,
        futuresType: 'U_MARGINED',
        rateLimits: [{ rateLimitType: 'REQUEST_WEIGHT', interval: 'MINUTE', intervalNum: 1, limit: 2400 }],
        exchangeFilters: [],
        assets: [],
        symbols: [entry('XAUUSDT', 'XAU'), entry('CLUSDT', 'CL')],
      };
    },

    /**
     * GET /fapi/v1/klines — the most recent `limit` candles up to the one containing
     * `at` (still forming), or ending at `endTime` when given.
     * @param {string} symbol
     * @param {string} interval
     * @param {{ at: number, limit?: number, endTime?: number }} options
     */
    klines(symbol, interval, { at, limit = 500, endTime }) {
      const p = need(symbol);
      const len = intervalLength(interval);
      const until = Math.min(at, endTime ?? Infinity);
      const lastOpen = Math.floor(until / len) * len;
      const rows = [];
      for (let t = lastOpen - (limit - 1) * len; t <= lastOpen; t += len) {
        if (t + len - 1 < p.firstTime) continue;
        const row = this.klineRow(symbol, interval, t, until);
        if (row) rows.push(row);
      }
      return rows;
    },

    /**
     * One REST kline row for the candle opening at `t`, aggregated up to `until`.
     * @param {string} symbol
     * @param {string} interval
     * @param {number} t
     * @param {number} until
     */
    klineRow(symbol, interval, t, until) {
      const p = need(symbol);
      const len = intervalLength(interval);
      const w = window(p, t, Math.min(t + len - 1, until));
      if (!w) return null;
      const d = p.spec.pricePrecision;
      const qd = p.spec.qtyDecimals;
      const takerShare = 0.48 + 0.04 * Math.sin(t / 3_600_000);
      return [
        t,
        w.o.toFixed(d),
        w.h.toFixed(d),
        w.l.toFixed(d),
        w.c.toFixed(d),
        w.v.toFixed(qd),
        t + len - 1,
        w.q.toFixed(d + qd),
        w.n,
        (w.v * takerShare).toFixed(qd),
        (w.q * takerShare).toFixed(d + qd),
        '0',
      ];
    },

    /**
     * `data` of <symbol>@ticker at time `at`.
     * @param {string} symbol
     * @param {number} at
     */
    tickerEvent(symbol, at) {
      const r = this.ticker24hr(symbol, at);
      return {
        e: '24hrTicker',
        E: at,
        s: symbol,
        p: r.priceChange,
        P: r.priceChangePercent,
        w: r.weightedAvgPrice,
        c: r.lastPrice,
        Q: r.lastQty,
        o: r.openPrice,
        h: r.highPrice,
        l: r.lowPrice,
        v: r.volume,
        q: r.quoteVolume,
        O: r.openTime,
        C: r.closeTime,
        F: r.firstId,
        L: r.lastId,
        n: r.count,
        ps: symbol,
        st: 1,
      };
    },

    /**
     * `data` of <symbol>@markPrice@1s at time `at`.
     * @param {string} symbol
     * @param {number} at
     */
    markPriceEvent(symbol, at) {
      const m = markParts(symbol, at);
      return {
        e: 'markPriceUpdate',
        E: at,
        s: symbol,
        p: m.mark.toFixed(8),
        i: m.index.toFixed(8),
        P: m.settle.toFixed(8),
        r: m.rate.toFixed(8),
        ap: m.mark.toFixed(8),
        T: nextFundingTime(at),
        st: 1,
      };
    },

    /**
     * `data` of <symbol>@kline_<interval>. By default the candle containing `at`,
     * forming; with `final`, the candle that ended just before `at`, closed (x: true),
     * which is what Binance pushes right after a boundary.
     * @param {string} symbol
     * @param {string} interval
     * @param {number} at
     * @param {{ final?: boolean }} [options]
     */
    klineEvent(symbol, interval, at, { final = false } = {}) {
      const len = intervalLength(interval);
      const t = Math.floor(at / len) * len - (final ? len : 0);
      const row = this.klineRow(symbol, interval, t, final ? t + len - 1 : at);
      if (!row) throw new RangeError(`market-sim: no ${interval} candle for ${symbol} at ${at}`);
      return {
        e: 'kline',
        E: at,
        s: symbol,
        k: {
          t: row[0],
          T: row[6],
          s: symbol,
          i: interval,
          f: TRADE_ID_BASE,
          L: TRADE_ID_BASE + row[8],
          o: row[1],
          c: row[4],
          h: row[2],
          l: row[3],
          v: row[5],
          n: row[8],
          x: final,
          q: row[7],
          V: row[9],
          Q: row[10],
          B: '0',
        },
      };
    },

    /**
     * Answer a REST request the way fapi would. Unknown symbols get Binance's own
     * error body (HTTP 400, code −1121).
     * @param {string} url
     * @param {number} at
     * @returns {{ status: number, body: unknown }}
     */
    handleRest(url, at) {
      const u = new URL(url);
      const q = u.searchParams;
      const symbol = q.get('symbol');
      const bad = { status: 400, body: { code: -1121, msg: 'Invalid symbol.' } };
      const known = (s) => s !== null && s in SPECS;
      switch (u.pathname) {
        case '/fapi/v1/time':
          return { status: 200, body: this.serverTime(at) };
        case '/fapi/v1/fundingInfo':
          return { status: 200, body: this.fundingInfo() };
        case '/fapi/v1/exchangeInfo':
          return { status: 200, body: this.exchangeInfo(at) };
        case '/fapi/v1/ticker/24hr':
          return known(symbol) ? { status: 200, body: this.ticker24hr(symbol, at) } : bad;
        case '/fapi/v1/premiumIndex':
          return known(symbol) ? { status: 200, body: this.premiumIndex(symbol, at) } : bad;
        case '/fapi/v1/openInterest':
          return known(symbol) ? { status: 200, body: this.openInterest(symbol, at) } : bad;
        case '/fapi/v1/klines': {
          if (!known(symbol)) return bad;
          const interval = q.get('interval') ?? '';
          if (!(interval in INTERVAL_MS)) return { status: 400, body: { code: -1120, msg: 'Invalid interval.' } };
          const limit = Math.min(1500, Number(q.get('limit') ?? 500));
          const endTime = q.has('endTime') ? Number(q.get('endTime')) : undefined;
          return { status: 200, body: this.klines(symbol, interval, { at, limit, endTime }) };
        }
        default:
          return { status: 404, body: { code: -5000, msg: `Path ${u.pathname}, Method GET is invalid` } };
      }
    },
  };
}

/** The 451 body fapi returned to this container (US) on 2026-10-13, verbatim. */
export const REGION_BLOCK_BODY = {
  code: 0,
  msg: "Service unavailable from a restricted location according to 'b. Eligibility' in https://www.binance.com/en/terms. Please contact customer service if you believe you received this message in error.",
};

/**
 * Contents of the static fixture files used by unit tests, keyed by path relative to
 * tests/fixtures. A test regenerates this map and compares it with the files on disk.
 * @returns {Map<string, unknown>}
 */
export function fixtureFiles() {
  const sim = createSim();
  const at = ANCHOR;
  /** @type {Map<string, unknown>} */
  const files = new Map();
  const wrap = (/** @type {string} */ stream, /** @type {unknown} */ data) => ({ stream, data });
  files.set('rest/time.json', sim.serverTime(at));
  files.set('rest/fundingInfo.json', sim.fundingInfo());
  files.set('rest/exchangeInfo.json', sim.exchangeInfo(at));
  files.set('rest/error-451.json', REGION_BLOCK_BODY);
  files.set('rest/error-invalid-symbol.json', { code: -1121, msg: 'Invalid symbol.' });
  for (const s of SIM_SYMBOLS) {
    const l = s.toLowerCase();
    files.set(`rest/ticker24hr-${s}.json`, sim.ticker24hr(s, at));
    files.set(`rest/premiumIndex-${s}.json`, sim.premiumIndex(s, at));
    files.set(`rest/openInterest-${s}.json`, sim.openInterest(s, at));
    files.set(`rest/klines-${s}-15m.json`, sim.klines(s, '15m', { at, limit: 300 }));
    files.set(`rest/klines-${s}-1d.json`, sim.klines(s, '1d', { at, limit: 31 }));
    files.set(`ws/ticker-${s}.json`, wrap(`${l}@ticker`, sim.tickerEvent(s, at + 2_000)));
    files.set(`ws/markPrice-${s}.json`, wrap(`${l}@markPrice@1s`, sim.markPriceEvent(s, at + 1_000)));
  }
  // The 20:30 candle forming at ANCHOR + 250 ms, then its close and the next candle,
  // both pushed right after the 20:45:00 boundary.
  const boundary = Math.floor(at / (15 * MINUTE)) * 15 * MINUTE + 15 * MINUTE;
  files.set('ws/kline-XAUUSDT-15m-forming.json', wrap('xauusdt@kline_15m', sim.klineEvent('XAUUSDT', '15m', at + 250)));
  files.set(
    'ws/kline-XAUUSDT-15m-closed.json',
    wrap('xauusdt@kline_15m', sim.klineEvent('XAUUSDT', '15m', boundary + 12, { final: true })),
  );
  files.set(
    'ws/kline-XAUUSDT-15m-next.json',
    wrap('xauusdt@kline_15m', sim.klineEvent('XAUUSDT', '15m', boundary + 260)),
  );
  return files;
}

/**
 * Write the static fixture files.
 * @param {string} dir tests/fixtures
 */
export function writeFixtures(dir) {
  for (const [rel, body] of fixtureFiles()) {
    const file = join(dir, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(body)}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--write')) {
    const dir = dirname(fileURLToPath(import.meta.url));
    writeFixtures(dir);
    console.log(`Fixtures written to ${dir}`);
  } else {
    console.log('Usage: node tests/fixtures/market-sim.mjs --write');
  }
}
