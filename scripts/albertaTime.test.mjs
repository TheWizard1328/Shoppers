// ── Alberta wall-clock regression tests — CLIENT helper ──────────────────────
// Run with:  node scripts/albertaTime.test.mjs
//
// Guards the Nov 1 2026 timezone fix on the Driver Activity page: segment times
// are naive Edmonton wall clock ("YYYY-MM-DDTHH:mm"), loaded into the dialog
// verbatim and saved verbatim, so repeated open + save can never shift them.

import assert from 'node:assert/strict';
import {
  edmontonWallHM,
  edmontonDateTimeInput,
  wallMinutesBetween,
  edmontonTodayKey,
  edmontonWallString,
  parseAnyTimestamp,
} from '../src/components/utils/albertaTime.js';

const results = [];
const test = (name, fn) => {
  try {
    fn();
    results.push(`PASS  ${name}`);
  } catch (err) {
    results.push(`FAIL  ${name}\n        ${err.message}`);
    process.exitCode = 1;
  }
};

const hhmm = (hm) => (hm ? `${String(hm.h).padStart(2, '0')}:${String(hm.m).padStart(2, '0')}` : null);

// ── 0: Alberta is on MST (-7) after Nov 1 2026, MDT (-6) in summer ──────────
test('2026-11-01 20:53Z renders 13:53', () => {
  assert.equal(hhmm(edmontonWallHM('2026-11-01T20:53:00.000Z')), '13:53');
  assert.equal(edmontonWallString(new Date('2026-11-01T20:53:00.000Z')), '2026-11-01T13:53:00');
});

test('summer ISO instant renders 14:10 from 20:10Z', () => {
  assert.equal(hhmm(edmontonWallHM('2026-07-15T20:10:00.000Z')), '14:10');
});

// ── 1: naive November value renders and re-saves unchanged ─────────────────
test('naive 2026-11-01T14:10 renders 14:10 (no +1h)', () => {
  assert.equal(hhmm(edmontonWallHM('2026-11-01T14:10')), '14:10');
  assert.equal(edmontonDateTimeInput('2026-11-01T14:10'), '2026-11-01T14:10');
});

test('repeated open + save never shifts the value', () => {
  let stored = '2026-11-01T12:35';
  for (let cycle = 0; cycle < 5; cycle++) stored = edmontonDateTimeInput(stored);
  assert.equal(stored, '2026-11-01T12:35');

  let end = '2026-11-01T14:10';
  for (let cycle = 0; cycle < 5; cycle++) end = edmontonDateTimeInput(end);
  assert.equal(end, '2026-11-01T14:10');
});

test('a saved value keeps its 95-minute span over repeated cycles', () => {
  const start = '2026-11-01T12:35';
  const end = edmontonDateTimeInput('2026-11-01T14:10');
  assert.equal(wallMinutesBetween(start, end), 95);
});

// ── 2: naive summer wall time ──────────────────────────────────────────────
test('naive 2026-07-15T14:10 renders 14:10', () => {
  assert.equal(hhmm(edmontonWallHM('2026-07-15T14:10')), '14:10');
  assert.equal(edmontonDateTimeInput('2026-07-15T14:10'), '2026-07-15T14:10');
});

// ── 3: legacy ISO-Z rows still render correctly ────────────────────────────
test('legacy 2026-11-01T21:10:00.000Z renders 14:10', () => {
  assert.equal(hhmm(edmontonWallHM('2026-11-01T21:10:00.000Z')), '14:10');
  assert.equal(edmontonDateTimeInput('2026-11-01T21:10:00.000Z'), '2026-11-01T14:10');
});

// ── 4/5: segment durations ─────────────────────────────────────────────────
test('legacy segment 19:35Z -> 21:10Z = 95 min', () => {
  assert.equal(wallMinutesBetween('2026-11-01T19:35:00.000Z', '2026-11-01T21:10:00.000Z'), 95);
});

test('naive segment 12:35 -> 14:10 = 95 min', () => {
  assert.equal(wallMinutesBetween('2026-11-01T12:35', '2026-11-01T14:10'), 95);
});

// ── Duty-clock math still resolves both shapes for open segments ───────────
test('parseAnyTimestamp resolves naive and ISO to the same instant', () => {
  assert.equal(
    parseAnyTimestamp('2026-11-01T14:10').getTime(),
    parseAnyTimestamp('2026-11-01T21:10:00.000Z').getTime()
  );
});

test('today key uses MST, not a -6 shortcut', () => {
  assert.equal(edmontonTodayKey(new Date('2026-11-02T05:30:00.000Z')), '2026-11-01');
  assert.equal(edmontonTodayKey(new Date('2026-11-02T07:30:00.000Z')), '2026-11-02');
});

console.log(results.join('\n'));
console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);