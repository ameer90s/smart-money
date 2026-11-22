// Regime-specific ideas, long only, measured in % of price (gross; the caller subtracts the spread). Each function scans one stock-day of
// 1-minute bars and returns events: { k, p, i, e, g } with g = { 'target_stop': % result } for a small grid. The stop is checked before the
// target inside a bar, and nothing is entered in the last 30 minutes. Used by the lab, not by live recommendations.
const MIN30 = 30 * 60000;
const t = (b) => Date.parse(b.t);

function exitPct(bars, i0, entry, stop, target, flatMs) {
  for (let j = i0; j < bars.length; j++) {
    const b = bars[j];
    if (t(b) >= flatMs) return (b.o / entry - 1) * 100;
    if (stop != null && b.l <= stop) return (Math.min(stop, j === i0 ? stop : b.o) / entry - 1) * 100;
    if (j > i0 && target != null && b.h >= target) return (Math.max(target, b.o) / entry - 1) * 100;
  }
  return (bars[bars.length - 1].c / entry - 1) * 100;
}
const grid = (bars, i0, entry, targets, stops, flatMs) => {
  const g = {};
  for (const [tn, tp] of Object.entries(targets)) for (const [sn, sp] of Object.entries(stops)) g[`${tn}_${sn}`] = +exitPct(bars, i0, entry, sp, tp, flatMs).toFixed(3);
  return g;
};
const late = (b, flatMs) => t(b) >= flatMs - MIN30;

// Falling stocks: buy the first touch of a drop of X% from the day's running high (X = 4, 5, 7, 10, 12), aiming at a small bounce.
// Targets: +2%, half the drop back, the whole drop back. Stops: -2%, -4%, none (hold to the flat time).
export function downEvents(bars, f, flatMs, drops = [4, 5, 7, 10, 12]) {
  const out = [], fired = new Set();
  let H = -Infinity;
  for (let i = f; i < bars.length; i++) {
    const b = bars[i];
    if (late(b, flatMs)) break;
    if (i >= f + 5) for (const X of drops) {
      if (fired.has(X)) continue;
      const L = H * (1 - X / 100);
      if (b.l <= L) {
        fired.add(X);
        const e = Math.min(L, b.o);
        if (!(e > 3)) continue;
        out.push({ k: 'down', p: String(X), i, e, g: grid(bars, i, e, { 2: e * 1.02, h: e + 0.5 * (H - e), f: H }, { 2: e * 0.98, 4: e * 0.96, n: null }, flatMs) });
      }
    }
    H = Math.max(H, b.h);
  }
  return out;
}

// Rising stocks (up 3%+ on the day): after a run, the first touch of VWAP or the 1-minute EMA20 from above. Targets +2/+3/+4%, stops -1%/-2%.
export function upEvents(bars, f, flatMs, pc) {
  const out = [], fired = new Set();
  let pv = 0, vv = 0, ema = null;
  for (let i = f; i < bars.length; i++) {
    const b = bars[i];
    if (late(b, flatMs)) break;
    if (i >= f + 10 && bars[i - 1].c / pc >= 1.03) {
      const anchors = { vwap: vv ? pv / vv : null, ema20: ema };
      for (const [name, a] of Object.entries(anchors)) {
        if (fired.has(name) || !a || !(bars[i - 1].c > a * 1.005) || !(b.l <= a) || !(b.o > a * 0.998)) continue;
        fired.add(name);
        const e = Math.min(a, b.o);
        out.push({ k: 'up', p: name, i, e, g: grid(bars, i, e, { 2: e * 1.02, 3: e * 1.03, 4: e * 1.04 }, { 1: e * 0.99, 2: e * 0.98 }, flatMs) });
      }
    }
    const tp = (b.h + b.l + b.c) / 3;
    pv += tp * b.v; vv += b.v;
    ema = ema == null ? b.c : b.c * (2 / 21) + ema * (19 / 21);
  }
  return out;
}

// Sideways stocks (within 4% of yesterday's close): buy a touch of VWAP minus k standard deviations of the day's distance from VWAP (k = 1.5, 2, 2.5).
// Targets: back to VWAP, half way back. Stops: 1 or 2 standard deviations below the entry, or none.
export function rangeEvents(bars, f, flatMs, pc, ks = [1.5, 2, 2.5]) {
  const out = [], fired = new Set(), dist = [];
  let pv = 0, vv = 0;
  for (let i = f; i < bars.length; i++) {
    const b = bars[i];
    if (late(b, flatMs)) break;
    if (i >= f + 30 && vv) {
      const v = pv / vv, n = dist.length, m = dist.reduce((a, x) => a + x, 0) / n;
      const sd = Math.sqrt(dist.reduce((a, x) => a + (x - m) ** 2, 0) / n);
      if (sd / v >= 0.0015 && Math.abs(bars[i - 1].c / pc - 1) <= 0.04) for (const k of ks) {
        const L = v - k * sd;
        if (fired.has(k) || !(b.l <= L) || !(L > 3)) continue;
        fired.add(k);
        const e = Math.min(L, b.o);
        out.push({ k: 'range', p: String(k), i, e, g: grid(bars, i, e, { v, m: e + 0.5 * (v - e) }, { 1: e - sd, 2: e - 2 * sd, n: null }, flatMs) });
      }
    }
    const tp = (b.h + b.l + b.c) / 3;
    pv += tp * b.v; vv += b.v;
    dist.push(b.c - pv / vv);
  }
  return out;
}
