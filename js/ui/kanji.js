// Japanese for the vertical Shippori Mincho columns (brief 1.5, 3). The columns are
// decorative (aria-hidden) but must be correct Japanese built from the real values,
// never pseudo-characters. Shippori Mincho is loaded with a &text= subset, so every
// character these functions can print is listed in MINCHO_CHARS, and a test checks
// that index.html requests exactly those.

const DIGITS = '〇一二三四五六七八九';

/** Instrument names: 金 (gold), 原油 (crude oil). */
export const INSTRUMENT_KANJI = Object.freeze({ XAUUSDT: '金', CLUSDT: '原油' });

/** Kline intervals as Japanese chart terms: 十五分足 is "15-minute candles". */
export const INTERVAL_KANJI = Object.freeze({
  '1m': '一分足',
  '5m': '五分足',
  '15m': '十五分足',
  '1h': '一時間足',
  '4h': '四時間足',
  '1d': '日足',
});

/** 無期限先物: perpetual futures. 資金調達率: funding rate. 次回まで: until the next one. 毎: every. */
const WORDS = ['無期限先物', '資金調達率', '次回まで', '時間', '分', '毎', 'まもなく'];

/** Every character the columns may contain, plus the ideographic space. */
export const MINCHO_CHARS = [
  ...new Set(
    [DIGITS, '十', ...Object.values(INSTRUMENT_KANJI), ...Object.values(INTERVAL_KANJI), ...WORDS, '\u3000'].join(''),
  ),
].join('');

/**
 * A count from 0 to 99 the way it is read: 3 → 三, 10 → 十, 15 → 十五, 23 → 二十三.
 * @param {number} n
 */
export function kanjiCount(n) {
  if (!Number.isInteger(n) || n < 0 || n > 99) throw new RangeError(`kanjiCount: ${n} is not an integer in 0..99`);
  if (n < 10) return DIGITS[n];
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return (tens > 1 ? DIGITS[tens] : '') + '十' + (ones ? DIGITS[ones] : '');
}

/**
 * Time left in hours and minutes: 3 h 15 min 40 s → "三時間十五分"; 42 min → "四十二分";
 * under a minute → "まもなく" (shortly). Hours above 99 cannot occur for funding.
 * @param {number} ms
 */
export function countdownKanji(ms) {
  if (!Number.isFinite(ms)) throw new RangeError(`countdownKanji: ${ms} is not a number`);
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes === 0) return 'まもなく';
  const h = Math.min(99, Math.floor(minutes / 60));
  const m = minutes % 60;
  return (h ? `${kanjiCount(h)}時間` : '') + (m || !h ? `${kanjiCount(m)}分` : '');
}

/**
 * The hero's column for the main instrument: name and "perpetual", then the funding
 * countdown when it is known.
 * @param {string} symbol
 * @param {number|null} msToFunding
 * @returns {string[]} one entry per vertical line
 */
export function heroColumn(symbol, msToFunding) {
  const name = INSTRUMENT_KANJI[/** @type {keyof typeof INSTRUMENT_KANJI} */ (symbol)] ?? '';
  const lines = [`${name}\u3000無期限先物`];
  lines.push(msToFunding === null ? '資金調達率' : `資金調達率\u3000次回まで${countdownKanji(msToFunding)}`);
  return lines;
}

/**
 * Plate II's column for the secondary instrument: name and "perpetual", then how
 * often funding settles ("資金調達\u3000八時間毎", every eight hours) when it is known.
 * The price is deliberately not repeated here: it is already set three times.
 * @param {string} symbol
 * @param {number|null} intervalHours
 */
export function plateColumn(symbol, intervalHours) {
  const name = INSTRUMENT_KANJI[/** @type {keyof typeof INSTRUMENT_KANJI} */ (symbol)] ?? '';
  const lines = [`${name}\u3000無期限先物`];
  if (
    Number.isInteger(intervalHours) &&
    /** @type {number} */ (intervalHours) > 0 &&
    /** @type {number} */ (intervalHours) < 100
  ) {
    lines.push(`資金調達\u3000${kanjiCount(/** @type {number} */ (intervalHours))}時間毎`);
  }
  return lines;
}

/**
 * The chart's margin note: instrument and candle length, "金\u3000十五分足".
 * @param {string} symbol
 * @param {string} interval
 */
export function chartNote(symbol, interval) {
  const name = INSTRUMENT_KANJI[/** @type {keyof typeof INSTRUMENT_KANJI} */ (symbol)] ?? '';
  return `${name}\u3000${INTERVAL_KANJI[/** @type {keyof typeof INTERVAL_KANJI} */ (interval)] ?? ''}`;
}
