// Historical replay that seeds the probability model before (and alongside) live data.
//
// Walk-forward, no hindsight: for each past session, every Shariah-compliant liquid stock is
// scored every 5 minutes using only the minutes that had already closed, the watchlist is
// simulated with the live rules (enter/exit scores, dwell, size cap, replacement), and setups
// are detected only while a stock is on it — through the same detectors, planner and trade
// management as live. Stocks that started strong and then faded are therefore included, just
// as they are in a real session. (An earlier version replayed only the day's eventual big
// movers, which made the hit rates look better than reality.)
import { alpaca } from './alpaca.js';
import { isoNy, nyToUtc, addDays, ny, hmToMin, minToHm } from './clock.js';
import { buildCtx, detect } from './setups.js';
import { plan as makePlan } from './planner.js';
import { simulate } from './simulate.js';
import { atr, mean, ms, volumeShare } from './indicators.js';
import { recordOf, loadCache } from './shariah.js';
import { tradable } from './universe.js';
import { estSpread, SECTOR_ETFS } from './market.js';
import { score as scoreOf } from './scanner.js';
import * as model from './model.js';
import { log, warn } from './log.js';

const STRUCTURAL = new Set(['stop', 'spread', 'ext']);
const SCAN_STEP_MIN = 5;
const TOP_N = 40;      // the live scan hands its top 40 rows to the watchlist
const NEWS_ADJ = 4;    // no historical news flag (live adds up to 8 points): enter a little lower
const CHUNK = 100;

// Context known before the session from daily bars strictly before `day`.
export function dailyContext(daily, day) {
  const prev = (daily || []).filter((b) => b.t.slice(0, 10) < day);
  if (prev.length < 5) return null;
  const last = prev[prev.length - 1];
  return { pc: last.c, pdh: last.h, atrD: atr(prev.slice(-15), 14), avgVol: mean(prev.slice(-20).map((b) => b.v)) };
}

// Live-style scan features and score for one stock at each scan time, from closed minutes only.
export function scoreSeries(bars, dc, openMs, scanTimes, sectorRelAt = () => 0) {
  const out = [];
  let i = 0, cumV = 0, cumPV = 0, hi = -Infinity, lo = Infinity, open = null, last = null;
  for (const T of scanTimes) {
    while (i < bars.length && ms(bars[i].t) + 60000 <= T) {
      const b = bars[i++];
      if (ms(b.t) < openMs) continue;
      if (open == null) open = b.o;
      cumV += b.v; cumPV += (b.vw || (b.h + b.l + b.c) / 3) * b.v;
      hi = Math.max(hi, b.h); lo = Math.min(lo, b.l); last = b;
    }
    if (!last || !dc) { out.push(null); continue; }
    const minAfterOpen = (T - openMs) / 60000;
    const price = last.c;
    const expected = dc.avgVol * volumeShare(Math.max(1, minAfterOpen));
    const range = hi - lo;
    const vw = cumV > 0 ? cumPV / cumV : price;
    const perMin = cumV / Math.max(1, minAfterOpen);
    const f = {
      price, chg: (price / dc.pc - 1) * 100, gap: (open / dc.pc - 1) * 100,
      rvol: expected > 0 ? cumV / expected : null,
      rangeAtr: dc.atrD ? range / dc.atrD : 0,
      aboveVw: price > vw,
      posInRange: range > 0 ? (price - lo) / range : 0.5,
      accel: perMin > 0 ? last.v / perMin : null,
    };
    f.score = scoreOf(f, { news: false, sectorRel: sectorRelAt(T) });
    out.push(f);
  }
  return out;
}

// The live watchlist rules over the scan series. Returns { sym: [[fromMs, toMs], ...] }.
export function simulateWatch(series, scanTimes, cfg, endMs) {
  const enter = cfg.watchEnter - NEWS_ADJ;
  const W = new Map();
  const win = {};
  const close = (sym, T) => { const w = win[sym]; w[w.length - 1][1] = T; W.delete(sym); };
  scanTimes.forEach((T, k) => {
    const rows = [];
    for (const [sym, s] of Object.entries(series)) { const f = s[k]; if (f) rows.push({ sym, ...f }); }
    rows.sort((a, b) => b.score - a.score);
    const cands = rows.slice(0, TOP_N).filter((r) => r.price >= cfg.minPrice && r.price <= cfg.maxPrice && r.chg > 0);
    const byS = Object.fromEntries(cands.map((c) => [c.sym, c]));
    for (const [sym, it] of [...W]) {
      if (byS[sym]) it.score = byS[sym].score; // like live: a name that drops out of the top keeps its last score
      if ((T - it.since) / 60000 >= cfg.watchMinDwellMin && it.score < cfg.watchExit) close(sym, T);
    }
    for (const c of cands) {
      if (W.has(c.sym) || c.score < enter) continue;
      if (W.size >= cfg.watchMax) {
        const weakest = [...W].sort((a, b) => a[1].score - b[1].score)[0];
        if (!weakest || weakest[1].score >= c.score - 5) continue;
        close(weakest[0], T);
      }
      W.set(c.sym, { since: T, score: c.score });
      (win[c.sym] = win[c.sym] || []).push([T, endMs]);
    }
  });
  return win;
}

