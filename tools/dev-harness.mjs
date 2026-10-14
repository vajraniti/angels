#!/usr/bin/env node
// Development harness: serves the site from a local port under /angels/ (the same
// sub-path GitHub Pages uses, so absolute paths break here as they would there), opens
// it in Playwright Chromium, answers every Binance REST call from the deterministic
// simulator in tests/fixtures/market-sim.mjs, and plays a scripted WebSocket stream.
// The browser clock starts at the fixture time, so screenshots are reproducible.
// Nothing here ships: the live site talks to Binance only.
//
//   node tools/dev-harness.mjs --shot <outdir> [--scenario live|stale|region|loading|offline|swap|all]
//                              [--width 1440 --height 900] [--dpr 1] [--full] [--reduced-motion]
//                              [--page index.html]
//
// Writes <outdir>/<scenario>-<n>-<label>.png, a matching .state.json (when the page
// exposes window.__angelsMarket) and <outdir>/console.json; prints a summary.

import { createServer } from 'node:http';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ANCHOR, createSim } from '../tests/fixtures/market-sim.mjs';
import { SILENT_RECONNECT_MS, STALE_AFTER_MS } from '../js/config.js';

const PLAYWRIGHT = '/opt/node22/lib/node_modules/playwright/index.mjs';
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PREFIX = '/angels/';
const FAPI = /^https:\/\/fapi\.binance\.com\//;
const PROBE = /^https:\/\/data-api\.binance\.vision\//;
const FSTREAM = /^wss:\/\/fstream\.binance\.com\//;
const SCENARIOS = ['live', 'stale', 'region', 'loading', 'offline', 'swap'];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const INTERVAL_MS = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

function usage(message) {
  if (message) console.error(`dev-harness: ${message}`);
  console.error(
    'Usage: node tools/dev-harness.mjs --shot <outdir> [--scenario live|stale|region|loading|offline|swap|all]\n' +
      '                                  [--width 1440 --height 900] [--dpr 1] [--full] [--reduced-motion]\n' +
      '                                  [--page index.html]',
  );
  process.exit(2);
}

function options() {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        shot: { type: 'string' },
        scenario: { type: 'string', default: 'live' },
        width: { type: 'string', default: '1440' },
        height: { type: 'string', default: '900' },
        dpr: { type: 'string', default: '1' },
        full: { type: 'boolean', default: false },
        'reduced-motion': { type: 'boolean', default: false },
        page: { type: 'string', default: 'index.html' },
        help: { type: 'boolean', default: false },
      },
    }).values;
  } catch (err) {
    usage(err instanceof Error ? err.message : String(err));
  }
  if (parsed.help) usage();
  if (!parsed.shot) usage('--shot <outdir> is required');
  const scenarios = parsed.scenario === 'all' ? SCENARIOS : [parsed.scenario];
  for (const s of scenarios) if (!SCENARIOS.includes(s)) usage(`unknown scenario "${s}"`);
  const num = (/** @type {string} */ name, /** @type {string} */ v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) usage(`--${name} must be a positive number, got "${v}"`);
    return n;
  };
  return {
    outDir: resolve(parsed.shot),
    scenarios,
    width: num('width', parsed.width),
    height: num('height', parsed.height),
    dpr: num('dpr', parsed.dpr),
    full: parsed.full,
    reducedMotion: parsed['reduced-motion'],
    page: parsed.page,
  };
}

/** Static file server for ROOT under PREFIX. */
function serve() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/' || url.pathname === '/angels') {
      res.writeHead(302, { location: PREFIX });
      res.end();
      return;
    }
    if (!url.pathname.startsWith(PREFIX)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end(`Not under ${PREFIX}: ${url.pathname} (absolute path? GitHub Pages serves the site from ${PREFIX})`);
      return;
    }
    let rel = decodeURIComponent(url.pathname.slice(PREFIX.length));
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const file = normalize(join(ROOT, rel));
    if (!file.startsWith(ROOT + sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    let body;
    try {
      if (!statSync(file).isFile()) throw new Error('not a file');
      body = readFileSync(file);
    } catch {
      // A missing file is an ordinary 404 for the page to report, not a harness failure.
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end(`Not found: ${rel}`);
      return;
    }
    res.writeHead(200, {
      'content-type':
        TYPES[/** @type {keyof typeof TYPES} */ (extname(file).toLowerCase())] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  });
  return new Promise((resolveServer, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('dev-harness: server has no TCP address'));
        return;
      }
      resolveServer({ server, origin: `http://127.0.0.1:${addr.port}` });
    });
  });
}

