// Strategy lab. Replays past sessions without hindsight (the same 5-minute scan and watchlist
// rules as live) and measures several entry and exit variants side by side, net of fees and
// spread, separately on older sessions (train) and the most recent ones (test). A variant is
// only worth adopting if it holds up on both. Writes lab/latest.json; never touches the model.
import { alpaca } from './alpaca.js';
import { isoNy, nyToUtc, addDays, ny, hmToMin, minToHm } from './clock.js';
import { buildCtx, detect } from './setups.js';
import { plan as makePlan } from './planner.js';
import { simulate } from './simulate.js';
import { ms, volumeShare } from './indicators.js';
import { recordOf, loadCache } from './shariah.js';
import { tradable } from './universe.js';
import { estSpread, SECTOR_ETFS } from './market.js';
import { dailyContext, scoreSeries, simulateWatch, regimeAt } from './backtest.js';
import { scoreBucket, todBucket } from './model.js';
import { writeJSON } from './store.js';
import { log, warn } from './log.js';

const STRUCTURAL = new Set(['stop', 'spread', 'ext']);
const SCAN_STEP_MIN = 5;
const CHUNK = 100;
const IN_PLAY = 50; // a stock is kept for the day once its live score reaches this
const EXITS = { mgmt: null, r1: 1, r15: 1.5, r2: 2 };

