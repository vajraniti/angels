// Typed failures of the data layer. Every failure that reaches the UI is a
// MarketError whose `kind` decides how the page phrases it, and whose message
// already says what was being done when it happened.

/**
 * - `region`  Binance refuses this location (HTTP 451, or inferred, see `inferred`).
 * - `http`    Binance answered with another non-2xx status (rate limit, WAF, 5xx, bad request).
 * - `network` No readable reply at all: offline, DNS, TLS, or a CORS block we cannot attribute.
 * - `timeout` No reply within the configured time.
 * - `parse`   A reply arrived but is not the documented shape.
 * - `stream`  The WebSocket closed, failed, or Binance rejected a stream request.
 * - `aborted` Cancelled by our own code (superseded chart load, stop()); never shown.
 * - `internal` A bug in this code; logged to the console as well.
 * @typedef {'region'|'http'|'network'|'timeout'|'parse'|'stream'|'aborted'|'internal'} ErrorKind
 */

export class MarketError extends Error {
  /**
   * @param {ErrorKind} kind
   * @param {string} message What was being done and what went wrong, in one sentence.
   * @param {{ status?: number, code?: number, detail?: string, inferred?: boolean, cause?: unknown }} [extra]
   */
  constructor(kind, message, extra = {}) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause });
    this.name = 'MarketError';
    this.kind = kind;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.code !== undefined) this.code = extra.code;
    if (extra.detail !== undefined) this.detail = extra.detail;
    if (extra.inferred) this.inferred = true;
  }
}

/** @param {unknown} err */
export function isAbort(err) {
  return err instanceof MarketError && err.kind === 'aborted';
}

/**
 * Plain, serialisable error record stored in the market state.
 * @typedef {Object} ErrorInfo
 * @property {ErrorKind} kind
 * @property {string} message      Human sentence, English, ready to print.
 * @property {string} source       Which part of the data layer failed: 'bootstrap', 'stream',
 *                                 'openInterest', 'dailyRange', 'fundingInfo', 'serverTime', 'chart'.
 * @property {number} at           Local time (ms) when it happened.
 * @property {number} [status]     HTTP status when one was readable (451, 429, 503...).
 * @property {number} [code]       Binance error code from the body ({"code":-1121,...}) or WS close code.
 * @property {string} [detail]     Binance's own message, verbatim.
 * @property {boolean} [inferred]  The kind was deduced, not read (e.g. region from a CORS-less 451).
 * @property {number} [retryAt]    Local time (ms) of the next automatic retry, if one is scheduled.
 */

/**
 * @param {unknown} err
 * @param {string} source
 * @param {number} at
 * @returns {ErrorInfo}
 */
export function toErrorInfo(err, source, at) {
  if (err instanceof MarketError) {
    /** @type {ErrorInfo} */
    const info = { kind: err.kind, message: err.message, source, at };
    if (err.status !== undefined) info.status = err.status;
    if (err.code !== undefined) info.code = err.code;
    if (err.detail !== undefined) info.detail = err.detail;
    if (err.inferred) info.inferred = true;
    return info;
  }
  // Anything else is a programming error; keep the stack in the console where a
  // developer can find it, and give the page a sentence it can show.
  console.error(`Unexpected error in ${source}`, err);
  const text = err instanceof Error ? err.message : String(err);
  return { kind: 'internal', message: `${source}: unexpected error (${text})`, source, at };
}
