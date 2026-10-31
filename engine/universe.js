// Daily universe: liquid US common stocks that pass the Shariah screen.
import { alpaca } from './alpaca.js';
import { DEFAULTS } from './config.js';
import { addDays, isoNy } from './clock.js';
import { atr, mean } from './indicators.js';
import { readJSON, writeJSON } from './store.js';
import { statusOf, recordOf, screenQueue, loadCache } from './shariah.js';
import { log, warn } from './log.js';

const NOT_COMMON = /\bETF|\bETN|\bFund\b|\bTrust\b|Leveraged|Inverse|\b[23]X\b|Ultra|ProShares|Direxion|iShares|SPDR|Invesco|Vanguard|GraniteShares|Tradr|Defiance|T-Rex|YieldMax|Roundhill|Warrant|\bUnits?\b|\bRights?\b|Preferred|Depositary|\bNotes?\b|Acquisition Corp|Bond|Treasury/i;

export function isCommonStock(a) {
  return a.tradable && ['NYSE', 'NASDAQ', 'AMEX'].includes(a.exchange) && /^[A-Z]{1,5}$/.test(a.symbol) && !NOT_COMMON.test(a.name || '');
}

export function dailyStats(bars) {
  if (!bars || bars.length < 5) return null;
  const last = bars[bars.length - 1];
  const prev = bars.slice(-20);
  return {
    pdc: last.c, pdh: last.h, pdl: last.l,
    adv: mean(prev.map((b) => b.c * b.v)),
    avgVol: mean(prev.map((b) => b.v)),
    atrD: atr(bars.slice(-15), 14),
  };
}

// Calendar days of daily history used for liquidity, ATR and relative volume.
export const UNIVERSE_WIN = 35;

export async function buildUniverse(cfg, today, { allowDoubtful = false } = {}) {
  const t0 = Date.now();
  const assets = (await alpaca.assets()).filter(isCommonStock);
  const meta = Object.fromEntries(assets.map((a) => [a.symbol, { name: a.name, exchange: a.exchange }]));
  const start = isoNy(addDays(today, -UNIVERSE_WIN), '00:00');
  const end = isoNy(addDays(today, -1), '20:00');
  const sip = await alpaca.bars(assets.map((a) => a.symbol), { timeframe: '1Day', start, end, feed: 'sip', per: 200 });
  const liquid = [];
  for (const [s, bars] of Object.entries(sip)) {
    const st = dailyStats(bars);
    if (!st) continue;
    if (st.pdc < cfg.minPrice || st.pdc > cfg.maxPrice || st.adv < cfg.minDollarVol) continue;
    liquid.push({ s, ...st, name: meta[s] && meta[s].name });
  }
  liquid.sort((a, b) => b.adv - a.adv);
  // IEX history for a like-for-like relative volume against the live IEX feed.
  const iex = await alpaca.bars(liquid.map((x) => x.s), { timeframe: '1Day', start, end, feed: 'iex', per: 200 });
  for (const x of liquid) {
    const b = iex[x.s] || [];
    x.avgIexVol = b.length ? mean(b.slice(-20).map((k) => k.v)) : 0;
  }
  const universe = {
    day: today, builtAt: Date.now(), win: UNIVERSE_WIN, assets: assets.length, liquid: liquid.length,
    symbols: liquid.map((x) => ({ ...x, adv: Math.round(x.adv), avgVol: Math.round(x.avgVol), avgIexVol: Math.round(x.avgIexVol), atrD: +x.atrD.toFixed(3) })),
  };
  writeJSON('universe.json', universe);
  log(`universe: ${assets.length} common → ${liquid.length} liquid in ${Math.round((Date.now() - t0) / 1000)}s`);
  return universe;
}

export function loadUniverse() { return readJSON('universe.json', null); }

export function tradable(universe, allowDoubtful) {
  loadCache();
  return universe.symbols.filter((x) => {
    const st = statusOf(x.s);
    return st === 'ok' || (allowDoubtful && st === 'doubt');
  }).map((x) => ({ ...x, sh: recordOf(x.s) }));
}

export async function screenUniverse(universe, budgetMs) {
  try {
    const n = await screenQueue(universe.symbols.map((x) => x.s), { budgetMs, onProgress: (k) => log(`shariah screened +${k}`) });
    if (n) log(`shariah: screened ${n} symbols`);
    return n;
  } catch (e) { warn('screenUniverse', e); return 0; }
}

export function universeCounts(universe) {
  loadCache();
  const c = { ok: 0, no: 0, doubt: 0, unknown: 0, pending: 0 };
  for (const x of (universe && universe.symbols) || []) c[statusOf(x.s)] = (c[statusOf(x.s)] || 0) + 1;
  return c;
}

export { DEFAULTS };
