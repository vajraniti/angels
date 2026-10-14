import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffDelay, createStreamClient } from '../js/stream.js';
import { SILENT_RECONNECT_MS, STREAM_BACKOFF, SUBSCRIBE_DEBOUNCE_MS } from '../js/config.js';
import { makeFakeWebSocket, settle } from './support/fakes.js';

const BASE = 'wss://fstream.binance.com/market/stream';
const STREAMS = ['xauusdt@ticker', 'xauusdt@markPrice@1s', 'xauusdt@kline_15m'];
const DATA = { stream: 'xauusdt@markPrice@1s', data: { e: 'markPriceUpdate' } };

/**
 * @param {import('node:test').TestContext} t
 * @param {Partial<Parameters<typeof createStreamClient>[0]>} [over]
 */
function setup(t, over = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  const WS = makeFakeWebSocket();
  const log = {
    data: /** @type {unknown[][]} */ ([]),
    opens: /** @type {boolean[]} */ ([]),
    errors: /** @type {{ err: any, retryAt: number|null }[]} */ ([]),
  };
  const client = createStreamClient({
    base: BASE,
    WebSocketImpl: /** @type {any} */ (WS),
    streams: STREAMS,
    now: () => Date.now(),
    random: () => 0.5,
    events: {
      onData: (stream, data) => log.data.push([stream, data]),
      onOpen: ({ reconnect }) => log.opens.push(reconnect),
      onError: (err, retryAt) => log.errors.push({ err, retryAt }),
    },
    ...over,
  });
  t.after(() => client.close());
  return { WS, client, log };
}

