// Throttled text for an aria-live="polite" region. A price that changes four times a
// second must not talk over the screen reader: at most one announcement per
// interval, always the latest text, and nothing when the text has not changed.

/**
 * @param {{
 *   write: (text: string) => void,
 *   intervalMs: number,
 *   now?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (id: unknown) => void,
 * }} p
 */
export function createAnnouncer({
  write,
  intervalMs,
  now = Date.now,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (id)),
}) {
  let lastText = '';
  let lastAt = -Infinity;
  let pending = '';
  /** @type {unknown} */
  let timer = null;

  function flush() {
    timer = null;
    if (pending === '' || pending === lastText) return;
    lastText = pending;
    lastAt = now();
    write(pending);
  }

  return {
    /** @param {string} text */
    push(text) {
      pending = text;
      if (text === '' || text === lastText) return;
      const wait = lastAt + intervalMs - now();
      if (wait <= 0) {
        if (timer !== null) clearTimer(timer);
        flush();
      } else if (timer === null) {
        timer = setTimer(flush, wait);
      }
    },
    /** Say this now regardless of the throttle (status changes are rare and important). */
    urgent(/** @type {string} */ text) {
      if (timer !== null) clearTimer(timer);
      timer = null;
      lastText = text;
      pending = text;
      lastAt = now();
      write(text);
    },
    dispose() {
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}
