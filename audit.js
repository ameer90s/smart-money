// After the close: replay today's recommendations, every fired signal (accepted or not)
// and watchlist entries on consolidated (SIP) bars, then feed the outcomes to the model.
import { alpaca } from './alpaca.js';
import { isoNy, nyToUtc, hmToMin } from './clock.js';
import { DayCollection, readJSON, writeJSON, dayRel } from './store.js';
import { simulate } from './simulate.js';
import { ms } from './indicators.js';
import * as model from './model.js';
import { log, warn } from './log.js';

const STRUCTURAL = new Set(['stop', 'spread', 'ext']);

export async function auditDay(day, cfg) {
  const signals = new DayCollection(day, 'signals');
  const recs = new DayCollection(day, 'recs');
  const watch = readJSON(dayRel(day, 'watch.json'), []);
  const syms = [...new Set([...signals.all().map((s) => s.sym), ...recs.all().map((r) => r.sym), ...watch.map((w) => w.sym)])];
  if (!syms.length) return { n: 0 };
  let bars;
  try {
    bars = await alpaca.bars(syms, { timeframe: '1Min', start: isoNy(day, '04:00'), end: isoNy(day, '16:00'), feed: 'sip' });
  } catch (e) { warn('audit bars', e); return { n: 0, error: String(e.message || e) }; }
  const flatMs = nyToUtc(day, cfg.flatAt);
  let n = 0;

  for (const s of signals.all()) {
    const b = bars[s.sym] || [];
    const sim = simulate(b, s.firedAt, s.plan, { flatMs, timeStopMin: cfg.timeStopMin });
    s.sim = sim;
    signals.upsert(s);
    const structuralFail = (s.plan.fails || []).some((f) => STRUCTURAL.has(f));
    if (!structuralFail && !s.sampled) {
      model.addSample({ setup: s.setup, mfe: sim.mfe, score: model.scoreBucket(s.score || 0), tod: model.todBucket(s.minAfterOpen || 60), regime: s.regime, src: 'live', day, sym: s.sym });
      s.sampled = true;
    }
    n++;
  }
  for (const r of recs.all()) {
    const b = bars[r.sym] || [];
    const sim = simulate(b, r.firedAt, r.plan, { flatMs, timeStopMin: cfg.timeStopMin });
    r.sip = sim;
    if (!r.calibrated) { model.addCalib(r.plan.targets[0].prob, sim.t1); r.calibrated = true; }
    recs.upsert(r);
  }
  for (const w of watch) {
    const b = (bars[w.sym] || []).filter((x) => ms(x.t) >= w.t && ms(x.t) < flatMs);
    if (!b.length) continue;
    const p0 = b[0].o;
    w.after = { maxUp: +((Math.max(...b.map((x) => x.h)) / p0 - 1) * 100).toFixed(2), maxDown: +((Math.min(...b.map((x) => x.l)) / p0 - 1) * 100).toFixed(2), close: +((b[b.length - 1].c / p0 - 1) * 100).toFixed(2) };
  }
  writeJSON(dayRel(day, 'watch.json'), watch);
  signals.flush(); recs.flush();
  model.markTrained(); model.save();
  log(`audit ${day}: ${n} signals, ${recs.all().length} recs`);
  return { n, recs: recs.all().length };
}

export { hmToMin };
