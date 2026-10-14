// The screener's single source of market data. It loads REST snapshots, keeps them
// current from the combined WebSocket stream, polls what has no stream (open
// interest), and publishes one immutable state object to subscribers.
//
// Usage:
//   const market = createMarket();
//   const off = market.subscribe((state) => render(state));
//   market.start();
//   market.setChart({ symbol: 'CLUSDT', interval: '1h' });
//   countdownMs = state.symbols.XAUUSDT.nextFundingTime - market.serverNow();
//
// Endpoints and streams (checked 2026-10-13):
// REST https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data
//   GET /fapi/v1/ticker/24hr?symbol   weight 1   24 h rolling stats
//   GET /fapi/v1/premiumIndex?symbol  weight 1   mark/index price, last funding rate, next funding time
//   GET /fapi/v1/fundingInfo          weight 0   (shares 500/5 min/IP with /fundingRate) adjusted intervals
//   GET /fapi/v1/openInterest?symbol  weight 1   open interest, no stream exists
//   GET /fapi/v1/klines               weight 2   (limit 100..499) chart; weight 1 (limit 31) 1d ranges
//   GET /fapi/v1/time                 weight 1   clock offset
//   GET /fapi/v1/exchangeInfo         weight 1   tick size per symbol (about 1.1 MB, 52 KB gzipped):
//                                                once per session, then with the hourly refresh
// WS   https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/ws-streams/market
//   <symbol>@ticker (2000 ms), <symbol>@markPrice@1s, <symbol>@kline_<interval> (250 ms)

import {
  CHART_MAX_CANDLES,
  DEFAULT_CHART,
  FALLBACK_AFTER_MS,
  FALLBACK_EVERY_MS,
  FUNDING_INTERVAL_DEFAULT_H,
  INTERVALS,
  KLINE_LIMIT,
  OI_POLL_MS,
  POLL_FRESH_MS,
  RANGE_DAYS,
  RANGE_MIN_DAYS,
  REACHABILITY_PROBE_URL,
  REST_BACKOFF,
  REST_BASE,
  SLOW_REFRESH_MS,
  STALE_AFTER_MS,
  STATUS_TICK_MS,
  SYMBOLS,
  WS_BASE,
} from './config.js';
import { createRestClient } from './rest.js';
import { backoffDelay, createStreamClient } from './stream.js';
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
} from './parse.js';
import { dailyRanges, intervalMs, mergeCandle, mergeSnapshot, rangePercentile } from './candles.js';
import { MarketError, isAbort, toErrorInfo } from './errors.js';

/** @typedef {import('./parse.js').Candle} Candle */
/** @typedef {import('./errors.js').ErrorInfo} ErrorInfo */

/**
 * Per-instrument data. Every field is null until its source has answered; the page
 * must print a placeholder for null, never a made-up number.
 * @typedef {Object} SymbolState
 * @property {string} symbol
 * @property {number|null} last              Last traded price: the @ticker stream, or the chart's
 *                                           kline stream when that event is newer (250 ms cadence).
 * @property {number|null} open24h           First price of the rolling 24 h window.
 * @property {number|null} change24h         last − open24h, rounded to priceDecimals.
 * @property {number|null} changePct24h      change24h / open24h × 100.
 * @property {number|null} high24h           Rolling 24 h high (extended live by newer kline prices).
 * @property {number|null} low24h            Rolling 24 h low (same).
 * @property {number|null} quoteVolume24h    USDT traded in the rolling 24 h.
 * @property {number|null} markPrice
 * @property {number|null} indexPrice
 * @property {number|null} fundingRate       Fraction per funding interval: 0.0001 means +0.0100 %.
 * @property {number|null} nextFundingTime   Server-clock ms. Countdown: nextFundingTime − market.serverNow().
 * @property {number|null} fundingIntervalHours  From /fapi/v1/fundingInfo; Binance's default 8 when unlisted.
 * @property {number|null} openInterest      Open interest in contracts (base-asset quantity).
 * @property {number|null} openInterestValue USDT: openInterest × markPrice (last price until a mark arrives).
 *                                           Mark, not last: Binance values positions at mark price,
 *                                           and mark is not moved by a single print.
 * @property {number|null} priceDecimals     Decimals of the symbol's tick size (exchangeInfo PRICE_FILTER);
 *                                           until that arrives, the most read from its price strings.
 * @property {number|null} qtyDecimals       Decimals of contract quantities (exchangeInfo LOT_SIZE step,
 *                                           or the open-interest string until then).
 * @property {number|null} rangePercentile30d 0–100: where (high24h − low24h) ranks among the last 30
 *                                           closed daily ranges (ties count half). Null with < 10 days.
 * @property {number|null} updatedAt         Local ms of the last change to any field.
 */