export const FAMILIES = {
  base: 'الأنماط الحالية كما هي',
  base10: 'الأنماط الحالية بعد 10:00',
  base10x: 'الأنماط الحالية بعد 10:00 وقريب من VWAP (≤ 1 ATR)',
  orb30: 'اختراق نطاق أول 30 دقيقة',
  vwappb: 'ارتداد من VWAP في سهم صاعد',
  dip: 'شراء الهبوط الحاد تحت VWAP بعد شمعة انعكاس',
  late: 'اختراق أعلى اليوم بعد 14:00',
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
  for (let i = 0; i < syms.length; i += CHUNK) {
    const part = syms.slice(i, i + CHUNK);
    const bars = await alpaca.bars(part, { timeframe: '1Min', start: rthStart, end: rthEnd, feed: 'sip' });
    for (const s of part) {
      const dc = dailyContext(daily[s], day);
      if (!dc || !bars[s] || !bars[s].length) continue;
      const rec = recordOf(s);
      const ser = scoreSeries(bars[s], dc, openMs, scanTimes, sectorRelAt(rec && rec.sector !== 'SPY' ? rec.sector : null));
      series[s] = ser; dcs[s] = dc;
      if (ser.some((f) => f && f.score >= IN_PLAY)) keep[s] = bars[s];
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
      const cands = [];
      for (const st of detect(ctx)) {
        if (st.type === 'DIP') continue; // measured as its own family below
        const fams = ['base'];
        if (tc >= tenMs) { fams.push('base10'); if (st.ext <= 1.0) fams.push('base10x'); }
        cands.push({ setup: st, fams });
      }
      for (const [fam, st] of [['orb30', orb30(ctx)], ['vwappb', vwapPullback(ctx, dc)], ['dip', dipBuy(ctx)], ['late', lateHod(ctx, rvol)]]) if (st) cands.push({ setup: st, fams: [fam] });
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
        const p = makePlan(s0, ctx, { spread: spread(s0.trigger) }, cfg, { score: sc, regime });
        const fails = p.fails.filter((f) => STRUCTURAL.has(f));
        const out = {};
        for (const [ex, k] of Object.entries(EXITS)) {
          out[ex] = k == null ? simulate(bars, fillAt, p, { flatMs, timeStopMin: cfg.timeStopMin }).r : simFixed(bars, fillAt, p.entry, p.stop, p.entry + k * p.R, cfg.timeStopMin, flatMs);
        }
        if (firstOfType) {
          // One row per stock, day and setup (first fill), with everything needed to re-cost and
          // re-filter offline: plan stop and two wider stops, each with fixed 1R/1.5R/2R exits.
          used.add(`row|${s0.type}`);
          const wide = (Rw) => ({ R: +Rw.toFixed(4), r1: +simFixed(bars, fillAt, p.entry, p.entry - Rw, p.entry + Rw, cfg.timeStopMin, flatMs).toFixed(3), r15: +simFixed(bars, fillAt, p.entry, p.entry - Rw, p.entry + 1.5 * Rw, cfg.timeStopMin, flatMs).toFixed(3), r2: +simFixed(bars, fillAt, p.entry, p.entry - Rw, p.entry + 2 * Rw, cfg.timeStopMin, flatMs).toFixed(3) });
          env.rows.push({
            d: day, s, ty: s0.type, fams: c.fams, w: inWatch ? 1 : 0, e: p.entry, R: +p.R.toFixed(4), sp: p.spread, a5: +ctx.a5.toFixed(4),
            ext: +s0.ext.toFixed(2), chg: +((ctx.last.c / dc.pc - 1) * 100).toFixed(2), rv: rvol == null ? null : +rvol.toFixed(2), sc, ma: Math.round(ctx.minAfterOpen), rg: regime,
            dv: +((ctx.vwap - ctx.last.c) / ctx.a5).toFixed(2), fails,
            x: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, +v.toFixed(3)])),
            w1: wide(Math.max(p.R, ctx.a5)), w2: wide(Math.max(p.R, 0.01 * p.entry)),
          });
        }
        if (!todo.length || fails.length) continue;
        const costR = ((2 * cfg.feePerSide) / (cfg.capital / p.entry) + p.spread) / p.R;
        const meta = { day, regime, tod: todBucket(ctx.minAfterOpen), score: scoreBucket(sc), type: s0.type };
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
  const daily = await alpaca.bars([...syms, 'SPY', ...SECTOR_ETFS], { timeframe: '1Day', start: isoNy(addDays(sessions[0].date, -45), '00:00'), end: isoNy(sessions[sessions.length - 1].date, '20:00'), feed: 'sip' });

  const stats = {};
  const get = (key) => (stats[key] = stats[key] || { train: blank(), test: blank(), all: blank(), regime: {}, tod: {}, score: {}, type: {}, month: {} });
  const record = (key, m, gross, net) => {
    const s = get(key);
    add(s[testSet.has(m.day) ? 'test' : 'train'], gross, net); add(s.all, gross, net);
    for (const [dim, v] of [['regime', m.regime], ['tod', m.tod], ['score', m.score], ['type', m.type], ['month', m.day.slice(0, 7)]]) add((s[dim][v] = s[dim][v] || blank()), gross, net);
  };
  const perDay = [];
  const rows = [];
  for (const sess of sessions.slice().reverse()) { // newest first, so a cut-off still covers the test set
    if (Date.now() - t0 > budgetMs) { warn('lab', 'time budget reached'); break; }
    try {
      const r = await labDay(sess, { syms, daily, cfg, record, advOf, rows });
      perDay.push({ day: sess.date, ...r });
      log(`lab ${sess.date}: ${r.inPlay} in play, ${r.watched} watched, ${r.trades} trades`);
    } catch (e) { warn(`lab ${sess.date}`, e); }
  }
  const variants = Object.entries(stats).map(([key, s]) => {
    const [fam, exit, funnel] = key.split('|');
    const dimFin = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fin(v)]));
    return { key, fam, exit, funnel, label: FAMILIES[fam], exitLabel: EXIT_AR[exit], funnelLabel: FUNNEL_AR[funnel], train: fin(s.train), test: fin(s.test), all: fin(s.all), regime: dimFin(s.regime), tod: dimFin(s.tod), score: dimFin(s.score), type: dimFin(s.type), month: dimFin(s.month) };
  }).sort((a, b) => (b.test.avgNet ?? -9) - (a.test.avgNet ?? -9));
  const out = {
    at: Date.now(), version: 1, sessions: sessions.length, done: perDay.length, from: sessions[0] && sessions[0].date, to: sessions[sessions.length - 1] && sessions[sessions.length - 1].date,
    testFrom: [...testSet].sort()[0], symbols: syms.length, costs: { feePerSide: cfg.feePerSide, capital: cfg.capital }, minutes: Math.round((Date.now() - t0) / 60000),
    perDay, variants,
  };
  writeJSON('lab/latest.json', out);
  writeJSON('lab/trades-latest.json', { at: out.at, testFrom: out.testFrom, costs: out.costs, rows });
  writeJSON(`lab/${today}-${ny().hm.replace(':', '')}.json`, out);
  log(`lab: ${perDay.length} sessions, ${variants.length} variants in ${out.minutes} min`);
  return out;
}
