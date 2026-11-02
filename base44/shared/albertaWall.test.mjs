// ── Alberta wall-clock regression tests — BACKEND helper ─────────────────────
// Run with:  node base44/shared/albertaWall.test.mjs
//
// Guards the Nov 1 2026 timezone fix: Alberta kept MST (-7) and the normal DST
// cycle. Activity segments are stored as naive wall clock and never converted,
// so nothing may shift +1h on an open + save cycle.

import assert from 'node:assert/strict';
import {
  edmontonWallParts,
  edmontonTodayKey,
  wallStringOf,
  wallMinutesBetween,
  roundWallTo5Min,
  utcMsOf,
} from './albertaWall.ts';

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

// ── 0: the premise — Alberta is on MST (-7) right after Nov 1 2026 ───────────
test('2026-11-01 20:53Z is 13:53 Edmonton (MST, -7)', () => {
  const w = edmontonWallParts(new Date('2026-11-01T20:53:00.000Z'));
  assert.equal(`${w.y}-${w.mo}-${w.d} ${w.h}:${w.mi}`, '2026-11-1 13:53');
});

test('summer instant still resolves to -6', () => {
  assert.equal(edmontonWallParts(new Date('2026-07-15T20:10:00.000Z')).h, 14);
});

// ── naive wall times pass through untouched ────────────────────────────────
test('wallStringOf passes a naive value through (no +1h)', () => {
  assert.equal(wallStringOf('2026-11-01T14:10'), '2026-11-01T14:10:00');
  assert.equal(wallStringOf('2026-07-15T14:10'), '2026-07-15T14:10:00');
});

test('wallStringOf resolves legacy ISO-Z to Edmonton wall', () => {
  assert.equal(wallStringOf('2026-11-01T21:10:00.000Z'), '2026-11-01T14:10:00');
});

// ── durations agree across both storage shapes ──────────────────────────────
test('legacy segment 19:35Z -> 21:10Z = 95 min', () => {
  assert.equal(wallMinutesBetween('2026-11-01T19:35:00.000Z', '2026-11-01T21:10:00.000Z'), 95);
});

test('naive segment 12:35 -> 14:10 = 95 min', () => {
  assert.equal(wallMinutesBetween('2026-11-01T12:35', '2026-11-01T14:10'), 95);
});

// ── writers round on the wall clock ─────────────────────────────────────────
test('roundWallTo5Min rounds on the wall clock, seconds ignored', () => {
  assert.equal(roundWallTo5Min('2026-11-01T14:10:41', 'floor'), '2026-11-01T14:10');
  assert.equal(roundWallTo5Min('2026-11-01T14:12:05', 'floor'), '2026-11-01T14:10');
  assert.equal(roundWallTo5Min('2026-11-01T14:12:05', 'ceil'), '2026-11-01T14:15');
  assert.equal(roundWallTo5Min('2026-11-01T23:58:00', 'ceil'), '2026-11-02T00:00');
});

test('utcMsOf reads both shapes as the same instant', () => {
  assert.equal(utcMsOf('2026-11-01T14:10'), Date.parse('2026-11-01T21:10:00.000Z'));
  assert.equal(utcMsOf('2026-11-01T21:10:00.000Z'), Date.parse('2026-11-01T21:10:00.000Z'));
});

test('Edmonton day key is MST-based, not a -6 shortcut', () => {
  assert.equal(edmontonTodayKey(new Date('2026-11-02T05:30:00.000Z')), '2026-11-01');
  assert.equal(edmontonTodayKey(new Date('2026-11-02T07:30:00.000Z')), '2026-11-02');
});

console.log(results.join('\n'));
console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);