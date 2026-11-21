// Catalyst archive: Finnhub news and earnings are only served live, so keep them per day to be able to test
// "stock with a catalyst" setups later. Also a one-off probe of how much history Finnhub gives us.
import { readJSON, writeJSON } from './store.js';
import { loadUniverse, tradable } from './universe.js';
import { finnhub } from './finnhub.js';
import { addDays } from './clock.js';
import { warn } from './log.js';

const MAX_SYMS = 60;
const clip = (s, n) => String(s || '').slice(0, n);

// Symbols that were on the watchlist or fired a signal that day.
export function daySymbols(day) {
  const set = new Set();
  for (const f of ['signals', 'watch']) for (const r of readJSON(`days/${day}/${f}.json`, []) || []) if (r && r.sym) set.add(r.sym);
  return [...set].slice(0, MAX_SYMS);
}

const compactNews = (list) => (Array.isArray(list) ? list : []).slice(0, 25).map((n) => ({ t: n.datetime ? n.datetime * 1000 : null, h: clip(n.headline, 160), s: clip(n.source, 30) }));
const compactEarn = (x) => ({ sym: x.symbol, hour: x.hour || '', epsA: x.epsActual ?? null, epsE: x.epsEstimate ?? null, revA: x.revenueActual ?? null, revE: x.revenueEstimate ?? null });

export async function archiveCatalysts(day, fh = finnhub) {
  if (!fh.enabled()) return null;
  const out = { day, news: {}, earnings: [] };
  for (const s of daySymbols(day)) {
    try { const n = compactNews(await fh.news(s, day, day)); if (n.length) out.news[s] = n; } catch (e) { warn(`archive news ${s}`, e); }
  }
  try {
    const u = loadUniverse();
    const set = new Set(u ? tradable(u, true).map((x) => x.s) : []);
    const r = await fh.earnings(day, day);
    out.earnings = ((r && r.earningsCalendar) || []).filter((x) => !set.size || set.has(x.symbol)).map(compactEarn);
  } catch (e) { warn('archive earnings', e); }
  writeJSON(`days/${day}/catalyst.json`, out);
  return out;
}

// How far back does the free Finnhub plan serve company news and the earnings calendar (with actual vs estimate)?
export async function probeFinnhub(today, fh = finnhub) {
  if (!fh.enabled()) return null;
  const out = { at: Date.now(), news: [], earnings: [] };
  for (const back of [7, 30, 60, 90, 180]) {
    const to = addDays(today, -back), from = addDays(to, -2);
    try {
      const n = await fh.news('AAPL', from, to);
      const ts = (Array.isArray(n) ? n : []).map((x) => x.datetime).filter(Boolean);
      out.news.push({ back, from, to, count: ts.length, first: ts.length ? Math.min(...ts) * 1000 : null, last: ts.length ? Math.max(...ts) * 1000 : null });
    } catch (e) { out.news.push({ back, from, to, error: clip(e && e.message, 120) }); }
    try {
      const r = await fh.earnings(from, to);
      const list = (r && r.earningsCalendar) || [];
      out.earnings.push({ back, from, to, count: list.length, withActual: list.filter((x) => x.epsActual != null).length, withEstimate: list.filter((x) => x.epsEstimate != null).length, sample: list.slice(0, 2).map(compactEarn) });
    } catch (e) { out.earnings.push({ back, from, to, error: clip(e && e.message, 120) }); }
  }
  writeJSON('lab/finnhub-probe.json', out);
  return out;
}
