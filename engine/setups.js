// Entry patterns. Pure functions over today's 1-minute bars, shared by the live engine
// and the historical replay, so both measure exactly the same thing.
import { vwapSeries, emaSeries, atr, aggregate, lowest, highest, mean, ms } from './indicators.js';

export const SETUP_LABELS = {
  ORB15: 'اختراق نطاق الافتتاح 15 د',
  ORB5: 'اختراق نطاق الافتتاح 5 د',
  VWAP: 'ارتداد واستعادة VWAP',
  FLAG: 'تماسك ثم اختراق',
  PMH: 'اختراق أعلى ما قبل الافتتاح',
  PDH: 'اختراق أعلى اليوم السابق',
  EMA: 'أول ارتداد EMA9',
  DIP: 'شراء الهبوط بعد انعكاس',
};

// bars: today's 1-minute bars (pre-market included), openMs: today's 09:30 in epoch ms.
export function buildCtx(bars, openMs, { pdh = null, atrD = null } = {}) {
  const pm = bars.filter((b) => ms(b.t) < openMs);
  const rth = bars.filter((b) => ms(b.t) >= openMs);
  if (!rth.length) return null;
  const vw = vwapSeries(rth);
  const closes = rth.map((b) => b.c);
  const e9 = emaSeries(closes, 9);
  const e20 = emaSeries(closes, 20);
  const b5 = aggregate(rth, 5, openMs);
  let a5 = b5.length >= 3 ? atr(b5, 14) : atr(rth, 14) * Math.sqrt(5);
  if (atrD) a5 = Math.max(a5, atrD / 40); // floor so a quiet first bar does not shrink stops to nothing
  const first = (n) => rth.filter((b) => ms(b.t) < openMs + n * 60000);
  const o5 = first(5), o15 = first(15);
  const last = rth[rth.length - 1];
  return {
    rth, pm, vw, e9, e20, a5, last,
    vwap: vw[vw.length - 1],
    pmHigh: pm.length ? Math.max(...pm.map((b) => b.h)) : null,
    pdh,
    hod: Math.max(...rth.map((b) => b.h)),
    lod: Math.min(...rth.map((b) => b.l)),
    orb5: o5.length >= 5 ? { h: Math.max(...o5.map((b) => b.h)), l: Math.min(...o5.map((b) => b.l)) } : null,
    orb15: o15.length >= 13 ? { h: Math.max(...o15.map((b) => b.h)), l: Math.min(...o15.map((b) => b.l)) } : null,
    avgVol: mean(rth.map((b) => b.v)),
    minAfterOpen: (ms(last.t) - openMs) / 60000 + 1,
  };
}

const tick = (p) => (p >= 1 ? 0.01 : 0.0001);

export function detect(ctx) {
  if (!ctx || ctx.rth.length < 3) return [];
  const { rth, a5: a, last, vwap } = ctx;
  const n = rth.length;
  const out = [];
  const add = (type, trigger, stopStruct, extra = {}) => {
    if (!(trigger > 0) || !(stopStruct > 0) || stopStruct >= trigger) return;
    out.push({ type, label: SETUP_LABELS[type], trigger: +trigger.toFixed(4), stopStruct: +stopStruct.toFixed(4), ext: (trigger - vwap) / a, ...extra });
  };

  // 1. Opening-range breakout (first breakout only).
  const orbCheck = (type, orb, startIdx) => {
    if (!orb) return;
    const lvl = orb.h;
    const after = rth.slice(startIdx);
    if (after.some((b) => b.c > lvl + 0.3 * a)) return;
    if (last.c <= lvl + 0.05 * a && last.c >= lvl - 0.6 * a && last.c > vwap && orb.h - orb.l <= 3 * a) {
      add(type, lvl + tick(lvl), Math.min(lowest(rth, 5), vwap) - 0.05 * a, { level: lvl });
    }
  };
  if (ctx.minAfterOpen >= 15) orbCheck('ORB15', ctx.orb15, 15);
  else if (ctx.minAfterOpen >= 5) orbCheck('ORB5', ctx.orb5, 5);

  // 2. VWAP pullback that held, turning back up.
  if (n >= 20) {
    const earlier = rth.slice(Math.max(0, n - 30), n - 6);
    const ext = earlier.length ? Math.max(...earlier.map((b, i) => b.c - ctx.vw[Math.max(0, n - 30) + i])) : 0;
    const last6 = rth.slice(-6);
    const vw6 = ctx.vw.slice(-6);
    const touched = Math.min(...last6.map((b) => b.l)) <= vwap + 0.2 * a;
    const held = last6.every((b, i) => b.c >= vw6[i] - 0.15 * a);
    if (ext >= 0.8 * a && touched && held && last.c > vwap && last.c > last.o) {
      add('VWAP', highest(rth, 2) + tick(last.c), lowest(rth, 6) - 0.05 * a);
    }
  }

  // 3. Impulse, tight consolidation, breakout (flag).
  if (n >= 10) {
    const look = rth.slice(-25);
    const off = n - look.length;
    let iH = 0;
    look.forEach((b, i) => { if (b.h >= look[iH].h) iH = i; });
    const k = look.length - 1 - iH;
    if (k >= 3 && k <= 12) {
      const before = look.slice(Math.max(0, iH - 12), iH + 1);
      const L = Math.min(...before.map((b) => b.l));
      const H = look[iH].h;
      const imp = H - L;
      const cons = look.slice(iH + 1);
      const cL = Math.min(...cons.map((b) => b.l));
      const cH = Math.max(...cons.map((b) => b.h));
      const vwAtCons = ctx.vw[off + iH];
      if (imp >= 2 * a && H - cL <= 0.5 * imp && cL > vwAtCons && cL >= L + 0.5 * imp && cH <= H + 0.05 * a) {
        const trig = Math.max(H, cH) + tick(H);
        add('FLAG', trig, cL - 0.05 * a, { mm: trig + imp });
      }
    }
  }

  // 4. Pre-market high / prior-day high breakout.
  const c3 = rth.slice(-3).map((b) => b.c);
  const rising = c3.length === 3 && c3[2] >= c3[1] && c3[1] >= c3[0];
  for (const [type, lvl] of [['PMH', ctx.pmHigh], ['PDH', ctx.pdh]]) {
    if (!lvl || lvl <= last.c) continue;
    if (ctx.hod >= lvl + 0.1 * a) continue;
    if (lvl - last.c <= 0.4 * a && last.c > vwap && rising) add(type, lvl + tick(lvl), lowest(rth, 3) - 0.05 * a, { level: lvl });
  }

  // 5. First pullback to the 9 EMA after a strong push.
  if (n >= 15) {
    const e9 = ctx.e9[n - 1], e20 = ctx.e20[n - 1];
    const s0 = Math.max(0, n - 20);
    const push = Math.max(...rth.slice(s0).map((b, i) => b.c - ctx.e20[s0 + i]));
    if (e9 > e20 && push >= 1.5 * a && last.l <= e9 + 0.1 * a && last.c >= e20 && last.c >= vwap) {
      add('EMA', last.h + tick(last.h), Math.min(lowest(rth, 3), e20) - 0.05 * a);
    }
  }

  // 6. Sharp dip: at least 1.5 ATR below VWAP, then a green bar closing above the prior high.
  //    The only setup that held an edge before costs in the walk-forward lab (S1.3).
  if (n >= 20 && last.c <= vwap - 1.5 * a && last.c > last.o && last.c > rth[n - 2].h) {
    add('DIP', last.h + tick(last.h), lowest(rth, 5) - 0.1 * a, { dv: (vwap - last.c) / a });
  }
  return out;
}
