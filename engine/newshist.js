// Historical Finnhub company news, kept only as timestamps, to measure whether a news catalyst helps (lab rows and the swing study).
import { finnhub } from './finnhub.js';
import { addDays } from './clock.js';
import { warn } from './log.js';

const CAP = 180; // a window that returns this many items is assumed truncated and is split in halves

const spanDays = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);

async function window(fh, sym, from, to, out, stats, dl) {
  if (Date.now() > dl) { stats.skipped++; return; }
  let list;
  try { list = await fh.news(sym, from, to); stats.calls++; } catch (e) { stats.errors++; warn(`news ${sym} ${from}`, e); return; }
  list = Array.isArray(list) ? list : [];
  if (list.length >= CAP && spanDays(from, to) >= 1) {
    const mid = addDays(from, Math.floor(spanDays(from, to) / 2));
    await window(fh, sym, from, mid, out, stats, dl);
    await window(fh, sym, addDays(mid, 1), to, out, stats, dl);
    return;
  }
  if (list.length >= CAP) stats.truncated++;
  for (const n of list) if (n && n.datetime) out.push(n.datetime * 1000);
}

// syms in priority order. Returns { map: {sym: sorted ms[]}, stats }. Symbols not reached before the budget ends are absent from the map.
export async function fetchNewsHistory(syms, from, to, { fh = finnhub, budgetMs = 150 * 60000, chunkDays = 45 } = {}) {
  const stats = { symbols: 0, calls: 0, errors: 0, truncated: 0, skipped: 0, from, to };
  const map = {}, dl = Date.now() + budgetMs;
  if (!fh.enabled()) return { map, stats: { ...stats, disabled: true } };
  for (const s of syms) {
    if (Date.now() > dl) break;
    const out = [];
    for (let a = from; a <= to; a = addDays(a, chunkDays + 1)) {
      const b = addDays(a, chunkDays) > to ? to : addDays(a, chunkDays);
      await window(fh, s, a, b, out, stats, dl);
    }
    map[s] = [...new Set(out)].sort((x, y) => x - y);
    stats.symbols++;
  }
  return { map, stats };
}

// [stories in the 24h before the fill, stories since the previous day's open until today's open (pre-market catalyst), stories in the last 60 min].
export function newsCounts(times, fillAt, openMs) {
  if (!times) return null;
  const c = (a, b) => { let n = 0; for (const t of times) if (t >= a && t < b) n++; return n; };
  return [c(fillAt - 24 * 3600e3, fillAt), c(openMs - 24 * 3600e3, openMs), c(fillAt - 3600e3, fillAt)];
}
