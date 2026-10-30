// Indicators on bar arrays [{t,o,h,l,c,v,vw}] (t = ISO or epoch ms).
export const ms = (t) => (typeof t === 'number' ? t : Date.parse(t));

export function vwapSeries(bars) {
  let pv = 0, v = 0;
  return bars.map((b) => {
    const px = b.vw || (b.h + b.l + b.c) / 3;
    pv += px * b.v; v += b.v;
    return v > 0 ? pv / v : b.c;
  });
}

export function emaSeries(values, n) {
  const k = 2 / (n + 1);
  let e = null;
  return values.map((x) => (e = e == null ? x : x * k + e * (1 - k)));
}

export function atr(bars, n = 14) {
  if (!bars.length) return 0;
  let a = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const pc = i ? bars[i - 1].c : b.o;
    const tr = Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
    a = a == null ? tr : (a * (n - 1) + tr) / n;
  }
  return a;
}

// Aggregate 1-minute bars into k-minute bars aligned to the session start (anchorMs).
export function aggregate(bars, k, anchorMs) {
  const out = [];
  let cur = null, key = null;
  for (const b of bars) {
    const t = ms(b.t);
    const kk = Math.floor((t - anchorMs) / (k * 60000));
    if (kk !== key) {
      if (cur) out.push(cur);
      key = kk;
      cur = { t: anchorMs + kk * k * 60000, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
    } else {
      cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export const lowest = (bars, n) => Math.min(...bars.slice(-n).map((b) => b.l));
export const highest = (bars, n) => Math.max(...bars.slice(-n).map((b) => b.h));
export const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
export const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export function percentile(a, p) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor((p / 100) * (s.length - 1))))];
}

// Cumulative share of a regular session's volume traded by minute m after the open
// (typical U-shaped intraday profile). Used to compare today's volume so far with an average day.
export function volumeShare(minAfterOpen) {
  const pts = [[0, 0], [5, 0.045], [15, 0.11], [30, 0.17], [60, 0.27], [90, 0.34], [120, 0.40], [180, 0.50], [240, 0.60], [300, 0.70], [360, 0.84], [390, 1]];
  const m = Math.max(0, Math.min(390, minAfterOpen));
  for (let i = 1; i < pts.length; i++) {
    const [m1, v1] = pts[i];
    const [m0, v0] = pts[i - 1];
    if (m <= m1) return v0 + ((v1 - v0) * (m - m0)) / (m1 - m0);
  }
  return 1;
}
