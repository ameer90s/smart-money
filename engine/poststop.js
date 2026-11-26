// Lab only: what happens if we buy AFTER a stop-out dip instead of at the original entry.
// T = start of the bar that touched the plan stop. All results are % of the entry price (spread/commission are applied offline).
// E1: resting limit at stop - k*ATR5 (X1 timed close at T+60, X2 same with protective stop, X3 target = the original stop price).
// E2: reclaim: after a bar reaches stop - k*ATR5, buy when price is back at the stop price (stop under the dip low).
// E3: higher-low confirmation: after the dip, a close above the highs of the previous 3 bars, enter next open (stop under the dip low).
const ms = (t) => (typeof t === 'number' ? t : Date.parse(t));
export const PS_K = [0.25, 0.5, 1.0, 1.5];
const pct = (a, b) => +((a / b - 1) * 100).toFixed(3);

// Walk bars from index `from`; stop-first inside a bar. Returns the exit price and whether it ended by stop/target.
function walk(bars, from, ps, tp, endMs, flatMs, fillBar = false) {
  let last = null;
  for (let x = from; x < bars.length; x++) {
    const t = ms(bars[x].t);
    if (t >= flatMs || t > endMs) break;
    last = bars[x];
    if (ps != null && last.l <= ps) return { px: Math.min(ps, last.o), why: 's' };
    if (tp != null && !(fillBar && x === from) && last.h >= tp) return { px: Math.max(tp, last.o), why: 't' };
  }
  return last ? { px: last.c, why: 'c' } : null;
}

function exitsR(bars, from, entry, ps, T, flatMs) {
  const R = entry - ps;
  if (!(R > 0)) return null;
  const end = T + 120 * 60000;
  const f = (tp) => { const w = walk(bars, from, ps, tp, end, flatMs); return w ? pct(w.px, entry) : null; };
  return { t: f(null), r1: f(entry + R), r15: f(entry + 1.5 * R), rp: +(R / entry * 100).toFixed(3) };
}

export function postStopArms(bars, j, stopPx, a5, flatMs) {
  if (j == null || j < 0 || !(a5 > 0)) return null;
  const T = ms(bars[j].t), end60 = T + 60 * 60000;
  const inWin = (x) => x < bars.length && ms(bars[x].t) <= end60 && ms(bars[x].t) < flatMs;
  const out = { E1: {}, E2: {}, E3: {} };
  for (const k of PS_K) {
    const L = stopPx - k * a5, key = String(k);
    // E1
    out.E1[key] = null;
    for (let x = j + 1; inWin(x); x++) {
      if (bars[x].l > L) continue;
      const en = Math.min(L, bars[x].o), ps = en - 0.75 * a5;
      const win = [];
      for (let y = x; inWin(y); y++) win.push(y);
      const lastY = win[win.length - 1];
      const x1 = pct(bars[lastY].c, en);
      const w2 = walk(bars, x, ps, null, end60, flatMs, true); // fill bar counts for the protective stop only
      const w3 = walk(bars, x, ps, stopPx, end60, flatMs, true);
      out.E1[key] = { m: Math.round((ms(bars[x].t) - T) / 60000), x1, x2: w2 ? pct(w2.px, en) : x1, x3: w3 ? pct(w3.px, en) : x1, en: +en.toFixed(4) };
      break;
    }
    // dip bar for E2/E3
    let d = -1;
    for (let x = j; inWin(x); x++) if (bars[x].l <= L) { d = x; break; }
    out.E2[key] = null; out.E3[key] = null;
    if (d < 0) continue;
    let low = Infinity;
    for (let x = j; x <= d; x++) low = Math.min(low, bars[x].l);
    // E2
    for (let y = d + 1; inWin(y); y++) {
      low = Math.min(low, bars[y - 1].l);
      if (bars[y].h < stopPx) continue;
      const en = Math.max(bars[y].o, stopPx), ps = low - 0.25 * a5;
      const r = exitsR(bars, y, en, ps, T, flatMs);
      if (r) out.E2[key] = { m: Math.round((ms(bars[y].t) - T) / 60000), en: +en.toFixed(4), ...r };
      break;
    }
    // E3
    let low3 = Infinity;
    for (let x = j; x <= d; x++) low3 = Math.min(low3, bars[x].l);
    for (let y = d + 1; inWin(y); y++) {
      low3 = Math.min(low3, bars[y - 1].l);
      if (y < 3 || y + 1 >= bars.length || ms(bars[y + 1].t) >= flatMs) continue;
      if (!(bars[y].c > Math.max(bars[y - 1].h, bars[y - 2].h, bars[y - 3].h))) continue;
      low3 = Math.min(low3, bars[y].l);
      const en = bars[y + 1].o, ps = low3 - 0.25 * a5;
      const r = exitsR(bars, y + 1, en, ps, T, flatMs);
      if (r) out.E3[key] = { m: Math.round((ms(bars[y + 1].t) - T) / 60000), en: +en.toFixed(4), ...r };
      break;
    }
  }
  return out;
}

// Index of the first bar from the fill time that touched the plan stop (same rule as afterStop/stopDip).
export function stopBarIndex(bars, fillAt, stop) {
  for (let x = 0; x < bars.length; x++) if (ms(bars[x].t) >= fillAt && bars[x].l <= stop) return x;
  return -1;
}
