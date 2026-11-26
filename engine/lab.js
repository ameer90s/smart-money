// Strategy lab. Replays past sessions without hindsight (the same 5-minute scan and watchlist
// rules as live) and measures several entry and exit variants side by side, net of fees and
// spread, separately on older sessions (train) and the most recent ones (test). A variant is
// only worth adopting if it holds up on both. Writes lab/latest.json; never touches the model.
import { alpaca } from './alpaca.js';
import { swingStudy } from './swing.js';
import { downEvents, upEvents, rangeEvents } from './regimes.js';
import { sweepArms } from './sweepentry.js';
import { postStopArms, stopBarIndex } from './poststop.js';
import { fetchNewsHistory, newsCounts } from './newshist.js';
import { DYN_STOPS, DYN_TARGETS, DYN_CONFIRM } from './config.js';
import { isoNy, nyToUtc, addDays, ny, hmToMin, minToHm } from './clock.js';
import { buildCtx, detect } from './setups.js';
import { plan as makePlan } from './planner.js';
import { simulate } from './simulate.js';
import { ms, volumeShare } from './indicators.js';
import { recordOf, loadCache } from './shariah.js';
import { tradable } from './universe.js';
import { estSpread, SECTOR_ETFS } from './market.js';
import { dailyContext, scoreSeries, simulateWatch, regimeAt, stateAt } from './backtest.js';
import { scoreBucket, todBucket } from './model.js';
import { writeJSON } from './store.js';
import { log, warn } from './log.js';

const STRUCTURAL = new Set(['stop', 'spread', 'ext']);
const SCAN_STEP_MIN = 5;
const CHUNK = 100;
const IN_PLAY = 50; // a stock is kept for the day once its live score reaches this
const EXITS = { mgmt: null, r1: 1, r15: 1.5, r2: 2 };
// Grid for the dynamic stop/target search: stop distance in 5-minute ATRs x target in R multiples.

export const FAMILIES = {
  base: 'الأنماط الحالية كما هي',
  base10: 'الأنماط الحالية بعد 10:00',
  base10x: 'الأنماط الحالية بعد 10:00 وقريب من VWAP (≤ 1 ATR)',
  orb30: 'اختراق نطاق أول 30 دقيقة',
  vwappb: 'ارتداد من VWAP في سهم صاعد',
  dip: 'شراء الهبوط الحاد تحت VWAP بعد شمعة انعكاس',
  late: 'اختراق أعلى اليوم بعد 14:00',
  sweep: 'سحب السيولة ثم استرداد المستوى (أدنى أمس أو قاع أول 15/30 دقيقة)',
};
export const EXIT_AR = { mgmt: 'الإدارة الحالية (نصف عند الهدف 1 ووقف على الدخول)', r1: 'هدف 1R', r15: 'هدف 1.5R', r2: 'هدف 2R' };
export const FUNNEL_AR = { watch: 'وهو في قائمة المراقبة', inplay: 'من أول ما دخل القائمة لنهاية اليوم' };

// ---------- extra entry families (buy only) ----------
const S = (type, trigger, stopStruct, ctx) => ({ type, label: FAMILIES[type.toLowerCase()] || type, trigger: +trigger.toFixed(4), stopStruct: +stopStruct.toFixed(4), ext: (trigger - ctx.vwap) / ctx.a5 });

export function orb30(ctx) {
  if (ctx.minAfterOpen < 31) return null;
  const r = ctx.rth.slice(0, 30);
  if (r.length < 28) return null;
  const h = Math.max(...r.map((b) => b.h)), l = Math.min(...r.map((b) => b.l));
  if (ctx.rth.slice(30).some((b) => b.c > h)) return null; // first breakout only
  if (ctx.last.c < h - 0.6 * ctx.a5) return null;
  return S('ORB30', h + 0.01, Math.max((h + l) / 2, h - 1.5 * ctx.a5), ctx);
}

export function vwapPullback(ctx, dc) {
  if (ctx.minAfterOpen < 30 || !dc) return null;
  const { rth, vw, a5, last } = ctx;
  const n = rth.length;
  if (rth.filter((b, k) => b.c > vw[k]).length / n < 0.7) return null; // has held above VWAP
  if (last.c / dc.pc - 1 < 0.02) return null;
  const lows = rth.slice(-3).map((b) => b.l);
  if (Math.min(...lows) > vw[n - 1] + 0.3 * a5 || last.c <= vw[n - 1]) return null;
  if (!(last.c > last.o && last.c >= rth[n - 2].h)) return null; // turning back up
  return S('VWAPPB', last.h + 0.01, Math.min(...lows) - 0.1 * a5, ctx);
}

