// The ticker tape between two rules (brief 5.1): both instruments, funding, the
// next settlement, the UTC clock and an honest status word with its halo glyph.

import { $, fill, setDirection, setText } from './dom.js';
import { formatCountdown, formatUtcClock } from '../format.js';
import { symbolView } from './view.js';

/** @typedef {import('../market.js').MarketState} MarketState */

/**
 * @param {HTMLElement} root the tape header
 */
export function createTape(root) {
  const funding = $('[data-tape="funding"]', root);
  const next = $('[data-tape="next"]', root);
  const clock = $('[data-tape="clock"]', root);
  const status = $('[data-tape="status"]', root);
  const age = $('[data-tape="age"]', root);
  const halo = $('.halo use', root);

  return {
    /**
     * @param {MarketState} state
     * @param {number} serverNow
     * @param {import('./view.js').StatusView} st
     */
    update(state, serverNow, st) {
      const views = [];
      for (const el of root.querySelectorAll('[data-tape-sym]')) {
        const sym = /** @type {HTMLElement} */ (el).dataset.tapeSym ?? '';
        const s = state.symbols[sym];
        if (!s) continue;
        const v = symbolView(s, serverNow);
        views.push({ s, v });
        fill(el, 'v', /** @type {Record<string, string>} */ (/** @type {unknown} */ (v)));
        setDirection($('.g', el), v.direction);
      }
      setText(funding, views.map(({ v }) => v.funding).join(' / '));
      // One countdown when both settle together (the usual case), otherwise both.
      const times = [...new Set(views.map(({ s }) => s.nextFundingTime))];
      setText(
        next,
        times.length === 1
          ? formatCountdown(times[0] === null ? null : times[0] - serverNow)
          : views.map(({ v }) => v.countdown).join(' / '),
      );
      setText(clock, formatUtcClock(serverNow));
      setText(status, st.word === 'CONNECTING' ? 'Connecting' : st.word);
      setText(age, st.age ?? '');
      const glyph = st.tone === 'live' ? '#g-halo' : '#g-halo-open';
      if (halo.getAttribute('href') !== glyph) halo.setAttribute('href', glyph);
    },
  };
}
