import assert from 'node:assert/strict';
import { postStopArms, stopBarIndex } from '../engine/poststop.js';

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('PASS', name); };
const t0 = Date.parse('2026-11-20T15:00:00Z');
const bar = (k, o, h, l, c) => ({ t: new Date(t0 + k * 60000).toISOString(), o, h, l, c, v: 1000 });
const flat = t0 + 600 * 60000;
// stop = 10.00, a5 = 0.1; bar 0 touches the stop, dip to 9.80, then recovery above 10.
const bars = [bar(0, 10.05, 10.06, 9.99, 10.0), bar(1, 10.0, 10.0, 9.9, 9.92), bar(2, 9.92, 9.95, 9.8, 9.85), bar(3, 9.85, 9.95, 9.84, 9.93), bar(4, 9.93, 9.99, 9.9, 9.97), bar(5, 9.97, 10.1, 9.95, 10.08), bar(6, 10.08, 10.3, 10.05, 10.25), bar(7, 10.25, 10.4, 10.2, 10.3)];

t('stopBarIndex finds the first bar touching the stop from the fill time', () => {
  assert.equal(stopBarIndex(bars, t0, 10.0), 0);
  assert.equal(stopBarIndex(bars, t0 + 60000, 9.95), 1);
  assert.equal(stopBarIndex(bars, t0, 9.0), -1);
});
t('E1 limit fills at the level; fill bar only counts for the protective stop', () => {
  const r = postStopArms(bars, 0, 10.0, 0.1, flat);
  assert.equal(r.E1['0.25'].en, 9.975); assert.equal(r.E1['0.25'].m, 1);
  assert.equal(r.E1['1'].en, 9.9);
  assert.equal(r.E1['1'].x2, -0.758); // stopped at 9.825 by the dip to 9.8
  assert.equal(r.E1['1'].x3, -0.758); // fill-bar high 10.0 must not count as the target
  assert.equal(r.E1['1.5'].m, 2); assert.equal(r.E1['1.5'].x2, 4.569); // 9.85 entry, protective 9.775 never hit
  assert.ok(r.E1['1.5'].x3 > 0);
});
t('E2 reclaim enters at the stop price after the dip, stop under the dip low', () => {
  const r = postStopArms(bars, 0, 10.0, 0.1, flat);
  assert.equal(r.E2['1'].en, 10); assert.equal(r.E2['1'].m, 5);
  assert.equal(r.E2['1'].rp, 2.25); // (10 - (9.8 - 0.025)) / 10
  assert.equal(r.E2['1'].r1, 2.25);
});
t('E3 waits for a close above the previous three highs, enters next open', () => {
  const r = postStopArms(bars, 0, 10.0, 0.1, flat);
  assert.equal(r.E3['1'].en, 10.08); assert.equal(r.E3['1'].m, 6);
});
t('no dip deeper than k, or no recovery: arms are null; bad input is null', () => {
  const flatBars = [bar(0, 10.05, 10.06, 9.99, 10.0), bar(1, 10.0, 10.1, 9.98, 10.05), bar(2, 10.05, 10.1, 10.0, 10.08)];
  const r = postStopArms(flatBars, 0, 10.0, 0.1, flat);
  assert.equal(r.E1['0.5'], null); assert.equal(r.E2['0.5'], null); assert.equal(r.E3['1.5'], null);
  assert.equal(postStopArms(bars, -1, 10, 0.1, flat), null);
  assert.equal(postStopArms(bars, 0, 10, 0, flat), null);
});
t('window ends at the flat time', () => {
  const r = postStopArms(bars, 0, 10.0, 0.1, t0 + 3 * 60000);
  assert.equal(r.E2['1'], null);
});
console.log(pass, 'PASS');