export function dipBuy(ctx) {
  const { rth, vw, a5, last } = ctx;
  const n = rth.length;
  if (n < 20 || last.c > vw[n - 1] - 1.5 * a5) return null;
  if (!(last.c > last.o && last.c > rth[n - 2].h)) return null; // reversal bar
  return S('DIP', last.h + 0.01, Math.min(...rth.slice(-5).map((b) => b.l)) - 0.1 * a5, ctx);
}

export function lateHod(ctx, rvol) {
  if (ctx.minAfterOpen < 270 || !(rvol >= 1.5)) return null;
  if (ctx.last.c <= ctx.vwap || ctx.hod - ctx.last.c > 0.3 * ctx.a5) return null;
  return S('LATE', ctx.hod + 0.01, ctx.hod + 0.01 - ctx.a5, ctx);
}


// Liquidity levels a stop-hunt would target: yesterday's low and the low of the first 15 / 30 minutes.
function levelsOf(ctx, dc) {
  const out = [];
  if (dc && dc.pdl > 0) out.push(['pdl', dc.pdl]);
  if (ctx.rth.length >= 20) out.push(['or15', Math.min(...ctx.rth.slice(0, 15).map((b) => b.l))]);
  if (ctx.rth.length >= 35) out.push(['or30', Math.min(...ctx.rth.slice(0, 30).map((b) => b.l))]);
  return out;
}

// Buy the first close back above a level that was just swept (price pushed below it, then reclaimed).
// Stop sits under the sweep low; the trigger is the high of the reclaim bar.
export function sweepReclaim(ctx, dc) {
  const { rth, a5, last } = ctx;
  const n = rth.length;
  if (n < 20 || !(last.c > last.o)) return null;
  for (const [name, lvl] of levelsOf(ctx, dc)) {
    if (name !== 'pdl' && n < (name === 'or15' ? 20 : 35)) continue;
    const from = Math.max(name === 'pdl' ? 0 : (name === 'or15' ? 15 : 30), n - 9);
    let k = -1;
    for (let j = from; j < n - 1; j++) if (rth[j].l < lvl - 0.1 * a5) { k = j; break; }
    if (k < 0 || !(last.c > lvl)) continue;
    if (rth.slice(k, n - 1).some((b) => b.c > lvl)) continue; // not the first reclaim
    const lowK = Math.min(...rth.slice(k).map((b) => b.l));
    const st = S('SWEEP', last.h + 0.01, lowK - 0.1 * a5, ctx);
    st.lvl = name;
    return st;
  }
  return null;
}

// How recently each level was swept and reclaimed before this signal (bars ago), else null.
function sweepFeat(ctx, dc) {
  const { rth, a5, last } = ctx;
  const n = rth.length, out = {};
  for (const [name, lvl] of levelsOf(ctx, dc)) {
    const start = name === 'pdl' ? 0 : (name === 'or15' ? 15 : 30);
    let k = -1;
    for (let j = n - 2; j >= Math.max(start, n - 60); j--) if (rth[j].l < lvl - 0.1 * a5) { k = j; break; }
    out[name] = k >= 0 && last.c > lvl ? n - 1 - k : null;
  }
  return out;
}

// What the price did after the plan stop was hit: [minutes to stop, best high in R vs entry within 30 min, within 60 min].
function afterStop(bars, fillAt, p, flatMs) {
  let j = -1;
  for (let x = 0; x < bars.length; x++) if (ms(bars[x].t) >= fillAt && bars[x].l <= p.stop) { j = x; break; }
  if (j < 0) return null;
  const tj = ms(bars[j].t);
  let h30 = null, h60 = null;
  for (let x = j + 1; x < bars.length; x++) {
    const t = ms(bars[x].t);
    if (t >= flatMs || t - tj > 60 * 60000) break;
    if (t - tj <= 30 * 60000) h30 = h30 == null ? bars[x].h : Math.max(h30, bars[x].h);
    h60 = h60 == null ? bars[x].h : Math.max(h60, bars[x].h);
  }
  const r = (h) => (h == null ? null : +((h - p.entry) / p.R).toFixed(2));
  return [Math.round((tj - fillAt) / 60000), r(h30), r(h60)];
}


