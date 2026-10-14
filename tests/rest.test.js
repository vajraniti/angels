import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRestClient, httpError } from '../js/rest.js';
import { MarketError, isAbort, toErrorInfo } from '../js/errors.js';
import { makeFakeFetch } from './support/fakes.js';

const BASE = 'https://fapi.binance.com';
const PROBE = 'https://data-api.binance.vision/api/v3/ping';
const region451 = readFileSync(new URL('./fixtures/rest/error-451.json', import.meta.url), 'utf8');

/**
 * @param {(url: string) => unknown} fapi
 * @param {{ probe?: (url: string) => unknown, timeoutMs?: number }} [opts]
 */
function client(fapi, { probe = () => ({ status: 200, body: {} }), timeoutMs = 1000 } = {}) {
  const fetchImpl = makeFakeFetch((url) => (url.startsWith(PROBE) ? probe(url) : fapi(url)));
  return {
    rest: createRestClient({ base: BASE, fetchImpl, timeoutMs, probeUrl: PROBE, probeTimeoutMs: 200 }),
    fetchImpl,
  };
}

/**
 * @param {Promise<unknown>} promise
 * @returns {Promise<MarketError>}
 */
async function failure(promise) {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof MarketError, `expected MarketError, got ${err}`);
    return err;
  }
  assert.fail('expected the request to fail');
}

test('builds the URL from base, path and query and returns parsed JSON', async () => {
  const { rest, fetchImpl } = client(() => ({ status: 200, body: { serverTime: 1 } }));
  const body = await rest.getJson('/fapi/v1/klines', { symbol: 'XAUUSDT', interval: '15m', limit: 300 });
  assert.deepEqual(body, { serverTime: 1 });
  assert.deepEqual(fetchImpl.calls, [`${BASE}/fapi/v1/klines?symbol=XAUUSDT&interval=15m&limit=300`]);
  const trailing = createRestClient({ base: `${BASE}/`, fetchImpl, probeUrl: null });
  await trailing.getJson('/fapi/v1/time');
  assert.equal(fetchImpl.calls.at(-1), `${BASE}/fapi/v1/time`);
});

test("a readable HTTP 451 is a region error carrying Binance's own message", async () => {
  const { rest } = client(() => ({ status: 451, body: region451 }));
  const err = await failure(
    rest.getJson('/fapi/v1/ticker/24hr', { symbol: 'XAUUSDT' }, { what: 'Loading 24h statistics for XAUUSDT' }),
  );
  assert.equal(err.kind, 'region');
  assert.equal(err.status, 451);
  assert.equal(err.code, 0);
  assert.match(err.message, /^Loading 24h statistics for XAUUSDT: Binance does not serve this region \(HTTP 451\)$/);
  assert.match(err.detail ?? '', /restricted location/);
  assert.equal(err.inferred, undefined);
});

test("a fetch that fails while Binance's public mirror answers is an inferred region block", async () => {
  // In a real browser the 451 reply has no CORS headers, so fetch only sees a TypeError.
  const { rest, fetchImpl } = client(() => {
    throw new TypeError('Failed to fetch');
  });
  const err = await failure(
    rest.getJson('/fapi/v1/premiumIndex', { symbol: 'CLUSDT' }, { what: 'Loading mark price for CLUSDT' }),
  );
  assert.equal(err.kind, 'region');
  assert.equal(err.inferred, true);
  assert.equal(err.status, undefined);
  assert.match(err.message, /Loading mark price for CLUSDT: Binance refused this location/);
  assert.ok(fetchImpl.calls.includes(PROBE));
});

test('a fetch that fails while the mirror fails too is a network error', async () => {
  const { rest } = client(
    () => {
      throw new TypeError('Failed to fetch');
    },
    {
      probe: () => {
        throw new TypeError('Failed to fetch');
      },
    },
  );
  const err = await failure(rest.getJson('/fapi/v1/time', {}, { what: 'Reading Binance server time' }));
  assert.equal(err.kind, 'network');
  assert.match(
    err.message,
    /^Reading Binance server time: no readable reply from https:\/\/fapi\.binance\.com .*Failed to fetch/,
  );
});

test('without a probe URL every unreadable failure is a network error', async () => {
  const fetchImpl = makeFakeFetch(() => {
    throw new TypeError('Failed to fetch');
  });
  const rest = createRestClient({ base: 'https://proxy.example', fetchImpl, probeUrl: null });
  assert.equal((await failure(rest.getJson('/fapi/v1/time'))).kind, 'network');
  assert.equal(fetchImpl.calls.length, 1);
});