// Regime as the live engine sees it: SPY against its previous close and its VWAP.
function regimeAt(spy, spyPc, t, openMs) {
  let cumV = 0, cumPV = 0, p = null;
  for (const b of spy) {
    const bt = ms(b.t);
    if (bt < openMs) continue;
    if (bt + 60000 > t) break;
    cumV += b.v; cumPV += (b.vw || b.c) * b.v; p = b.c;
  }
  if (p == null || !spyPc || !cumV) return 'flat';
  const vw = cumPV / cumV, chg = (p / spyPc - 1) * 100;
  if (p > vw && chg > 0.2) return 'up';
  if (p < vw && chg < -0.3) return 'down';
  return 'flat';
}

// Setups for one watched stock, only inside its watch windows; each setup type once per day.
export function replayWatched({ sym, day, bars, spy, spyPc, cfg, dc, adv, windows, scoreAt, sess }) {
  const openMs = nyToUtc(day, sess.open);
  const toMs = nyToUtc(day, minToHm(Math.min(hmToMin(cfg.recTo), hmToMin(sess.close) - 30)));
  const flatMs = Math.min(nyToUtc(day, cfg.flatAt), nyToUtc(day, sess.close) - 5 * 60000);
  const fromMs = nyToUtc(day, cfg.recFrom);
  const inWin = (t) => windows.some(([a, b]) => t >= a && t < b);
  const used = new Set();
  const out = [];
  const first = bars.findIndex((b) => ms(b.t) >= openMs);
  if (first < 0) return out;
  for (let i = first + 2; i < bars.length - 1; i++) {
    const t = ms(bars[i].t);
    if (t >= toMs) break;
    if (t + 60000 < fromMs || !inWin(t + 60000)) continue;
    const ctx = buildCtx(bars.slice(0, i + 1), openMs, { pdh: dc.pdh, atrD: dc.atrD });
    for (const s of detect(ctx)) {
      if (used.has(s.type)) continue;
      const R0 = s.trigger - s.stopStruct;
      for (let j = i + 1; j <= Math.min(i + 3, bars.length - 1); j++) {
        const b = bars[j];
        if (b.h < s.trigger) continue;
        if (b.o > s.trigger + 0.25 * R0) break; // gapped through the trigger: not a fill we'd chase
        used.add(s.type);
        const at = ms(b.t);
        const regime = regimeAt(spy, spyPc, at, openMs);
        const sc = scoreAt(at);
        const p = makePlan(s, ctx, { spread: estSpread(s.trigger, adv) }, cfg, { score: sc, regime });
        if (p.fails.some((f) => STRUCTURAL.has(f))) break;
        const sim = simulate(bars, at, p, { flatMs, timeStopMin: cfg.timeStopMin });
        out.push({ setup: s.type, mfe: sim.mfe, score: model.scoreBucket(sc), tod: model.todBucket(ctx.minAfterOpen), regime, src: 'replay', day, sym, r: sim.r });
        break;
      }
    }
  }
  return out;
}

