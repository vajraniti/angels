// Test doubles for the two I/O boundaries of the data layer: fetch and WebSocket.

/**
 * A WebSocket class with server-side controls. Each call returns a fresh class with its
 * own `instances` list, so tests do not share sockets.
 */
export function makeFakeWebSocket() {
  class FakeWebSocket {
    static OPEN = 1;
    /** @type {FakeWebSocket[]} */
    static instances = [];

    /** @param {string} url */
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      /** @type {unknown[]} */
      this.sent = [];
      /** @type {{ code: number, reason: string, by: 'client'|'server' }|null} */
      this.closed = null;
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      FakeWebSocket.instances.push(this);
    }

    /** Streams named in the URL (?streams=a/b/c). */
    get urlStreams() {
      return (new URL(this.url).searchParams.get('streams') ?? '').split('/').filter(Boolean);
    }

    /** @param {string} data */
    send(data) {
      if (this.readyState !== 1) throw new Error(`send() on a socket in state ${this.readyState}`);
      this.sent.push(JSON.parse(data));
    }

    /**
     * @param {number} [code]
     * @param {string} [reason]
     */
    close(code = 1000, reason = '') {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.closed = { code, reason, by: 'client' };
      const handler = this.onclose;
      // Browsers deliver the close event asynchronously.
      queueMicrotask(() => handler?.({ code, reason, wasClean: true }));
    }

    serverOpen() {
      this.readyState = 1;
      this.onopen?.({});
    }

    /** @param {unknown} payload object (JSON-encoded here) or raw string */
    serverSend(payload) {
      this.onmessage?.({ data: typeof payload === 'string' ? payload : JSON.stringify(payload) });
    }

    /**
     * @param {number} [code]
     * @param {string} [reason]
     */
    serverClose(code = 1006, reason = '') {
      this.readyState = 3;
      this.closed = { code, reason, by: 'server' };
      this.onclose?.({ code, reason, wasClean: code !== 1006 });
    }

    static open() {
      return FakeWebSocket.instances.filter((s) => s.readyState !== 3);
    }

    static last() {
      return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    }
  }
  return FakeWebSocket;
}

/**
 * fetch double. `handler(url, init)` returns { status, body } (body JSON-encoded unless
 * a string), a Promise of that, or throws/rejects to simulate a network failure.
 * Honors AbortSignal like the real fetch.
 * @param {(url: string, init?: RequestInit) => unknown} handler
 */
export function makeFakeFetch(handler) {
  /** @type {string[]} */
  const calls = [];
  /**
   * @param {string} url
   * @param {RequestInit} [init]
   */
  async function fakeFetch(url, init = {}) {
    calls.push(url);
    const signal = init.signal;
    if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    const result = new Promise((resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), {
        once: true,
      });
      Promise.resolve()
        .then(() => handler(url, init))
        .then((r) => {
          const { status = 200, body = null } = /** @type {{ status?: number, body?: unknown }} */ (r);
          const text = typeof body === 'string' ? body : JSON.stringify(body);
          resolve(new Response(text, { status, headers: { 'content-type': 'application/json' } }));
        }, reject);
    });
    return result;
  }
  fakeFetch.calls = calls;
  return fakeFetch;
}

/** Let pending promise chains run (setImmediate is not faked by mock.timers here). */
export async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}

/**
 * A promise resolved after `ms` on the (possibly mocked) timer clock.
 * @param {number} ms
 * @param {unknown} value
 */
export function later(ms, value) {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), ms);
  });
}

/**
 * Advance mocked time in steps. Node's mock timers run every callback of one tick() at
 * the final time and skip timers scheduled during it, so time-dependent sequences
 * (watchdogs, retries, polls) need small steps with promise settling in between.
 * @param {import('node:test').TestContext} t
 * @param {number} ms
 * @param {{ step?: number, each?: () => void }} [options] `each` runs after every step
 */
export async function advance(t, ms, { step = 250, each } = {}) {
  for (let done = 0; done < ms; ) {
    const d = Math.min(step, ms - done);
    t.mock.timers.tick(d);
    done += d;
    each?.();
    await settle(2);
  }
}