/**
 * @typedef {Object} ChartState
 * @property {string} symbol
 * @property {string} interval        One of INTERVALS.
 * @property {readonly Candle[]} candles Ascending by `t`; at most CHART_MAX_CANDLES; the last one may be forming.
 * @property {boolean} loading        True from a switch until its REST snapshot arrives (candles is [] then).
 * @property {ErrorInfo|null} error   Last chart load failure (with retryAt); cleared on success.
 */

/**
 * @typedef {'connecting'|'live'|'polling'|'stale'|'error'} MarketStatus
 * - connecting: no data yet and nothing has failed for good; or data arrived but the
 *   stream has not delivered within its first STALE_AFTER_MS.
 * - live: the stream delivered within STALE_AFTER_MS.
 * - polling: the stream is down or never opened, and prices come from the REST
 *   fallback, whose last successful round is at most POLL_FRESH_MS old.
 * - stale: data is shown but neither the stream nor the fallback is delivering.
 * - error: no data at all and the initial load failed (see `error`; it retries by itself).
 */

/**
 * @typedef {Object} MarketState
 * @property {MarketStatus} status
 * @property {ErrorInfo|null} error   The most important active problem, null when none. Priority:
 *                                    bootstrap > stream > openInterest > fundingInfo > dailyRange > serverTime.
 * @property {number|null} lastMessageAt Local ms of the last stream data message.
 * @property {number|null} dataAt     Binance server ms of the newest price or mark actually applied
 *                                    (stream event time or REST reply time), null until one arrives.
 *                                    The page's "last update … ago" and "Last figures …" read it.
 * @property {number|null} clockSkew  serverTime − localTime in ms (from /fapi/v1/time), null until known.
 * @property {Record<string, SymbolState>} symbols
 * @property {ChartState} chart
 */

const ERROR_PRIORITY = [
  'bootstrap',
  'stream',
  'openInterest',
  'fundingInfo',
  'exchangeInfo',
  'dailyRange',
  'serverTime',
];

/**
 * Pure status rule, separated for tests.
 *
 * Live depends on the age of the newest stream message alone, not on whether a socket
 * is open at this instant: a reconnect (the planned 24 h recycle, or a drop that is
 * back within a second) leaves data well under STALE_AFTER_MS old, and calling it
 * stale would flash the stale mosaic for nothing. A socket that is open but silent is
 * caught by the same age rule, and the stream's watchdog replaces it.
 * @param {{ hasData: boolean, fatal: boolean, lastMessageAt: number|null, polledAt: number|null,
 *           startedAt: number, now: number, staleAfterMs: number, pollFreshMs: number }} p
 *        times in local ms; `polledAt` is the last successful REST round of prices
 * @returns {MarketStatus}
 */
export function computeStatus({ hasData, fatal, lastMessageAt, polledAt, startedAt, now, staleAfterMs, pollFreshMs }) {
  if (!hasData) return fatal ? 'error' : 'connecting';
  if (lastMessageAt !== null && now - lastMessageAt <= staleAfterMs) return 'live';
  // REST data arrived first; give the stream its grace period before saying it is not there.
  if (lastMessageAt === null && now - startedAt <= staleAfterMs) return 'connecting';
  if (polledAt !== null && now - polledAt <= pollFreshMs) return 'polling';
  return 'stale';
}

