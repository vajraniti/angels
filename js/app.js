// Entry point: connects the market (js/market.js) to the page's views. Every figure on
// the page comes from Binance through the market state; nothing here invents one.

import { createMarket } from './market.js';
import { DEFAULT_CHART, INTERVALS, SYMBOLS } from './config.js';
import { $, $$, prefs, reducedMotion, setText } from './ui/dom.js';
import { createHero } from './ui/hero.js';
import { createChart } from './ui/chart.js';
import { createPlate2 } from './ui/plate2.js';
import { createTape } from './ui/tape.js';
import { createImprint } from './ui/imprint.js';
import { createAnnouncer } from './ui/announce.js';
import { announceWorthy, announcement, statusView, symbolView } from './ui/view.js';

/** Fonts the canvases draw with; the page waits this long for them, then draws anyway. */
const FONT_WAIT_MS = 4000;
/**
 * The polite live region speaks the price at most this often, and only when it is
 * news (announceWorthy: a new 24 h high or low, or a move of a quarter percent).
 */
const ANNOUNCE_EVERY_MS = 20_000;

/** @typedef {import('./market.js').MarketState} MarketState */

function boot() {
  let main = prefs.get('main', SYMBOLS) ?? DEFAULT_CHART.symbol;
  const interval = prefs.get('interval', INTERVALS) ?? DEFAULT_CHART.interval;
  const market = createMarket({ chart: { symbol: main, interval } });
  // The dev harness (tools/dev-harness.mjs) reads the state next to its screenshots.
  /** @type {any} */ (window).__angelsMarket = market;

  const hero = createHero($('#hero'));
  const chart = createChart($('#plate1'), {
    serverNow: market.serverNow,
    redElsewhere: $('#hero [data-crisp] [data-geo-dial]'),
  });
  const plate2 = createPlate2($('#plate2'));
  const tape = createTape($('.tape'));
  const imprint = createImprint($('.imprint'));
  const liveRegion = $('[data-announce]');
  const announcer = createAnnouncer({ write: (t) => setText(liveRegion, t), intervalMs: ANNOUNCE_EVERY_MS });

  const secondOf = (/** @type {string} */ sym) => SYMBOLS.find((s) => s !== sym) ?? sym;

  function syncRoleButtons() {
    for (const b of $$('[data-set-main]')) b.setAttribute('aria-pressed', String(b.dataset.setMain === main));
  }

  hero.setMain(main);
  plate2.setSymbol(secondOf(main));
  syncRoleButtons();

  let lastWord = '';
  let hadData = false;
  let queued = false;
  /** @type {import('./ui/view.js').Said|null} what the live region last said */
  let said = null;

  /** @param {MarketState} state */
  function render(state) {
    const serverNow = market.serverNow();
    const st = statusView(state, Date.now());
    document.body.dataset.status = state.status;
    tape.update(state, serverNow, st);
    hero.update(state, serverNow);
    hero.setNotice(st);
    plate2.update(state, serverNow);
    imprint.update(state);
    chart.update(state);

    const hasData = state.symbols[main].last !== null;
    if (hasData && !hadData) revealNumbers();
    hadData = hasData;

    if (st.word !== lastWord) {
      // Status changes are rare and matter; say them at once. The first
      // "connecting" is not news.
      if (lastWord !== '' || st.word !== 'CONNECTING') {
        announcer.urgent(st.word === 'LIVE' ? 'Live data from Binance.' : (st.headline ?? st.word));
      }
      lastWord = st.word;
    }
    const s = state.symbols[main];
    if (announceWorthy(said, s)) {
      said = { symbol: s.symbol, last: s.last, high24h: s.high24h, low24h: s.low24h };
      announcer.push(announcement(symbolView(s, serverNow)));
    }
  }

  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      try {
        render(market.getState());
      } catch (err) {
        console.error('Rendering the page from the market state failed', err);
      }
    });
  }

  /** The first figures come into focus from coarse mosaic blocks (brief: states). */
  function revealNumbers() {
    if (reducedMotion()) return;
    const steps = ['8', '4', '2', ''];
    steps.forEach((level, i) => {
      setTimeout(() => {
        if (level) document.body.dataset.reveal = level;
        else delete document.body.dataset.reveal;
      }, i * 150);
    });
  }

  /** @param {string} sym */
  function setMain(sym) {
    if (sym === main || !SYMBOLS.includes(sym)) return;
    main = sym;
    prefs.set('main', sym);
    hero.setMain(sym);
    plate2.setSymbol(secondOf(sym));
    syncRoleButtons();
    market.setChart({ symbol: sym });
    schedule();
  }

  for (const b of $$('[data-set-main]')) b.addEventListener('click', () => setMain(b.dataset.setMain ?? ''));
  for (const b of $$('[data-interval]')) {
    b.addEventListener('click', () => {
      const next = b.dataset.interval ?? '';
      if (!INTERVALS.includes(next)) return;
      prefs.set('interval', next);
      market.setChart({ interval: next });
    });
  }

  market.subscribe(schedule);

  // Countdowns, the clock and "last update" ages move even when no data arrives.
  // Ticks are aligned to Binance's second so the countdown never skips a digit.
  function tick() {
    schedule();
    chart.tick();
    setTimeout(tick, 1000 - (market.serverNow() % 1000) + 5);
  }
  setTimeout(tick, 1000 - (Date.now() % 1000));

  let resizeTimer = 0;
  let lastSize = '';
  new ResizeObserver(([entry]) => {
    const size = `${Math.round(entry.contentRect.width)}x${Math.round(entry.contentRect.height)}`;
    if (size === lastSize) return;
    lastSize = size;
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      hero.relayout();
      schedule();
    }, 150);
  }).observe($('#hero'));

  // The mass is drawn from Archivo's own glyphs; wait for them, but not forever.
  let archivoReady = document.fonts.check('900 100px Archivo');
  const fontsLoaded = Promise.all([
    document.fonts.load('900 100px Archivo'),
    document.fonts.load('400 100px "Bodoni Moda"'),
    document.fonts.load('italic 400 12px "Bodoni Moda"'),
  ]);
  const timeout = new Promise((resolve) => {
    setTimeout(() => resolve('timeout'), FONT_WAIT_MS);
  });
  Promise.race([fontsLoaded, timeout])
    .then((r) => {
      if (r === 'timeout') console.warn(`Web fonts not loaded after ${FONT_WAIT_MS} ms; drawing with fallbacks`);
    })
    .catch((err) => {
      console.warn('Loading web fonts failed; drawing with fallbacks', err);
    })
    .finally(() => {
      archivoReady = document.fonts.check('900 100px Archivo');
      hero.fontsLoaded();
      schedule();
    });
  // Archivo arriving after the timeout changes the glyphs: draw the mass again.
  document.fonts.addEventListener('loadingdone', () => {
    if (archivoReady || !document.fonts.check('900 100px Archivo')) return;
    archivoReady = true;
    hero.fontsLoaded();
    schedule();
  });

  market.start();
}

try {
  boot();
} catch (err) {
  console.error('Starting the page failed', err);
  const notice = document.querySelector('[data-hero-notice]');
  if (notice instanceof HTMLElement) {
    notice.hidden = false;
    notice.textContent = `This page could not start: ${err instanceof Error ? err.message : String(err)}`;
  }
}
