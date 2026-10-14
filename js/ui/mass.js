// Paints the dissolve mass (js/ui/dissolve.js) into the hero and keeps the sharp
// layer's inversion exact. Four surfaces, bottom to top:
//   echo canvas   grey echo dots (and the pale latent impression before data);
//   ink canvas    the black dots;
//   ink layer     the sharp type in ink, each glyph with a thin paper halo that
//                 clears the grain around it (DOM, masked to where the mass is thin);
//   paper layer   the same sharp type in paper colour, masked to where it is dense.
// The two masks are one region and its complement: the contour where the mass's ink
// density reaches SOLID_AT. Inside it a glyph is solid paper on near-solid black;
// outside it, solid ink kept clear of the grain by its halo. No dot of grain or echo
// ever lands inside a glyph (critique: no halftone leaks into the sharp layer), and a
// glyph in the transition band keeps one clean edge instead of dissolving into it.

import { massKey, massParams, moveOf, renderLayers } from './dissolve.js';
import { BAYER4 } from './chart-scale.js';
import { reducedMotion } from './dom.js';

const MASS_FONT_WEIGHT = 900;
const REVEAL_MS = 600;
const REVEAL_STEPS = 16;
const ECHO_RGB = [0x61, 0x61, 0x61]; // --grey-far
const LATENT_RGB = [0xdc, 0xdc, 0xdc]; // --ghost

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} size
 */
function setMassFont(ctx, size) {
  ctx.font = `${MASS_FONT_WEIGHT} ${size}px Archivo`;
  // Archivo's widest instance (wdth 125) is the brief's source for the masses.
  // Where the canvas cannot select it the normal width is used and the layout,
  // which measures the glyphs, sizes the mass accordingly.
  if ('fontStretch' in ctx) /** @type {any} */ (ctx).fontStretch = 'expanded';
}

/**
 * Glyph metrics of `text` at 1 px type size with `tracking` (em) between letters:
 * ink width, cap height, and the offset of the ink's left edge from the pen.
 * @param {string} text
 * @param {number} [tracking]
 */
export function measureGlyphs(text, tracking = 0) {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) throw new Error('Measuring the mass letters: this browser gives no 2D canvas');
  setMassFont(ctx, 100);
  const chars = [...text];
  const first = ctx.measureText(chars[0] ?? '');
  const last = ctx.measureText(chars[chars.length - 1] ?? '');
  let pen = 0;
  let ascent = 0;
  for (let i = 0; i < chars.length; i++) {
    const m = ctx.measureText(chars[i]);
    ascent = Math.max(ascent, m.actualBoundingBoxAscent);
    if (i < chars.length - 1) pen += m.width + tracking * 100;
  }
  const left = -first.actualBoundingBoxLeft;
  const right = pen + last.actualBoundingBoxRight;
  return { width: (right - left) / 100, ascent: ascent / 100, left: left / 100 };
}

/**
 * Draw `text` letter by letter so tracking works in every canvas (ctx.letterSpacing
 * is recent).
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} x
 * @param {number} y
 * @param {number} trackingPx
 */
function fillTracked(ctx, text, x, y, trackingPx) {
  let pen = x;
  for (const ch of text) {
    ctx.fillText(ch, pen, y);
    pen += ctx.measureText(ch).width + trackingPx;
  }
}

/** @typedef {ReturnType<typeof renderLayers>} Layers */

/**
 * renderLayers in a module worker when the browser offers one, on the main thread
 * otherwise (same code, same result; only the stall differs).
 */
function createRenderer() {
  /** @type {Worker|null} */
  let worker = null;
  try {
    worker = new Worker(new URL('./dissolve-worker.js', import.meta.url), { type: 'module' });
  } catch (err) {
    console.warn('The dissolve runs on the main thread: no module worker', err);
  }
  let nextId = 1;
  /** @type {Map<number, { resolve: (out: Layers) => void, reject: (err: Error) => void }>} */
  const pending = new Map();
  worker?.addEventListener('message', (event) => {
    const { id, out, error } = event.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error) p.reject(new Error(`Dissolve worker: ${error}`));
    else p.resolve(out);
  });
  worker?.addEventListener('error', (event) => {
    // A worker that failed to load (blocked, old browser) hands its work back.
    console.warn('The dissolve worker failed; running on the main thread', event.message);
    const w = worker;
    worker = null;
    w?.terminate();
    for (const [, p] of pending) p.reject(new Error('Dissolve worker failed'));
    pending.clear();
  });
  /**
   * @param {Parameters<typeof renderLayers>[0]} args
   * @returns {Promise<Layers>}
   */
  return function render(args) {
    if (!worker) return Promise.resolve(renderLayers(args));
    const id = nextId++;
    const w = worker;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      w.postMessage({ id, args }, [args.alpha.buffer]);
    });
  };
}

/**
 * @param {number} w
 * @param {number} h
 */
function blankCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** @param {HTMLCanvasElement} c */
function context(c) {
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Painting the mass: this browser gives no 2D canvas');
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

/**
 * Wait until the browser has painted, so a long computation does not delay the
 * frame that shows the result of the previous one.
 */
function nextFrame() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
}