const sleep = (/** @type {number} */ ms) =>
  new Promise((done) => {
    setTimeout(done, ms);
  });

/**
 * Play Binance's combined market stream on one routed WebSocket: markPrice every
 * second, ticker every 2 s, the chart kline every 250 ms, and a closed candle plus the
 * next one whenever the simulated clock crosses an interval boundary.
 * @param {import('playwright').WebSocketRoute} ws
 * @param {ReturnType<typeof createSim>} sim
 * @param {() => number} simNow
 * @param {Promise<unknown>} clockSynced events start once simulated time is pinned to the page clock
 */
function playStream(ws, sim, simNow, clockSynced) {
  const subs = new Set((new URL(ws.url()).searchParams.get('streams') ?? '').split('/').filter(Boolean));
  let open = true;
  let paused = false;
  let synced = false;
  clockSynced.then(() => {
    synced = true;
  });
  let lastSecond = -1;
  let lastTicker = -1;
  /** @type {Map<string, number>} */
  const candleOpen = new Map();

  ws.onMessage((raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch (err) {
      console.error('dev-harness: page sent a non-JSON stream message', raw, err);
      return;
    }
    if (msg.method === 'SUBSCRIBE') for (const p of msg.params) subs.add(p);
    if (msg.method === 'UNSUBSCRIBE') for (const p of msg.params) subs.delete(p);
    ws.send(JSON.stringify({ result: null, id: msg.id }));
  });
  ws.onClose(() => {
    open = false;
  });

  const send = (/** @type {string} */ stream, /** @type {unknown} */ data) => {
    if (open) ws.send(JSON.stringify({ stream, data }));
  };

  const timer = setInterval(() => {
    if (!open) {
      clearInterval(timer);
      return;
    }
    if (paused || !synced) return;
    const at = simNow();
    const second = Math.floor(at / 1000);
    const twoSeconds = Math.floor(at / 2000);
    for (const s of subs) {
      const [lower, kind] = s.split('@');
      const symbol = lower.toUpperCase();
      if (!sim.symbols.includes(symbol)) continue;
      if (kind === 'markPrice' && second !== lastSecond) send(s, sim.markPriceEvent(symbol, at));
      if (kind === 'ticker' && twoSeconds !== lastTicker) send(s, sim.tickerEvent(symbol, at));
      if (kind.startsWith('kline_')) {
        const interval = kind.slice('kline_'.length);
        const len = INTERVAL_MS[/** @type {keyof typeof INTERVAL_MS} */ (interval)];
        if (!len) continue;
        const t = Math.floor(at / len) * len;
        const prev = candleOpen.get(s);
        if (prev !== undefined && t > prev) send(s, sim.klineEvent(symbol, interval, at, { final: true }));
        candleOpen.set(s, t);
        send(s, sim.klineEvent(symbol, interval, at));
      }
    }
    lastSecond = second;
    lastTicker = twoSeconds;
  }, 250);

  return {
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
    },
    /** @param {number} code @param {string} reason */
    close(code, reason) {
      if (!open) return;
      open = false;
      clearInterval(timer);
      ws.close({ code, reason });
    },
  };
}

/**
 * @param {import('playwright').Browser} browser
 * @param {ReturnType<typeof createSim>} sim
 * @param {string} scenario
 * @param {ReturnType<typeof options>} opts
 * @param {string} origin
 */