// After the plan stop was hit: [minutes from the stop to the lowest low within 90 minutes, how far that low is below the stop in %,
// the rebound from that low to the highest high within the next 60 minutes in %, the close 60 minutes after the stop versus the stop in %].
export function stopDip(bars, fillAt, p, flatMs) {
  let j = -1;
  for (let x = 0; x < bars.length; x++) if (ms(bars[x].t) >= fillAt && bars[x].l <= p.stop) { j = x; break; }
  if (j < 0) return null;
  const tj = ms(bars[j].t);
  let lowI = j, low = bars[j].l;
  for (let x = j + 1; x < bars.length; x++) {
    const t = ms(bars[x].t);
    if (t >= flatMs || t - tj > 90 * 60000) break;
    if (bars[x].l < low) { low = bars[x].l; lowI = x; }
  }
  const tl = ms(bars[lowI].t);
  let hi = low, c60 = null;
  for (let x = lowI; x < bars.length; x++) {
    const t = ms(bars[x].t);
    if (t >= flatMs || t - tl > 60 * 60000) break;
    hi = Math.max(hi, bars[x].h);
  }
  for (let x = j; x < bars.length; x++) {
    const t = ms(bars[x].t);
    if (t >= flatMs) break;
    if (t - tj <= 60 * 60000) c60 = bars[x].c; else break;
  }
  const pc = (a, b) => +((a / b - 1) * 100).toFixed(2);
  return [Math.round((tl - tj) / 60000), pc(low, p.stop), pc(hi, low), c60 == null ? null : pc(c60, p.stop)];
}


// Longer holds: stop only (no target) until the flat time. 'close' keeps the plan stop; 'trail' trails the high by 1R once +1R was reached.
// Returns [R held to close, R with trailing stop, best excursion in R, worst excursion in R].
function holdSim(bars, fillAt, p, flatMs) {
  const R = p.entry - p.stop; // same definition as simFixed
  let hh = p.entry, lo = p.entry, lastC = p.entry, closeR = null, trailR = null, trailStop = p.stop, trailOn = false;
  for (const b of bars) {
    const t = ms(b.t);
    if (t < fillAt) continue;
    if (t >= flatMs) { if (closeR == null) closeR = (b.o - p.entry) / R; if (trailR == null) trailR = (b.o - p.entry) / R; break; }
    if (closeR == null && b.l <= p.stop) closeR = -1;
    if (trailR == null && b.l <= trailStop) trailR = (trailStop - p.entry) / R;
    hh = Math.max(hh, b.h); lo = Math.min(lo, b.l); lastC = b.c;
    if (trailR == null) { if (hh >= p.entry + R) trailOn = true; if (trailOn) trailStop = Math.max(trailStop, hh - R); }
    if (closeR != null && trailR != null) break;
  }
  if (closeR == null) closeR = (lastC - p.entry) / R;
  if (trailR == null) trailR = (lastC - p.entry) / R;
  return [+closeR.toFixed(3), +trailR.toFixed(3), +((hh - p.entry) / R).toFixed(2), +((lo - p.entry) / R).toFixed(2)];
}


function emaLast(vals, n) { let e = vals[0]; const k = 2 / (n + 1); for (let i = 1; i < vals.length; i++) e = vals[i] * k + e * (1 - k); return e; }
// Moving-average stack as a string, one char per link: price>EMA9, EMA9>EMA20, EMA20>EMA50, EMA50>EMA100, EMA100>EMA200
// on today's 1-minute closes ('1' up, '0' not, '-' not enough bars yet).
export function emaAlign(closes) {
  const n = closes.length, P = [9, 20, 50, 100, 200];
  const e = P.map((x) => (n >= x ? emaLast(closes, x) : null));
  const c = closes[n - 1];
  const link = (a, b) => (a == null || b == null ? '-' : a > b ? '1' : '0');
  return link(c, e[0]) + link(e[0], e[1]) + link(e[1], e[2]) + link(e[2], e[3]) + link(e[3], e[4]);
}
// Same stack on daily closes before this day (EMA 20/50/100/200): '1' = price above that EMA, '-' = history too short.
export function dailyAlign(dailyBars, day, price) {
  const cl = (dailyBars || []).filter((b) => b.t.slice(0, 10) < day).map((b) => b.c);
  return [20, 50, 100, 200].map((x) => (cl.length >= x ? (price > emaLast(cl, x) ? '1' : '0') : '-')).join('');
}
const IP_STOPS = [0.1, 0.2, 0.5, 1];

