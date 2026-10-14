import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MINUS,
  PLACEHOLDER,
  THIN_SPACE,
  formatAge,
  formatCompact,
  formatCountdown,
  formatFundingRate,
  formatNumber,
  formatPercent,
  formatPrice,
  formatSigned,
  formatUtcClock,
  formatUtcDate,
} from '../js/format.js';

const T = THIN_SPACE;

test('typographic constants are the exact code points the brief requires', () => {
  assert.equal(THIN_SPACE, ' ');
  assert.equal(MINUS, '−');
});

test('formatNumber groups thousands with thin spaces and uses a true minus', () => {
  assert.equal(formatNumber(4012.35, 2), `4${T}012.35`);
  assert.equal(formatNumber(1284512330, 0), `1${T}284${T}512${T}330`);
  assert.equal(formatNumber(-1234.5, 2), `${MINUS}1${T}234.50`);
  assert.equal(formatNumber(999, 0), '999');
  assert.equal(formatNumber(1000, 0), `1${T}000`);
  assert.equal(formatNumber(0.5, 3), '0.500');
});

test('formatNumber rounds to the requested decimals, including carries into new groups', () => {
  assert.equal(formatNumber(999.996, 2), `1${T}000.00`);
  assert.equal(formatNumber(71.084, 2), '71.08');
  assert.equal(formatNumber(41220.118, 3), `41${T}220.118`);
});

test('a value that rounds to zero never prints a minus sign', () => {
  assert.equal(formatNumber(-0.004, 2), '0.00');
  assert.equal(formatNumber(-0, 2), '0.00');
  assert.equal(formatSigned(-0.004, 2), '0.00');
  assert.equal(formatSigned(0, 2), '0.00');
});

test('unknown values print the placeholder, never a number', () => {
  for (const v of [null, undefined, NaN, Infinity, -Infinity, '12']) {
    assert.equal(formatNumber(/** @type {any} */ (v), 2), PLACEHOLDER);
    assert.equal(formatSigned(/** @type {any} */ (v), 2), PLACEHOLDER);
    assert.equal(formatPercent(/** @type {any} */ (v)), PLACEHOLDER);
    assert.equal(formatFundingRate(/** @type {any} */ (v)), PLACEHOLDER);
    assert.equal(formatCompact(/** @type {any} */ (v)), PLACEHOLDER);
    assert.equal(formatCountdown(/** @type {any} */ (v)), PLACEHOLDER);
    assert.equal(formatUtcClock(/** @type {any} */ (v)), PLACEHOLDER);
    assert.equal(formatUtcDate(/** @type {any} */ (v)), PLACEHOLDER);
    assert.equal(formatAge(/** @type {any} */ (v)), PLACEHOLDER);
  }
});

test('formatPrice uses the symbol precision and falls back to 2 while it is unknown', () => {
  assert.equal(formatPrice(4012.3, 2), `4${T}012.30`);
  assert.equal(formatPrice(71.084, 3), '71.084');
  assert.equal(formatPrice(71.084, null), '71.08');
});

test('formatSigned and formatPercent always show the direction', () => {
  assert.equal(formatSigned(16.79, 2), '+16.79');
  assert.equal(formatSigned(-0.81, 2), `${MINUS}0.81`);
  assert.equal(formatPercent(0.4202), '+0.42%');
  assert.equal(formatPercent(-1.127), `${MINUS}1.13%`);
  assert.equal(formatPercent(66.7, { decimals: 0, signed: false }), '67%');
});

test('formatFundingRate converts the per-interval fraction to percent with 4 decimals', () => {
  assert.equal(formatFundingRate(0.0001), '+0.0100%');
  assert.equal(formatFundingRate(-0.000042), `${MINUS}0.0042%`);
  assert.equal(formatFundingRate(0.00038246), '+0.0382%');
  assert.equal(formatFundingRate(0), '0.0000%');
});

test('formatCompact picks K/M/B/T and moves up a unit instead of printing 1000', () => {
  assert.equal(formatCompact(1284512330), '1.28B');
  assert.equal(formatCompact(186402115), '186.40M');
  assert.equal(formatCompact(950), '950');
  assert.equal(formatCompact(999.5), '1.00K');
  assert.equal(formatCompact(999_996_000), '1.00B');
  assert.equal(formatCompact(-1_234_567), `${MINUS}1.23M`);
  assert.equal(formatCompact(0), '0');
  assert.equal(formatCompact(12_345, 1), '12.3K');
  assert.equal(formatCompact(1e15), `1${T}000.00T`);
});

test('formatCountdown prints HH:MM:SS, floors seconds and never goes negative', () => {
  assert.equal(formatCountdown(3 * 3600e3 + 15 * 60e3 + 4e3), '03:15:04');
  assert.equal(formatCountdown(999), '00:00:00');
  assert.equal(formatCountdown(59_999), '00:00:59');
  assert.equal(formatCountdown(-5000), '00:00:00');
  assert.equal(formatCountdown(26 * 3600e3), '26:00:00');
});

test('UTC clock and date ignore the local time zone', () => {
  const t = Date.UTC(2026, 9, 11, 20, 42, 18, 900);
  assert.equal(formatUtcClock(t), '20:42:18');
  assert.equal(formatUtcClock(t, { seconds: false }), '20:42');
  assert.equal(formatUtcDate(t), '11 Oct 2026');
  assert.equal(formatUtcDate(Date.UTC(2026, 0, 1)), '1 Jan 2026');
});

test('formatAge steps from seconds to days', () => {
  assert.equal(formatAge(0), `0${T}s`);
  assert.equal(formatAge(41_500), `41${T}s`);
  assert.equal(formatAge(3 * 60e3 + 5e3), `3${T}min`);
  assert.equal(formatAge(2 * 3600e3), `2${T}h`);
  assert.equal(formatAge(5 * 86400e3), `5${T}d`);
  assert.equal(formatAge(-10), `0${T}s`);
});