test('no reply within the timeout is a timeout error and the request is aborted', async () => {
  /** @type {AbortSignal|undefined} */
  let seen;
  const fetchImpl = makeFakeFetch((_url, init) => {
    seen = init?.signal ?? undefined;
    return new Promise(() => {});
  });
  const rest = createRestClient({ base: BASE, fetchImpl, timeoutMs: 30, probeUrl: PROBE });
  const err = await failure(
    rest.getJson('/fapi/v1/openInterest', { symbol: 'XAUUSDT' }, { what: 'Loading open interest for XAUUSDT' }),
  );
  assert.equal(err.kind, 'timeout');
  assert.match(err.message, /Loading open interest for XAUUSDT: no answer from Binance within 0\.03 s/);
  assert.equal(seen?.aborted, true);
  assert.equal(fetchImpl.calls.includes(PROBE), false, 'a timeout is not probed');
});

test('a caller abort is reported as aborted, before or during the request', async () => {
  const { rest } = client(() => new Promise(() => {}));
  const ctrl = new AbortController();
  const pending = rest.getJson('/fapi/v1/klines', { symbol: 'XAUUSDT' }, { signal: ctrl.signal });
  ctrl.abort();
  const err = await failure(pending);
  assert.equal(isAbort(err), true);
  const early = await failure(rest.getJson('/fapi/v1/time', {}, { signal: ctrl.signal }));
  assert.equal(isAbort(early), true);
});

test('HTTP statuses map to explicit messages', async () => {
  const cases = [
    [429, { code: -1003, msg: 'Too many requests' }, /rate limit reached \(HTTP 429\)/],
    [418, { code: -1003, msg: 'banned' }, /temporarily banned .* \(HTTP 418\)/],
    [403, '<html>WAF</html>', /web application firewall \(HTTP 403\)/],
    [
      503,
      { code: -1001, msg: 'Service Unavailable.' },
      /server error \(HTTP 503.*\) \(code -1001: Service Unavailable\.\)/,
    ],
    [
      400,
      { code: -1121, msg: 'Invalid symbol.' },
      /rejected the request \(HTTP 400\) \(code -1121: Invalid symbol\.\)/,
    ],
  ];
  for (const [status, body, pattern] of cases) {
    const { rest } = client(() => ({ status, body }));
    const err = await failure(rest.getJson('/fapi/v1/ticker/24hr', { symbol: 'X' }));
    assert.equal(err.kind, 'http', `status ${status}`);
    assert.equal(err.status, status);
    assert.match(err.message, /** @type {RegExp} */ (pattern));
  }
});

test('a 200 reply that is not JSON is a parse error quoting the body', async () => {
  const { rest } = client(() => ({ status: 200, body: '<html>maintenance</html>' }));
  const err = await failure(rest.getJson('/fapi/v1/time', {}, { what: 'Reading Binance server time' }));
  assert.equal(err.kind, 'parse');
  assert.match(err.message, /not JSON \("<html>maintenance<\/html>"\)/);
  const empty = await failure(client(() => ({ status: 200, body: '' })).rest.getJson('/fapi/v1/time'));
  assert.match(empty.message, /empty body/);
});

test('httpError tolerates bodies without a Binance code', () => {
  const err = httpError(502, 'Bad Gateway', '', 'Loading x');
  assert.equal(err.kind, 'http');
  assert.equal(err.code, undefined);
  assert.equal(err.message, 'Loading x: Binance server error (HTTP 502 Bad Gateway)');
});

test('toErrorInfo keeps the typed fields and wraps unexpected errors as internal', (t) => {
  const info = toErrorInfo(
    new MarketError('region', 'm', { status: 451, code: 0, detail: 'd', inferred: true }),
    'bootstrap',
    5,
  );
  assert.deepEqual(info, {
    kind: 'region',
    message: 'm',
    source: 'bootstrap',
    at: 5,
    status: 451,
    code: 0,
    detail: 'd',
    inferred: true,
  });
  const logged = t.mock.method(console, 'error', () => {});
  const bug = toErrorInfo(new TypeError('x is undefined'), 'chart', 6);
  assert.equal(bug.kind, 'internal');
  assert.equal(bug.message, 'chart: unexpected error (x is undefined)');
  assert.equal(logged.mock.callCount(), 1, 'unexpected errors are logged, not swallowed');
});
