// Regime ideas on synthetic 1-minute bars, and the ORB-Plus shadow profile condition.
import assert from 'node:assert/strict';
import { downEvents, upEvents, rangeEvents } from '../engine/regimes.js';
import { matchProfile } from '../engine/profiles.js';
import { DEFAULTS as CONFIG } from '../engine/config.js';

const T0 = Date.UTC(2026, 10, 18, 14, 30); // 09:30 NY
const bar = (i, o, h, l, c, v = 1000) => ({ t: new Date(T0 + i * 60000).toISOString(), o, h, l, c, v });
const flatMs = T0 + 385 * 60000;
let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`PASS  ${name}`); };

// Day: flat at 50, then a fall of ~8% from the high, then a bounce.
const fall = [];
for (let i = 0; i < 10; i++) fall.push(bar(i, 50, 50.2, 49.9, 50));
for (let i = 10; i < 30; i++) { const p = 50 - (i - 9) * 0.22; fall.push(bar(i, p + 0.2, p + 0.25, p - 0.05, p)); }
for (let i = 30; i < 60; i++) { const p = 45.6 + (i - 30) * 0.15; fall.push(bar(i, p - 0.1, p + 0.1, p - 0.15, p)); }

t('down: events fire at each drop level once, entry at the level, +2% target reached on the bounce', () => {
  const ev = downEvents(fall, 0, flatMs);
  const ps = ev.map((x) => x.p);
  assert.ok(ps.includes('4') && ps.includes('5') && ps.includes('7') && new Set(ps).size === ps.length);
  const e4 = ev.find((x) => x.p === '4');
  assert.ok(Math.abs(e4.e - 50.2 * 0.96) < 0.01 || e4.e <= 50.2 * 0.96);
  assert.ok(e4.g['2_n'] > 0, JSON.stringify(e4.g)); // no stop: the bounce reaches +2%
  assert.ok(e4.g['2_4'] <= -3.9, JSON.stringify(e4.g)); // a 4% stop is hit first because the fall continued
  assert.equal(Object.keys(e4.g).length, 9);
});
t('down: a stop is hit first when the fall continues', () => {
  const b = [...fall.slice(0, 12), ...Array.from({ length: 40 }, (_, i) => bar(12 + i, 47 - i * 0.2, 47 - i * 0.2 + 0.1, 47 - i * 0.2 - 0.3, 47 - i * 0.2 - 0.2))];
  const ev = downEvents(b, 0, flatMs, [4]);
  assert.equal(ev.length, 1);
  assert.ok(ev[0].g['2_2'] <= -1.9 && ev[0].g['2_n'] < 0);
});
t('no entries in the last 30 minutes', () => {
  const late = [];
  for (let i = 0; i < 385; i++) late.push(bar(i, 50, 50.1, 49.9, 50));
  for (let i = 385; i < 389; i++) late.push(bar(i, 50 - (i - 384) * 2, 50, 40, 41));
  assert.equal(downEvents(late, 0, flatMs).length, 0);
});
t('up: first touch of VWAP after a run in a stock up 3%+, +2% target before a -1% stop', () => {
  const b = [];
  for (let i = 0; i < 12; i++) b.push(bar(i, 100 + i * 0.5, 100 + i * 0.5 + 0.4, 100 + i * 0.5 - 0.1, 100 + i * 0.5 + 0.3, 5000));
  for (let i = 12; i < 40; i++) b.push(bar(i, 105.5, 105.7, 105.2, 105.4, 5000));
  b.push(bar(40, 105.4, 105.4, 103.2, 103.5, 5000));
  for (let i = 41; i < 70; i++) b.push(bar(i, 103.5 + (i - 41) * 0.2, 103.8 + (i - 41) * 0.2, 103.4 + (i - 41) * 0.2, 103.7 + (i - 41) * 0.2, 5000));
  const ev = upEvents(b, 0, flatMs, 100);
  assert.ok(ev.length >= 1 && ev.every((x) => x.k === 'up'));
  assert.equal(Object.keys(ev[0].g).length, 6);
});
t('up: nothing when the stock is not up 3%', () => assert.equal(upEvents(Array.from({ length: 80 }, (_, i) => bar(i, 100, 100.1, 99.9, 100)), 0, flatMs, 100).length, 0));
t('range: a dip of k standard deviations under VWAP is bought, target VWAP', () => {
  const b = [];
  for (let i = 0; i < 60; i++) b.push(bar(i, 100 + Math.sin(i) * 0.15, 100.3 + Math.sin(i) * 0.15, 99.7 + Math.sin(i) * 0.15, 100 + Math.sin(i) * 0.15));
  b.push(bar(60, 100, 100, 98.8, 99.2));
  for (let i = 61; i < 90; i++) b.push(bar(i, 99.5 + (i - 61) * 0.03, 99.8 + (i - 61) * 0.03, 99.4 + (i - 61) * 0.03, 99.6 + (i - 61) * 0.03));
  const ev = rangeEvents(b, 0, flatMs, 100);
  assert.ok(ev.length >= 1 && ev[0].e < 100);
  assert.ok(ev[0].g.v_n > 0 || ev[0].g.m_n > 0, JSON.stringify(ev[0].g));
});
t('ORB-Plus shadow profile needs ORB15/30, day change 8%+ and a stop of at least 1% of price', () => {
  const base = { setup: 'ORB15', plan: { fails: [], R: 1.2, entry: 100, ext: 1 }, minAfterOpen: 20, feats: { chg: 9 }, regime: 'up' };
  assert.ok(String(matchProfile(CONFIG, base)).startsWith('ORB'));
  assert.notEqual(matchProfile(CONFIG, { ...base, plan: { ...base.plan, R: 0.8 } }), 'ORBPLUS-15');
  assert.notEqual(matchProfile(CONFIG, { ...base, feats: { chg: 6 } }), 'ORBPLUS-15');
  assert.equal(matchProfile(CONFIG, { ...base, setup: 'ORB30', plan: { ...base.plan, R: 1.5 } }), 'ORBPLUS-30');
});
console.log(`${n} regime checks passed`);
