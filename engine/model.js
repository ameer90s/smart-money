// Probability model: how often a setup reached k·R before its stop, learned from
// outcomes (historical replay + every live signal audited after the close).
// Empirical-Bayes smoothing toward a no-edge prior p0(r) = 1 / (1 + r).
import { readJSON, writeJSON } from './store.js';

const REL = 'model.json';
const K = 20;          // smoothing strength (pseudo-samples)
const MAX = 6000;      // samples kept
let M = null;

// One sample per source, day, symbol and setup; a re-run of the replay (or a restarted
// engine re-firing the same setup) must not count the same trade twice.
const keyOf = (s) => `${s.src}|${s.day}|${s.sym}|${s.setup}`;
let IDX = null;

function recount(m) {
  m.sources = {};
  for (const s of m.samples) m.sources[s.src] = (m.sources[s.src] || 0) + 1;
}

export function load() {
  if (!M) {
    M = readJSON(REL, { v: 1, samples: [], calib: [], trainedAt: 0, sources: {} });
    if (!M.replayed) { // files written before replay tracking: seed it from the samples
      M.replayed = {};
      for (const x of M.samples) if (x.src === 'backtest' && x.day && x.sym) M.replayed[`${x.day}|${x.sym}`] = 1;
    }
    IDX = new Set();
    const kept = [];
    for (const s of M.samples) {
      if (s.day && s.sym) { const k = keyOf(s); if (IDX.has(k)) continue; IDX.add(k); }
      kept.push(s);
    }
    if (kept.length !== M.samples.length) M.samples = kept;
    recount(M);
  }
  return M;
}
export function save() { if (M) writeJSON(REL, M); }

const p0 = (r) => 1 / (1 + r);
export const todBucket = (minAfterOpen) => (minAfterOpen < 30 ? 'open' : minAfterOpen < 120 ? 'morning' : minAfterOpen < 240 ? 'midday' : 'late');
export const scoreBucket = (s) => (s >= 80 ? 'hi' : s >= 65 ? 'mid' : 'lo');

// sample: { setup, mfe (R reached before stop / close), score, tod, regime, src, day, sym }
export function addSample(s) {
  const m = load();
  if (s.day && s.sym) {
    const k = keyOf(s);
    if (IDX.has(k)) return false;
    IDX.add(k);
  }
  m.samples.push(s);
  if (m.samples.length > MAX) {
    for (const x of m.samples.splice(0, m.samples.length - MAX)) if (x.day && x.sym) IDX.delete(keyOf(x));
    recount(m);
  } else m.sources[s.src] = (m.sources[s.src] || 0) + 1;
  return true;
}

// Which (day, symbol) pairs the historical replay already covered, so a full replay only
// fetches what is new. Capped to the newest few thousand pairs.
export function wasReplayed(day, sym) { return !!load().replayed[`${day}|${sym}`]; }
export function markReplayed(day, sym) {
  const m = load();
  m.replayed[`${day}|${sym}`] = 1;
  const keys = Object.keys(m.replayed);
  if (keys.length > 8000) {
    const cutoff = keys.map((k) => k.slice(0, 10)).sort().reverse()[7000];
    for (const k of keys) if (k.slice(0, 10) < cutoff) delete m.replayed[k];
  }
}
// Remove every sample from one source (used to retire the earlier hindsight-selected replay).
export function dropSource(src) {
  const m = load();
  const before = m.samples.length;
  m.samples = m.samples.filter((s) => s.src !== src);
  IDX = new Set(m.samples.filter((s) => s.day && s.sym).map(keyOf));
  recount(m);
  return before - m.samples.length;
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

// Expected result per trade in R (before fees) for setups with one fixed target: the average
// outcome of past cases, including time exits, shrunk toward zero edge, then adjusted for time
// of day and market regime where there are at least 30 cases.
export function expectancy(setup, feats = {}) {
  const all = load().samples.filter((s) => s.setup === setup && typeof s.r === 'number');
  const n = all.length;
  if (!n) return { ev: 0, n: 0, win: null };
  const mean = all.reduce((a, s) => a + s.r, 0) / n;
  let ev = (mean * n) / (n + K);
  for (const [key, val] of [['tod', feats.tod], ['regime', feats.regime]]) {
    if (val == null) continue;
    const sub = all.filter((x) => x[key] === val);
    if (sub.length < 30) continue;
    const m = sub.reduce((a, s) => a + s.r, 0) / sub.length;
    ev += (m * sub.length + mean * K) / (sub.length + K) - mean;
  }
  return { ev, n, win: all.filter((s) => s.r > 0).length / n };
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
