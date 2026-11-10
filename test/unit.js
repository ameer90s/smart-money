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
import { estSpread, effectiveSpread } from '../engine/market.js';
import { matchProfile, profileSim } from '../engine/profiles.js';
import { Watchlist } from '../engine/watchlist.js';
import { marketState, stateTimeline } from '../engine/regime.js';
import { pathOf } from '../engine/audit.js';

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

t('dip plan: stop at least 1 ATR, one target at 1.5R, sell everything there', () => {
  const ctx = buildCtx(bars, open, { pdh: 21, atrD: 1 });
  const setup = { type: 'DIP', label: 'dip', trigger: ctx.last.h + 0.01, stopStruct: ctx.last.h - 0.02, ext: -2 };
  const p = plan(setup, ctx, { spread: 0.01 }, DEFAULTS, { score: 60, regime: 'down' });
  assert.equal(p.exit, 'full');
  assert.ok(p.R >= ctx.a5 - 0.001, 'stop floor 1 ATR (plan values are rounded)');
  assert.ok(Math.abs(p.targets[0].r - 1.5) < 0.01);
  const b0 = Date.parse('2026-11-02T15:00:00Z');
  const pl = { entry: 10, stop: 9.8, R: 0.2, exit: 'full', targets: [{ price: 10.3 }, { price: 10.4 }, { price: 10.6 }] };
  const up = [[10, 10.1, 9.95, 10.05], [10.05, 10.31, 10.0, 10.3], [10.3, 10.7, 10.2, 10.6]].map(([o, h, l, c], i) => ({ t: new Date(b0 + i * 60000).toISOString(), o, h, l, c, v: 1 }));
  const r = simulate(up, b0, pl, {});
  assert.equal(r.reason, 't1'); assert.ok(Math.abs(r.r - 1.5) < 1e-9);
  const flat = Array.from({ length: 70 }, (_, i) => ({ t: new Date(b0 + i * 60000).toISOString(), o: 10.05, h: 10.1, l: 9.9, c: 10.05, v: 1 }));
  const r2 = simulate(flat, b0, pl, { timeStopMin: 60 });
  assert.equal(r2.reason, 'timestop'); assert.ok(Math.abs(r2.r - 0.25) < 1e-9);
});

t('pattern profiles: match only their own setting, replay their own exit', () => {
  const plan = { fails: [], ext: 0.8, entry: 10, stop: 9.8, R: 0.2, atr5: 0.3, exit: 'scale', targets: [{ price: 10.3 }, { price: 10.5 }, { price: 10.8 }] };
  assert.equal(matchProfile(DEFAULTS, { setup: 'VWAP', plan, minAfterOpen: 45, feats: { rvol: 1.5, chg: 3 }, regime: 'up' }), 'VWAP-a');
  assert.equal(matchProfile(DEFAULTS, { setup: 'VWAP', plan, minAfterOpen: 45, feats: { rvol: 1.5, chg: 3 }, regime: 'flat' }), null, 'needs an up market');
  assert.equal(matchProfile(DEFAULTS, { setup: 'VWAP', plan: { ...plan, fails: ['spread'] }, minAfterOpen: 45, feats: { rvol: 1.5 }, regime: 'up' }), null, 'structural fail');
  assert.equal(matchProfile(DEFAULTS, { setup: 'ORB15', plan: { ...plan, ext: 0.3 }, minAfterOpen: 20, feats: { chg: 6 }, regime: 'down' }), 'ORB15-a');
  const b0 = Date.parse('2026-11-02T15:00:00Z');
  const up = Array.from({ length: 10 }, (_, i) => ({ t: new Date(b0 + i * 60000).toISOString(), o: 10 + i * 0.1, h: 10.1 + i * 0.1, l: 9.95 + i * 0.1, c: 10.05 + i * 0.1, v: 1 }));
  const ema = DEFAULTS.profiles.find((p) => p.id === 'EMA-a');
  const r = profileSim(up, b0, plan, ema, { timeStopMin: 60 });
  assert.equal(r.reason, 't1'); assert.ok(Math.abs(r.r - 2) < 1e-9, 'EMA-a: 2R target with a 1 ATR stop');
});

t('dip fires like the lab: first touch within 3 minutes, never above trigger + 0.25R', () => {
  const ev = [], sig = [];
  const wl = new Watchlist({ cfg: DEFAULTS, stream: { set() {} }, today: day, openMs: open, onSignal: (it, s) => sig.push(s.trigger), onEvent: (k, e) => ev.push([k, e.outcome || '']) });
  const t0 = Date.now();
  const mk = (trigger) => ({ s: { type: 'DIP', trigger, stopStruct: trigger - 0.2 }, at: t0, until: t0 + 180000 });
  const it = { sym: 'X', fired: new Set(), pend: [mk(10)], armed: [], cross: {} };
  wl.checkTouch(it, 9.99, t0 + 10000);
  assert.equal(sig.length, 0, 'below trigger: wait');
  wl.checkTouch(it, 10.02, t0 + 20000);
  assert.deepEqual(sig, [10], 'fires on the first touch, no 20-second hold');
  const it2 = { sym: 'Y', fired: new Set(), pend: [mk(20)], armed: [], cross: {} };
  wl.checkTouch(it2, 20.2, t0 + 5000);
  const it3 = { sym: 'Z', fired: new Set(), pend: [mk(30)], armed: [], cross: {} };
  wl.checkTouch(it3, null, t0 + 181000);
  assert.deepEqual(ev.map((x) => x[1]), ['fired', 'gapped', 'expired']);
  assert.equal(sig.length, 1);
});