// Fixed-target exit: stop first when one bar touches both; time stop and flat at the bar open.
export function simFixed(bars, fromMs, entry, stop, target, timeStopMin, flatMs) {
  const R = entry - stop;
  let last = entry;
  for (const b of bars) {
    const t = ms(b.t);
    if (t < fromMs) continue;
    if (t >= flatMs || t - fromMs >= timeStopMin * 60000) return (b.o - entry) / R;
    if (b.l <= stop) return -1;
    if (b.h >= target) return (target - entry) / R;
    last = b.c;
  }
  return (last - entry) / R;
}

// ---------- statistics ----------
const blank = () => ({ n: 0, wins: 0, gross: 0, net: 0, pos: 0, neg: 0 });
function add(st, gross, net) {
  st.n++; st.gross += gross; st.net += net;
  if (net > 0) { st.wins++; st.pos += net; } else st.neg -= net;
}
const fin = (st) => ({ n: st.n, win: st.n ? +(st.wins / st.n).toFixed(3) : null, avgR: st.n ? +(st.gross / st.n).toFixed(3) : null, avgNet: st.n ? +(st.net / st.n).toFixed(3) : null, pf: st.neg > 0 ? +(st.pos / st.neg).toFixed(2) : null, totalNet: +st.net.toFixed(1) });

