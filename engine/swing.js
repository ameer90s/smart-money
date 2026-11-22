// Swing study: would holding for days instead of minutes give an edge? Pure function over daily bars (long only).
// Entry at the next day's open after the signal close, stop at 2 ATR (checked on daily lows, gaps fill at the open), exit at the close of day H.
// Costs: round trip 2 x fee on the position + 0.05% spread. One position per stock at a time. Excess = net minus the same-hold baseline (every stock, same dates).
export const HOLDS = [1, 3, 5, 10];
const SPREAD_PCT = 0.05;

function prep(bars) {
  const n = bars.length, atr = new Array(n).fill(null), av = new Array(n).fill(null), ema = new Array(n).fill(null);
  let e = bars[0].c;
  for (let i = 0; i < n; i++) {
    e = i === 0 ? bars[0].c : bars[i].c * (2 / 51) + e * (1 - 2 / 51);
    if (i >= 50) ema[i] = e;
    if (i >= 14) {
      let t = 0;
      for (let j = i - 13; j <= i; j++) t += Math.max(bars[j].h - bars[j].l, Math.abs(bars[j].h - bars[j - 1].c), Math.abs(bars[j].l - bars[j - 1].c));
      atr[i] = t / 14;
    }
    if (i >= 20) { let v = 0; for (let j = i - 20; j < i; j++) v += bars[j].v; av[i] = v / 20; }
  }
  return { atr, av, ema };
}

export function swingStudy(daily, { feePerSide = 1, capital = 1000, minPrice = 5, spy = null } = {}) {
  // Market regime on the signal date: SPY close above its 50-day EMA ('up') or not.
  const upDay = {};
  if (spy && spy.length > 60) { let e = spy[0].c; spy.forEach((b, i) => { e = i === 0 ? b.c : b.c * (2 / 51) + e * (1 - 2 / 51); if (i >= 50) upDay[b.t.slice(0, 10)] = b.c > e; }); }
  const cost = ((2 * feePerSide) / capital) * 100 + SPREAD_PCT;
  const syms = Object.keys(daily).filter((s) => (daily[s] || []).length > 60);
  const info = {};
  for (const s of syms) info[s] = prep(daily[s]);
  // 20-day return threshold (top 10%) per date for the relative-strength rule.
  const byDate = {};
  for (const s of syms) daily[s].forEach((b, i) => { if (i >= 20) (byDate[b.t.slice(0, 10)] = byDate[b.t.slice(0, 10)] || []).push(b.c / daily[s][i - 20].c - 1); });
  const rsCut = {};
  for (const [d, v] of Object.entries(byDate)) if (v.length >= 20) { v.sort((a, b) => a - b); rsCut[d] = v[Math.floor(v.length * 0.9)]; }

  const RULES = {
    base: () => true,
    brk20: (b, i, I, bars) => i >= 20 && b.c > Math.max(...bars.slice(i - 20, i).map((x) => x.h)) && b.v > 1.5 * I.av[i],
    pullback: (b, i, I, bars) => i >= 50 && I.ema[i] && b.c > I.ema[i] && bars[i].c < bars[i - 1].c && bars[i - 1].c < bars[i - 2].c && bars[i - 2].c < bars[i - 3].c,
    gapup: (b, i, I, bars) => i >= 20 && b.o / bars[i - 1].c >= 1.03 && b.c > b.o && b.v > 1.5 * I.av[i],
    strong20: (b, i, I, bars) => i >= 20 && rsCut[b.t.slice(0, 10)] != null && b.c / bars[i - 20].c - 1 >= rsCut[b.t.slice(0, 10)],
  };
  const dates = [...new Set(syms.flatMap((s) => daily[s].map((b) => b.t.slice(0, 10))))].sort();
  const split = dates[Math.floor(dates.length * 0.7)];
  const trades = {}; // rule -> H -> [{d, net}]
  for (const r of Object.keys(RULES)) { trades[r] = {}; for (const H of HOLDS) trades[r][H] = []; }
  for (const s of syms) {
    const bars = daily[s], I = info[s];
    for (const r of Object.keys(RULES)) for (const H of HOLDS) {
      let free = 0;
      for (let i = 60; i < bars.length - H - 1; i++) {
        if (i < free || !I.atr[i] || bars[i].c < minPrice || !RULES[r](bars[i], i, I, bars)) continue;
        const entry = bars[i + 1].o, stop = entry - 2 * I.atr[i];
        if (!(entry > 0) || stop <= 0) continue;
        let exit = bars[i + H].c;
        for (let j = i + 1; j <= i + H; j++) if (bars[j].l <= stop) { exit = Math.min(stop, bars[j].o); break; }
        trades[r][H].push({ d: bars[i + 1].t.slice(0, 10), up: upDay[bars[i].t.slice(0, 10)], net: (exit / entry - 1) * 100 - cost });
        free = i + H + 1;
      }
    }
  }
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y.net, 0) / a.length : null);
  const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y.net - m) ** 2, 0) / (a.length - 1)); };
  const rnd = (x) => (x == null ? null : +x.toFixed(3));
  const out = { cost: +cost.toFixed(3), split, dates: [dates[0], dates[dates.length - 1]], symbols: syms.length, regime: Object.keys(upDay).length > 0, rules: {} };
  const stats = (t, b) => {
    const part = (arr, f) => arr.filter((x) => f(x.d));
    const tr = part(t, (d) => d < split), te = part(t, (d) => d >= split);
    const btr = mean(part(b, (d) => d < split)), bte = mean(part(b, (d) => d >= split));
    const ex = (a, bm) => (mean(a) == null || bm == null ? null : mean(a) - bm);
    const se = te.length > 1 ? sd(te) / Math.sqrt(te.length) : null;
    // Months where the rule beat the baseline of the same month (needs 20+ trades in both).
    const months = {}; for (const x of t) (months[x.d.slice(0, 7)] = months[x.d.slice(0, 7)] || { t: [], b: [] }).t.push(x);
    for (const x of b) if (months[x.d.slice(0, 7)]) months[x.d.slice(0, 7)].b.push(x);
    const ok = Object.values(months).filter((m) => m.t.length >= 20 && m.b.length >= 20);
    return {
      n: t.length, net: rnd(mean(t)), win: t.length ? +(t.filter((x) => x.net > 0).length / t.length).toFixed(3) : null,
      trainN: tr.length, trainNet: rnd(mean(tr)), trainExcess: rnd(ex(tr, btr)),
      testN: te.length, testNet: rnd(mean(te)), testExcess: rnd(ex(te, bte)), testSe: rnd(se),
      monthsBeat: ok.filter((m) => mean(m.t) > mean(m.b)).length, monthsTotal: ok.length,
    };
  };
  for (const r of Object.keys(RULES)) {
    out.rules[r] = {};
    for (const H of HOLDS) {
      const t = trades[r][H], b = trades.base[H];
      out.rules[r][H] = stats(t, b);
      if (out.regime) out.rules[r][H].up = stats(t.filter((x) => x.up === true), b.filter((x) => x.up === true));
      if (out.regime) out.rules[r][H].down = stats(t.filter((x) => x.up === false), b.filter((x) => x.up === false));
    }
  }
  return out;
}