/**
 * Settle every promise; whatever succeeded has already been applied by its own
 * handler, so one failing symbol never hides the other. Then fail with the first
 * failure, so the task's error slot and retry still see it.
 * @param {Promise<unknown>[]} jobs
 */
async function allApplied(jobs) {
  const results = await Promise.allSettled(jobs);
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) throw /** @type {PromiseRejectedResult} */ (failed).reason;
}

/**
 * @param {string} symbol
 * @returns {SymbolState}
 */
function emptySymbol(symbol) {
  return {
    symbol,
    last: null,
    open24h: null,
    change24h: null,
    changePct24h: null,
    high24h: null,
    low24h: null,
    quoteVolume24h: null,
    markPrice: null,
    indexPrice: null,
    fundingRate: null,
    nextFundingTime: null,
    fundingIntervalHours: null,
    openInterest: null,
    openInterestValue: null,
    priceDecimals: null,
    qtyDecimals: null,
    rangePercentile30d: null,
    updatedAt: null,
  };
}

/**
 * @param {{
 *   symbols?: readonly string[],
 *   fetchImpl?: import('./rest.js').FetchLike,
 *   WebSocketImpl?: typeof WebSocket,
 *   now?: () => number,
 *   restBase?: string,
 *   wsBase?: string,
 *   probeUrl?: string|null,
 *   chart?: { symbol: string, interval: string },
 *   random?: () => number,
 * }} [options]
 */
