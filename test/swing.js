// Swing study on synthetic daily bars: structure, cost handling and a planted edge.
import assert from 'node:assert/strict';
import { swingStudy, HOLDS } from '../engine/swing.js';

let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const day = (i) => new Date(Date.UTC(2026, 0, 1) + i * 864e5).toISOString().slice(0, 10) + 'T05:00:00Z';
function series(plant) {
  const bars = []; let p = 20;
  for (let i = 0; i < 260; i++) {
    const brk = plant && i > 25 && i % 17 === 0; // volume spike + new high, then drift up
    const drift = plant && i > 26 && (i - 1) % 17 < 6 && (i - 1) % 17 >= 0 && Math.floor((i - 1) / 17) * 17 + 17 > i ? 0.012 : 0;
    const o = p * (1 + (rnd() - 0.5) * 0.004), c = o * (1 + (rnd() - 0.5) * 0.01 + (brk ? 0.05 : 0) + drift);
    bars.push({ t: day(i), o, h: Math.max(o, c) * 1.003, l: Math.min(o, c) * 0.997, c, v: brk ? 5e6 : 1e6 });
    p = c;
  }
  return bars;
}
let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`PASS  ${name}`); };
const noise = Object.fromEntries(Array.from({ length: 30 }, (_, k) => [`S${k}`, series(false)]));
const planted = Object.fromEntries(Array.from({ length: 30 }, (_, k) => [`P${k}`, series(true)]));

t('output has every rule and hold with train/test split', () => {
  const o = swingStudy(noise);
  assert.deepEqual(Object.keys(o.rules).sort(), ['base', 'brk20', 'gapup', 'pullback', 'strong20']);
  for (const r of Object.values(o.rules)) for (const H of HOLDS) { assert.ok(H in r); assert.ok(r[H].n >= 0 && r[H].trainN + r[H].testN === r[H].n); }
  assert.ok(o.symbols === 30 && o.split > o.dates[0]);
});
t('costs are charged: round trip fee plus spread', () => assert.equal(swingStudy(noise).cost, 0.25));
t('higher fees lower the net result', () => assert.ok(swingStudy(noise, { feePerSide: 5 }).rules.base[5].net < swingStudy(noise).rules.base[5].net));
t('baseline excess is zero by construction', () => { const b = swingStudy(noise).rules.base[5]; assert.equal(b.testExcess, 0); assert.equal(b.trainExcess, 0); });
t('a planted breakout drift is found as positive excess', () => { const o = swingStudy(planted); assert.ok(o.rules.brk20[3].net > o.rules.base[3].net, JSON.stringify(o.rules.brk20[3])); });
t('regime split and month consistency are reported when SPY is given', () => {
  const spy = series(false).map((b, i) => ({ ...b, c: 100 + (i < 130 ? i : 260 - i) }));
  const o = swingStudy(noise, { spy }), r = o.rules.brk20[5];
  assert.ok(o.regime && r.up && r.down);
  assert.equal(r.up.n + r.down.n <= r.n, true);
  assert.ok(o.rules.base[5].monthsTotal >= 1 && r.monthsBeat <= r.monthsTotal);
  assert.ok(r.testSe == null || r.testSe > 0);
  assert.equal(swingStudy(noise).regime, false);
});
t('news split compares stocks with and without a story the day before', () => {
  const o = swingStudy(noise, { newsAt: (sym, d) => (d.endsWith('5') || d.endsWith('0') ? 2 : 0) });
  assert.ok(o.news);
  const r = o.rules.base[3];
  assert.ok(r.withNews && r.noNews && r.withNews.n > 0 && r.noNews.n > 0);
  assert.equal(r.withNews.n + r.noNews.n, r.n);
  assert.equal(swingStudy(noise).news, false);
});
console.log(`${n} swing checks passed`);
