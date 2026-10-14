// Runs renderDissolve off the main thread: a full-width mass is a million pixels of
// blurs and noise, about a tenth of a second that would otherwise stall scrolling
// and the chart's pointer read-out.

import { renderDissolve } from './dissolve.js';

self.addEventListener('message', (event) => {
  const { id, args } = event.data;
  try {
    const out = renderDissolve(args);
    self.postMessage({ id, out }, [out.buffer]);
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err) });
  }
});
