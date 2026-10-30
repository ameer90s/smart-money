// Unit checks for the pure parts: clock, setups, planner, simulation, Shariah screen, settings.
import assert from 'node:assert/strict';
import { nyToUtc, ny, fallbackSession, addDays } from '../engine/clock.js';
import { buildCtx, detect } from '../engine/setups.js';
import { plan } from '../engine/planner.js';
import { simulate } from '../engine/simulate.js';
import { evaluate, sectorOf } from '../engine/shariah.js';
import { sanitize } from '../engine/live.js';
import { volumeShare, aggregate } from '../engine/indicators.js';
import { isCommonStock } from '../engine/universe.js';
import { DEFAULTS } from '../engine/config.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`PASS  ${name}`); };

t('NY clock handles DST', () => {
  assert.equal(new Date(nyToUtc('2026-07-01', '09:30')).toISOString(), '2026-07-01T13:30:00.000Z');
  assert.equal(new Date(nyToUtc('2026-11-02', '09:30')).toISOString(), '2026-11-02T14:30:00.000Z');
  assert.equal(ny(Date.parse('2026-11-02T14:30:00Z')).hm, '09:30');
  assert.equal(fallbackSession('2026-11-26'), null);
  assert.equal(fallbackSession('2026-11-27').close, '13:00');
  assert.equal(addDays('2026-10-30', 3), '2026-11-02');
});

// Synthetic opening-range breakout day.
const day = '2026-11-02';
const open = nyToUtc(day, '09:30');
const mk = (i, o, h, l, c, v = 10000) => ({ t: new Date(open + i * 60000).toISOString(), o, h, l, c, v, vw: (h + l + c) / 3 });
const bars = [];
for (let i = 0; i < 15; i++) { const base = 20 + (i % 3) * 0.1; bars.push(mk(i, base, base + 0.2, base - 0.1, base + 0.05, 20000)); }
for (let i = 15; i < 18; i++) { const base = 20.15 + (i - 15) * 0.03; bars.push(mk(i, base, base + 0.05, base - 0.03, base + 0.04, 12000)); }

t('ORB15 armed below the 15-minute high', () => {
  const ctx = buildCtx(bars, open, { pdh: 21, atrD: 1 });
  const s = detect(ctx);
  const orb = s.find((x) => x.type === 'ORB15');
  assert.ok(orb, 'ORB15 detected');
  assert.ok(Math.abs(orb.trigger - (ctx.orb15.h + 0.01)) < 1e-9);
  assert.ok(orb.stopStruct < orb.trigger);
});

t('planner: stop clamped, targets ascending, costs and probabilities', () => {
  const ctx = buildCtx(bars, open, { pdh: 21, atrD: 1 });
  const s = detect(ctx).find((x) => x.type === 'ORB15');
  const p = plan(s, ctx, { spread: 0.01 }, DEFAULTS, { score: 70, regime: 'flat' });
  assert.ok(p.stop < p.entry);
  assert.ok(p.R >= DEFAULTS.stopAtrMin * ctx.a5 - 1e-9);
  assert.ok(p.targets[0].price < p.targets[1].price && p.targets[1].price < p.targets[2].price);
  assert.ok(p.targets.every((x) => x.prob > 0 && x.prob < 1));
  assert.ok(p.targets[0].netR >= 0);
  assert.equal(p.sizing.fees, 2);
  assert.ok(p.sizing.cost <= DEFAULTS.capital);
  // With an empty model the no-edge prior keeps target 1 under the 45% threshold: no rec.
  assert.ok(p.fails.includes('prob'));
});

