// Historical replay that seeds the probability model before (and alongside) live data:
// for each of the last N sessions, the day's biggest Shariah-compliant movers are replayed
// minute by minute through the same detectors, planner and management rules.
import { alpaca } from './alpaca.js';
import { isoNy, nyToUtc, addDays } from './clock.js';
import { buildCtx, detect } from './setups.js';
import { plan as makePlan } from './planner.js';
import { simulate } from './simulate.js';
import { vwapSeries, atr, ms } from './indicators.js';
import { statusOf, loadCache } from './shariah.js';
import * as model from './model.js';
import { log, warn } from './log.js';

const STRUCTURAL = new Set(['stop', 'spread', 'ext']);

function regimeAt(spy, t, openMs) {
  const rth = spy.filter((b) => ms(b.t) >= openMs && ms(b.t) <= t);
  if (rth.length < 2) return 'flat';
  const vw = vwapSeries(rth);
  const p = rth[rth.length - 1].c, o = rth[0].o;
  const chg = (p / o - 1) * 100;
  if (p > vw[vw.length - 1] && chg > 0.2) return 'up';
  if (p < vw[vw.length - 1] && chg < -0.3) return 'down';
  return 'flat';
}

export function replaySymbol({ sym, day, bars, spy, cfg, pdh, atrD }) {
  const openMs = nyToUtc(day, '09:30');
  const fromMs = nyToUtc(day, cfg.recFrom);
  const toMs = nyToUtc(day, cfg.recTo);
  const flatMs = nyToUtc(day, cfg.flatAt);
  const used = new Set();
  const out = [];
  const first = bars.findIndex((b) => ms(b.t) >= openMs);
  if (first < 0) return out;
  for (let i = first + 2; i < bars.length - 1; i++) {
    const t = ms(bars[i].t);
    if (t >= toMs) break;
    if (t < fromMs - 60000) continue;
    const ctx = buildCtx(bars.slice(0, i + 1), openMs, { pdh, atrD });
    for (const s of detect(ctx)) {
      if (used.has(s.type)) continue;
      const R0 = s.trigger - s.stopStruct;
      for (let j = i + 1; j <= Math.min(i + 3, bars.length - 1); j++) {
        const b = bars[j];
        if (b.h < s.trigger) continue;
        if (b.o > s.trigger + 0.25 * R0) break; // gapped through the trigger: not a fill we'd chase
        used.add(s.type);
        const regime = regimeAt(spy, ms(b.t), openMs);
        const p = makePlan(s, ctx, { spread: Math.max(0.01, 0.0003 * s.trigger) }, cfg, { score: 70, regime });
        if (p.fails.some((f) => STRUCTURAL.has(f))) break;
        const sim = simulate(bars, ms(b.t), p, { flatMs, timeStopMin: cfg.timeStopMin });
        out.push({ setup: s.type, mfe: sim.mfe, score: 'mid', tod: model.todBucket(ctx.minAfterOpen), regime, src: 'backtest', day, sym, r: sim.r });
        break;
      }
    }
  }
  return out;
}

export async function bootstrap(universe, cfg, { days = 20, perDay = 12, budgetMs = 20 * 60000 } = {}) {
  const t0 = Date.now();
  loadCache();
  const mv = (universe && universe.movers) || {};
  const dayList = Object.keys(mv).sort().slice(-days);
  let total = 0;
  for (const day of dayList) {
    if (Date.now() - t0 > budgetMs) break;
    const syms = mv[day].filter((s) => statusOf(s) === 'ok').slice(0, perDay);
    if (!syms.length) continue;
    try {
      const bars = await alpaca.bars([...syms, 'SPY'], { timeframe: '1Min', start: isoNy(day, '04:00'), end: isoNy(day, '16:00'), feed: 'sip' });
      const daily = await alpaca.bars(syms, { timeframe: '1Day', start: isoNy(addDays(day, -30), '00:00'), end: isoNy(addDays(day, -1), '20:00'), feed: 'sip' });
      for (const sym of syms) {
        const d = daily[sym] || [];
        const pdh = d.length ? d[d.length - 1].h : null;
        const atrD = d.length > 5 ? atr(d.slice(-15), 14) : null;
        const res = replaySymbol({ sym, day, bars: bars[sym] || [], spy: bars.SPY || [], cfg, pdh, atrD });
        for (const s of res) model.addSample(s);
        total += res.length;
      }
    } catch (e) { warn(`backtest ${day}`, e); }
  }
  model.markTrained();
  model.save();
  log(`backtest: ${total} historical signals from ${dayList.length} sessions in ${Math.round((Date.now() - t0) / 1000)}s`);
  return total;
}
