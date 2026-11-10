// Market state from SPY one-minute bars: trend up, trend down, sideways, or choppy.
// It sits next to the old three-way regime (up/flat/down), which still drives live decisions,
// so history and every existing gate stay valid. The state is recorded with each signal,
// sample and lab row so the analysis can learn the best setup and settings per state.
//
// Everything is measured over the last hour of 5-minute samples (or since the open if
// shorter), identically in live and in replay:
//   er      efficiency ratio: net move / total path (1 = straight line, 0 = round trip)
//   amp     high-low range of the window, % of the previous close
//   crosses how many times price crossed the day's VWAP inside the window
import { ms } from './indicators.js';

export const STATES = ['trendUp', 'trendDown', 'range', 'choppy'];
export const STATE_AR = { trendUp: 'اتجاه صاعد', trendDown: 'اتجاه هابط', range: 'جانبي', choppy: 'متذبذب بشدة' };

export const STATE_CFG = {
  step: 5, // minutes per sample
  window: 60, // minutes looked back
  minSamples: 6, // no state before 30 minutes of trading
  trendEr: 0.35, // er at or above this is a trend
  choppyCrosses: 3, // VWAP crossings that mark a choppy tape...
  choppyAmp: 0.25, // ...when the swings are also big enough to matter (% of previous close)
};

// spy: 1-minute bars; pc: previous close; t: decision time (ms); openMs: session open (ms).
// Only bars that closed before t are used. Returns null before enough data exists.
export function marketState(spy, pc, t, openMs, cfg = STATE_CFG) {
  if (!spy || !spy.length || !pc) return null;
  const bars = [];
  for (const b of spy) {
    const bt = ms(b.t);
    if (bt < openMs) continue;
    if (bt + 60000 > t) break;
    bars.push(b);
  }
  if (bars.length < cfg.step * cfg.minSamples) return null;
  let cumV = 0, cumPV = 0;
  const samples = [];
  let hi = -Infinity, lo = Infinity;
  bars.forEach((b, i) => {
    cumV += b.v || 0; cumPV += (b.vw || b.c) * (b.v || 0);
    hi = Math.max(hi, b.h); lo = Math.min(lo, b.l);
    if ((i + 1) % cfg.step === 0 || i === bars.length - 1) {
      samples.push({ c: b.c, vw: cumV ? cumPV / cumV : b.c, h: hi, l: lo });
      hi = -Infinity; lo = Infinity;
    }
  });
  const n = Math.round(cfg.window / cfg.step);
  const w = samples.slice(Math.max(0, samples.length - 1 - n));
  let path = 0, crosses = 0, prevSide = 0;
  for (let i = 0; i < w.length; i++) {
    if (i) path += Math.abs(w[i].c - w[i - 1].c);
    const side = Math.sign(w[i].c - w[i].vw);
    if (side && prevSide && side !== prevSide) crosses++;
    if (side) prevSide = side;
  }
  const net = w[w.length - 1].c - w[0].c;
  const er = path ? Math.abs(net) / path : 0;
  const amp = ((Math.max(...w.map((x) => x.h)) - Math.min(...w.map((x) => x.l))) / pc) * 100;
  let state;
  if (er >= cfg.trendEr) state = net >= 0 ? 'trendUp' : 'trendDown';
  else if (crosses >= cfg.choppyCrosses && amp >= cfg.choppyAmp) state = 'choppy';
  else state = 'range';
  return { state, er: +er.toFixed(2), amp: +amp.toFixed(2), crosses, net: +((net / pc) * 100).toFixed(2) };
}

// The state at every 5 minutes of a finished session (for the day's market timeline).
export function stateTimeline(spy, pc, openMs, closeMs, cfg = STATE_CFG) {
  const out = [];
  for (let t = openMs + cfg.step * cfg.minSamples * 60000; t <= closeMs; t += cfg.step * 60000) {
    const s = marketState(spy, pc, t, openMs, cfg);
    if (s) out.push({ t, ...s });
  }
  return out;
}
