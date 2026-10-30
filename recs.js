// Recommendations: guards, issuing, and managing each one until it closes (targets,
// stop moved to break-even after target 1, time stop, forced close before the bell).
import { DayCollection, readJSON, listDays, dayRel } from './store.js';
import { now, ny, hmToMin, addDays, dowOf } from './clock.js';
import { notify } from './notify.js';
import { VERSION, ENV } from './config.js';

const fmt = (x) => (x == null ? '—' : Number(x).toFixed(2));

export class Recs {
  constructor({ cfg, day, onEvent }) {
    this.cfg = cfg; this.day = day; this.onEvent = onEvent;
    this.col = new DayCollection(day, 'recs');
    this.cooldownUntil = 0;
  }

  all() { return this.col.all(); }
  active() { return this.all().filter((r) => r.status === 'active'); }

  stats() {
    const closed = this.all().filter((r) => r.status === 'closed');
    const net = closed.reduce((a, r) => a + (r.result ? r.result.net : 0), 0);
    let streak = 0;
    for (const r of [...closed].reverse()) { if (r.result && r.result.net < 0) streak++; else break; }
    return { issued: this.all().length, closed: closed.length, active: this.active().length, net: +net.toFixed(2), wins: closed.filter((r) => r.result.net > 0).length, losses: closed.filter((r) => r.result.net <= 0).length, lossStreak: streak };
  }

  guard(sym, cfgOverride = {}) {
    const cfg = { ...this.cfg, ...cfgOverride };
    const m = ny().min;
    const why = [];
    if (m < hmToMin(cfg.recFrom) || m > hmToMin(cfg.recTo)) why.push('window');
    const st = this.stats();
    if (st.issued >= cfg.maxRecsDay) why.push('max');
    if (st.net <= -cfg.dailyLossStop) why.push('dailyLoss');
    if (now() < this.cooldownUntil) why.push('cooldown');
    if (this.all().some((r) => r.sym === sym)) why.push('dup');
    return why;
  }

  issue({ it, setup, plan, feats, market, sh, events }) {
    const t = now();
    const rec = {
      id: `${this.day}-${it.sym}-${setup.type}`, day: this.day, sym: it.sym, name: it.name, version: VERSION,
      firedAt: t, firedNy: ny(t).hm, validUntil: t + 15 * 60000,
      setup: setup.type, label: setup.label, sector: it.sector,
      plan, status: 'active', stopNow: plan.stop, t1: false, t2: false, t3: false,
      maxP: plan.entry, minP: plan.entry, last: plan.entry,
      sh: sh ? { st: sh.st, why: sh.why, dr: sh.dr, cr: sh.cr } : null,
      reasons: reasonsOf(it, plan, feats, market),
      snapshot: { feats, ctx: ctxSnap(it.ctx), market, setup, scoreAtAdd: it.scoreAtAdd, watchAddedAt: it.addedAt, events: events || [] },
      timeline: [
        { t: it.addedAt, what: 'دخل قائمة المراقبة', note: `الدرجة ${it.scoreAtAdd}` },
        { t, what: 'صدرت التوصية', note: setup.label },
      ],
      user: null,
    };
    this.col.upsert(rec);
    this.col.flush();
    it.hasRec = true;
    this.onEvent('rec', { id: rec.id, sym: rec.sym, setup: rec.setup, entry: plan.entry, stop: plan.stop, t });
    const T = plan.targets;
    if (this.cfg.notifyRec) {
      notify({
        title: `توصية شراء ${rec.sym} · ${plan.label}`,
        message: `دخول ${fmt(plan.entry)} (حتى ${fmt(plan.maxBuy)}) · وقف ${fmt(plan.stop)}\nأهداف ${fmt(T[0].price)} (${Math.round(T[0].prob * 100)}%) · ${fmt(T[1].price)} (${Math.round(T[1].prob * 100)}%) · ${fmt(T[2].price)} (${Math.round(T[2].prob * 100)}%)`,
        priority: 5, tags: ['chart_with_upwards_trend'], click: ENV.appUrl ? `${ENV.appUrl}#rec=${encodeURIComponent(rec.id)}` : undefined,
      });
    }
    return rec;
  }

  closeRec(r, p, reason, t) {
    const sh = r.plan.sizing.shares;
    const half = r.t1 ? sh / 2 : 0;
    const rest = sh - half;
    const gross = (r.t1 ? half * (r.plan.targets[0].price - r.plan.entry) : 0) + rest * (p - r.plan.entry);
    const net = gross - r.plan.sizing.fees;
    const rMult = (gross / sh) / r.plan.R;
    r.status = 'closed';
    r.closedAt = t; r.exit = +p.toFixed(4); r.exitReason = reason;
    r.result = { net: +net.toFixed(2), r: +rMult.toFixed(2), best: r.t3 ? 3 : r.t2 ? 2 : r.t1 ? 1 : 0 };
    r.timeline.push({ t, what: reason, note: `الصافي ${net >= 0 ? '+' : ''}${net.toFixed(2)}$` });
    if (net < 0) {
      const st = this.stats();
      if (st.lossStreak >= this.cfg.cooldownLosses) this.cooldownUntil = t + 30 * 60000;
    }
    this.onEvent('rec_close', { id: r.id, sym: r.sym, reason, net: r.result.net, t });
    if (this.cfg.notifyMgmt) notify({ title: `${r.sym}: ${reason}`, message: `خروج ${fmt(p)} · الصافي ${net >= 0 ? '+' : ''}${net.toFixed(2)}$ (${rMult >= 0 ? '+' : ''}${rMult.toFixed(2)}R)`, priority: 4, tags: [net >= 0 ? 'white_check_mark' : 'x'] });
  }