// ---------- one session ----------
async function labDay(sess, env) {
  const { syms, daily, cfg, record } = env;
  const day = sess.date;
  const openMs = nyToUtc(day, sess.open);
  const lastRecMin = Math.min(hmToMin(cfg.recTo), hmToMin(sess.close) - 30);
  const toMs = nyToUtc(day, minToHm(lastRecMin));
  const fromMs = nyToUtc(day, cfg.recFrom);
  const flatMs = Math.min(nyToUtc(day, cfg.flatAt), nyToUtc(day, sess.close) - 5 * 60000);
  const tenMs = nyToUtc(day, '10:00');
  const scanTimes = [];
  for (let T = fromMs; T <= toMs; T += SCAN_STEP_MIN * 60000) scanTimes.push(T);
  const rthStart = isoNy(day, sess.open), rthEnd = isoNy(day, sess.close);

  const mk = await alpaca.bars(['SPY', ...SECTOR_ETFS], { timeframe: '1Min', start: rthStart, end: rthEnd, feed: 'sip' });
  const spy = mk.SPY || [];
  const pcOf = (s) => { const d = dailyContext(daily[s], day); return d ? d.pc : null; };
  const spyPc = pcOf('SPY');
  const chgAt = (bars, pc, T) => { let p = null; for (const b of bars) { if (ms(b.t) + 60000 > T) break; p = b.c; } return p && pc ? (p / pc - 1) * 100 : 0; };
  const rel = {};
  const sectorRelAt = (etf) => (T) => { const k = `${etf}|${T}`; if (!(k in rel)) rel[k] = etf && mk[etf] ? chgAt(mk[etf], pcOf(etf), T) - chgAt(spy, spyPc, T) : 0; return rel[k]; };

  const series = {}, keep = {}, dcs = {};
  // Opening-range breakout on the most active stocks (published stocks-in-play variant, long only): rank by the first 5 minutes'
  // volume against the usual volume at that time, then buy a break of the 5-minute high when it closed green, hold to the flat time.
  const ipPool = [];
  const ipCollect = (s, bs, dc, om) => {
    const f = bs.findIndex((b) => ms(b.t) >= om);
    if (f < 0 || bs.length < f + 6 || !(dc.pc > 5) || !(dc.atrD > 0.5) || !(dc.avgVol > 0)) return;
    const o5 = bs.slice(f, f + 5);
    const v5 = o5.reduce((a, b) => a + b.v, 0);
    const r5 = v5 / (dc.avgVol * volumeShare(5));
    if (r5 > 1) ipPool.push({ s, r5, f, bars: bs, orh: Math.max(...o5.map((b) => b.h)), green: o5[4].c > o5[0].o, dc });
  };
  for (let i = 0; i < syms.length; i += CHUNK) {
    const part = syms.slice(i, i + CHUNK);
    const bars = await alpaca.bars(part, { timeframe: '1Min', start: rthStart, end: rthEnd, feed: 'sip' });
    for (const s of part) {
      const dc = dailyContext(daily[s], day);
      if (!dc || !bars[s] || !bars[s].length) continue;
      const rec = recordOf(s);
      const ser = scoreSeries(bars[s], dc, openMs, scanTimes, sectorRelAt(rec && rec.sector !== 'SPY' ? rec.sector : null));
      series[s] = ser; dcs[s] = dc;
      ipCollect(s, bars[s], dc, openMs);
      if (ser.some((f) => f && f.score >= IN_PLAY)) keep[s] = bars[s];
    }
  }
  ipPool.sort((a, b) => b.r5 - a.r5);
  ipPool.slice(0, 20).forEach((c, rank) => {
    if (!c.green) return;
    const trig = c.orh + 0.01;
    let fillIdx = -1;
    for (let j = c.f + 5; j < c.bars.length; j++) { if (ms(c.bars[j].t) >= flatMs) break; if (c.bars[j].h >= trig) { fillIdx = j; break; } }
    if (fillIdx < 0) return;
    const entry = Math.max(trig, c.bars[fillIdx].o), fillAt = ms(c.bars[fillIdx].t);
    const g = {};
    for (const m of IP_STOPS) {
      const Rm = m * c.dc.atrD;
      if (!(Rm > 0 && entry - Rm > 0)) continue;
      g[m] = [+simFixed(c.bars, fillAt, entry, entry - Rm, entry + 1000 * Rm, 100000, flatMs).toFixed(3), +Rm.toFixed(4)];
    }
    env.ipRows.push({ d: day, s: c.s, rank: rank + 1, r5: +c.r5.toFixed(2), e: +entry.toFixed(4), atrD: +c.dc.atrD.toFixed(4), sp: estSpread(entry, env.advOf[c.s]), et: +(ny(fillAt).min / 60).toFixed(2), chg: +((entry / c.dc.pc - 1) * 100).toFixed(2), g });
  });
  // Regime ideas (see regimes.js): scanned on the 100 stocks with the highest opening volume, each event tagged with the market state at entry.
  for (const c of ipPool.slice(0, 100)) {
    const evs = [...downEvents(c.bars, c.f, flatMs), ...upEvents(c.bars, c.f, flatMs, c.dc.pc), ...rangeEvents(c.bars, c.f, flatMs, c.dc.pc)];
    for (const v of evs) {
      const T = ms(c.bars[v.i].t);
      env.regRows.push({ d: day, s: c.s, k: v.k, p: v.p, st: stateAt(spy, spyPc, T, openMs), et: +(ny(T).min / 60).toFixed(2), e: +v.e.toFixed(4), c: +((estSpread(v.e, env.advOf[c.s]) / v.e) * 100).toFixed(3), g: v.g });
    }
  }
  const windows = simulateWatch(series, scanTimes, cfg, flatMs);
  let trades = 0;
  for (const s of Object.keys(windows)) {
    const bars = keep[s];
    if (!bars) continue;
    const dc = dcs[s], ser = series[s], wins = windows[s];
    const inplayFrom = wins[0][0];
    const adv = env.advOf[s];
    const spread = (px) => estSpread(px, adv);
    const used = new Set();
    const first = bars.findIndex((b) => ms(b.t) >= openMs);
    if (first < 0) continue;
    let cumV = 0;
    for (let i = first; i < bars.length - 1; i++) {
      cumV += bars[i].v;
      if (i < first + 2) continue;
      const t = ms(bars[i].t), tc = t + 60000;
      if (t >= toMs) break;
      if (tc < fromMs || tc < inplayFrom) continue;
      const inWatch = wins.some(([a, b]) => tc >= a && tc < b);
      const ctx = buildCtx(bars.slice(0, i + 1), openMs, { pdh: dc.pdh, atrD: dc.atrD });
      if (!ctx) continue;
      const rvol = dc.avgVol > 0 ? cumV / (dc.avgVol * volumeShare(Math.max(1, ctx.minAfterOpen))) : null;
      // Sweep entry arms (measurement only): reclaim entry vs resting buys under the sweep low, one event per stock, day and level.
      const swSt = sweepReclaim(ctx, dc);
      if (swSt && !used.has(`sw|${swSt.lvl}`)) {
        used.add(`sw|${swSt.lvl}`);
        env.swRows.push({ d: day, s, lv: swSt.lvl, e: +swSt.trigger.toFixed(4), a5: +ctx.a5.toFixed(4), sp: spread(swSt.trigger), st: stateAt(spy, spyPc, tc, openMs), et: +(ny(tc).min / 60).toFixed(2), arms: sweepArms(bars, i, swSt, ctx.a5, { timeStopMin: cfg.timeStopMin, flatMs, simFixed }) });
      }
      const cands = [];
      for (const st of detect(ctx)) {
        if (st.type === 'DIP') continue; // measured as its own family below
        const fams = ['base'];
        if (tc >= tenMs) { fams.push('base10'); if (st.ext <= 1.0) fams.push('base10x'); }
        cands.push({ setup: st, fams });
      }
      for (const [fam, st] of [['orb30', orb30(ctx)], ['vwappb', vwapPullback(ctx, dc)], ['dip', dipBuy(ctx)], ['late', lateHod(ctx, rvol)], ['sweep', sweepReclaim(ctx, dc)]]) if (st) cands.push({ setup: st, fams: [fam] });
      if (!cands.length) continue;
      let sc = 0;
      scanTimes.forEach((T, k) => { if (T <= tc && ser[k]) sc = ser[k].score; });
      for (const c of cands) {
        const s0 = c.setup;
        const R0 = s0.trigger - s0.stopStruct;
        let fillAt = null;
        for (let j = i + 1; j <= Math.min(i + 3, bars.length - 1); j++) {
          const b = bars[j];
          if (b.h < s0.trigger) continue;
          if (b.o > s0.trigger + 0.25 * R0) break;
          fillAt = ms(b.t); break;
        }
        if (fillAt == null) continue;
        const funnels = inWatch ? ['watch', 'inplay'] : ['inplay'];
        const todo = [];
        for (const fam of c.fams) for (const fu of funnels) { const k = `${fam}|${fu}|${s0.type}`; if (!used.has(k)) { used.add(k); todo.push([fam, fu]); } }
        const firstOfType = !used.has(`row|${s0.type}`);
        if (!todo.length && !firstOfType) continue;
        const regime = regimeAt(spy, spyPc, fillAt, openMs);
        const mstate = stateAt(spy, spyPc, fillAt, openMs);
        const p = makePlan(s0, ctx, { spread: spread(s0.trigger) }, cfg, { score: sc, regime });
        const fails = p.fails.filter((f) => STRUCTURAL.has(f));
        const out = {};
        let mgReason = null;
        for (const [ex, k] of Object.entries(EXITS)) {
          if (k == null) { const sm = simulate(bars, fillAt, p, { flatMs, timeStopMin: cfg.timeStopMin }); out[ex] = sm.r; mgReason = sm.reason; }
          else out[ex] = simFixed(bars, fillAt, p.entry, p.stop, p.entry + k * p.R, cfg.timeStopMin, flatMs);
        }
        if (firstOfType) {
          // One row per stock, day and setup (first fill), with everything needed to re-cost and
          // re-filter offline: plan stop and two wider stops, each with fixed 1R/1.5R/2R exits.
          used.add(`row|${s0.type}`);
          const wide = (Rw) => ({ R: +Rw.toFixed(4), r1: +simFixed(bars, fillAt, p.entry, p.entry - Rw, p.entry + Rw, cfg.timeStopMin, flatMs).toFixed(3), r15: +simFixed(bars, fillAt, p.entry, p.entry - Rw, p.entry + 1.5 * Rw, cfg.timeStopMin, flatMs).toFixed(3), r2: +simFixed(bars, fillAt, p.entry, p.entry - Rw, p.entry + 2 * Rw, cfg.timeStopMin, flatMs).toFixed(3) });
          // Gross R of every (stop, target) pair, fixed stop distance s*ATR, single target k*R, same time stop.
          const grid = () => DYN_STOPS.map((sa) => DYN_TARGETS.map((k) => { const Rg = sa * ctx.a5; return +simFixed(bars, fillAt, p.entry, p.entry - Rg, p.entry + k * Rg, cfg.timeStopMin, flatMs).toFixed(3); }));
          // Delayed entry: the price must close at or above the trigger on every bar for d minutes after the fill, then
          // we enter at the next open (if not already too extended). Fixed 1.5R target, same structural stop.
          const confirm = () => DYN_CONFIRM.map((dm) => {
            const t0 = fillAt + dm * 60000;
            let held = true, entry2 = null;
            for (const b of bars) {
              const bt = ms(b.t);
              if (bt < fillAt) continue;
              if (bt < t0) { if (b.c < s0.trigger || b.l <= p.stop) { held = false; break; } continue; }
              entry2 = b.o; break;
            }
            if (!held || entry2 == null || entry2 > s0.trigger + 0.25 * R0 || entry2 <= p.stop) return null;
            const R2 = entry2 - p.stop;
            return [+simFixed(bars, t0, entry2, p.stop, entry2 + 1.5 * R2, cfg.timeStopMin, flatMs).toFixed(3), +R2.toFixed(4), +entry2.toFixed(4)];
          });
          env.rows.push({
            d: day, s, ty: s0.type, fams: c.fams, w: inWatch ? 1 : 0, e: p.entry, R: +p.R.toFixed(4), sp: p.spread, a5: +ctx.a5.toFixed(4),
            ext: +s0.ext.toFixed(2), chg: +((ctx.last.c / dc.pc - 1) * 100).toFixed(2), rv: rvol == null ? null : +rvol.toFixed(2), sc, ma: Math.round(ctx.minAfterOpen), rg: regime, st: mstate,
            dv: +((ctx.vwap - ctx.last.c) / ctx.a5).toFixed(2), fails,
            et: +(ny(fillAt).min / 60).toFixed(2), xr: mgReason, // entry time (NY hour) and how the managed exit ended
            x: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, +v.toFixed(3)])),
            w1: wide(Math.max(p.R, ctx.a5)), w2: wide(Math.max(p.R, 0.01 * p.entry)),
            g: grid(),
            cf: confirm(),
            hd: holdSim(bars, fillAt, p, flatMs), gap: +((bars[first].o / dc.pc - 1) * 100).toFixed(2), rs: +(((ctx.last.c / dc.pc - 1) * 100) - chgAt(spy, spyPc, fillAt)).toFixed(2),
            ea: emaAlign(bars.slice(first, i + 1).map((b) => b.c)), ed: dailyAlign(daily[s], day, ctx.last.c),
            fa: fillAt, sw: sweepFeat(ctx, dc), aft: afterStop(bars, fillAt, p, flatMs), sd: stopDip(bars, fillAt, p, flatMs), pd: postStopArms(bars, stopBarIndex(bars, fillAt, p.stop), p.stop, ctx.a5, flatMs), lv: s0.lvl || null,
          });
        }
        if (!todo.length || fails.length) continue;
        const costR = ((2 * cfg.feePerSide) / (cfg.capital / p.entry) + p.spread) / p.R;
        const meta = { day, regime, state: mstate || 'none', tod: todBucket(ctx.minAfterOpen), score: scoreBucket(sc), type: s0.type };
        for (const [fam, fu] of todo) for (const ex of Object.keys(EXITS)) record(`${fam}|${ex}|${fu}`, meta, out[ex], out[ex] - costR);
        trades++;
      }
    }
  }
  return { inPlay: Object.keys(keep).length, watched: Object.keys(windows).length, trades };
}

