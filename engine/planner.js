// Turns an armed setup into a trade plan: structural stop clamped by ATR, targets from
// real price levels, probabilities per target, sizing for the virtual account, costs.
import * as model from './model.js';

const round = (x, d = 2) => +x.toFixed(d);

function roundLevels(entry, upTo) {
  const step = entry < 10 ? 0.5 : entry < 50 ? 1 : entry < 200 ? 5 : 10;
  const out = [];
  for (let x = Math.ceil(entry / step) * step; x <= upTo; x += step) if (x > entry) out.push({ p: x, why: 'رقم صحيح' });
  return out;
}

// setup: from detect(); ctx: buildCtx(); q: { spread, price }; feats: { score, regime, rvol }
export function plan(setup, ctx, q, cfg, feats = {}) {
  const fails = [];
  const a = ctx.a5;
  const entry = setup.trigger;
  let stop = setup.stopStruct;
  let R = entry - stop;
  const spread = Math.max(0.01, q.spread || 0.01);
  const minAtr = (cfg.stopAtrMinBy && cfg.stopAtrMinBy[setup.type]) || cfg.stopAtrMin;
  const minR = Math.max(minAtr * a, 2 * spread, entry * 0.0025);
  if (R < minR) { R = minR; stop = entry - R; }
  if (R > cfg.stopAtrMax * a) fails.push('stop');            // structure too far away
  if (spread / entry * 100 > cfg.spreadMaxPct || spread / R > cfg.spreadMaxR) fails.push('spread');
  if (setup.ext > cfg.extMaxAtr5) fails.push('ext');

  const shares = Math.max(0, Math.floor((cfg.capital / entry) * 100) / 100);
  const fees = 2 * cfg.feePerSide;
  const costPerShare = shares > 0 ? fees / shares + spread : Infinity;
  const costR = costPerShare / R;

  // Candidate target levels above entry.
  const lv = [];
  if (ctx.hod > entry + 0.5 * R) lv.push({ p: ctx.hod, why: 'أعلى اليوم' });
  if (ctx.pmHigh && ctx.pmHigh > entry + 0.5 * R) lv.push({ p: ctx.pmHigh, why: 'أعلى ما قبل الافتتاح' });
  if (ctx.pdh && ctx.pdh > entry + 0.5 * R) lv.push({ p: ctx.pdh, why: 'أعلى اليوم السابق' });
  if (setup.mm) lv.push({ p: setup.mm, why: 'حركة مقاسة لطول الدفعة' });
  lv.push(...roundLevels(entry, entry + 6 * R));
  lv.sort((x, y) => x.p - y.p);
  const pick = (loR, hiR, fallbackR, fallbackWhy) => {
    const c = lv.find((x) => x.p >= entry + loR * R && x.p <= entry + hiR * R);
    return c ? { p: c.p, why: c.why } : { p: entry + fallbackR * R, why: fallbackWhy };
  };
  // Fixed single target (sell everything at k·R), as tested in the lab; T2/T3 are shown for information.
  const fixedK = cfg.fixedR && cfg.fixedR[setup.type];
  let t1, t2, t3;
  if (fixedK) {
    t1 = { p: entry + fixedK * R, why: `هدف ثابت ${fixedK}R (بيع كامل)` };
    t2 = { p: entry + (fixedK + 0.5) * R, why: 'مستوى أعلى · للمعلومة' };
    t3 = { p: entry + (fixedK + 1.5) * R, why: 'مستوى أعلى · للمعلومة' };
  } else {
    const minT1 = cfg.rrMinNet + costR;
    t1 = pick(minT1, Math.max(minT1 + 1.2, 3), minT1, 'مضاعف المخاطرة');
    const r1 = (t1.p - entry) / R;
    t2 = pick(r1 + 0.8, 5, Math.max(2.5, r1 + 1), 'مضاعف المخاطرة');
    const r2 = (t2.p - entry) / R;
    t3 = pick(r2 + 1, 7, Math.max(4, r2 + 1.5), 'امتداد ATR');
  }

  const fe = { score: model.scoreBucket(feats.score || 0), tod: model.todBucket(ctx.minAfterOpen), regime: feats.regime };
  const targets = [t1, t2, t3].map((t, i) => {
    const r = (t.p - entry) / R;
    const pr = model.prob(setup.type, r, fe);
    const netR = r - costR;
    return {
      k: i + 1, price: round(t.p), r: round(r), pct: round(((t.p - entry) / entry) * 100), why: t.why,
      prob: round(pr.p, 3), n: pr.n, netR: round(netR),
      netUsd: round(shares * (t.p - entry) - fees),
      ev: round(pr.p * netR - (1 - pr.p) * (1 + costR)),
    };
  });
  let best = targets.reduce((b, t) => (t.ev > b.ev ? t : b), targets[0]);
  if (fixedK) {
    // One exit at k·R: break-even win rate is 1/(1+k) before costs. Trial week judges the edge
    // before fees (they are still charged in the result); otherwise after fees.
    best = targets[0];
    const p1 = targets[0].prob;
    const evGross = p1 * fixedK - (1 - p1);
    const ev = cfg.trialGross ? evGross : targets[0].ev;
    targets[0].evGross = round(evGross, 3);
    if ((t1.p - entry) < cfg.costMult * costPerShare) fails.push('cost');
    if (p1 < 1 / (1 + fixedK) + 0.02) fails.push('prob');
    if (ev < 0.05) fails.push('ev');
  } else {
    if (targets[0].netR < cfg.rrMinNet) fails.push('rr');
    if ((t1.p - entry) < cfg.costMult * costPerShare) fails.push('cost');
    if (targets[0].prob < cfg.probMinT1) fails.push('prob');
    if (best.ev < cfg.evMin) fails.push('ev');
  }

  return {
    setup: setup.type, label: setup.label,
    entry: round(entry), maxBuy: round(entry + 0.2 * R), stop: round(stop), R: round(R, 3),
    rPct: round((R / entry) * 100), atr5: round(a, 3), stopAtr: round(R / a),
    targets, expected: best.k, ev: fixedK && cfg.trialGross ? targets[0].evGross : best.ev, exit: fixedK ? 'full' : 'scale',
    stopProb: round(1 - targets[0].prob, 3),
    sizing: { shares, cost: round(shares * entry), riskUsd: round(shares * R + fees), fees },
    costR: round(costR, 3), spread: round(spread, 4), ext: round(setup.ext),
    ok: fails.length === 0, fails,
  };
}
