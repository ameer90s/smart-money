// Replays a plan on 1-minute bars with the same management rules as live recommendations.
// When a bar touches both the stop and a target, the stop is assumed first (conservative).
import { ms } from './indicators.js';

export function simulate(bars, fromMs, plan, { flatMs, timeStopMin = 60 } = {}) {
  const T = plan.targets.map((t) => t.price);
  const E = plan.entry, R = plan.R;
  let stop = plan.stop, t1 = false, t2 = false, t3 = false;
  let mfe = 0, mae = 0, stoppedOrig = false, minutesToT1 = null;
  let exit = null, reason = null, exitT = null;
  const half = 0.5;
  const full = plan.exit === 'full'; // single target: sell everything at target 1; time stop is unconditional
  for (const b of bars) {
    const t = ms(b.t);
    if (t < fromMs) continue;
    if (flatMs && t >= flatMs) { exit = b.o; reason = 'time'; exitT = t; break; }
    if (!stoppedOrig) {
      if (b.l <= plan.stop) stoppedOrig = true;
      else mfe = Math.max(mfe, (b.h - E) / R);
    }
    mae = Math.max(mae, (E - b.l) / R);
    if (full && (t - fromMs) / 60000 >= timeStopMin) { exit = b.o; reason = 'timestop'; exitT = t; break; }
    if (b.l <= stop) { exit = stop; reason = t1 ? 'be' : 'stop'; exitT = t; break; }
    if (full && b.h >= T[0]) { t1 = true; exit = T[0]; reason = 't1'; exitT = t; minutesToT1 = Math.round((t - fromMs) / 60000); break; }
    if (!t1 && b.h >= T[0]) { t1 = true; stop = E; minutesToT1 = Math.round((t - fromMs) / 60000); }
    if (t1 && !t2 && b.h >= T[1]) { t2 = true; stop = Math.max(stop, T[0]); }
    if (t2 && b.h >= T[2]) { t3 = true; exit = T[2]; reason = 't3'; exitT = t; break; }
    if (!t1 && (t - fromMs) / 60000 >= timeStopMin && b.c < E + 0.3 * R) { exit = b.c; reason = 'timestop'; exitT = t; break; }
  }
  if (exit == null) { const lb = bars[bars.length - 1]; exit = lb ? lb.c : E; reason = 'eod'; exitT = lb ? ms(lb.t) : fromMs; }
  // After a stop: did price go on to reach target 1 before the close? (stop inside the noise)
  let afterStopT1 = false;
  if (reason === 'stop') {
    for (const b of bars) {
      const t = ms(b.t);
      if (t <= exitT) continue;
      if (flatMs && t >= flatMs) break;
      if (b.h >= T[0]) { afterStopT1 = true; break; }
    }
  }
  const rGross = t1 && !full ? half * ((T[0] - E) / R) + half * ((exit - E) / R) : (exit - E) / R;
  return {
    mfe: +Math.min(mfe, 10).toFixed(2), mae: +mae.toFixed(2), stoppedOrig,
    t1, t2, t3, best: t3 ? 3 : t2 ? 2 : t1 ? 1 : 0, reason, exit: +exit.toFixed(4), exitT,
    minutesToT1, r: +rGross.toFixed(2), afterStopT1,
  };
}
