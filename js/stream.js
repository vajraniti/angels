// WebSocket client for Binance's combined market stream:
//   wss://fstream.binance.com/market/stream?streams=a/b/c  →  {"stream": "a", "data": {...}}
// It keeps one socket alive: reconnects with exponential backoff and jitter, rebuilds
// the subscription from the desired set on every connect, changes streams live with
// SUBSCRIBE/UNSUBSCRIBE, recycles the socket before Binance's 24 h cut-off, and drops
// a socket that has gone silent.
// https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/websocket-market-streams/Connect
// https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/websocket-market-streams/Live-Subscribing-Unsubscribing-to-streams

import { MarketError } from './errors.js';
import {
  CONNECT_TIMEOUT_MS,
  SILENT_RECONNECT_MS,
  STATUS_TICK_MS,
  STREAM_BACKOFF,
  SUBSCRIBE_DEBOUNCE_MS,
  WS_MAX_AGE_MS,
} from './config.js';

const OPEN = 1;

/**
 * Delay before reconnect attempt number `attempt` (0-based): exponential growth capped
 * at `capMs`, with "equal jitter" (half fixed, half random) so many clients dropped at
 * once do not return in lockstep, while no retry is ever immediate.
 * @param {number} attempt
 * @param {{ baseMs: number, capMs: number }} schedule
 * @param {() => number} random uniform in [0, 1)
 */
export function backoffDelay(attempt, { baseMs, capMs }, random) {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.min(attempt, 30));
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

/**
 * @typedef {Object} StreamEvents
 * @property {(stream: string, data: unknown) => void} onData  a market event arrived
 * @property {(info: { reconnect: boolean }) => void} onOpen   socket open; `reconnect` is
 *           true when an earlier socket of this client had delivered data (gap possible)
 * @property {(err: MarketError, retryAt: number|null) => void} onError
 *           the socket dropped or Binance rejected a request; `retryAt` is the local time
 *           of the scheduled reconnect, or null when the socket stays up
 */

/**
 * @param {{
 *   base: string,
 *   WebSocketImpl: typeof WebSocket,
 *   streams: Iterable<string>,
 *   now: () => number,
 *   random?: () => number,
 *   events: StreamEvents,
 *   backoff?: { baseMs: number, capMs: number },
 *   silentReconnectMs?: number,
 *   connectTimeoutMs?: number,
 *   maxAgeMs?: number,
 *   debounceMs?: number,
 * }} options
 */