export async function runLab(universe, cfg, { days = 90, testDays = 30, budgetMs = 300 * 60000 } = {}) {
  const t0 = Date.now();
  loadCache();
  const list = tradable(universe, false);
  const syms = list.map((x) => x.s);
  const advOf = Object.fromEntries(list.map((x) => [x.s, x.adv]));
  const today = ny().ymd;
  const cal = await alpaca.calendar(addDays(today, -Math.ceil(days * 1.6) - 7), addDays(today, -1));
  const sessions = cal.filter((c) => c.date < today).slice(-days);
  const testSet = new Set(sessions.slice(-testDays).map((c) => c.date));
  const daily = await alpaca.bars([...syms, 'SPY', ...SECTOR_ETFS], { timeframe: '1Day', start: isoNy(addDays(sessions[0].date, -330), '00:00'), end: isoNy(sessions[sessions.length - 1].date, '20:00'), feed: 'sip' });

  const stats = {};
  const get = (key) => (stats[key] = stats[key] || { train: blank(), test: blank(), all: blank(), regime: {}, state: {}, tod: {}, score: {}, type: {}, month: {} });
  const record = (key, m, gross, net) => {
    const s = get(key);
    add(s[testSet.has(m.day) ? 'test' : 'train'], gross, net); add(s.all, gross, net);
    for (const [dim, v] of [['regime', m.regime], ['state', m.state], ['tod', m.tod], ['score', m.score], ['type', m.type], ['month', m.day.slice(0, 7)]]) add((s[dim][v] = s[dim][v] || blank()), gross, net);
  };
  const perDay = [];
  const rows = [];
  const ipRows = [];
  const regRows = [];
  const swRows = [];
  for (const sess of sessions.slice().reverse()) { // newest first, so a cut-off still covers the test set
    if (Date.now() - t0 > budgetMs) { warn('lab', 'time budget reached'); break; }
    try {
      const r = await labDay(sess, { syms, daily, cfg, record, advOf, rows, ipRows, regRows, swRows });
      perDay.push({ day: sess.date, ...r });
      log(`lab ${sess.date}: ${r.inPlay} in play, ${r.watched} watched, ${r.trades} trades`);
    } catch (e) { warn(`lab ${sess.date}`, e); }
  }
  const variants = Object.entries(stats).map(([key, s]) => {
    const [fam, exit, funnel] = key.split('|');
    const dimFin = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fin(v)]));
    return { key, fam, exit, funnel, label: FAMILIES[fam], exitLabel: EXIT_AR[exit], funnelLabel: FUNNEL_AR[funnel], train: fin(s.train), test: fin(s.test), all: fin(s.all), regime: dimFin(s.regime), state: dimFin(s.state), tod: dimFin(s.tod), score: dimFin(s.score), type: dimFin(s.type), month: dimFin(s.month) };
  }).sort((a, b) => (b.test.avgNet ?? -9) - (a.test.avgNet ?? -9));
  const out = {
    at: Date.now(), version: 1, sessions: sessions.length, done: perDay.length, from: sessions[0] && sessions[0].date, to: sessions[sessions.length - 1] && sessions[sessions.length - 1].date,
    testFrom: [...testSet].sort()[0], symbols: syms.length, costs: { feePerSide: cfg.feePerSide, capital: cfg.capital }, minutes: Math.round((Date.now() - t0) / 60000),
    perDay, variants,
  };
  // News catalyst measurement: Finnhub story timestamps for the symbols seen, rows get nw = [24h, pre-open, 60min] story counts.
  let newsMap = {};
  try {
    const last = sessions[sessions.length - 1].date;
    const order = [...new Set(rows.map((r) => r.s)), ...syms];
    const nh = await fetchNewsHistory([...new Set(order)], addDays(last, -180), last);
    newsMap = nh.map;
    for (const r of rows) r.nw = newsCounts(newsMap[r.s], r.fa, nyToUtc(r.d, '09:30'));
    writeJSON('lab/news-meta.json', { at: Date.now(), ...nh.stats, rowsCovered: rows.filter((r) => r.nw).length, rows: rows.length });
  } catch (e) { warn('news history', e); }
  writeJSON('lab/latest.json', out);
  writeJSON('lab/trades-latest.json', { at: out.at, testFrom: out.testFrom, costs: out.costs, rows });
  try { writeJSON('lab/swing-latest.json', { at: out.at, ...swingStudy(Object.fromEntries(syms.map((x) => [x, daily[x] || []])), { feePerSide: cfg.feePerSide, capital: cfg.capital, spy: daily.SPY, newsAt: (sym, day) => (newsMap[sym] ? newsCounts(newsMap[sym], nyToUtc(day, '09:30'), nyToUtc(day, '09:30'))[0] : null) }) }); } catch (e) { warn('swing', e); }
  writeJSON('lab/regimes-latest.json', { at: out.at, testFrom: out.testFrom, rows: regRows });
  writeJSON('lab/sweepentry-latest.json', { at: out.at, testFrom: out.testFrom, rows: swRows });
  try { writeJSON('lab/poststop-latest.json', { at: out.at, testFrom: out.testFrom, k: [0.25, 0.5, 1, 1.5], rows: rows.filter((r) => r.pd).map((r) => ({ d: r.d, s: r.s, ty: r.ty, et: r.et, fa: r.fa, a5: r.a5, e: r.e, R: r.R, sp: r.sp, st: r.st, rg: r.rg, sd: r.sd, pd: r.pd })) }); } catch (e) { warn('poststop', e); }
  writeJSON('lab/orbip-latest.json', { at: out.at, testFrom: out.testFrom, costs: out.costs, stops: IP_STOPS, rows: ipRows });
  writeJSON(`lab/${today}-${ny().hm.replace(':', '')}.json`, out);
  log(`lab: ${perDay.length} sessions, ${variants.length} variants in ${out.minutes} min`);
  return out;
}