t('spread: liquidity estimate caps a wide IEX quote, a tight quote wins', () => {
  assert.equal(estSpread(315.8, 300e6), 0.1);       // 3 bps, rounded up to the cent
  assert.equal(effectiveSpread(315.8, 5.17, 300e6), 0.1); // the FDX case from 30 Oct
  assert.equal(effectiveSpread(84, 0.01, 300e6), 0.01);
  assert.equal(effectiveSpread(25.76, null, 20e6), 0.03);
  assert.equal(estSpread(5, 1e9), 0.01);            // never below one cent
});

// ---- market state (trend / sideways / choppy) from synthetic SPY minutes ----
const spyDay = '2026-11-03';
const spyOpen = nyToUtc(spyDay, '09:30');
const mkSpy = (f, n = 120, base = 500) => Array.from({ length: n }, (_, i) => {
  const c = f(i, base), o = i ? f(i - 1, base) : base;
  return { t: new Date(spyOpen + i * 60000).toISOString(), o, h: Math.max(o, c) + 0.05, l: Math.min(o, c) - 0.05, c, v: 1000, vw: c };
});
const at = (n) => spyOpen + n * 60000 + 60000;
t('market state: straight climb is a trend up, straight drop a trend down', () => {
  assert.equal(marketState(mkSpy((i, b) => b + i * 0.05), 500, at(120), spyOpen).state, 'trendUp');
  assert.equal(marketState(mkSpy((i, b) => b - i * 0.05), 500, at(120), spyOpen).state, 'trendDown');
});
t('market state: tiny wiggle around one level is sideways', () => {
  const m = marketState(mkSpy((i, b) => b + Math.sin(i / 3) * 0.05), 500, at(120), spyOpen);
  assert.equal(m.state, 'range');
  assert.ok(m.amp < 0.25);
});
t('market state: big swings back and forth across VWAP are choppy', () => {
  // vwap is the running mean of the closes, so a wide square wave crosses it again and again
  const bars = mkSpy((i, b) => b + (Math.floor(i / 8) % 2 ? 1.6 : -1.6), 120);
  let cum = 0; bars.forEach((x, i) => { cum += x.c; x.vw = cum / (i + 1); });
  const m = marketState(bars, 500, at(120), spyOpen);
  assert.equal(m.state, 'choppy', JSON.stringify(m));
  assert.ok(m.crosses >= 3 && m.amp >= 0.25);
});
t('market state: no state before 30 minutes, and no look-ahead', () => {
  const bars = mkSpy((i, b) => b + i * 0.05);
  assert.equal(marketState(bars, 500, at(20), spyOpen), null);
  const early = marketState(bars, 500, at(60), spyOpen);
  const sameWithFuture = marketState(bars.concat(mkSpy((i, b) => b - 50, 10).map((x, i) => ({ ...x, t: new Date(spyOpen + (120 + i) * 60000).toISOString() }))), 500, at(60), spyOpen);
  assert.deepEqual(early, sameWithFuture);
  assert.equal(marketState([], 500, at(60), spyOpen), null);
  assert.ok(stateTimeline(bars, 500, spyOpen, spyOpen + 120 * 60000).length >= 15);
});

// ---- watchlist outcome path ----
t('path: high and low times, first +/-2% touch and 5-minute closes', () => {
  const t0 = nyToUtc(spyDay, '10:00');
  const px = [100, 100.5, 101, 102.2, 101.5, 100.2, 98.5, 97.8, 98.5, 99, 99.5, 100];
  const b = px.map((c, i) => ({ t: new Date(t0 + i * 60000).toISOString(), o: i ? px[i - 1] : 100, h: c + 0.1, l: c - 0.1, c }));
  const r = pathOf(b, 100, t0);
  assert.equal(r.tHigh, 3);
  assert.equal(r.tLow, 7);
  assert.deepEqual(r.first2, { side: 'up', min: 3 });
  assert.deepEqual(r.first1, { side: 'up', min: 2 });
  assert.deepEqual(r.path, [+(((b[4].c / 100) - 1) * 100).toFixed(2), +(((b[9].c / 100) - 1) * 100).toFixed(2)]);
});

console.log(`\n${n} unit checks passed`);
