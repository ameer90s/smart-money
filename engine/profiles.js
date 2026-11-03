// Shadow tracking of the best lab setting for each pattern. A live signal that matches its
// pattern's profile is tagged; after the close the profile's own exit is replayed on full (SIP)
// bars and the result is kept in profiles.json. Profiles never issue recommendations.
import { simulate } from './simulate.js';
import { readJSON, writeJSON } from './store.js';

const STRUCTURAL = new Set(['stop', 'spread', 'ext']);

export function matchProfile(cfg, { setup, plan, minAfterOpen, feats = {}, regime }) {
  if ((plan.fails || []).some((f) => STRUCTURAL.has(f))) return null;
  for (const p of cfg.profiles || []) {
    if (p.setup !== setup) continue;
    if (p.tod && !(minAfterOpen >= p.tod[0] && minAfterOpen < p.tod[1])) continue;
    if (p.regime && !p.regime.includes(regime)) continue;
    if (p.regimeNot && p.regimeNot.includes(regime)) continue;
    if (p.minRvol != null && !((feats.rvol || 0) >= p.minRvol)) continue;
    if (p.maxRvol != null && !((feats.rvol || 0) < p.maxRvol)) continue;
    if (p.minChg != null && !((feats.chg || 0) >= p.minChg)) continue;
    if (p.maxExt != null && !(plan.ext < p.maxExt)) continue;
    return p.id;
  }
  return null;
}

// The profile's exit on one signal: 'mgmt' is the normal plan; 'rK' sells everything at K·R
// (with an optional wider stop in 5-minute ATRs) and exits at market after the time stop.
export function profileSim(bars, firedAt, plan, prof, { flatMs, timeStopMin }) {
  if (!prof || prof.exit === 'mgmt') return simulate(bars, firedAt, plan, { flatMs, timeStopMin });
  const k = Number(prof.exit.slice(1)) / (prof.exit === 'r15' ? 10 : 1);
  const R = Math.max(plan.R, prof.stopAtr ? prof.stopAtr * (plan.atr5 || 0) : 0);
  const fixed = { ...plan, R, stop: plan.entry - R, exit: 'full', targets: [k, k + 0.5, k + 1.5].map((x) => ({ price: plan.entry + x * R })) };
  return simulate(bars, firedAt, fixed, { flatMs, timeStopMin });
}

// Append audited, profile-tagged signals to the running log (one entry per signal id).
export function recordProfiles(cfg, signals) {
  const log = readJSON('profiles.json', {});
  for (const p of cfg.profiles || []) log[p.id] = { ...(log[p.id] || { trades: [] }), setup: p.setup, desc: p.desc, lab: p.lab, exit: p.exit };
  let added = 0;
  for (const s of signals) {
    if (!s.profile || !s.profileSim || !log[s.profile]) continue;
    const L = log[s.profile].trades;
    if (L.some((x) => x.id === s.id)) continue;
    L.push({ id: s.id, day: s.day, sym: s.sym, t: s.firedNy, r: s.profileSim.r, reason: s.profileSim.reason, best: s.profileSim.best, accepted: !!s.accepted });
    added++;
  }
  writeJSON('profiles.json', log);
  return added;
}

export function profilesSummary(cfg) {
  const log = readJSON('profiles.json', {});
  return (cfg.profiles || []).map((p) => {
    const T = (log[p.id] && log[p.id].trades) || [];
    const n = T.length;
    return { id: p.id, setup: p.setup, desc: p.desc, lab: p.lab, exit: p.exit, n, avgR: n ? +(T.reduce((a, x) => a + x.r, 0) / n).toFixed(3) : null, win: n ? +(T.filter((x) => x.r > 0).length / n).toFixed(3) : null, last: T.slice(-5) };
  });
}
