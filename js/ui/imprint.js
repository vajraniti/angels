// The imprint's live lines: when the figures were printed, the funding schedule the
// † mark refers to, and one factual line on what the mass's grain encodes.

import { $, setText } from './dom.js';
import { formatUtcClock, formatUtcDate } from '../format.js';
import { SYMBOL_INFO } from '../config.js';

/** @typedef {import('../market.js').MarketState} MarketState */

/**
 * 1 → "1st", 2 → "2nd", 11 → "11th", 87 → "87th".
 * @param {number} n
 */
export function ordinal(n) {
  const k = Math.abs(n) % 100;
  if (k >= 11 && k <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][k % 10] ?? 'th'}`;
}

/**
 * Settlement hours of one UTC day, "00:00, 08:00 and 16:00".
 * @param {number} nextFundingTime
 * @param {number} intervalHours
 */
export function settlementHours(nextFundingTime, intervalHours) {
  const first = new Date(nextFundingTime).getUTCHours() + new Date(nextFundingTime).getUTCMinutes() / 60;
  const hours = [];
  for (let h = first % intervalHours; h < 24; h += intervalHours) hours.push(h);
  const text = hours.map((h) => {
    const hh = Math.floor(h);
    const mm = Math.round((h - hh) * 60);
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  });
  return text.length > 1 ? `${text.slice(0, -1).join(', ')} and ${text[text.length - 1]}` : text.join('');
}

/**
 * @param {MarketState} state
 */
export function fundingNote(state) {
  const parts = [];
  for (const s of Object.values(state.symbols)) {
    if (s.nextFundingTime === null || s.fundingIntervalHours === null) continue;
    parts.push({
      base: SYMBOL_INFO[/** @type {keyof typeof SYMBOL_INFO} */ (s.symbol)]?.base ?? s.symbol,
      every: s.fundingIntervalHours,
      at: settlementHours(s.nextFundingTime, s.fundingIntervalHours),
    });
  }
  const lead = '† Funding is paid between longs and shorts';
  const tail = 'the countdown runs to the next settlement.';
  if (parts.length === 0) return `${lead} at each settlement; ${tail}`;
  const same = parts.every((p) => p.every === parts[0].every && p.at === parts[0].at);
  if (same) return `${lead} every ${parts[0].every}\u2009h, at ${parts[0].at} UTC; ${tail}`;
  return `${lead}: ${parts.map((p) => `${p.base} every ${p.every}\u2009h (${p.at} UTC)`).join('; ')}; ${tail}`;
}

/**
 * @param {MarketState} state
 */
export function massNote(state) {
  const items = Object.values(state.symbols).map((s) => {
    const base = SYMBOL_INFO[/** @type {keyof typeof SYMBOL_INFO} */ (s.symbol)]?.base ?? s.symbol;
    return s.rangePercentile30d === null
      ? `${base} not available yet`
      : `${base} at the ${ordinal(Math.round(s.rangePercentile30d))} percentile`;
  });
  return (
    `Grain of the large letters: today’s 24\u2009h range ranked against the last 30 daily ranges, ` +
    `${items.join(', ')}. The sharp edge of the letters faces the 24\u2009h move.`
  );
}

/**
 * @param {HTMLElement} root the footer
 */
export function createImprint(root) {
  const asof = $('[data-imprint="asof"]', root);
  const funding = $('[data-imprint="funding"]', root);
  const mass = $('[data-imprint="mass"]', root);
  return {
    /** @param {MarketState} state */
    update(state) {
      // Binance's own time of the newest figure applied, whether it came by stream or REST.
      const t = state.dataAt;
      setText(asof, t === null ? '' : `Last figures ${formatUtcDate(t)}, ${formatUtcClock(t)} UTC.`);
      setText(funding, fundingNote(state));
      setText(mass, massNote(state));
    },
  };
}