export function createMarket({
  symbols = SYMBOLS,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  WebSocketImpl = globalThis.WebSocket,
  now = Date.now,
  restBase = REST_BASE,
  wsBase = WS_BASE,
  probeUrl = REACHABILITY_PROBE_URL,
  chart = DEFAULT_CHART,
  random = Math.random,
} = {}) {
  if (!symbols.length) throw new RangeError('createMarket: at least one symbol is required');
  validateChart(chart.symbol, chart.interval);

  /** @type {MarketState} */
  let state = {
    status: 'connecting',
    error: null,
    lastMessageAt: null,
    dataAt: null,
    clockSkew: null,
    symbols: Object.fromEntries(symbols.map((s) => [s, emptySymbol(s)])),
    chart: { symbol: chart.symbol, interval: chart.interval, candles: [], loading: true, error: null },
  };

  /** Event-time watermarks per symbol, so an older update never overwrites a newer one. */
  const marks = Object.fromEntries(
    symbols.map((s) => [s, { statsAt: -Infinity, lastAt: -Infinity, markAt: -Infinity, oiAt: -Infinity }]),
  );
  /** @type {Record<string, number[]|null>} closed daily ranges per symbol */
  const ranges = Object.fromEntries(symbols.map((s) => [s, null]));
  /**
   * Tick and quantity-step decimals per symbol from exchangeInfo; null until it answers.
   * @type {Record<string, { priceDecimals: number, qtyDecimals: number|null }|null>}
   */
  const steps = Object.fromEntries(symbols.map((s) => [s, null]));
  /** @type {Map<string, ErrorInfo>} */
  const errors = new Map();
  /** @type {Set<(state: MarketState) => void>} */
  const listeners = new Set();
  /** @type {Set<AbortController>} */
  const inflight = new Set();
  /** @type {ReturnType<typeof setInterval>[]} */
  let intervals = [];

  let started = false;
  let session = 0;
  let startedAt = 0;
  /**
   * Local ms of the last fully successful REST round of prices (bootstrap or fallback).
   * @type {number|null}
   */
  let polledAt = null;
  let emitQueued = false;
  /** @type {ReturnType<typeof createRestClient>|null} */
  let rest = null;
  /** @type {ReturnType<typeof createStreamClient>|null} */
  let stream = null;

  // Chart bookkeeping. `chartGen` increases on every switch; a response or retry that
  // belongs to an older generation is dropped, so fast switching cannot race.
  let chartGen = 0;
  /** @type {AbortController|null} */
  let chartCtrl = null;
  /** @type {Candle[]} stream candles that arrived while the snapshot was loading */
  let chartBuffer = [];
  let chartAttempt = 0;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let chartRetry = null;
  let chartResyncing = false;

  // ---------------------------------------------------------------- state plumbing

  function serverNow() {
    return now() + (state.clockSkew ?? 0);
  }

  /** @param {Partial<MarketState>} patch */
  function commit(patch) {
    const next = { ...state, ...patch };
    next.error = topError();
    next.status = statusOf(next);
    const changed =
      next.status !== state.status ||
      next.error !== state.error ||
      Object.keys(patch).some(
        (k) => patch[/** @type {keyof MarketState} */ (k)] !== state[/** @type {keyof MarketState} */ (k)],
      );
    state = next;
    if (changed) queueEmit();
  }

  /** @param {MarketState} s */
  function statusOf(s) {
    const hasData = Object.values(s.symbols).some((x) => x.last !== null && x.markPrice !== null);
    return computeStatus({
      hasData,
      fatal: errors.has('bootstrap'),
      lastMessageAt: s.lastMessageAt,
      polledAt,
      startedAt,
      now: now(),
      staleAfterMs: STALE_AFTER_MS,
      pollFreshMs: POLL_FRESH_MS,
    });
  }

  function topError() {
    for (const source of ERROR_PRIORITY) {
      const e = errors.get(source);
      if (e) return e;
    }
    return null;
  }

  /**
   * @param {string} source
   * @param {unknown} err
   * @param {number|null} [retryAt]
   */
  function setError(source, err, retryAt = null) {
    const info = toErrorInfo(err, source, now());
    if (retryAt !== null) info.retryAt = retryAt;
    errors.set(source, info);
    commit({});
  }

  /** @param {string} source */
  function clearError(source) {
    if (errors.delete(source)) commit({});
  }

  function queueEmit() {
    if (emitQueued) return;
    emitQueued = true;
    // Several updates from one event (or one Promise.all) reach listeners once.
    queueMicrotask(() => {
      emitQueued = false;
      const snapshot = state;
      for (const fn of listeners) {
        try {
          fn(snapshot);
        } catch (err) {
          console.error('A market state listener threw', err);
        }
      }
    });
  }

  /**
   * @param {string} sym
   * @param {Partial<SymbolState>} patch
   * @param {number|null} [at] server time of the price data in `patch`, which moves
   *        `dataAt`; null for data that is not a price (open interest, ranges, steps)
   */
  function patchSymbol(sym, patch, at = null) {
    const prev = state.symbols[sym];
    if (!prev) return;
    const next = derive(sym, { ...prev, ...patch, updatedAt: now() });
    /** @type {Partial<MarketState>} */
    const top = { symbols: { ...state.symbols, [sym]: next } };
    if (at !== null && (state.dataAt === null || at > state.dataAt)) top.dataAt = at;
    commit(top);
  }

  /**
   * Recompute the fields that are functions of others.
   * @param {string} sym
   * @param {SymbolState} s
   */
  function derive(sym, s) {
    const out = { ...s };
    if (s.last !== null && s.open24h !== null) {
      const raw = s.last - s.open24h;
      out.change24h = s.priceDecimals !== null ? Number(raw.toFixed(s.priceDecimals)) : raw;
      out.changePct24h = s.open24h !== 0 ? (raw / s.open24h) * 100 : null;
    }
    const valuation = s.markPrice ?? s.last;
    out.openInterestValue = s.openInterest !== null && valuation !== null ? s.openInterest * valuation : null;
    const r = ranges[sym];
    out.rangePercentile30d =
      r && s.high24h !== null && s.low24h !== null ? rangePercentile(s.high24h - s.low24h, r, RANGE_MIN_DAYS) : null;
    return out;
  }

  /**
   * Fallback precision from price strings, used only until exchangeInfo has answered.
   * @param {string} sym
   * @param {Iterable<string>} strings
   * @returns {Partial<SymbolState>} the priceDecimals patch, if it grew
   */
  function decimalsPatch(sym, strings) {
    if (steps[sym]) return {};
    const found = inferDecimals(strings);
    const cur = state.symbols[sym]?.priceDecimals ?? null;
    // Only grows: a sample whose last digit is 0 must not take a digit off the prices.
    return found !== null && (cur === null || found > cur) ? { priceDecimals: found } : {};
  }

  // ---------------------------------------------------------------- applying data

  /** @param {import('./parse.js').TickerStats} t */
  function applyTicker(t) {
    const m = marks[t.symbol];
    if (!m || t.at < m.statsAt) return;
    m.statsAt = t.at;
    /** @type {Partial<SymbolState>} */
    const patch = {
      open24h: t.open,
      high24h: t.high,
      low24h: t.low,
      quoteVolume24h: t.quoteVolume,
      ...decimalsPatch(t.symbol, t.priceStrings),
    };
    let at = null;
    if (t.at >= m.lastAt) {
      m.lastAt = t.at;
      patch.last = t.last;
      at = t.at;
    }
    patchSymbol(t.symbol, patch, at);
  }

  /** @param {import('./parse.js').MarkInfo} k */
  function applyMark(k) {
    const m = marks[k.symbol];
    if (!m || k.at < m.markAt) return;
    m.markAt = k.at;
    patchSymbol(
      k.symbol,
      {
        markPrice: k.markPrice,
        indexPrice: k.indexPrice,
        fundingRate: k.fundingRate,
        nextFundingTime: k.nextFundingTime,
      },
      k.at,
    );
  }

  /** @param {ReturnType<typeof parseKlineEvent>} ev */
  function applyKlineEvent(ev) {
    const m = marks[ev.symbol];
    if (!m) return;
    const s = state.symbols[ev.symbol];
    /** @type {Partial<SymbolState>} */
    const patch = decimalsPatch(ev.symbol, ev.priceStrings);
    let at = null;
    if (ev.at > m.lastAt) {
      // The forming candle's close is the latest trade; it is newer than the 2 s ticker.
      m.lastAt = ev.at;
      at = ev.at;
      const c = ev.candle.c;
      patch.last = c;
      if (s.high24h !== null && c > s.high24h) patch.high24h = c;
      if (s.low24h !== null && c < s.low24h) patch.low24h = c;
    }
    if (Object.keys(patch).length) patchSymbol(ev.symbol, patch, at);

    const ch = state.chart;
    // Events of the previous chart can still arrive until UNSUBSCRIBE takes effect.
    if (ev.symbol !== ch.symbol || ev.interval !== ch.interval) return;
    if (ch.loading) {
      chartBuffer.push(ev.candle);
      if (chartBuffer.length > CHART_MAX_CANDLES) chartBuffer.shift();
      return;
    }
    const r = mergeCandle(ch.candles, ev.candle, { maxLength: CHART_MAX_CANDLES, intervalMs: intervalMs(ch.interval) });
    if (r.changed) commit({ chart: { ...ch, candles: r.candles } });
    if (r.gap) loadChart(true);
  }

  // ---------------------------------------------------------------- REST loaders

  /**
   * @param {string} path
   * @param {Record<string, string|number>} params
   * @param {string} what
   */
  async function request(path, params, what) {
    if (!rest) throw new MarketError('aborted', `${what}: market is stopped`);
    const ctrl = new AbortController();
    inflight.add(ctrl);
    try {
      return await rest.getJson(path, params, { signal: ctrl.signal, what });
    } finally {
      inflight.delete(ctrl);
    }
  }

  /**
   * A REST job with its own error slot and retry-with-backoff; also re-run on a period.
   * @param {string} source
   * @param {() => Promise<void>} job
   */
  function task(source, job) {
    let attempt = 0;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let timer = null;
    // The session whose run is in flight (0: none). Scoped to the session, not a plain
    // flag: after stop() and start() in the same tick the aborted run of the old
    // session has not settled yet, and it must not block the new session's first run.
    let runningSession = 0;
    async function run() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (!started || runningSession === session) return;
      const sess = session;
      runningSession = sess;
      try {
        await job();
        if (sess !== session) return;
        attempt = 0;
        clearError(source);
      } catch (err) {
        if (sess !== session || isAbort(err)) return;
        const delay = backoffDelay(attempt++, REST_BACKOFF, random);
        setError(source, err, now() + delay);
        timer = setTimeout(run, delay);
      } finally {
        if (runningSession === sess) runningSession = 0;
      }
    }
    function cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      attempt = 0;
    }
    /** A run is in flight or a retry is scheduled: periodic callers leave it alone. */
    function busy() {
      return runningSession === session || timer !== null;
    }
    return { run, cancel, busy };
  }

  const bootstrap = task('bootstrap', async () => {
    await allApplied(
      symbols.flatMap((sym) => [
        request('/fapi/v1/ticker/24hr', { symbol: sym }, `Loading 24h statistics for ${sym}`).then((b) =>
          applyTicker(parseTicker24hrRest(b, sym)),
        ),
        request('/fapi/v1/premiumIndex', { symbol: sym }, `Loading mark price and funding for ${sym}`).then((b) =>
          applyMark(parsePremiumIndexRest(b, sym)),
        ),
      ]),
    );
    polledAt = now();
  });

  const openInterest = task('openInterest', () =>
    allApplied(
      symbols.map(async (sym) => {
        const oi = parseOpenInterest(
          await request('/fapi/v1/openInterest', { symbol: sym }, `Loading open interest for ${sym}`),
          sym,
        );
        const m = marks[sym];
        if (oi.at < m.oiAt) return;
        m.oiAt = oi.at;
        patchSymbol(sym, { openInterest: oi.openInterest, qtyDecimals: steps[sym]?.qtyDecimals ?? oi.qtyDecimals });
      }),
    ),
  );

  const fundingInfo = task('fundingInfo', async () => {
    const hours = parseFundingInfo(await request('/fapi/v1/fundingInfo', {}, 'Loading funding intervals'), symbols);
    for (const sym of symbols) patchSymbol(sym, { fundingIntervalHours: hours[sym] ?? FUNDING_INTERVAL_DEFAULT_H });
  });

  const exchangeInfo = task('exchangeInfo', async () => {
    const found = parseExchangeInfo(
      await request('/fapi/v1/exchangeInfo', {}, 'Loading tick sizes from exchange information'),
      symbols,
    );
    for (const sym of symbols) {
      const st = found[sym];
      if (!st) continue;
      steps[sym] = st;
      // The tick size is authoritative: set outright, so a padded string ("93.66000")
      // read before it arrived cannot keep extra digits.
      /** @type {Partial<SymbolState>} */
      const patch = { priceDecimals: st.priceDecimals };
      if (st.qtyDecimals !== null) patch.qtyDecimals = st.qtyDecimals;
      patchSymbol(sym, patch);
    }
  });

  const dailyRange = task('dailyRange', () =>
    allApplied(
      symbols.map(async (sym) => {
        const body = await request(
          '/fapi/v1/klines',
          { symbol: sym, interval: '1d', limit: RANGE_DAYS + 1 },
          `Loading ${RANGE_DAYS} daily ranges for ${sym}`,
        );
        const { candles, priceStrings } = parseKlinesRest(body, serverNow(), `daily klines ${sym}`);
        ranges[sym] = dailyRanges(candles, RANGE_DAYS);
        patchSymbol(sym, decimalsPatch(sym, priceStrings));
      }),
    ),
  );

  const serverTime = task('serverTime', async () => {
    const t0 = now();
    const body = await request('/fapi/v1/time', {}, 'Reading Binance server time');
    const t1 = now();
    // Assume the reply was stamped half-way through the round trip.
    commit({ clockSkew: Math.round(parseServerTime(body) - (t0 + t1) / 2) });
  });

  /**
   * Load the chart snapshot. `resync` keeps the candles on screen and merges, used after
   * a reconnect or a detected gap; otherwise the snapshot replaces an empty chart.
   * @param {boolean} resync
   */
  function loadChart(resync) {
    if (!started) return;
    if (resync && (state.chart.loading || chartResyncing)) return;
    const gen = chartGen;
    const sess = session;
    const { symbol, interval } = state.chart;
    if (chartRetry !== null) clearTimeout(chartRetry);
    chartRetry = null;
    chartCtrl?.abort();
    const ctrl = new AbortController();
    chartCtrl = ctrl;
    if (resync) chartResyncing = true;
    const what = `Loading ${interval} candles for ${symbol}`;

    rest
      .getJson('/fapi/v1/klines', { symbol, interval, limit: KLINE_LIMIT }, { signal: ctrl.signal, what })
      .then((body) => {
        if (gen !== chartGen || sess !== session) return;
        const { candles, priceStrings } = parseKlinesRest(body, serverNow(), `klines ${symbol} ${interval}`);
        const tailStart = candles.length ? candles[candles.length - 1].t : -Infinity;
        // On resync only the forming tail of what we hold can be newer than the snapshot;
        // older candles we hold may carry an inferred close, so the snapshot wins there.
        const updates = resync ? state.chart.candles.filter((c) => c.t >= tailStart) : chartBuffer;
        const merged = mergeSnapshot(candles, updates, CHART_MAX_CANDLES);
        chartBuffer = [];
        chartAttempt = 0;
        patchSymbol(symbol, decimalsPatch(symbol, priceStrings));
        commit({ chart: { ...state.chart, candles: merged, loading: false, error: null } });
      })
      .catch((err) => {
        if (gen !== chartGen || sess !== session || isAbort(err)) return;
        const delay = backoffDelay(chartAttempt++, REST_BACKOFF, random);
        const info = toErrorInfo(err, 'chart', now());
        info.retryAt = now() + delay;
        // `loading` stays true until a first snapshot lands, so stream candles keep
        // buffering and the retry still treats the chart as empty.
        commit({ chart: { ...state.chart, error: info } });
        chartRetry = setTimeout(() => loadChart(!state.chart.loading), delay);
      })
      .finally(() => {
        if (chartCtrl === ctrl) chartCtrl = null;
        if (resync && gen === chartGen) chartResyncing = false;
      });
  }

  // ---------------------------------------------------------------- stream

  function streamNames() {
    const names = symbols.flatMap((s) => {
      const l = s.toLowerCase();
      return [`${l}@ticker`, `${l}@markPrice@1s`];
    });
    names.push(`${state.chart.symbol.toLowerCase()}@kline_${state.chart.interval}`);
    return names;
  }

  /**
   * @param {string} name
   * @param {unknown} data
   */
  function onData(name, data) {
    try {
      if (name.endsWith('@ticker')) applyTicker(parseTickerEvent(data));
      else if (name.includes('@markPrice')) applyMark(parseMarkPriceEvent(data));
      else if (name.includes('@kline_')) applyKlineEvent(parseKlineEvent(data));
      else throw new MarketError('parse', `Live stream: data for unexpected stream "${name}"`);
      // Data on one stream does not mend a subscription Binance rejected on another:
      // that error stays until the rejected stream itself delivers.
      if (!stream?.info().rejected.length) errors.delete('stream');
      commit({ lastMessageAt: now() });
    } catch (err) {
      // A malformed event is a contract break worth seeing in the console, but the
      // connection itself is fine, so it is reported without dropping the socket.
      console.error(`Market stream event on ${name} could not be applied`, err);
      setError('stream', err);
    }
  }

  // ---------------------------------------------------------------- public API

  /**
   * @param {string} symbol
   * @param {string} interval
   */
  function validateChart(symbol, interval) {
    if (!symbols.includes(symbol))
      throw new RangeError(`Unknown chart symbol "${symbol}" (expected ${symbols.join(', ')})`);
    if (!INTERVALS.includes(interval)) {
      throw new RangeError(`Unsupported chart interval "${interval}" (expected ${INTERVALS.join(', ')})`);
    }
  }

  function start() {
    if (started) return;
    if (typeof fetchImpl !== 'function') throw new TypeError('createMarket: no fetch implementation available');
    started = true;
    session++;
    startedAt = now();
    polledAt = null;
    rest = createRestClient({ base: restBase, fetchImpl, probeUrl });
    stream = createStreamClient({
      base: wsBase,
      WebSocketImpl,
      streams: streamNames(),
      now,
      random,
      events: {
        onData,
        onOpen: ({ reconnect }) => {
          commit({});
          // Candle closes may have been missed while disconnected.
          if (reconnect) loadChart(true);
        },
        onError: (err, retryAt) => setError('stream', err, retryAt),
      },
    });
    stream.connect();
    bootstrap.run();
    openInterest.run();
    fundingInfo.run();
    exchangeInfo.run();
    dailyRange.run();
    // The chart waits for the clock offset: a skewed local clock could otherwise mark
    // the forming candle closed, which would freeze it.
    serverTime.run().finally(() => {
      if (started && state.chart.loading && !chartCtrl) loadChart(false);
    });
    intervals = [
      setInterval(() => openInterest.run(), OI_POLL_MS),
      setInterval(() => {
        fundingInfo.run();
        exchangeInfo.run();
        dailyRange.run();
        serverTime.run();
      }, SLOW_REFRESH_MS),
      setInterval(() => {
        pollIfStreamQuiet();
        commit({});
      }, STATUS_TICK_MS),
    ];
  }

  /**
   * REST fallback while the stream is down or was never able to open: refresh prices
   * and funding (and the chart's tail) every FALLBACK_EVERY_MS. It stops by itself as
   * soon as the stream delivers again. A failed round backs off through the task.
   */
  function pollIfStreamQuiet() {
    const t = now();
    const quietSince = state.lastMessageAt ?? startedAt;
    if (t - quietSince < FALLBACK_AFTER_MS) return;
    if (polledAt !== null && t - polledAt < FALLBACK_EVERY_MS) return;
    if (bootstrap.busy()) return;
    bootstrap.run();
    if (!state.chart.loading) loadChart(true);
  }

  function stop() {
    if (!started) return;
    started = false;
    session++;
    for (const id of intervals) clearInterval(id);
    intervals = [];
    for (const t of [bootstrap, openInterest, fundingInfo, exchangeInfo, dailyRange, serverTime]) t.cancel();
    for (const ctrl of inflight) ctrl.abort();
    inflight.clear();
    chartCtrl?.abort();
    chartCtrl = null;
    if (chartRetry !== null) clearTimeout(chartRetry);
    chartRetry = null;
    chartResyncing = false;
    stream?.close();
    stream = null;
    rest = null;
    commit({});
  }

  /**
   * Switch the chart. Either field may be omitted to keep its current value. The new
   * chart starts empty with `loading: true`; responses for the previous one are ignored.
   * @param {{ symbol?: string, interval?: string }} next
   */
  function setChart({ symbol = state.chart.symbol, interval = state.chart.interval } = {}) {
    validateChart(symbol, interval);
    if (symbol === state.chart.symbol && interval === state.chart.interval) return;
    chartGen++;
    chartCtrl?.abort();
    chartCtrl = null;
    if (chartRetry !== null) clearTimeout(chartRetry);
    chartRetry = null;
    chartBuffer = [];
    chartAttempt = 0;
    chartResyncing = false;
    commit({ chart: { symbol, interval, candles: [], loading: true, error: null } });
    stream?.setStreams(streamNames());
    loadChart(false);
  }

  /**
   * @param {(state: MarketState) => void} listener called now with the current state,
   *        then (batched per microtask) after every change
   * @returns {() => void} unsubscribe
   */
  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('subscribe: listener must be a function');
    listeners.add(listener);
    try {
      listener(state);
    } catch (err) {
      console.error('A market state listener threw', err);
    }
    return () => {
      listeners.delete(listener);
    };
  }

  return {
    start,
    stop,
    subscribe,
    setChart,
    /** @returns {MarketState} the current state; treat it as read-only */
    getState: () => state,
    /** Current time on Binance's clock (local time corrected by clockSkew). */
    serverNow,
  };
}
