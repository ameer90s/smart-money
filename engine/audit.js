// After the close: replay today's recommendations, every fired signal (accepted or not)
// and watchlist entries on consolidated (SIP) bars, then feed the outcomes to the model.
import { alpaca } from './alpaca.js';
import { isoNy, nyToUtc, hmToMin } from './clock.js';
import { DayCollection, readJSON, writeJSON, dayRel } from './store.js';
import { simulate } from './simulate.js';
import { profileSim, recordProfiles } from './profiles.js';
import { ms } from './indicators.js';
import { stateTimeline } from './regime.js';
import * as model from './model.js';
import { log, warn } from './log.js';

const STRUCTURAL = new Set(['stop', 'spread', 'ext']);

// Where the watched stock went after it entered the watchlist: when its high and low came, which
// of +/-1% and +/-2% it touched first, and a 5-minute path (close vs the starting price, in %).
export function pathOf(b, p0, t0) {
  let hi = -Infinity, lo = Infinity, iHi = 0, iLo = 0;
  b.forEach((x, i) => { if (x.h > hi) { hi = x.h; iHi = i; } if (x.l < lo) { lo = x.l; iLo = i; } });
  const mins = (i) => Math.round((ms(b[i].t) - t0) / 60000);
  const first = (pct) => {
    const up = p0 * (1 + pct / 100), dn = p0 * (1 - pct / 100);
    for (let i = 0; i < b.length; i++) {
      const u = b[i].h >= up, d = b[i].l <= dn;
      if (u && d) return { side: 'both', min: mins(i) }; // same minute: order unknown
      if (u) return { side: 'up', min: mins(i) };
      if (d) return { side: 'down', min: mins(i) };
    }
    return null;
  };
  const path = [];
  for (let i = 4; i < b.length; i += 5) path.push(+((b[i].c / p0 - 1) * 100).toFixed(2));
  return { tHigh: mins(iHi), tLow: mins(iLo), first1: first(1), first2: first(2), path };
}

const addDaysYmd = (ymd, n) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);


export async function auditDay(day, cfg) {
  const signals = new DayCollection(day, 'signals');
  const recs = new DayCollection(day, 'recs');
  const watch = readJSON(dayRel(day, 'watch.json'), []);
  const syms = [...new Set([...signals.all().map((s) => s.sym), ...recs.all().map((r) => r.sym), ...watch.map((w) => w.sym)])];
  if (!syms.length) return { n: 0 };
  const needSpy = !syms.includes('SPY');
  if (needSpy) syms.push('SPY'); // for the day's market-state timeline
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
    if (s.profile) { const prof = (cfg.profiles || []).find((p) => p.id === s.profile); if (prof) s.profileSim = profileSim(b, s.firedAt, s.plan, prof, { flatMs, timeStopMin: cfg.timeStopMin }); }
    signals.upsert(s);
    const structuralFail = (s.plan.fails || []).some((f) => STRUCTURAL.has(f));
    if (!structuralFail && !s.sampled) {
      model.addSample({ setup: s.setup, mfe: sim.mfe, r: sim.r, score: model.scoreBucket(s.score || 0), tod: model.todBucket(s.minAfterOpen || 60), regime: s.regime, state: s.state || null, src: 'live', day, sym: s.sym });
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
    w.after = { maxUp: +((Math.max(...b.map((x) => x.h)) / p0 - 1) * 100).toFixed(2), maxDown: +((Math.min(...b.map((x) => x.l)) / p0 - 1) * 100).toFixed(2), close: +((b[b.length - 1].c / p0 - 1) * 100).toFixed(2), ...pathOf(b, p0, w.t) };
  }
  // The day's market-state timeline (every 5 minutes), from SPY.
  try {
    const spy = bars.SPY || [];
    const dailySpy = await alpaca.bars(['SPY'], { timeframe: '1Day', start: isoNy(addDaysYmd(day, -7), '00:00'), end: isoNy(day, '00:00'), feed: 'sip' });
    const last = (dailySpy.SPY || []).filter((x) => x.t.slice(0, 10) < day).pop();
    if (spy.length && last) writeJSON(dayRel(day, 'state.json'), stateTimeline(spy, last.c, nyToUtc(day, '09:30'), flatMs));
  } catch (e) { warn('audit state', e); }
  writeJSON(dayRel(day, 'watch.json'), watch);
  signals.flush(); recs.flush();
  const nProf = recordProfiles(cfg, signals.all());
  if (nProf) log(`profiles: ${nProf} new tracked signals`);
  model.markTrained(); model.save();
  log(`audit ${day}: ${n} signals, ${recs.all().length} recs`);
  return { n, recs: recs.all().length };
}

export { hmToMin };