async function runScenario(browser, sim, scenario, opts, origin) {
  const context = await browser.newContext({
    viewport: { width: opts.width, height: opts.height },
    deviceScaleFactor: opts.dpr,
    reducedMotion: opts.reducedMotion ? 'reduce' : 'no-preference',
  });
  const page = await context.newPage();
  /** @type {{ scenario: string, type: string, text: string, location?: string, expected?: boolean }[]} */
  const log = [];
  const expectedFailure = (/** @type {string} */ text) =>
    (scenario === 'region' || scenario === 'offline') && /ERR_FAILED|Failed to load resource|net::/.test(text);
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const loc = m.location();
    log.push({
      scenario,
      type: m.type(),
      text: m.text(),
      location: loc.url ? `${loc.url}:${loc.lineNumber}` : undefined,
      expected: expectedFailure(m.text()) || undefined,
    });
  });
  page.on('pageerror', (err) => log.push({ scenario, type: 'pageerror', text: err.stack ?? err.message }));
  page.on('requestfailed', (req) => {
    const url = req.url();
    const expected =
      (scenario === 'region' && FAPI.test(url)) ||
      (scenario === 'offline' && (FAPI.test(url) || PROBE.test(url))) ||
      // Swapping roles replaces Plate II's emblem; the browser drops the old download.
      (scenario === 'swap' && req.failure()?.errorText === 'net::ERR_ABORTED' && url.includes('/assets/'));
    log.push({
      scenario,
      type: 'requestfailed',
      text: `${req.failure()?.errorText ?? 'failed'} ${url}`,
      expected: expected || undefined,
    });
  });

  // Simulated time follows the page clock: it starts at ANCHOR when the document is
  // created and runs in real time, plus whatever the scenario fast-forwards. The exact
  // start is only known after navigation, so Binance answers wait for it.
  await page.clock.install({ time: ANCHOR });
  let realStart = Date.now();
  let skipped = 0;
  const simNow = () => ANCHOR + (Date.now() - realStart) + skipped;
  /** @type {() => void} */
  let markClockSynced = () => {};
  const clockSynced = new Promise((done) => {
    markClockSynced = () => done(undefined);
  });
  /** @type {ReturnType<typeof playStream>[]} */
  const sockets = [];

  await page.route(PROBE, (route) =>
    scenario === 'offline'
      ? route.abort('internetdisconnected')
      : route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: '{}',
        }),
  );
  await page.route(FAPI, async (route) => {
    if (scenario === 'loading') return; // never answered: the page stays in its loading state
    if (scenario === 'region' || scenario === 'offline') {
      // A real browser cannot read Binance's 451 (no CORS headers), so fetch fails as
      // if the network did; route.fulfill would add CORS headers and hide that.
      await route.abort('failed');
      return;
    }
    await clockSynced;
    // Stamp the reply half-way through its latency, as a real server would be seen.
    const latency = 40 + Math.round(Math.random() * 80);
    const at = simNow() + latency / 2;
    await sleep(latency);
    const { status, body } = sim.handleRest(route.request().url(), at);
    await route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(body),
    });
  });
  await page.routeWebSocket(FSTREAM, (ws) => {
    if (scenario === 'region' || scenario === 'offline') {
      ws.close({ code: 1008, reason: 'dev-harness: stream refused' });
      return;
    }
    const s = playStream(ws, sim, simNow, clockSynced);
    if (scenario === 'loading') s.pause();
    sockets.push(s);
  });

  let shotNo = 0;
  /** @type {string[]} */
  const written = [];
  const shot = async (/** @type {string} */ label) => {
    shotNo++;
    const base = join(opts.outDir, `${scenario}-${shotNo}-${label}`);
    await page.screenshot({ path: `${base}.png`, fullPage: opts.full });
    written.push(`${base}.png`);
    // The page must never scroll sideways; name what sticks out if it does.
    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      if (doc.scrollWidth <= doc.clientWidth) return null;
      const wide = [...document.querySelectorAll('body *')]
        .map((el) => ({ el, right: el.getBoundingClientRect().right }))
        .filter((x) => x.right > doc.clientWidth + 1)
        .sort((a, b) => b.right - a.right)
        .slice(0, 5)
        .map((x) => `${x.el.tagName.toLowerCase()}.${[...x.el.classList].join('.')} right=${Math.round(x.right)}`);
      return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, wide };
    });
    if (overflow) {
      log.push({
        scenario,
        type: 'overflow',
        text: `${label}: page is ${overflow.scrollWidth} px wide in a ${overflow.clientWidth} px viewport: ${overflow.wide.join(', ')}`,
      });
    }
    const state = await page.evaluate(() => {
      const m = /** @type {any} */ (window).__angelsMarket;
      if (!m) return null;
      const s = m.getState();
      return {
        pageTime: new Date(Date.now()).toISOString(),
        ...s,
        chart: { ...s.chart, candles: s.chart.candles.length, lastCandles: s.chart.candles.slice(-3) },
      };
    });
    if (state) {
      writeFileSync(
        `${base}.state.json`,
        `${JSON.stringify({ simTime: new Date(simNow()).toISOString(), ...state }, null, 2)}\n`,
      );
      written.push(`${base}.state.json`);
    }
  };
  const fastForward = async (/** @type {number} */ ms) => {
    skipped += ms;
    await page.clock.fastForward(ms);
  };

  const url = `${origin}${PREFIX}${opts.page}`;
  const response = await page.goto(url, { waitUntil: 'commit' });
  if (!response || !response.ok()) throw new Error(`dev-harness: ${url} answered ${response?.status() ?? 'nothing'}`);
  const pageNow = await page.evaluate(() => Date.now());
  realStart = Date.now() - (pageNow - ANCHOR);
  markClockSynced();
  await page.waitForLoadState('load');

  switch (scenario) {
    case 'live': {
      await sleep(2500);
      await shot('boot');
      // ANCHOR is 4 s before 20:45:00; wait for the candle close plus a moment.
      await sleep(Math.max(0, ANCHOR + 5500 - simNow()));
      await shot('candle-closed');
      sockets.at(-1)?.close(1001, 'dev-harness: scripted drop');
      await sleep(3000);
      await shot('reconnected');
      break;
    }
    case 'stale': {
      await sleep(2500);
      await shot('live');
      for (const s of sockets) s.pause();
      await fastForward(STALE_AFTER_MS + 2000);
      await sleep(400);
      await shot('stale');
      for (const s of sockets) s.resume();
      // The resumed socket was replaced anyway: silence past the watchdog limit.
      await fastForward(SILENT_RECONNECT_MS);
      await sleep(2500);
      await shot('recovered');
      break;
    }
    case 'region':
    case 'offline': {
      await sleep(3000);
      await shot('error');
      break;
    }
    case 'loading': {
      await sleep(1500);
      await shot('loading');
      break;
    }
    case 'swap': {
      // The reader makes CL the main instrument, then reads the chart with the pointer.
      await sleep(2500);
      await page.click('.roles [data-set-main="CLUSDT"]');
      await sleep(2000);
      await shot('cl-main');
      await sleep(4000);
      await shot('cl-main-later');
      await page.click('[data-interval="1h"]');
      await sleep(1200);
      const box = await page.locator('[data-chart]').boundingBox();
      if (!box) throw new Error('dev-harness: chart canvas is not on the page');
      await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.4);
      await sleep(300);
      await page.locator('#plate1').screenshot({ path: join(opts.outDir, `${scenario}-plate1-hover.png`) });
      written.push(join(opts.outDir, `${scenario}-plate1-hover.png`));
      await page.locator('#plate2').screenshot({ path: join(opts.outDir, `${scenario}-plate2-xau.png`) });
      written.push(join(opts.outDir, `${scenario}-plate2-xau.png`));
      break;
    }
    default:
      throw new Error(`dev-harness: no script for scenario ${scenario}`);
  }
  for (const s of sockets) s.close(1000, 'dev-harness: done');
  await context.close();
  return { written, log };
}