/**
 * Encode a canvas as a PNG object URL and decode it, so a mask that uses it appears in
 * the same frame as whatever is shown with it.
 * @param {HTMLCanvasElement} c
 * @returns {Promise<string>}
 */
async function maskUrl(c) {
  /** @type {Blob|null} */
  const blob = await new Promise((resolve) => {
    c.toBlob(resolve, 'image/png');
  });
  if (!blob) throw new Error('Building the inversion mask: the canvas could not be encoded as PNG');
  const url = URL.createObjectURL(blob);
  const probe = new Image();
  probe.src = url;
  try {
    await probe.decode();
  } catch (err) {
    URL.revokeObjectURL(url);
    throw new Error('Building the inversion mask: the PNG could not be decoded', { cause: err });
  }
  return url;
}

/**
 * @param {{ echoCanvas: HTMLCanvasElement, inkCanvas: HTMLCanvasElement, inkLayer: HTMLElement, paperLayer: HTMLElement }} p
 */
export function createMass({ echoCanvas, inkCanvas, inkLayer, paperLayer }) {
  let shownKey = '';
  let job = 0;
  let shownW = 0;
  let shownH = 0;
  /** @type {import('./dissolve.js').Move|null} the move the mass shows, with hysteresis */
  let move = null;
  let moveText = '';
  /** @type {{ paper: string, ink: string }|null} object URLs of the masks in use */
  let masks = null;
  /**
   * What the two canvases show, as RGBA: the start of the next reveal.
   * @type {{ ink: Uint8ClampedArray, echo: Uint8ClampedArray, w: number, h: number }|null}
   */
  let frame = null;
  const renderer = createRenderer();

  /**
   * @param {{
   *   text: string, tracking?: number, seed: number, width: number, height: number,
   *   size: number, x: number, baseline: number, massWidth: number,
   *   percentile: number|null, changePct: number|null,
   * }} spec all lengths in CSS px, relative to the hero
   * @returns {Promise<void>}
   */
  async function render(spec) {
    if (spec.text !== moveText) {
      // Another instrument: its move starts fresh, not from gold's hysteresis.
      moveText = spec.text;
      move = null;
    }
    move = moveOf(move, spec.changePct);
    const w = Math.max(1, Math.round(spec.width));
    const h = Math.max(1, Math.round(spec.height));
    const key = [
      spec.text,
      spec.tracking ?? 0,
      w,
      h,
      Math.round(spec.size),
      Math.round(spec.x),
      Math.round(spec.baseline),
      massKey({ percentile: spec.percentile, move }),
    ].join('|');
    if (key === shownKey) return;
    shownKey = key;
    const mine = ++job;
    const cancelled = () => mine !== job;

    const alpha = glyphAlpha(spec, w, h);
    await nextFrame();
    if (cancelled()) return;

    const params = massParams({ percentile: spec.percentile, move, size: spec.size, massWidth: spec.massWidth });
    /** @type {Layers} */
    let out;
    try {
      out = await renderer({
        alpha,
        width: w,
        height: h,
        sigma: params.sigma,
        trailLength: params.trailLength,
        trail: params.trail,
        echo: params.echo,
        seed: spec.seed,
        density: params.latent ? 0.42 : 1,
        latent: params.latent,
        colors: { echo: ECHO_RGB, latent: LATENT_RGB },
      });
    } catch (err) {
      // Let the next update try again (on the main thread if the worker died).
      if (mine === job) shownKey = '';
      throw err;
    }
    if (cancelled()) return;

    const sameSize = shownW === w && shownH === h;
    if (!sameSize) {
      for (const c of [echoCanvas, inkCanvas]) {
        c.width = w;
        c.height = h;
      }
      // Masks of another size would put the inversion in the wrong place.
      setMasks(null);
    }
    // The new masks are encoded while the reveal runs; the old ones stay applied until
    // then, so the price never goes ink on ink while the picture changes.
    const next = out.solid ? buildMasks(out.solid, w, h) : Promise.resolve(null);
    try {
      await reveal(out, w, h, cancelled);
    } catch (err) {
      next.then(revoke, (maskErr) => console.error('Building the inversion masks failed', maskErr));
      throw err;
    }
    if (cancelled()) {
      // A newer render has taken over and builds its own masks; this pair is unused,
      // and a failure to build it would recur, and be reported, in that render.
      next.then(revoke, () => {});
      return;
    }
    shownW = w;
    shownH = h;
    const m = await next;
    if (cancelled()) {
      revoke(m);
      return;
    }
    setMasks(m);
  }

  /**
   * @param {{ text: string, tracking?: number, size: number, x: number, baseline: number }} spec
   * @param {number} w
   * @param {number} h
   */
  function glyphAlpha(spec, w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Drawing the mass letters: this browser gives no 2D canvas');
    setMassFont(ctx, spec.size);
    ctx.fillStyle = '#000';
    ctx.textBaseline = 'alphabetic';
    fillTracked(ctx, spec.text, spec.x, spec.baseline, (spec.tracking ?? 0) * spec.size);
    const src = ctx.getImageData(0, 0, w, h).data;
    const a = new Float32Array(w * h);
    for (let i = 0; i < a.length; i++) a[i] = src[i * 4 + 3] / 255;
    return a;
  }

  /**
   * Bayer transition from the picture on screen to the new impression (brief 4.5):
   * 16 screen levels over 600 ms, then the picture stands still. Each level switches
   * one cell of the 4×4 Bayer matrix, a sixteenth of the pixels, from the old picture
   * to the new one in an RGBA copy of what is shown, then puts it on the canvas. That
   * is a strided copy and one putImageData a step, cheap even where canvas has no GPU
   * (compositing full-size pattern fills cost about a second there). Instant when the
   * reader prefers reduced motion.
   * @param {Layers} to
   * @param {number} w
   * @param {number} h
   * @param {() => boolean} cancelled
   */
  async function reveal(to, w, h, cancelled) {
    if (!frame || frame.w !== w || frame.h !== h) {
      frame = { ink: new Uint8ClampedArray(w * h * 4), echo: new Uint8ClampedArray(w * h * 4), w, h };
    }
    const shown = frame;
    const views = /** @type {const} */ ([
      [inkCanvas, shown.ink, to.ink],
      [echoCanvas, shown.echo, to.echo],
    ]).map(([canvas, cur, next]) => ({
      ctx: context(canvas),
      // The ImageData wraps the shown buffer without copying it.
      image: new ImageData(cur, w, h),
      cur: new Uint32Array(cur.buffer),
      next: new Uint32Array(next.buffer),
    }));
    const put = () => {
      for (const v of views) v.ctx.putImageData(v.image, 0, 0);
    };
    if (reducedMotion()) {
      for (const v of views) v.cur.set(v.next);
      put();
      return;
    }
    const t0 = performance.now();
    for (let step = 0; step < REVEAL_STEPS; step++) {
      const cell = BAYER4.indexOf(step);
      const cx = cell & 3;
      const cy = cell >> 2;
      for (const v of views) {
        for (let y = cy; y < h; y += 4) {
          const row = y * w;
          for (let x = cx; x < w; x += 4) v.cur[row + x] = v.next[row + x];
        }
      }
      put();
      if (step < REVEAL_STEPS - 1) {
        const due = t0 + (REVEAL_MS * (step + 1)) / REVEAL_STEPS;
        await new Promise((resolve) => {
          setTimeout(resolve, Math.max(0, due - performance.now()));
        });
        // A newer render continues from the mix on screen, which `frame` still holds.
        if (cancelled()) return;
      }
    }
  }

  /**
   * The paper layer's mask (the solid region) and the ink layer's (its complement),
   * one mask pixel per CSS pixel, scaled by the layers with mask-size: 100% 100%.
   * @param {Uint8ClampedArray} solid RGBA, opaque inside the region
   * @param {number} w
   * @param {number} h
   */
  async function buildMasks(solid, w, h) {
    const region = blankCanvas(w, h);
    context(region).putImageData(new ImageData(solid, w, h), 0, 0);
    const rest = blankCanvas(w, h);
    const rctx = context(rest);
    rctx.fillStyle = '#000';
    rctx.fillRect(0, 0, w, h);
    rctx.globalCompositeOperation = 'destination-out';
    rctx.drawImage(region, 0, 0);
    const [paper, ink] = await Promise.allSettled([maskUrl(region), maskUrl(rest)]);
    if (paper.status === 'rejected' || ink.status === 'rejected') {
      for (const r of [paper, ink]) if (r.status === 'fulfilled') URL.revokeObjectURL(r.value);
      throw paper.status === 'rejected' ? paper.reason : /** @type {PromiseRejectedResult} */ (ink).reason;
    }
    return { paper: paper.value, ink: ink.value };
  }

  /** @param {{ paper: string, ink: string }|null} m */
  function revoke(m) {
    if (!m) return;
    URL.revokeObjectURL(m.paper);
    URL.revokeObjectURL(m.ink);
  }

  /**
   * Apply a pair of masks, or none: without masks the ink layer shows whole (its
   * halos keep it legible over the grain) and the paper layer is hidden.
   * @param {{ paper: string, ink: string }|null} m
   */
  function setMasks(m) {
    const old = masks;
    masks = m;
    for (const [layer, url] of /** @type {const} */ ([
      [paperLayer, m?.paper],
      [inkLayer, m?.ink],
    ])) {
      if (url) {
        layer.style.setProperty('-webkit-mask-image', `url("${url}")`);
        layer.style.setProperty('mask-image', `url("${url}")`);
      } else {
        layer.style.removeProperty('-webkit-mask-image');
        layer.style.removeProperty('mask-image');
      }
    }
    paperLayer.classList.toggle('is-masked', m !== null);
    revoke(old);
  }

  return {
    render,
    /** Forget the shown key so the next render redraws (fonts arrived, DPR changed). */
    invalidate() {
      shownKey = '';
    },
  };
}