test('backoff doubles from 1 s to a 30 s cap with equal jitter', () => {
  const at = (r) => Array.from({ length: 8 }, (_, i) => backoffDelay(i, STREAM_BACKOFF, () => r));
  assert.deepEqual(at(0), [500, 1000, 2000, 4000, 8000, 15000, 15000, 15000]);
  assert.deepEqual(at(0.999999), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  assert.equal(
    backoffDelay(1000, STREAM_BACKOFF, () => 0.5),
    22500,
    'huge attempt counts do not overflow',
  );
});

test('connects to the combined-stream URL with every desired stream', (t) => {
  const { WS, client } = setup(t);
  client.connect();
  assert.equal(WS.instances.length, 1);
  assert.equal(WS.last().url, `${BASE}?streams=xauusdt@ticker/xauusdt@markPrice@1s/xauusdt@kline_15m`);
  assert.deepEqual(WS.last().urlStreams, STREAMS);
  client.connect();
  assert.equal(WS.instances.length, 1, 'connect() is idempotent');
});

test('delivers combined payloads and ignores subscription acks', (t) => {
  const { WS, client, log } = setup(t);
  client.connect();
  WS.last().serverOpen();
  WS.last().serverSend({ result: null, id: 1 });
  WS.last().serverSend(DATA);
  assert.deepEqual(log.data, [[DATA.stream, DATA.data]]);
  assert.deepEqual(log.opens, [false]);
  assert.equal(client.info().connected, true);
  assert.equal(client.info().lastMessageAt, Date.now());
  assert.equal(log.errors.length, 0);
});

test('reconnects after a drop with growing backoff, then resets once data flows', async (t) => {
  const { WS, client, log } = setup(t);
  client.connect();
  const delays = [];
  for (let i = 0; i < 4; i++) {
    WS.last().serverClose(1006);
    const { retryAt } = log.errors.at(-1);
    delays.push(retryAt - Date.now());
    t.mock.timers.tick(retryAt - Date.now());
  }
  assert.deepEqual(delays, [750, 1500, 3000, 6000]);
  assert.equal(WS.instances.length, 5);
  assert.match(
    log.errors[0].err.message,
    /^Live stream: connection lost or refused \(code 1006\); reconnecting in 1 s$/,
  );
  assert.equal(log.errors[0].err.kind, 'stream');
  assert.equal(log.errors[0].err.code, 1006);

  WS.last().serverOpen();
  WS.last().serverSend(DATA);
  WS.last().serverClose(1001, 'going away');
  assert.equal(log.errors.at(-1).retryAt - Date.now(), 750, 'a socket that delivered data was healthy: attempt resets');
  assert.match(log.errors.at(-1).err.message, /closed by the server \(code 1001, "going away"\)/);
  t.mock.timers.tick(750);
  WS.last().serverOpen();
  assert.deepEqual(log.opens, [false, true], 'the reopen after data is flagged as a reconnect');
  await settle(1);
  assert.equal(WS.open().length, 1, 'never more than one live socket');
});

test('changes streams in place with one UNSUBSCRIBE and one SUBSCRIBE per burst', (t) => {
  const { WS, client } = setup(t);
  client.connect();
  const ws = WS.last();
  ws.serverOpen();
  t.mock.timers.tick(0);
  assert.deepEqual(ws.sent, [], 'nothing to reconcile right after open');
  const base = STREAMS.slice(0, 2);
  client.setStreams([...base, 'clusdt@kline_15m']);
  client.setStreams([...base, 'clusdt@kline_1h']);
  client.setStreams([...base, 'xauusdt@kline_4h']);
  assert.deepEqual(ws.sent, [], 'debounced');
  t.mock.timers.tick(SUBSCRIBE_DEBOUNCE_MS);
  assert.deepEqual(ws.sent, [
    { method: 'UNSUBSCRIBE', params: ['xauusdt@kline_15m'], id: 1 },
    { method: 'SUBSCRIBE', params: ['xauusdt@kline_4h'], id: 2 },
  ]);
  assert.equal(WS.instances.length, 1, 'no reconnect for a stream change');
});

test('streams changed while disconnected are used in the next URL (resubscribe)', (t) => {
  const { WS, client, log } = setup(t);
  client.connect();
  WS.last().serverOpen();
  WS.last().serverClose(1006);
  client.setStreams(['clusdt@ticker', 'clusdt@kline_1d']);
  t.mock.timers.tick(log.errors.at(-1).retryAt - Date.now());
  assert.deepEqual(WS.last().urlStreams, ['clusdt@ticker', 'clusdt@kline_1d']);
  WS.last().serverOpen();
  t.mock.timers.tick(0);
  assert.deepEqual(WS.last().sent, [], 'the URL already carries the set');
});

test('streams changed during the handshake are reconciled on open', (t) => {
  const { WS, client } = setup(t);
  client.connect();
  client.setStreams([...STREAMS.slice(0, 2), 'xauusdt@kline_1m']);
  const ws = WS.last();
  ws.serverOpen();
  t.mock.timers.tick(0);
  assert.deepEqual(ws.sent, [
    { method: 'UNSUBSCRIBE', params: ['xauusdt@kline_15m'], id: 1 },
    { method: 'SUBSCRIBE', params: ['xauusdt@kline_1m'], id: 2 },
  ]);
});

test('a silent socket is closed and replaced', (t) => {
  const { WS, client, log } = setup(t);
  client.connect();
  const first = WS.last();
  first.serverOpen();
  first.serverSend(DATA);
  t.mock.timers.tick(SILENT_RECONNECT_MS + 1000);
  assert.equal(first.closed?.by, 'client');
  assert.equal(first.closed?.code, 4000);
  assert.match(log.errors.at(-1).err.message, /^Live stream: no data for 2\d s; reconnecting in 1 s$/);
  t.mock.timers.tick(1000);
  assert.equal(WS.instances.length, 2);
  assert.equal(WS.open().length, 1);
});

test("the connection is recycled before Binance's 24 h limit without backoff", (t) => {
  const { WS, client, log } = setup(t, { maxAgeMs: 60_000, silentReconnectMs: 10 * 60_000 });
  client.connect();
  const first = WS.last();
  first.serverOpen();
  first.serverSend(DATA);
  t.mock.timers.tick(61_000);
  assert.equal(first.closed?.by, 'client');
  assert.equal(log.errors.length, 0, 'a planned recycle is not an error');
  t.mock.timers.tick(0);
  assert.equal(WS.instances.length, 2);
  WS.last().serverOpen();
  assert.deepEqual(log.opens, [false, true]);
});

test('a handshake that never completes is abandoned and retried', (t) => {
  const { WS, client, log } = setup(t, { connectTimeoutMs: 5_000 });
  client.connect();
  t.mock.timers.tick(6_000);
  assert.equal(WS.instances[0].closed?.by, 'client');
  assert.match(log.errors.at(-1).err.message, /handshake did not complete within 5 s/);
  t.mock.timers.tick(1_000);
  assert.equal(WS.instances.length, 2);
});

test('Binance error replies and malformed messages are reported without dropping the socket', (t) => {
  const { WS, client, log } = setup(t);
  client.connect();
  const ws = WS.last();
  ws.serverOpen();
  ws.serverSend({ code: 2, msg: 'Invalid request: too many parameters', id: 7 });
  ws.serverSend('not json');
  ws.serverSend({ hello: 'world' });
  assert.equal(log.errors.length, 3);
  assert.equal(log.errors[0].err.kind, 'stream');
  assert.match(
    log.errors[0].err.message,
    /rejected a subscription request \(code 2: Invalid request: too many parameters\)/,
  );
  assert.equal(log.errors[0].retryAt, null);
  assert.equal(log.errors[1].err.kind, 'parse');
  assert.equal(log.errors[2].err.kind, 'parse');
  assert.equal(ws.closed, null);
  assert.equal(WS.instances.length, 1);
});

test('close() closes the socket, cancels the pending reconnect and ignores late events', async (t) => {
  const { WS, client, log } = setup(t);
  client.connect();
  const ws = WS.last();
  ws.serverOpen();
  ws.serverClose(1006);
  client.close();
  t.mock.timers.tick(60_000);
  assert.equal(WS.instances.length, 1, 'no reconnect after close()');

  const { WS: WS2, client: c2, log: log2 } = setup2(t);
  c2.connect();
  const live = WS2.last();
  live.serverOpen();
  c2.close();
  assert.deepEqual(live.closed, { code: 1000, reason: 'client closed', by: 'client' });
  live.serverSend(DATA);
  await settle(1);
  assert.equal(log2.data.length, 0, 'events of a closed socket are ignored');
  assert.equal(log.errors.length, 1);
});

/**
 * A second client in the same test, sharing the already-enabled mock timers.
 * @param {import('node:test').TestContext} t
 */
function setup2(t) {
  const WS = makeFakeWebSocket();
  const log = { data: /** @type {unknown[]} */ ([]) };
  const client = createStreamClient({
    base: BASE,
    WebSocketImpl: /** @type {any} */ (WS),
    streams: STREAMS,
    now: () => Date.now(),
    random: () => 0.5,
    events: { onData: (...a) => log.data.push(a), onOpen: () => {}, onError: () => {} },
  });
  t.after(() => client.close());
  return { WS, client, log };
}

test('an empty stream set opens nothing until streams are given', (t) => {
  const { WS, client } = setup(t, { streams: [] });
  client.connect();
  assert.equal(WS.instances.length, 0);
  client.setStreams(['xauusdt@ticker']);
  assert.equal(WS.instances.length, 1);
  assert.deepEqual(WS.last().urlStreams, ['xauusdt@ticker']);
});

test('a WebSocket constructor that throws is reported and retried', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  const WS = makeFakeWebSocket();
  let failures = 1;
  class Flaky extends WS {
    /** @param {string} url */
    constructor(url) {
      if (failures-- > 0) throw new SyntaxError(`Failed to construct 'WebSocket': The URL '${url}' is invalid.`);
      super(url);
    }
  }
  /** @type {{ err: any, retryAt: number|null }[]} */
  const errors = [];
  const client = createStreamClient({
    base: BASE,
    WebSocketImpl: /** @type {any} */ (Flaky),
    streams: STREAMS,
    now: () => Date.now(),
    random: () => 0.5,
    events: { onData: () => {}, onOpen: () => {}, onError: (err, retryAt) => errors.push({ err, retryAt }) },
  });
  t.after(() => client.close());
  client.connect();
  assert.equal(errors.length, 1);
  assert.match(errors[0].err.message, /^Live stream: cannot open wss:\/\/.* \(Failed to construct/);
  assert.equal(errors[0].retryAt, 750);
  t.mock.timers.tick(750);
  assert.equal(WS.instances.length, 1);
});
