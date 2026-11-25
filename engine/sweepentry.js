// Sweep entry arms (lab only, measurement, no live change). For one swept-and-reclaimed level, compare three ways to buy:
//   A  at the reclaim (the live-style trigger above the reclaim bar, stop under the sweep low)
//   B  a resting buy order UNDER the sweep low (waits for a deeper dip), stop half an ATR(5m) below the order
//   C  a resting buy order half way between the sweep low and the reclaim trigger, stop under the sweep low
// Each arm is scored with fixed targets of 1R / 1.5R / 2R. A resting order is valid for `waitBars` minutes after the signal; the bar that
// fills it is not used for the exit, except that a stop touched in the same bar counts as a stop.
const ms = (t) => Date.parse(t);

function resting(bars, i, limit, stop, waitBars, timeStopMin, flatMs, simFixed) {
  for (let j = i + 1; j <= Math.min(i + waitBars, bars.length - 2); j++) {
    const b = bars[j];
    if (ms(b.t) >= flatMs) return null;
    if (b.l > limit) continue;
    const entry = Math.min(limit, b.o);
    const R = entry - stop;
    if (!(R > 0)) return null;
    const mk = (r1, r15, r2) => [r1, r15, r2, +R.toFixed(4), j - i];
    if (b.l <= stop) return mk(-1, -1, -1);
    const from = ms(bars[j + 1].t);
    return mk(...[1, 1.5, 2].map((k) => +simFixed(bars, from, entry, stop, entry + k * R, timeStopMin, flatMs).toFixed(3)));
  }
  return null;
}

// st: the SWEEP setup { trigger, stopStruct } from sweepReclaim; a5: ATR of 5-minute bars. Returns { A, B, C }, each [r1, r15, r2, R, minutesToFill] or null when never filled.
export function sweepArms(bars, i, st, a5, { timeStopMin = 60, flatMs, waitBars = 30, simFixed }) {
  const lowK = st.stopStruct + 0.1 * a5;
  const out = { A: null, B: null, C: null };
  // A: same fill rule as the lab (signal bar + up to 3 bars, trigger must trade, no gap above 0.25R)
  const R0 = st.trigger - st.stopStruct;
  for (let j = i + 1; j <= Math.min(i + 3, bars.length - 2); j++) {
    const b = bars[j];
    if (b.h < st.trigger) continue;
    if (b.o > st.trigger + 0.25 * R0) break;
    if (ms(b.t) >= flatMs) break;
    out.A = [...[1, 1.5, 2].map((k) => +simFixed(bars, ms(b.t), st.trigger, st.stopStruct, st.trigger + k * R0, timeStopMin, flatMs).toFixed(3)), +R0.toFixed(4), j - i];
    break;
  }
  const lb = lowK - 0.1 * a5;
  out.B = resting(bars, i, lb, lb - 0.5 * a5, waitBars, timeStopMin, flatMs, simFixed);
  out.C = resting(bars, i, (st.trigger + lowK) / 2, st.stopStruct, waitBars, timeStopMin, flatMs, simFixed);
  return out;
}
