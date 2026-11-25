import assert from 'node:assert/strict';
import { sweepArms } from '../engine/sweepentry.js';
import { simFixed } from '../engine/lab.js';

let pass = 0;
const t = async (name, fn) => { await fn(); pass++; console.log('PASS', name); };
const t0 = Date.parse('2026-11-20T15:00:00Z');
const bar = (k, o, h, l, c) => ({ t: new Date(t0 + k * 60000).toISOString(), o, h, l, c, v: 1000 });
const st = { trigger: 10.10, stopStruct: 9.89 }; // sweep low 9.90 with a5 = 0.1
const opt = { flatMs: t0 + 600 * 60000, simFixed };

await t('rally after the reclaim: A and the half-way order win, the order under the low never fills', () => {
  const bars = [bar(0, 10.0, 10.08, 9.98, 10.07), bar(1, 10.07, 10.12, 10.05, 10.1), bar(2, 10.1, 10.3, 10.0, 10.25), bar(3, 10.25, 10.4, 10.2, 10.35), bar(4, 10.35, 10.5, 10.3, 10.45), bar(5, 10.45, 10.6, 10.4, 10.5), bar(6, 10.5, 10.55, 10.45, 10.5)];
  const r = sweepArms(bars, 0, st, 0.1, opt);
  assert.deepEqual(r.A.slice(0, 3), [1, 1.5, 2]);
  assert.equal(r.B, null);
  assert.deepEqual(r.C.slice(0, 3), [1, 1.5, 2]);
  assert.ok(r.C[3] < r.A[3], 'half-way order has the smaller risk');
});

await t('deep dip through the stop: every arm is stopped, none is lost silently', () => {
  const bars = [bar(0, 10.0, 10.08, 9.98, 10.07), bar(1, 10.07, 10.1, 9.8, 9.85), bar(2, 9.85, 10.0, 9.8, 9.95), bar(3, 9.95, 10.3, 9.9, 10.2), bar(4, 10.2, 10.4, 10.1, 10.3), bar(5, 10.3, 10.5, 10.2, 10.4), bar(6, 10.4, 10.5, 10.3, 10.4)];
  const r = sweepArms(bars, 0, st, 0.1, opt);
  assert.deepEqual(r.A.slice(0, 3), [-1, -1, -1]);
  assert.deepEqual(r.B.slice(0, 3), [-1, -1, -1]);
  assert.deepEqual(r.C.slice(0, 3), [-1, -1, -1]);
});

await t('dip under the low, then recovery: the order under the low fills and wins, A is stopped later', () => {
  const bars = [bar(0, 10.0, 10.08, 9.98, 10.07), bar(1, 10.07, 10.09, 9.95, 9.97), bar(2, 9.97, 10.0, 9.87, 9.92), bar(3, 9.92, 10.2, 9.9, 10.15), bar(4, 10.15, 10.3, 10.1, 10.25), bar(5, 10.25, 10.4, 10.2, 10.35), bar(6, 10.35, 10.5, 10.3, 10.45)];
  const r = sweepArms(bars, 0, st, 0.1, opt);
  assert.ok(r.B && r.B[0] === 1, 'B fills near 9.89 and reaches 1R');
  assert.equal(r.B[4], 2);
});

await t('orders are not filled after the flat time', () => {
  const bars = [bar(0, 10.0, 10.08, 9.98, 10.07), bar(1, 10.07, 10.12, 10.05, 10.1), bar(2, 10.1, 10.3, 10.0, 10.25), bar(3, 10.25, 10.3, 9.5, 9.6), bar(4, 9.6, 9.7, 9.5, 9.6)];
  const r = sweepArms(bars, 0, st, 0.1, { ...opt, flatMs: t0 + 3 * 60000 });
  assert.equal(r.B, null);
});

console.log(`${pass} sweepentry tests PASS`);