async function main() {
  const opts = options();
  mkdirSync(opts.outDir, { recursive: true });
  const { chromium } = await import(PLAYWRIGHT);
  const sim = createSim();
  // Build the price paths now: done lazily inside the first route handler it blocks
  // Node for about two seconds, which delays replies and skews the page's clock estimate.
  for (const symbol of sim.symbols) sim.lastPrice(symbol, ANCHOR);
  const { server, origin } = await serve();
  // Web fonts come through the container's HTTPS proxy when one is set; the local
  // server must not. Playwright forces loopback through the proxy unless told not to.
  const proxy = process.env.HTTPS_PROXY
    ? { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' }
    : undefined;
  if (proxy) process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = '1';
  const browser = await chromium.launch(proxy ? { proxy } : {});
  /** @type {string[]} */
  const written = [];
  /** @type {any[]} */
  const log = [];
  try {
    for (const scenario of opts.scenarios) {
      const r = await runScenario(browser, sim, scenario, opts, origin);
      written.push(...r.written);
      log.push(...r.log);
    }
  } finally {
    await browser.close();
    server.close();
  }
  const consoleFile = join(opts.outDir, 'console.json');
  writeFileSync(consoleFile, `${JSON.stringify(log, null, 2)}\n`);
  const unexpected = log.filter((e) => !e.expected);
  console.log(`Wrote ${written.length} files to ${opts.outDir}`);
  for (const f of written) console.log(`  ${f}`);
  console.log(`Console: ${log.length} entries, ${unexpected.length} unexpected (${consoleFile})`);
  for (const e of unexpected) console.log(`  [${e.scenario}] ${e.type}: ${e.text.split('\n')[0]}`);
}

main().catch((err) => {
  console.error('dev-harness failed:', err);
  process.exit(1);
});