async function replayDay(sess, ctx) {
  const { syms, daily, advOf, cfg } = ctx;
  const day = sess.date;
  const openMs = nyToUtc(day, sess.open);
  const endMs = Math.min(nyToUtc(day, cfg.flatAt), nyToUtc(day, sess.close) - 5 * 60000);
  const scanTimes = [];
  for (let T = nyToUtc(day, cfg.recFrom); T <= nyToUtc(day, minToHm(Math.min(hmToMin(cfg.recTo), hmToMin(sess.close) - 30))); T += SCAN_STEP_MIN * 60000) scanTimes.push(T);
  const rthStart = isoNy(day, sess.open), rthEnd = isoNy(day, sess.close);

  // Market and sector funds: regime and sector strength relative to SPY at each moment.
  const mk = await alpaca.bars(['SPY', ...SECTOR_ETFS], { timeframe: '1Min', start: rthStart, end: rthEnd, feed: 'sip' });
  const spy = mk.SPY || [];
  const pcOf = (s) => { const d = dailyContext(daily[s], day); return d ? d.pc : null; };
  const spyPc = pcOf('SPY');
  const chgAt = (bars, pc, T) => { let p = null; for (const b of bars) { if (ms(b.t) + 60000 > T) break; p = b.c; } return p && pc ? (p / pc - 1) * 100 : 0; };
  const relCache = {};
  const sectorRelAt = (etf) => (T) => {
    const k = `${etf}|${T}`;
    if (!(k in relCache)) relCache[k] = etf && mk[etf] ? chgAt(mk[etf], pcOf(etf), T) - chgAt(spy, spyPc, T) : 0;
    return relCache[k];
  };

  // Score every stock through the day; keep minute bars only for names that could make the list.
  const series = {}, keep = {}, dcs = {};
  const enter = cfg.watchEnter - NEWS_ADJ;
  for (let i = 0; i < syms.length; i += CHUNK) {
    const part = syms.slice(i, i + CHUNK);
    const bars = await alpaca.bars(part, { timeframe: '1Min', start: rthStart, end: rthEnd, feed: 'sip' });
    for (const s of part) {
      const dc = dailyContext(daily[s], day);
      if (!dc || !bars[s] || !bars[s].length) continue;
      const rec = recordOf(s);
      const ser = scoreSeries(bars[s], dc, openMs, scanTimes, sectorRelAt(rec && rec.sector !== 'SPY' ? rec.sector : null));
      series[s] = ser; dcs[s] = dc;
      if (ser.some((f) => f && f.score >= enter)) keep[s] = bars[s];
    }
  }
  const windows = simulateWatch(series, scanTimes, cfg, endMs);
  const watched = Object.keys(windows).filter((s) => keep[s]);
  if (!watched.length) return { samples: 0, watched: 0 };

  // Pre-market minutes for the watched names (for the pre-market-high setup).
  let pm = {};
  try { pm = await alpaca.bars(watched, { timeframe: '1Min', start: isoNy(day, '04:00'), end: new Date(openMs - 60000).toISOString(), feed: 'sip' }); }
  catch (e) { warn(`replay premarket ${day}`, e); }
  let added = 0;
  for (const s of watched) {
    const bars = [...(pm[s] || []), ...keep[s]];
    const ser = series[s];
    const scoreAt = (t) => { let sc = 0; scanTimes.forEach((T, k) => { if (T <= t && ser[k]) sc = ser[k].score; }); return sc; };
    const res = replayWatched({ sym: s, day, bars, spy, spyPc, cfg, dc: dcs[s], adv: advOf[s], windows: windows[s], scoreAt, sess });
    for (const x of res) if (model.addSample(x)) added++;
  }
  return { samples: added, watched: watched.length };
}

export async function bootstrap(universe, cfg, { days = 45, budgetMs = 50 * 60000, minReplay = 100 } = {}) {
  const t0 = Date.now();
  loadCache();
  const list = tradable(universe, false);
  const syms = list.map((x) => x.s);
  const advOf = Object.fromEntries(list.map((x) => [x.s, x.adv]));
  const today = ny().ymd;
  let cal = [];
  try { cal = await alpaca.calendar(addDays(today, -Math.ceil(days * 1.6) - 7), addDays(today, -1)); } catch (e) { warn('replay calendar', e); }
  const sessions = cal.filter((c) => c.date < today).slice(-days).reverse(); // newest first
  const todo = sessions.filter((c) => !model.wasReplayed(c.date, '*'));
  let total = 0, done = 0;
  if (todo.length && syms.length) {
    const oldest = todo[todo.length - 1].date;
    let daily = {};
    try { daily = await alpaca.bars([...syms, 'SPY', ...SECTOR_ETFS], { timeframe: '1Day', start: isoNy(addDays(oldest, -45), '00:00'), end: isoNy(todo[0].date, '20:00'), feed: 'sip' }); }
    catch (e) { warn('replay daily', e); }
    for (const sess of todo) {
      if (Date.now() - t0 > budgetMs) break;
      try {
        const r = await replayDay(sess, { syms, daily, advOf, cfg });
        total += r.samples; done++;
        model.markReplayed(sess.date, '*');
        log(`replay ${sess.date}: ${r.watched} watched, ${r.samples} signals`);
      } catch (e) { warn(`replay ${sess.date}`, e); }
    }
  }
  // Once the walk-forward replay has enough cases, retire the earlier hindsight-selected ones.
  const nReplay = model.load().samples.filter((s) => s.src === 'replay').length;
  if (nReplay >= minReplay) { const dropped = model.dropSource('backtest'); if (dropped) log(`retired ${dropped} hindsight-selected backtest samples`); }
  model.markTrained();
  model.save();
  log(`replay: ${total} new signals from ${done} sessions (${sessions.length - todo.length} already done) in ${Math.round((Date.now() - t0) / 1000)}s; model has ${model.load().samples.length}`);
  return total;
}
