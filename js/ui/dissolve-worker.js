// Runs the dissolve off the main thread: a full-width mass is a million pixels of
// blurs and noise, plus the loops that turn it into RGBA for the canvases and the
// inversion mask, about a tenth of a second that would otherwise stall scrolling and
// the chart's pointer read-out.

import { renderLayers } from './dissolve.js';

self.addEventListener('message', (event) => {
  const { id, args } = event.data;
  try {
    const out = renderLayers(args);
    const transfer = [out.ink.buffer, out.echo.buffer];
    if (out.solid) transfer.push(out.solid.buffer);
    self.postMessage({ id, out }, transfer);
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err) });
  }
});
