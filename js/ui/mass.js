// Paints the dissolve mass (js/ui/dissolve.js) into the hero and keeps the sharp
// layer's inversion exact. Three surfaces, bottom to top:
//   echo canvas   grey echo dots (and the pale latent impression before data);
//   ink layer     the sharp type, ink on paper (DOM, sits between the canvases);
//   ink canvas    the black dots;
//   paper layer   the same sharp type in paper colour, masked to the black dots.
// So a glyph is solid ink over paper and over grey echo dots, and exactly paper over
// black dots: the inversion is computed against the mass only (critique: no
// halftone or echo dots leak into the sharp layer).

import { ECHO, INK, massKey, massParams, renderDissolve } from './dissolve.js';
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

/**
 * renderDissolve in a module worker when the browser offers one, on the main thread
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
  /** @type {Map<number, { resolve: (out: Uint8Array) => void, reject: (err: Error) => void }>} */
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
   * @param {Parameters<typeof renderDissolve>[0]} args
   * @returns {Promise<Uint8Array>}
   */
  return function render(args) {
    if (!worker) return Promise.resolve(renderDissolve(args));
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
 * A 4×4 ordered-dither tile that is opaque where the Bayer threshold is under
 * `level`, as a repeating pattern factory for a given context.
 * @param {number} level 0..1
 */
function bayerPattern(level) {
  const tile = blankCanvas(4, 4);
  const tctx = context(tile);
  const img = tctx.createImageData(4, 4);
  for (let i = 0; i < 16; i++) if ((BAYER4[i] + 0.5) / 16 < level) img.data[i * 4 + 3] = 255;
  tctx.putImageData(img, 0, 0);
  return (/** @type {CanvasRenderingContext2D} */ ctx) => {
    const p = ctx.createPattern(tile, 'repeat');
    if (!p) throw new Error('Painting the mass: the canvas refused a Bayer pattern');
    return p;
  };
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
 * @param {{ echoCanvas: HTMLCanvasElement, inkCanvas: HTMLCanvasElement, paperLayer: HTMLElement }} p
 */
export function createMass({ echoCanvas, inkCanvas, paperLayer }) {
  let shownKey = '';
  let job = 0;
  let shownW = 0;
  let shownH = 0;
  /** @type {string|null} */
  let maskUrl = null;
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
      massKey(spec),
    ].join('|');
    if (key === shownKey) return;
    shownKey = key;
    const mine = ++job;

    const alpha = glyphAlpha(spec, w, h);
    await nextFrame();
    if (mine !== job) return;

    const params = massParams(spec);
    /** @type {Uint8Array} */
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
      });
    } catch (err) {
      // Let the next update try again (on the main thread if the worker died).
      if (mine === job) shownKey = '';
      throw err;
    }
    if (mine !== job) return;

    const sameSize = shownW === w && shownH === h;
    if (!sameSize) {
      for (const c of [echoCanvas, inkCanvas]) {
        c.width = w;
        c.height = h;
      }
    }
    // The mask goes out of date the moment the dots change; drop it first so the
    // paper layer never shows paper type where there is no longer any mass.
    clearMask();
    await reveal(out, params.latent, w, h, () => mine !== job);
    if (mine !== job) return;
    shownW = w;
    shownH = h;
    if (!params.latent) await applyMask(out, w, h, () => mine !== job);
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
   * 16 screen levels over 600 ms, then the picture stands still. Each level is a
   * pattern fill composited on the GPU, not a per-pixel loop, so a full-width mass
   * costs a few draw calls per step. Instant when the reader prefers reduced motion.
   * @param {Uint8Array} to
   * @param {boolean} latent the new picture is the pale impression without data
   * @param {number} w
   * @param {number} h
   * @param {() => boolean} cancelled
   */
  async function reveal(to, latent, w, h, cancelled) {
    // `from` holds what is on screen now: the transition starts there.
    const targets = [inkCanvas, echoCanvas].map((canvas) => {
      const from = blankCanvas(w, h);
      context(from).drawImage(canvas, 0, 0);
      return { canvas, image: blankCanvas(w, h), from };
    });
    const [ink, echo] = targets;
    const inkCtx = context(ink.image);
    const echoCtx = context(echo.image);
    const inkImg = inkCtx.createImageData(w, h);
    const echoImg = echoCtx.createImageData(w, h);
    for (let i = 0; i < to.length; i++) {
      const code = to[i];
      if (code === 0) continue;
      const j = i * 4;
      if (code === INK && !latent) {
        inkImg.data[j + 3] = 255;
      } else {
        const rgb = code === ECHO ? ECHO_RGB : LATENT_RGB;
        echoImg.data[j] = rgb[0];
        echoImg.data[j + 1] = rgb[1];
        echoImg.data[j + 2] = rgb[2];
        echoImg.data[j + 3] = 255;
      }
    }
    inkCtx.putImageData(inkImg, 0, 0);
    echoCtx.putImageData(echoImg, 0, 0);

    const steps = reducedMotion() ? 1 : REVEAL_STEPS;
    if (steps === 1) {
      for (const t of targets) {
        const ctx = context(t.canvas);
        ctx.globalCompositeOperation = 'copy';
        ctx.drawImage(t.image, 0, 0);
        ctx.globalCompositeOperation = 'source-over';
      }
      return;
    }
    const scratch = blankCanvas(w, h);
    const sctx = context(scratch);
    const t0 = performance.now();
    for (let step = 1; step <= steps; step++) {
      const pattern = bayerPattern(step / steps);
      for (const t of targets) {
        // scratch = new picture through the screen; screen = old picture outside it.
        sctx.globalCompositeOperation = 'copy';
        sctx.drawImage(t.image, 0, 0);
        sctx.globalCompositeOperation = 'destination-in';
        sctx.fillStyle = pattern(sctx);
        sctx.fillRect(0, 0, w, h);
        const ctx = context(t.canvas);
        ctx.globalCompositeOperation = 'copy';
        ctx.drawImage(t.from, 0, 0);
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillStyle = pattern(ctx);
        ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = 'source-over';
        ctx.drawImage(scratch, 0, 0);
      }
      if (step < steps) {
        const due = t0 + (REVEAL_MS * step) / steps;
        await new Promise((resolve) => {
          setTimeout(resolve, Math.max(0, due - performance.now()));
        });
        if (cancelled()) return;
      }
    }
  }

  function clearMask() {
    paperLayer.classList.remove('is-masked');
    paperLayer.style.removeProperty('mask-image');
    paperLayer.style.removeProperty('-webkit-mask-image');
    if (maskUrl) URL.revokeObjectURL(maskUrl);
    maskUrl = null;
  }

  /**
   * Mask image of the black dots, one mask pixel per dot. The paper layer scales it
   * with image-rendering: pixelated, so each dot's edge lands on the same device
   * pixels as the dot on the canvas.
   * @param {Uint8Array} out
   * @param {number} w
   * @param {number} h
   * @param {() => boolean} cancelled
   */
  async function applyMask(out, w, h, cancelled) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('Building the inversion mask: this browser gives no 2D canvas');
    const img = ctx.createImageData(w, h);
    for (let i = 0; i < out.length; i++) if (out[i] === INK) img.data[i * 4 + 3] = 255;
    ctx.putImageData(img, 0, 0);

    /** @type {Blob|null} */
    const blob = await new Promise((resolve) => {
      c.toBlob(resolve, 'image/png');
    });
    if (!blob) throw new Error('Building the inversion mask: the canvas could not be encoded as PNG');
    if (cancelled()) return;
    const url = URL.createObjectURL(blob);
    // Decode before use, so the mask and the dots appear in the same frame.
    const probe = new Image();
    probe.src = url;
    try {
      await probe.decode();
    } catch (err) {
      URL.revokeObjectURL(url);
      throw new Error('Building the inversion mask: the PNG could not be decoded', { cause: err });
    }
    if (cancelled()) {
      URL.revokeObjectURL(url);
      return;
    }
    clearMask();
    maskUrl = url;
    paperLayer.style.setProperty('-webkit-mask-image', `url("${url}")`);
    paperLayer.style.setProperty('mask-image', `url("${url}")`);
    paperLayer.classList.add('is-masked');
  }

  return {
    render,
    /** Forget the shown key so the next render redraws (fonts arrived, DPR changed). */
    invalidate() {
      shownKey = '';
    },
  };
}
