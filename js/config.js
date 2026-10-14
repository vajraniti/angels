// Static configuration of the screener's data layer. Everything that a deployment
// might need to change (a CORS proxy, symbols, cadence) lives here as one constant.

/** Instruments shown on the page, in display order (the first one is the main one). */
export const SYMBOLS = Object.freeze(['XAUUSDT', 'CLUSDT']);

/** Human names for the instruments. `base` is the short ticker set in large type. */
export const SYMBOL_INFO = Object.freeze({
  XAUUSDT: Object.freeze({ base: 'XAU', name: 'Gold' }),
  CLUSDT: Object.freeze({ base: 'CL', name: 'WTI crude oil' }),
});

/** Chart timeframes offered by the UI; all are valid Binance kline intervals. */
// https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/common-definition
export const INTERVALS = Object.freeze(['1m', '5m', '15m', '1h', '4h', '1d']);

/** Chart shown on first load ("Plate I. XAUUSDT, perpetual, 15 min."). */
export const DEFAULT_CHART = Object.freeze({ symbol: 'XAUUSDT', interval: '15m' });

/**
 * REST base URL. Swap for a same-shape proxy (e.g. a Cloudflare Worker that forwards
 * /fapi/v1/*) if fapi.binance.com stops answering browsers with CORS headers.
 * https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/general-info
 */
export const REST_BASE = 'https://fapi.binance.com';

/**
 * Combined-stream endpoint for "market" streams (ticker, markPrice, kline). The legacy
 * unrouted /stream URL stopped carrying these streams on 2026-04-23.
 * https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/websocket-market-streams/Important-WebSocket-Change-Notice
 */
export const WS_BASE = 'wss://fstream.binance.com/market/stream';

/**
 * A Binance host that is not region-blocked and answers browsers with
 * `access-control-allow-origin: *` (checked 2026-10-13). When a fapi request fails
 * without a readable response but this URL answers, the failure is attributed to
 * Binance's regional block, whose HTTP 451 reply carries no CORS headers.
 * Set to null to disable the probe (e.g. behind a proxy).
 */
export const REACHABILITY_PROBE_URL = 'https://data-api.binance.vision/api/v3/ping';

export const REST_TIMEOUT_MS = 10_000;
export const PROBE_TIMEOUT_MS = 5_000;

/** Candles requested for the chart (weight 2 for limit 100..499; the 1d ranges use 31, weight 1). */
export const KLINE_LIMIT = 300;
/** Upper bound of candles kept in memory while the stream appends new ones. */
export const CHART_MAX_CANDLES = 500;

/** /fapi/v1/openInterest has no stream, so it is polled. */
export const OI_POLL_MS = 30_000;
/** Daily ranges, funding interval and clock offset change slowly; refresh hourly. */
export const SLOW_REFRESH_MS = 60 * 60 * 1000;

/**
 * markPrice@1s pushes every second for each symbol, so several seconds of silence
 * means the feed is not live any more.
 */
export const STALE_AFTER_MS = 8_000;
/** Silence this long on an open socket means a half-open TCP link: reconnect. */
export const SILENT_RECONNECT_MS = 25_000;
/** A handshake that has not completed after this long is abandoned and retried. */
export const CONNECT_TIMEOUT_MS = 15_000;
/**
 * Binance closes every stream connection at the 24 h mark; reconnecting ten minutes
 * earlier keeps the drop on our schedule instead of theirs.
 */
export const WS_MAX_AGE_MS = 24 * 60 * 60 * 1000 - 10 * 60 * 1000;
/**
 * Binance disconnects a client that sends more than 10 messages per second. Chart
 * switches are coalesced so a burst of clicks sends at most one UNSUBSCRIBE and one
 * SUBSCRIBE per window.
 */
export const SUBSCRIBE_DEBOUNCE_MS = 250;

/** Reconnect schedule of the stream: exponential with equal jitter. */
export const STREAM_BACKOFF = Object.freeze({ baseMs: 1_000, capMs: 30_000 });
/** Retry schedule of failed REST loads. */
export const REST_BACKOFF = Object.freeze({ baseMs: 2_000, capMs: 60_000 });

/** How often the market re-evaluates live/stale status. */
export const STATUS_TICK_MS = 1_000;

/**
 * When the stream has been silent this long (or never opened: a proxy or a corporate
 * network that blocks WebSockets but lets HTTPS through), prices and funding are
 * polled over REST instead, so the page does not freeze at its first figures.
 */
export const FALLBACK_AFTER_MS = 5_000;
/** Cadence of that REST fallback: ticker/24hr + premiumIndex per symbol, weight 4 a round. */
export const FALLBACK_EVERY_MS = 12_000;
/**
 * Polled figures count as current (status "polling") while the last successful round
 * is at most this old: two missed rounds plus one request timeout.
 */
export const POLL_FRESH_MS = 2 * FALLBACK_EVERY_MS + REST_TIMEOUT_MS;

/** Daily candles compared against today's 24 h range. */
export const RANGE_DAYS = 30;
/** Fewer closed days than this (a fresh listing) gives no percentile at all. */
export const RANGE_MIN_DAYS = 10;

/**
 * /fapi/v1/fundingInfo lists only symbols whose funding settings were adjusted;
 * everything else settles on Binance's default 8 h schedule (00:00, 08:00, 16:00 UTC).
 * https://www.binance.com/en/support/faq/detail/360033525031
 */
export const FUNDING_INTERVAL_DEFAULT_H = 8;
