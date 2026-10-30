// Wide scan: one snapshot pass over the tradable universe, scored for intraday potential.
import { alpaca } from './alpaca.js';
import { volumeShare, percentile } from './indicators.js';
import { snapPrice, prevClose, isToday, isTodayDaily } from './market.js';

export function features(sym, snap, u, minAfterOpen, today) {
  if (!snap) return null;
  const price = snapPrice(snap);
  const pc = prevClose(snap, today) || u.pdc;
  if (!price || !pc) return null;
  const d = isTodayDaily(snap.dailyBar, today) ? snap.dailyBar : null;
  const vol = d ? d.v : 0;
  const expected = u.avgIexVol * volumeShare(Math.max(1, minAfterOpen));
  const rvol = expected > 0 ? vol / expected : null;
  const range = d ? d.h - d.l : 0;
  const q = snap.latestQuote;
  let spread = q && q.ap > 0 && q.bp > 0 && q.ap >= q.bp ? q.ap - q.bp : null;
  if (spread != null && spread > price * 0.05) spread = null; // crossed/stale quote
  if (spread != null) spread = +spread.toFixed(4);
  const mb = snap.minuteBar;
  const perMin = vol / Math.max(1, minAfterOpen);
  return {
    sym, price, pc,
    chg: (price / pc - 1) * 100,
    gap: d ? (d.o / pc - 1) * 100 : (price / pc - 1) * 100,
    vol, rvol,
    rangeAtr: u.atrD ? range / u.atrD : 0,
    vw: d ? d.vw : null,
    aboveVw: d && d.vw ? price > d.vw : null,
    posInRange: range > 0 ? (price - d.l) / range : 0.5,
    hod: d ? d.h : price,
    spread,
    accel: mb && perMin > 0 && isToday(mb, today) ? mb.v / perMin : null,
    atrD: u.atrD, pdh: u.pdh, sector: u.sh ? u.sh.sector : 'SPY', name: u.name,
  };
}

// 0–100. Buy-only: falling stocks score zero on change.
export function score(f, ctx = {}) {
  if (!f) return 0;
  const rv = f.rvol == null ? 0 : Math.min(1, Math.log2(Math.max(0, f.rvol) + 1) / Math.log2(6));
  const ch = Math.min(1, Math.max(0, f.chg) / 8);
  const rg = Math.min(1, f.rangeAtr / 1.5);
  const vw = f.aboveVw ? 1 : 0;
  const pos = f.posInRange >= 0.7 ? 1 : f.posInRange >= 0.5 ? 0.5 : 0;
  const news = ctx.news ? 1 : 0;
  const sec = ctx.sectorRel > 0 ? 1 : 0;
  const acc = f.accel != null ? Math.min(1, Math.max(0, (f.accel - 1) / 2)) : 0;
  return Math.round(30 * rv + 20 * ch + 12 * rg + 10 * vw + 10 * pos + 8 * news + 5 * sec + 5 * acc);
}

export function flags(f) {
  const out = [];
  if (f.rvol >= 3) out.push(`حجم نسبي ×${f.rvol.toFixed(1)}`);
  if (f.accel >= 2) out.push('تسارع الحجم');
  if (f.gap >= 3) out.push(`فجوة +${f.gap.toFixed(1)}%`);
  if (f.aboveVw) out.push('فوق VWAP');
  if (f.posInRange >= 0.85) out.push('قرب أعلى اليوم');
  return out;
}

export async function scan(universeList, extraSymbols, { minAfterOpen, today, sectorRel = {}, newsSet = new Set() }) {
  const bySym = Object.fromEntries(universeList.map((u) => [u.s, u]));
  const syms = [...new Set([...universeList.map((u) => u.s), ...extraSymbols.filter((s) => bySym[s])])];
  const t0 = Date.now();
  const snaps = await alpaca.snapshots(syms);
  const rows = [];
  for (const s of syms) {
    const f = features(s, snaps[s], bySym[s], minAfterOpen, today);
    if (!f) continue;
    f.score = score(f, { news: newsSet.has(s), sectorRel: sectorRel[f.sector] || 0 });
    f.flags = flags(f);
    rows.push(f);
  }
  rows.sort((a, b) => b.score - a.score);
  const active = rows.filter((r) => r.chg > 1 || (r.rvol || 0) > 1.5);
  return {
    ms: Date.now() - t0,
    scanned: rows.length,
    active: active.length,
    p90rvol: percentile(rows.map((r) => r.rvol || 0), 90),
    p90chg: percentile(rows.map((r) => r.chg), 90),
    top: rows.slice(0, 40),
    snaps,
  };
}
