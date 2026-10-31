// Week ahead: US economic releases (Forex Factory weekly feed, free), earnings of
// universe names (Finnhub), and the session calendar. Outcomes are recorded after each event.
import { ENV } from './config.js';
import { request } from './http.js';
import { finnhub } from './finnhub.js';
import { alpaca } from './alpaca.js';
import { ny, addDays, dowOf, now, isoNy } from './clock.js';
import { readJSON, writeJSON } from './store.js';
import { warn } from './log.js';

const AR = [
  [/non-farm|nonfarm/i, 'تقرير الوظائف'], [/unemployment rate/i, 'معدل البطالة'], [/unemployment claims/i, 'طلبات إعانة البطالة'],
  [/core cpi/i, 'التضخم الأساسي CPI'], [/\bcpi\b/i, 'التضخم CPI'], [/\bppi\b/i, 'أسعار المنتجين PPI'], [/pce/i, 'مؤشر PCE'],
  [/fomc|federal funds/i, 'قرار الفيدرالي'], [/fed chair|powell/i, 'خطاب رئيس الفيدرالي'], [/ism manufacturing/i, 'ISM الصناعي'],
  [/ism services/i, 'ISM الخدمي'], [/retail sales/i, 'مبيعات التجزئة'], [/gdp/i, 'الناتج المحلي'], [/consumer confidence|sentiment/i, 'ثقة المستهلك'],
  [/jolts/i, 'فرص العمل JOLTS'], [/adp/i, 'وظائف ADP'], [/durable goods/i, 'السلع المعمرة'],
];
const arTitle = (t) => { for (const [re, a] of AR) if (re.test(t)) return a; return t; };

export function weekStart(today) { return addDays(today, -((dowOf(today) + 6) % 7)); }

export async function buildWeek(today, universeSyms = []) {
  const monday = weekStart(today);
  const friday = addDays(monday, 4);
  const out = { week: monday, builtAt: now(), econ: [], earnings: {}, sessions: [] };
  try {
    const ff = await request(ENV.ffUrl, { perMin: 5, tries: 2 });
    for (const e of ff || []) {
      if (e.country !== 'USD' || !['High', 'Medium'].includes(e.impact)) continue;
      const t = Date.parse(e.date);
      out.econ.push({ t, day: ny(t).ymd, hm: ny(t).hm, title: e.title, ar: arTitle(e.title), impact: e.impact === 'High' ? 'high' : 'mid', forecast: e.forecast || '', previous: e.previous || '', result: null });
    }
  } catch (e) { warn('ff calendar', e); }
  if (finnhub.enabled()) {
    try {
      const set = new Set(universeSyms);
      const r = await finnhub.earnings(monday, friday);
      for (const x of (r && r.earningsCalendar) || []) if (set.has(x.symbol)) (out.earnings[x.date] = out.earnings[x.date] || []).push({ sym: x.symbol, hour: x.hour || '' });
    } catch (e) { warn('earnings', e); }
  }
  try {
    const cal = await alpaca.calendar(monday, friday);
    out.sessions = (cal || []).map((d) => ({ date: d.date, open: d.open, close: d.close }));
  } catch (e) { warn('calendar', e); }
  writeJSON(`weekly/${monday}.json`, out);
  return out;
}

export function loadWeek(today) { return readJSON(`weekly/${weekStart(today)}.json`, null); }

// Analyst rules for the week: smaller size before 10:30 and a stricter threshold on high-impact days.
export function dayRules(week, today) {
  const ev = ((week && week.econ) || []).filter((e) => e.day === today && e.impact === 'high');
  const earn = ((week && week.earnings[today]) || []).map((x) => x.sym);
  return { highImpact: ev.length > 0, events: ev.map((e) => `${e.hm} ${e.ar}`), halfSizeUntil: ev.length ? '10:30' : null, probBoost: ev.length ? 0.05 : 0, earningsToday: earn };
}

// After each event, record SPY's move over the following 30 minutes.
export async function recordOutcomes(week) {
  if (!week) return false;
  let changed = false;
  for (const e of week.econ) {
    // Consolidated (SIP) bars are served once they are over 15 minutes old: wait 30 + 16 minutes.
    if ((e.result && e.result.src === 'sip') || now() < e.t + 47 * 60000) continue; // older IEX-based results are re-measured
    try {
      // Pre-market releases are measured on the opening half hour; others from the release time.
      const pre = e.hm < '09:30';
      const t0 = pre ? Date.parse(isoNy(e.day, '09:30')) : e.t;
      if (now() < t0 + 47 * 60000) continue;
      const start = new Date(t0).toISOString();
      const end = new Date(t0 + 29 * 60000).toISOString(); // 30 one-minute bars: open at t0 to close at t0+30
      const bars = (await alpaca.bars(['SPY'], { timeframe: '1Min', start, end, feed: 'sip' })).SPY || [];
      if (bars.length >= 2) {
        const mv = (bars[bars.length - 1].c / bars[0].o - 1) * 100;
        e.result = { spy30: +mv.toFixed(2), from: ny(Date.parse(bars[0].t)).hm, to: ny(Date.parse(bars[bars.length - 1].t)).hm, src: 'sip' };
        changed = true;
      }
    } catch (err) { warn('event outcome', err); }
  }
  if (changed) writeJSON(`weekly/${week.week}.json`, week);
  return changed;
}
