import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  INSTRUMENT_KANJI,
  INTERVAL_KANJI,
  MINCHO_CHARS,
  chartNote,
  countdownKanji,
  heroColumn,
  kanjiCount,
  plateColumn,
} from '../js/ui/kanji.js';
import { INTERVALS, SYMBOLS } from '../js/config.js';

const HOUR = 3_600_000;
const MIN = 60_000;

test('kanjiCount reads numbers the Japanese way', () => {
  assert.equal(kanjiCount(0), '〇');
  assert.equal(kanjiCount(3), '三');
  assert.equal(kanjiCount(10), '十');
  assert.equal(kanjiCount(15), '十五');
  assert.equal(kanjiCount(20), '二十');
  assert.equal(kanjiCount(23), '二十三');
  assert.equal(kanjiCount(99), '九十九');
  assert.throws(() => kanjiCount(100), RangeError);
  assert.throws(() => kanjiCount(-1), RangeError);
  assert.throws(() => kanjiCount(1.5), RangeError);
});

test('countdownKanji gives hours and minutes, floored like the digital countdown', () => {
  assert.equal(countdownKanji(3 * HOUR + 15 * MIN + 40_000), '三時間十五分');
  assert.equal(countdownKanji(42 * MIN + 59_999), '四十二分');
  assert.equal(countdownKanji(2 * HOUR), '二時間', 'whole hours drop the minutes');
  assert.equal(countdownKanji(HOUR + MIN), '一時間一分');
  assert.equal(countdownKanji(59_000), 'まもなく', 'under a minute: "shortly"');
  assert.equal(countdownKanji(-5_000), 'まもなく', 'overdue reads as due');
  assert.throws(() => countdownKanji(Number.NaN), RangeError);
});

test('every instrument and interval the page offers has a Japanese name', () => {
  for (const s of SYMBOLS) assert.ok(INSTRUMENT_KANJI[s], s);
  for (const i of INTERVALS) assert.ok(INTERVAL_KANJI[i], i);
  assert.equal(chartNote('XAUUSDT', '15m'), '金　十五分足');
  assert.equal(chartNote('CLUSDT', '1d'), '原油　日足');
});

test('the hero column carries the funding countdown only when it is known', () => {
  assert.deepEqual(heroColumn('XAUUSDT', 3 * HOUR + 15 * MIN), ['金　無期限先物', '資金調達率　次回まで三時間十五分']);
  assert.deepEqual(heroColumn('CLUSDT', null), ['原油　無期限先物', '資金調達率']);
});

test('the plate column states the funding interval, never repeats the price', () => {
  assert.deepEqual(plateColumn('CLUSDT', 8), ['原油　無期限先物', '資金調達　八時間毎']);
  assert.deepEqual(plateColumn('XAUUSDT', 4), ['金　無期限先物', '資金調達　四時間毎']);
  assert.deepEqual(plateColumn('CLUSDT', null), ['原油　無期限先物']);
});

test('everything the columns can print is inside the Shippori Mincho subset', () => {
  const samples = [];
  for (const s of SYMBOLS) {
    for (let m = 0; m < 24 * 60; m += 7) samples.push(...heroColumn(s, m * MIN + 30_000));
    for (const h of [1, 2, 4, 8, 12]) samples.push(...plateColumn(s, h));
    for (const i of INTERVALS) samples.push(chartNote(s, i));
  }
  samples.push(...heroColumn('XAUUSDT', 10_000));
  for (const line of samples) for (const ch of line) assert.ok(MINCHO_CHARS.includes(ch), `"${ch}" in "${line}"`);
});

test('index.html requests exactly the Mincho subset the columns use', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const href = /href="(https:\/\/fonts\.googleapis\.com\/css2\?family=Shippori\+Mincho[^"]+)"/.exec(html);
  assert.ok(href, 'Shippori Mincho stylesheet link');
  const text = new URL(href[1].replace(/&amp;/g, '&')).searchParams.get('text') ?? '';
  assert.deepEqual([...new Set(text)].sort(), [...new Set(MINCHO_CHARS)].sort());
});

test('index.html requests Pinyon Script for both script words', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const href = /href="(https:\/\/fonts\.googleapis\.com\/css2\?family=Pinyon\+Script[^"]+)"/.exec(html);
  assert.ok(href);
  const text = new URL(href[1].replace(/&amp;/g, '&')).searchParams.get('text') ?? '';
  for (const word of ['aurum', 'oleum']) for (const ch of word) assert.ok(text.includes(ch), `${ch} of ${word}`);
});
