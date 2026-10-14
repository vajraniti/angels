// Minimal REST client for Binance USDⓈ-M public market data: GET + JSON, a hard
// timeout on every call, and failures classified into MarketError kinds.

import { MarketError } from './errors.js';
import { PROBE_TIMEOUT_MS, REACHABILITY_PROBE_URL, REST_TIMEOUT_MS } from './config.js';

/**
 * @typedef {(input: string, init?: RequestInit) => Promise<Response>} FetchLike
 */

/**
 * @param {{ base: string, fetchImpl: FetchLike, timeoutMs?: number,
 *           probeUrl?: string|null, probeTimeoutMs?: number }} options
 */
export function createRestClient({
  base,
  fetchImpl,
  timeoutMs = REST_TIMEOUT_MS,
  probeUrl = REACHABILITY_PROBE_URL,
  probeTimeoutMs = PROBE_TIMEOUT_MS,
}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('createRestClient: fetchImpl must be a function');
  const root = base.replace(/\/+$/, '');

  /**
   * GET `path` with query `params` and return the parsed JSON body.
   * @param {string} path e.g. '/fapi/v1/ticker/24hr'
   * @param {Record<string, string|number>} [params]
   * @param {{ signal?: AbortSignal, what?: string }} [options]
   *        `what` describes the operation for error messages ("Loading 24h stats for XAUUSDT").
   * @returns {Promise<unknown>}
   */
  async function getJson(path, params = {}, { signal, what = `GET ${path}` } = {}) {
    const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
    const url = `${root}${path}${query ? `?${query}` : ''}`;
    if (signal?.aborted) throw new MarketError('aborted', `${what}: cancelled`);

    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    const forwardAbort = () => ctrl.abort();
    signal?.addEventListener('abort', forwardAbort, { once: true });

    // One classifier for both stages (headers and body): either can be cut short by
    // our timeout, by the caller, or by the network.
    const failure = async (err) => {
      if (timedOut) {
        return new MarketError('timeout', `${what}: no answer from Binance within ${timeoutMs / 1000} s`, {
          cause: err,
        });
      }
      if (signal?.aborted) return new MarketError('aborted', `${what}: cancelled`, { cause: err });
      const reachable = await probe();
      if (signal?.aborted) return new MarketError('aborted', `${what}: cancelled`, { cause: err });
      if (reachable) {
        return new MarketError(
          'region',
          `${what}: Binance refused this location (its HTTP 451 reply is unreadable to browsers, while Binance's public mirror answered)`,
          { inferred: true, cause: err },
        );
      }
      const reason = err instanceof Error ? err.message : String(err);
      return new MarketError(
        'network',
        `${what}: no readable reply from ${root} (offline, DNS, TLS or CORS: ${reason})`,
        {
          cause: err,
        },
      );
    };

    try {
      let res;
      try {
        // credentials:'omit' and no custom headers keep this a CORS "simple request",
        // so the browser sends no preflight.
        res = await fetchImpl(url, { signal: ctrl.signal, credentials: 'omit' });
      } catch (err) {
        throw await failure(err);
      }
      let text;
      try {
        text = await res.text();
      } catch (err) {
        throw await failure(err);
      }
      if (!res.ok) throw httpError(res.status, res.statusText, text, what);
      try {
        return JSON.parse(text);
      } catch (err) {
        throw new MarketError(
          'parse',
          `${what}: Binance answered HTTP ${res.status} with a body that is not JSON (${snippet(text)})`,
          {
            status: res.status,
            cause: err,
          },
        );
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
    }
  }

  /** @returns {Promise<boolean>} true when the probe host answered 2xx. */
  async function probe() {
    if (!probeUrl) return false;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), probeTimeoutMs);
    try {
      const res = await fetchImpl(probeUrl, { signal: ctrl.signal, credentials: 'omit' });
      return res.ok;
    } catch {
      // The probe exists to tell "Binance refused us" from "we are offline"; a probe
      // that fails too is exactly the "offline" answer, not an error of its own.
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  return { getJson, base: root };
}

/**
 * Turn a non-2xx reply into a MarketError. Binance error bodies look like
 * {"code":-1121,"msg":"Invalid symbol."}.
 * https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/general-info
 * @param {number} status
 * @param {string} statusText
 * @param {string} bodyText
 * @param {string} what
 */
export function httpError(status, statusText, bodyText, what) {
  let code;
  let detail;
  try {
    const body = JSON.parse(bodyText);
    if (body && typeof body === 'object') {
      if (typeof body.code === 'number') code = body.code;
      if (typeof body.msg === 'string') detail = body.msg;
    }
  } catch {
    // Error pages from the CDN (HTML, empty) carry no Binance code; status alone is enough.
  }
  const extra = { status, code, detail };
  const binance = code !== undefined && detail ? ` (code ${code}: ${detail})` : '';
  if (status === 451) {
    return new MarketError('region', `${what}: Binance does not serve this region (HTTP 451)`, extra);
  }
  if (status === 429) {
    return new MarketError('http', `${what}: Binance rate limit reached (HTTP 429), backing off`, extra);
  }
  if (status === 418) {
    return new MarketError(
      'http',
      `${what}: this IP is temporarily banned by Binance for exceeding rate limits (HTTP 418)`,
      extra,
    );
  }
  if (status === 403) {
    return new MarketError('http', `${what}: blocked by Binance's web application firewall (HTTP 403)`, extra);
  }
  if (status >= 500) {
    return new MarketError(
      'http',
      `${what}: Binance server error (HTTP ${status}${statusText ? ` ${statusText}` : ''})${binance}`,
      extra,
    );
  }
  return new MarketError('http', `${what}: Binance rejected the request (HTTP ${status})${binance}`, extra);
}

/** @param {string} text */
function snippet(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return 'empty body';
  return flat.length > 80 ? `"${flat.slice(0, 80)}…"` : `"${flat}"`;
}