t('simulate: target 1 then break-even stop', () => {
  const pl = { entry: 10, stop: 9.8, R: 0.2, targets: [{ price: 10.3 }, { price: 10.6 }, { price: 11 }] };
  const b0 = Date.parse('2026-11-02T15:00:00Z');
  const seq = [[10, 10.1, 9.95, 10.05], [10.05, 10.35, 10.0, 10.3], [10.3, 10.32, 9.99, 10.0]];
  const bs = seq.map(([o, h, l, c], i) => ({ t: new Date(b0 + i * 60000).toISOString(), o, h, l, c, v: 1 }));
  const r = simulate(bs, b0, pl, {});
  assert.equal(r.t1, true);
  assert.equal(r.reason, 'be');
  assert.ok(Math.abs(r.r - 0.75) < 1e-9); // half at +1.5R, half at 0
});

t('simulate: stop first when a bar touches both', () => {
  const pl = { entry: 10, stop: 9.8, R: 0.2, targets: [{ price: 10.3 }, { price: 10.6 }, { price: 11 }] };
  const b0 = Date.parse('2026-11-02T15:00:00Z');
  const r = simulate([{ t: new Date(b0).toISOString(), o: 10, h: 10.4, l: 9.7, c: 10 }], b0, pl, {});
  assert.equal(r.reason, 'stop');
  assert.equal(r.r, -1);
});

t('Shariah screen: industry, debt and cash ratios', () => {
  assert.equal(evaluate({ finnhubIndustry: 'Banking', name: 'X Bancorp', shareOutstanding: 100 }, { metric: {} }).st, 'no');
  const ok = evaluate({ finnhubIndustry: 'Technology', name: 'Y Inc', shareOutstanding: 100 }, { metric: { marketCapitalization: 5000, 'totalDebt/totalEquityQuarterly': 0.2, bookValuePerShareQuarterly: 10, cashPerSharePerShareQuarterly: 3 } });
  assert.equal(ok.st, 'ok');
  const debt = evaluate({ finnhubIndustry: 'Technology', name: 'Z Inc', shareOutstanding: 100 }, { metric: { marketCapitalization: 1000, 'totalDebt/totalEquityQuarterly': 2, bookValuePerShareQuarterly: 5, cashPerSharePerShareQuarterly: 1 } });
  assert.equal(debt.st, 'no');
  assert.equal(evaluate({ finnhubIndustry: 'Beverages', name: 'B Inc', shareOutstanding: 100 }, { metric: { marketCapitalization: 5000, 'totalDebt/totalEquityQuarterly': 0.1, bookValuePerShareQuarterly: 10, cashPerSharePerShareQuarterly: 1 } }).st, 'doubt');
  assert.equal(sectorOf('Semiconductors'), 'XLK');
});

t('universe filter drops ETFs, leveraged and odd symbols', () => {
  assert.ok(isCommonStock({ symbol: 'NVDA', name: 'NVIDIA Corp', exchange: 'NASDAQ', tradable: true }));
  assert.ok(!isCommonStock({ symbol: 'SPY', name: 'SPDR S&P 500 ETF Trust', exchange: 'ARCA', tradable: true }));
  assert.ok(!isCommonStock({ symbol: 'NVDU', name: 'Direxion Daily NVDA Bull 2X Shares', exchange: 'NASDAQ', tradable: true }));
  assert.ok(!isCommonStock({ symbol: 'ABC.W', name: 'ABC Warrant', exchange: 'NYSE', tradable: true }));
});

t('settings from the app are sanitized and clamped', () => {
  const s = sanitize({ capital: '5000', watchMax: 99, useNews: 0, evil: 'x', ntfyTopic: 'bad topic!' });
  assert.deepEqual(s, { capital: 5000, watchMax: 12, useNews: false });
});

t('intraday volume curve and 5-minute aggregation', () => {
  assert.equal(volumeShare(0), 0);
  assert.equal(volumeShare(390), 1);
  assert.ok(volumeShare(30) > 0.15 && volumeShare(30) < 0.2);
  const b5 = aggregate(bars, 5, open);
  assert.equal(b5.length, Math.ceil(bars.length / 5));
});

console.log(`\n${n} unit checks passed`);
