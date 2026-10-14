// From market state to the strings the page sets. Pure: every number the reader sees
// passes through here, so the rules (placeholder for unknown, true minus, thin space,
// decimals per instrument) are tested in one place.

import {
  PLACEHOLDER,
  formatAge,
  formatCompact,
  formatCountdown,
  formatFundingRate,
  formatNumber,
  formatPercent,
  formatPrice,
  formatSigned,
} from '../format.js';
import { SYMBOL_INFO } from '../config.js';

/** @typedef {import('../market.js').SymbolState} SymbolState */
/** @typedef {import('../market.js').MarketState} MarketState */

/**
 * @typedef {Object} SymbolView
 * @property {string} symbol
 * @property {string} base        "XAU"
 * @property {string} name        "Gold"
 * @property {string} last
 * @property {string} change      "+16.79"
 * @property {string} changePct   "+0.42%"
 * @property {'up'|'down'|'flat'|null} direction
 * @property {string} high
 * @property {string} low
 * @property {string} open
 * @property {string} volume      full USDT figure, "1 284 512 330"
 * @property {string} volumeShort "1.28B"
 * @property {string} funding     "+0.0100%"
 * @property {string} fundingEvery "8 h" or the placeholder
 * @property {string} countdown   "03:17:41"
 * @property {number|null} countdownMs
 * @property {string} oi          contracts
 * @property {string} oiValue     USDT, whole dollars
 * @property {string} oiValueShort
 * @property {boolean} known      the price has arrived
 */

/**
 * @param {SymbolState} s
 * @param {number} serverNow Binance clock, for the funding countdown
 * @returns {SymbolView}
 */
export function symbolView(s, serverNow) {
  const d = s.priceDecimals;
  const info = SYMBOL_INFO[/** @type {keyof typeof SYMBOL_INFO} */ (s.symbol)];
  const countdownMs = s.nextFundingTime === null ? null : Math.max(0, s.nextFundingTime - serverNow);
  return {
    symbol: s.symbol,
    base: info?.base ?? s.symbol.replace(/USDT$/, ''),
    name: info?.name ?? s.symbol,
    last: formatPrice(s.last, d),
    change: formatSigned(s.change24h, d ?? 2),
    changePct: formatPercent(s.changePct24h),
    direction: directionOf(s.change24h),
    high: formatPrice(s.high24h, d),
    low: formatPrice(s.low24h, d),
    open: formatPrice(s.open24h, d),
    volume: formatNumber(s.quoteVolume24h, 0),
    volumeShort: formatCompact(s.quoteVolume24h),
    funding: formatFundingRate(s.fundingRate),
    fundingEvery: s.fundingIntervalHours === null ? PLACEHOLDER : `${s.fundingIntervalHours}\u2009h`,
    countdown: formatCountdown(countdownMs),
    countdownMs,
    oi: formatNumber(s.openInterest, s.qtyDecimals ?? 0),
    oiValue: formatNumber(s.openInterestValue, 0),
    oiValueShort: formatCompact(s.openInterestValue),
    known: s.last !== null,
  };
}

/**
 * @param {number|null} change
 * @returns {'up'|'down'|'flat'|null}
 */
export function directionOf(change) {
  if (change === null || !Number.isFinite(change)) return null;
  return change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
}

/**
 * @typedef {Object} StatusView
 * @property {'LIVE'|'STALE'|'CONNECTING'|'OFFLINE'|'BLOCKED'} word
 * @property {'live'|'stale'|'connecting'|'error'} tone
 * @property {string|null} age       "last update 41 s ago" while stale
 * @property {string|null} headline  one plain sentence when something is wrong
 * @property {string|null} detail    the data layer's own message (what was being done)
 * @property {string|null} retry     "retrying in 12 s" when a retry is scheduled
 */

/**
 * @param {MarketState} state
 * @param {number} localNow Date.now(): lastMessageAt and retryAt are local times
 * @returns {StatusView}
 */
export function statusView(state, localNow) {
  const raw = state.error;
  // The stream's message ends with the delay it computed when the socket dropped
  // ("…; reconnecting in 4 s"); that number goes stale, so the live countdown below
  // replaces it.
  const e =
    raw && raw.source === 'stream' ? { ...raw, message: raw.message.replace(/; reconnecting in \d+ s$/, '') } : raw;
  // Rounded up: "retrying in 0 s" would be false until the retry has happened.
  const retry =
    e && typeof e.retryAt === 'number'
      ? `retrying in ${formatAge(Math.ceil(Math.max(1000, e.retryAt - localNow) / 1000) * 1000)}`
      : null;
  const age =
    state.status === 'stale' && state.lastMessageAt !== null
      ? `last update ${formatAge(localNow - state.lastMessageAt)} ago`
      : null;

  if (state.status === 'live') {
    // A side problem (open interest poll failed) while prices stream: say it quietly.
    return { word: 'LIVE', tone: 'live', age: null, headline: null, detail: e ? e.message : null, retry };
  }
  if (state.status === 'stale') {
    const headline =
      e?.source === 'stream' || e === null
        ? 'The live stream from Binance has stopped; these are the last figures received.'
        : 'Binance stopped answering; these are the last figures received.';
    return { word: 'STALE', tone: 'stale', age, headline, detail: e ? e.message : null, retry };
  }
  if (state.status === 'connecting') {
    return {
      word: 'CONNECTING',
      tone: 'connecting',
      age: null,
      headline: e ? null : 'Connecting to Binance futures\u2026',
      detail: e ? e.message : null,
      retry,
    };
  }
  // 'error': nothing has loaded.
  if (e?.kind === 'region') {
    return {
      word: 'BLOCKED',
      tone: 'error',
      age: null,
      headline: e.inferred
        ? 'Binance does not serve this region. Its futures API gave this browser no readable answer while Binance’s public data mirror did, which is how its regional block (HTTP 451) looks from a web page.'
        : 'Binance does not serve this region: its futures API answered HTTP 451.',
      detail: e.message,
      retry,
    };
  }
  const headlines = {
    network: 'Binance cannot be reached from this browser right now.',
    timeout: 'Binance did not answer in time.',
    http: 'Binance refused the request.',
    parse: 'Binance answered in a shape this page does not understand.',
    stream: 'The live stream from Binance could not be opened.',
    internal: 'This page hit a bug while reading Binance.',
  };
  return {
    word: 'OFFLINE',
    tone: 'error',
    age: null,
    headline: e ? (headlines[/** @type {keyof typeof headlines} */ (e.kind)] ?? 'Binance data is unavailable.') : null,
    detail: e ? e.message : null,
    retry,
  };
}

/**
 * Text of the polite live region for the main instrument: short and only on change.
 * @param {SymbolView} v
 */
export function announcement(v) {
  if (!v.known) return '';
  return `${v.symbol} ${v.last.replace(/\u2009/g, '')}, ${v.changePct} in 24 hours`;
}
