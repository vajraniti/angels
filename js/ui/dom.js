// Small DOM helpers shared by the views.

export const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * @param {string} selector
 * @param {ParentNode} [root]
 * @returns {HTMLElement}
 */
export function $(selector, root = document) {
  const el = root.querySelector(selector);
  if (!el) throw new Error(`Page markup is missing ${selector}`);
  return /** @type {HTMLElement} */ (el);
}

/**
 * @param {string} selector
 * @param {ParentNode} [root]
 * @returns {HTMLElement[]}
 */
export function $$(selector, root = document) {
  return /** @type {HTMLElement[]} */ ([...root.querySelectorAll(selector)]);
}

/**
 * Set textContent only when it differs: avoids layout work and keeps screen readers
 * from re-reading unchanged nodes.
 * @param {Element} el
 * @param {string} text
 */
export function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

/**
 * Set the text of every element carrying `data-<attr>="<key>"` under root.
 * @param {ParentNode} root
 * @param {string} attr data attribute name without "data-"
 * @param {Record<string, string>} values
 */
export function fill(root, attr, values) {
  for (const el of root.querySelectorAll(`[data-${attr}]`)) {
    const key = /** @type {HTMLElement} */ (el).dataset[camel(attr)];
    if (key !== undefined && key in values) setText(el, values[key]);
  }
}

/**
 * Like fill() for display figures: each thin-space group becomes its own span, so
 * CSS can open the gap that a thin space of a 100 px Didone does not show.
 * Elements carry `data-grouped="<key>"`.
 * @param {ParentNode} root
 * @param {Record<string, string>} values
 */
export function fillGrouped(root, values) {
  for (const el of root.querySelectorAll('[data-grouped]')) {
    const key = /** @type {HTMLElement} */ (el).dataset.grouped;
    if (key === undefined || !(key in values)) continue;
    const text = values[key];
    if (el.textContent === text.replace(/\u2009/g, '')) continue;
    el.replaceChildren(
      ...text.split('\u2009').map((g) => {
        const span = document.createElement('span');
        span.className = 'grp';
        span.textContent = g;
        return span;
      }),
    );
  }
}

/** @param {string} s */
function camel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * @param {string} tag
 * @param {Record<string, string|number>} [attrs]
 * @param {Element} [parent]
 * @returns {SVGElement}
 */
export function svgEl(tag, attrs = {}, parent) {
  const el = /** @type {SVGElement} */ (document.createElementNS(SVG_NS, tag));
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (parent) parent.appendChild(el);
  return el;
}

/**
 * The ▲ / ▽ direction glyph from the page's SVG sprite (fallback fonts draw these
 * differently on every OS, brief 3).
 * @param {Element} el an <svg> holding one <use>
 * @param {'up'|'down'|'flat'|null} direction
 */
export function setDirection(el, direction) {
  const use = el.querySelector('use');
  if (!use) throw new Error('Direction glyph markup is missing its <use> element');
  const id = direction === 'up' ? '#g-up' : direction === 'down' ? '#g-dn' : '';
  if (use.getAttribute('href') !== id) {
    if (id) use.setAttribute('href', id);
    else use.removeAttribute('href');
  }
  el.toggleAttribute('hidden', id === '');
}

/**
 * Device pixel ratio, capped: beyond 3 the canvases only cost memory.
 */
export function pixelRatio() {
  return Math.max(1, Math.min(3, window.devicePixelRatio || 1));
}

/** Whether the reader asked for less motion; read live, the setting can change. */
export function reducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Per-viewer preference in localStorage. Storage can be missing or throw (private
 * windows, blocked site data); the page then simply starts from its defaults.
 */
export const prefs = {
  /**
   * @param {string} key
   * @param {readonly string[]} allowed
   * @returns {string|null}
   */
  get(key, allowed) {
    try {
      const v = window.localStorage.getItem(`angels.${key}`);
      return v !== null && allowed.includes(v) ? v : null;
    } catch {
      return null;
    }
  },
  /**
   * @param {string} key
   * @param {string} value
   */
  set(key, value) {
    try {
      window.localStorage.setItem(`angels.${key}`, value);
    } catch {
      // Not remembering a tab choice is harmless; nothing to report.
    }
  },
};
