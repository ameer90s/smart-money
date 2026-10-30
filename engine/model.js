// Probability model: how often a setup reached k·R before its stop, learned from
// outcomes (historical replay + every live signal audited after the close).
// Empirical-Bayes smoothing toward a no-edge prior p0(r) = 1 / (1 + r).
import { readJSON, writeJSON } from './store.js';

const REL = 'model.json';
const K = 20;          // smoothing strength (pseudo-samples)
const MAX = 6000;      // samples kept
let M = null;

export function load() {
  if (!M) M = readJSON(REL, { v: 1, samples: [], calib: [], trainedAt: 0, sources: {} });
  return M;
}
export function save() { if (M) writeJSON(REL, M); }

const p0 = (r) => 1 / (1 + r);
export const todBucket = (minAfterOpen) => (minAfterOpen < 30 ? 'open' : minAfterOpen < 120 ? 'morning' : minAfterOpen < 240 ? 'midday' : 'late');
export const scoreBucket = (s) => (s >= 80 ? 'hi' : s >= 65 ? 'mid' : 'lo');

// sample: { setup, mfe (R reached before stop / close), score, tod, regime, src, day, sym }
export function addSample(s) {
  const m = load();
  m.samples.push(s);
  if (m.samples.length > MAX) m.samples.splice(0, m.samples.length - MAX);
  m.sources[s.src] = (m.sources[s.src] || 0) + 1;
}

function rate(list, r, prior) {
  const hits = list.reduce((a, s) => a + (s.mfe >= r ? 1 : 0), 0);
  return { p: (hits + K * prior) / (list.length + K), n: list.length };
}

export function prob(setup, r, feats = {}) {
  const all = load().samples;
  const g = rate(all, r, p0(r));
  const mine = all.filter((s) => s.setup === setup);
  const s = rate(mine, r, g.p);
  let adj = 1;
  const base15 = rate(all, 1.5, p0(1.5)).p;
  for (const [key, val] of [['score', feats.score], ['tod', feats.tod], ['regime', feats.regime]]) {
    if (val == null) continue;
    const sub = all.filter((x) => x[key] === val);
    if (sub.length < 15) continue;
    adj *= rate(sub, 1.5, base15).p / base15;
  }
  adj = Math.max(0.75, Math.min(1.3, adj));
  return { p: Math.max(0.02, Math.min(0.95, s.p * adj)), n: mine.length, nAll: all.length };
}

export function addCalib(pred, hit) {
  const m = load();
  m.calib.push({ p: +pred.toFixed(3), h: hit ? 1 : 0 });
  if (m.calib.length > 2000) m.calib.shift();
}

export function calibration() {
  const bins = [[0.4, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 1.01]];
  return bins.map(([lo, hi]) => {
    const xs = load().calib.filter((c) => c.p >= lo && c.p < hi);
    return { range: `${Math.round(lo * 100)}–${Math.min(100, Math.round(hi * 100))}%`, n: xs.length, hit: xs.length ? xs.reduce((a, c) => a + c.h, 0) / xs.length : null };
  }).filter((b) => b.n > 0);
}

export function perSetup() {
  const out = {};
  for (const s of load().samples) {
    const o = (out[s.setup] = out[s.setup] || { n: 0, t15: 0, mfe: 0 });
    o.n++; o.mfe += Math.min(s.mfe, 6); if (s.mfe >= 1.5) o.t15++;
  }
  for (const o of Object.values(out)) { o.t15 = o.n ? o.t15 / o.n : 0; o.mfe = o.n ? o.mfe / o.n : 0; }
  return out;
}

export function summary() {
  const m = load();
  return { n: m.samples.length, sources: m.sources, trainedAt: m.trainedAt, calib: calibration(), setups: perSetup() };
}

export function markTrained() { load().trainedAt = Date.now(); }