  onPrice(sym, p, t) {
    for (const r of this.active().filter((x) => x.sym === sym)) {
      const P = r.plan, T = P.targets;
      r.last = p; r.maxP = Math.max(r.maxP, p); r.minP = Math.min(r.minP, p);
      if (p <= r.stopNow) { this.closeRec(r, r.stopNow, r.t1 ? 'وقف على التعادل' : 'ضرب الوقف', t); continue; }
      if (!r.t1 && p >= T[0].price) {
        r.t1 = true; r.stopNow = P.entry;
        r.timeline.push({ t, what: 'وصل الهدف 1', note: `بيع النصف · الوقف رُفع إلى ${fmt(P.entry)} (التعادل)` });
        if (this.cfg.notifyMgmt) notify({ title: `${sym}: وصل الهدف 1 ✓`, message: `${fmt(T[0].price)} · بِع النصف وارفع الوقف إلى ${fmt(P.entry)}`, priority: 4, tags: ['dart'] });
      }
      if (r.t1 && !r.t2 && p >= T[1].price) {
        r.t2 = true; r.stopNow = Math.max(r.stopNow, T[0].price);
        r.timeline.push({ t, what: 'وصل الهدف 2', note: `الوقف رُفع إلى ${fmt(T[0].price)}` });
        if (this.cfg.notifyMgmt) notify({ title: `${sym}: وصل الهدف 2 ✓`, message: `${fmt(T[1].price)} · الوقف إلى ${fmt(T[0].price)}`, priority: 4, tags: ['dart'] });
      }
      if (r.t2 && p >= T[2].price) { r.t3 = true; this.closeRec(r, T[2].price, 'وصل الهدف 3', t); continue; }
      const mins = (t - r.firedAt) / 60000;
      if (!r.t1 && mins >= this.cfg.timeStopMin && p < P.entry + 0.3 * P.R) this.closeRec(r, p, 'خروج زمني', t);
    }
    this.col.dirty = true;
  }

  flatten(priceOf, t) {
    for (const r of this.active()) this.closeRec(r, priceOf(r.sym) || r.last, 'إغلاق قبل نهاية الجلسة', t);
    this.col.flush();
  }

  markUserEntry(id, price) {
    const r = this.all().find((x) => x.id === id);
    if (r) { r.user = { entry: price, at: now() }; this.col.dirty = true; }
  }

  flush() { this.col.flush(); }
}

function ctxSnap(c) {
  if (!c) return null;
  return { vwap: +c.vwap.toFixed(4), a5: +c.a5.toFixed(4), hod: c.hod, lod: c.lod, pmHigh: c.pmHigh, pdh: c.pdh, orb15: c.orb15, orb5: c.orb5, minAfterOpen: Math.round(c.minAfterOpen), bars: c.rth.length };
}

function reasonsOf(it, plan, f, market) {
  const out = [];
  if (f.rvol != null) out.push({ k: 'الحجم النسبي لهذا الوقت', v: `×${f.rvol.toFixed(1)}`, good: f.rvol >= 2 });
  out.push({ k: 'البعد عن VWAP', v: `${plan.ext.toFixed(1)} ATR`, good: plan.ext <= 1.2 });
  out.push({ k: 'الوقف', v: `${plan.stopAtr.toFixed(1)} × ATR 5د`, good: true });
  if (market) out.push({ k: 'السوق SPY', v: `${market.spy.chg >= 0 ? '+' : ''}${market.spy.chg}% · ${market.spy.above ? 'فوق' : 'تحت'} VWAP`, good: market.regime !== 'down' });
  if (market && market.sectors && it.sector && market.sectors[it.sector] != null) out.push({ k: `القطاع ${it.sector}`, v: `${market.sectors[it.sector] >= 0 ? '+' : ''}${market.sectors[it.sector]}% مقابل SPY`, good: market.sectors[it.sector] >= 0 });
  out.push({ k: 'السبريد مقابل R', v: `${(plan.spread * 100).toFixed(0)}¢ = ${Math.round((plan.spread / plan.R) * 100)}% من R`, good: plan.spread / plan.R < 0.1 });
  out.push({ k: 'الهدف 1 مقابل التكلفة', v: `${((plan.targets[0].price - plan.entry) * plan.sizing.shares / plan.sizing.fees).toFixed(1)} أضعاف العمولة`, good: true });
  if (it.why && it.why.length) out.push({ k: 'إشارات الزخم', v: it.why.slice(0, 3).join(' · '), good: true });
  return out;
}

// Week-to-date stats across day files (Mon–Fri of the current NY week).
export function weekStats(today) {
  const w = dowOf(today);
  const monday = addDays(today, -((w + 6) % 7));
  const days = listDays().filter((d) => d >= monday && d <= today);
  let net = 0, trades = 0, wins = 0, losses = 0, peak = 0, equity = 0, dd = 0;
  for (const d of days) {
    for (const r of readJSON(dayRel(d, 'recs.json'), [])) {
      if (r.status !== 'closed' || !r.result) continue;
      trades++; net += r.result.net; equity += r.result.net;
      if (r.result.net > 0) wins++; else losses++;
      peak = Math.max(peak, equity); dd = Math.max(dd, peak - equity);
    }
  }
  return { from: monday, net: +net.toFixed(2), trades, wins, losses, ddUsd: +dd.toFixed(2) };
}