export function createStreamClient({
  base,
  WebSocketImpl,
  streams,
  now,
  random = Math.random,
  events,
  backoff = STREAM_BACKOFF,
  silentReconnectMs = SILENT_RECONNECT_MS,
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  maxAgeMs = WS_MAX_AGE_MS,
  debounceMs = SUBSCRIBE_DEBOUNCE_MS,
}) {
  if (typeof WebSocketImpl !== 'function')
    throw new TypeError('createStreamClient: WebSocketImpl must be a constructor');

  let desired = new Set(streams);
  /** Streams the current socket is subscribed to (URL plus acknowledged changes). */
  let active = new Set();
  /** @type {WebSocket|null} */
  let ws = null;
  let running = false;
  let attempt = 0;
  let nextId = 1;
  let createdAt = 0;
  let openedAt = 0;
  /** @type {number|null} */
  let lastMessageAt = null;
  let deliveredBefore = false;
  let deliveredThisSocket = false;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let retryTimer = null;
  /** @type {number|null} */
  let retryAt = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let reconcileTimer = null;
  /** @type {ReturnType<typeof setInterval>|null} */
  let watchdog = null;

  /** @param {string[]} list */
  function url(list) {
    // '@' and '/' stay literal, exactly as in Binance's documented combined-stream URLs.
    return `${base}?streams=${list.join('/')}`;
  }

  function connect() {
    if (running) return;
    running = true;
    attempt = 0;
    open();
    watchdog = setInterval(checkHealth, STATUS_TICK_MS);
  }

  function open() {
    retryTimer = null;
    retryAt = null;
    if (desired.size === 0) return;
    const list = [...desired];
    const target = url(list);
    let sock;
    try {
      sock = new WebSocketImpl(target);
    } catch (err) {
      // The constructor throws only for a malformed URL or a blocked scheme (e.g. ws: on
      // an https page); report it and keep retrying so a fixed config recovers.
      const reason = err instanceof Error ? err.message : String(err);
      dropped(`Live stream: cannot open ${target} (${reason})`);
      return;
    }
    ws = sock;
    active = new Set(list);
    createdAt = now();
    openedAt = 0;
    deliveredThisSocket = false;

    sock.onopen = () => {
      if (ws !== sock) return;
      openedAt = now();
      // The desired set may have changed while the handshake ran.
      scheduleReconcile(0);
      events.onOpen({ reconnect: deliveredBefore });
    };
    sock.onmessage = (ev) => {
      if (ws !== sock) return;
      handleMessage(ev.data);
    };
    // Browsers give no detail on 'error'; the 'close' event that always follows
    // carries the code, so failures are reported from onclose only.
    sock.onerror = null;
    sock.onclose = (ev) => {
      if (ws !== sock) return;
      detach(sock);
      ws = null;
      const reason = ev.reason ? `, "${ev.reason}"` : '';
      const what =
        ev.code === 1006 ? 'connection lost or refused (code 1006)' : `closed by the server (code ${ev.code}${reason})`;
      dropped(`Live stream: ${what}`, ev.code);
    };
  }

  /** @param {WebSocket} sock */
  function detach(sock) {
    sock.onopen = null;
    sock.onmessage = null;
    sock.onclose = null;
    sock.onerror = null;
  }

  /**
   * The socket is gone through no plan of ours: schedule the next attempt and report.
   * @param {string} what
   * @param {number} [code] WebSocket close code
   */
  function dropped(what, code) {
    if (!running) return;
    // A socket that delivered data was healthy, so this is a fresh outage rather than
    // another failure of the same one.
    if (deliveredThisSocket) attempt = 0;
    const delay = backoffDelay(attempt, backoff, random);
    attempt++;
    scheduleOpen(delay);
    const seconds = Math.max(1, Math.round(delay / 1000));
    events.onError(new MarketError('stream', `${what}; reconnecting in ${seconds} s`, { code }), retryAt);
  }

  /** @param {number} delay */
  function scheduleOpen(delay) {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryAt = now() + delay;
    retryTimer = setTimeout(open, delay);
  }

  /**
   * Close the current socket on our own initiative and connect again.
   * @param {string} why
   * @param {boolean} immediate planned recycle (no backoff) vs a fault (backoff)
   */
  function recycle(why, immediate) {
    const sock = ws;
    if (sock) {
      detach(sock);
      ws = null;
      closeQuietly(sock, 4000, why);
    }
    if (immediate) {
      scheduleOpen(0);
    } else {
      dropped(`Live stream: ${why}`);
    }
  }

  /**
   * @param {WebSocket} sock
   * @param {number} code
   * @param {string} reason
   */
  function closeQuietly(sock, code, reason) {
    try {
      sock.close(code, reason.slice(0, 120));
    } catch (err) {
      // close() only throws for an invalid code/reason, which would be a bug here;
      // the socket is already detached, so log and carry on.
      console.error('Closing the market stream socket failed', err);
    }
  }

  function checkHealth() {
    if (!running || !ws) return;
    const t = now();
    if (!openedAt) {
      if (t - createdAt > connectTimeoutMs) {
        recycle(`handshake did not complete within ${Math.round(connectTimeoutMs / 1000)} s`, false);
      }
      return;
    }
    if (t - openedAt > maxAgeMs) {
      recycle('planned reconnect before the 24 h connection limit', true);
      return;
    }
    const quietSince = lastMessageAt !== null && lastMessageAt > openedAt ? lastMessageAt : openedAt;
    if (t - quietSince > silentReconnectMs) {
      recycle(`no data for ${Math.round((t - quietSince) / 1000)} s`, false);
    }
  }

  /** @param {unknown} raw */
  function handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch (err) {
      events.onError(
        new MarketError('parse', `Live stream: message is not JSON (${String(raw).slice(0, 60)})`, { cause: err }),
        null,
      );
      return;
    }
    if (msg && typeof msg === 'object' && typeof msg.stream === 'string' && 'data' in msg) {
      lastMessageAt = now();
      deliveredThisSocket = true;
      deliveredBefore = true;
      events.onData(msg.stream, msg.data);
      return;
    }
    if (msg && typeof msg === 'object' && 'id' in msg && 'result' in msg) return; // ack of (UN)SUBSCRIBE
    if (msg && typeof msg === 'object' && ('code' in msg || 'error' in msg)) {
      const e = msg.error && typeof msg.error === 'object' ? msg.error : msg;
      events.onError(
        new MarketError('stream', `Live stream: Binance rejected a subscription request (code ${e.code}: ${e.msg})`, {
          code: typeof e.code === 'number' ? e.code : undefined,
          detail: typeof e.msg === 'string' ? e.msg : undefined,
        }),
        null,
      );
      return;
    }
    events.onError(new MarketError('parse', `Live stream: unrecognised message ${String(raw).slice(0, 80)}`), null);
  }

  /** @param {number} delay */
  function scheduleReconcile(delay) {
    if (reconcileTimer !== null) clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(reconcile, delay);
  }

  function reconcile() {
    reconcileTimer = null;
    const sock = ws;
    if (!sock || sock.readyState !== OPEN) return;
    const remove = [...active].filter((s) => !desired.has(s));
    const add = [...desired].filter((s) => !active.has(s));
    if (remove.length) sock.send(JSON.stringify({ method: 'UNSUBSCRIBE', params: remove, id: nextId++ }));
    if (add.length) sock.send(JSON.stringify({ method: 'SUBSCRIBE', params: add, id: nextId++ }));
    active = new Set(desired);
  }

  /**
   * Replace the desired stream set. An open socket is updated in place (coalesced over
   * `debounceMs`); otherwise the next connect simply uses the new set in its URL.
   * @param {Iterable<string>} list
   */
  function setStreams(list) {
    desired = new Set(list);
    if (!running) return;
    if (ws && ws.readyState === OPEN) scheduleReconcile(debounceMs);
    else if (!ws && retryTimer === null) open();
  }

  function close() {
    running = false;
    if (retryTimer !== null) clearTimeout(retryTimer);
    if (reconcileTimer !== null) clearTimeout(reconcileTimer);
    if (watchdog !== null) clearInterval(watchdog);
    retryTimer = reconcileTimer = watchdog = null;
    retryAt = null;
    const sock = ws;
    ws = null;
    if (sock) {
      detach(sock);
      closeQuietly(sock, 1000, 'client closed');
    }
  }

  function info() {
    return {
      connected: !!ws && ws.readyState === OPEN,
      lastMessageAt,
      retryAt,
      streams: [...desired],
    };
  }

  return { connect, close, setStreams, info };
}
