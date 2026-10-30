// Approximate AAOIFI screen from Finnhub data (free). This applies published criteria,
// it is not a fatwa. Statuses: ok | no | doubt | unknown. Only "ok" is tradable by default.
import { finnhub } from './finnhub.js';
import { readJSON, writeJSON } from './store.js';
import { warn } from './log.js';

const DENY_IND = /bank|insur|financial serv|capital markets|consumer financ|mortgage|thrift|tobacco|casino|gaming|gambl|brew|distill|wine|spirit|alcohol|adult/i;
const DOUBT_IND = /beverage|media|entertain|hotel|restaurant|leisure|real estate|reit|diversified financ|asset management/i;
const DENY_NAME = /\bbank\b|bancorp|bancshares|insurance|assurance|brewing|brewery|distiller|casino|gaming|tobacco|cannabis/i;

const SECTORS = [
  ['XLK', /tech|semiconductor|software|electronic|communications equipment|it serv|hardware/i],
  ['XLC', /media|telecom|entertain|interactive|communication/i],
  ['XLV', /health|pharma|biotech|medical|life science/i],
  ['XLF', /bank|insur|financ|capital markets/i],
  ['XLE', /energy|oil|gas|coal/i],
  ['XLU', /utilit/i],
  ['XLRE', /real estate|reit/i],
  ['XLB', /chemical|metal|mining|paper|packag|material|steel/i],
  ['XLP', /food|beverage|tobacco|personal products|household products/i],
  ['XLY', /retail|auto|hotel|restaurant|leisure|consumer|textile|apparel|durables|distribut/i],
  ['XLI', /aerospace|defense|machinery|industrial|airline|transport|logistic|construct|electrical|commercial serv|building|marine|road/i],
];

export function sectorOf(industry) {
  for (const [etf, re] of SECTORS) if (re.test(industry || '')) return etf;
  return 'SPY';
}

const REL = 'shariah.json';
const TTL = 30 * 864e5;
let cache = null;

export function loadCache() { if (!cache) cache = readJSON(REL, {}); return cache; }
export function saveCache() { if (cache) writeJSON(REL, cache); }
export function statusOf(sym) { const c = loadCache()[sym]; return c ? c.st : 'pending'; }
export function recordOf(sym) { return loadCache()[sym] || null; }
export function needsCheck(sym, t = Date.now()) { const c = loadCache()[sym]; return !c || t - c.at > TTL || c.st === 'unknown'; }

const num = (x) => (typeof x === 'number' && isFinite(x) ? x : null);

export function evaluate(profile, metric) {
  const ind = profile.finnhubIndustry || '';
  const name = profile.name || '';
  const m = (metric && metric.metric) || {};
  const shares = num(profile.shareOutstanding);           // millions
  const mc = num(m.marketCapitalization) || num(profile.marketCapitalization); // millions
  const de = num(m['totalDebt/totalEquityQuarterly']) ?? num(m['totalDebt/totalEquityAnnual']);
  const bvps = num(m.bookValuePerShareQuarterly) ?? num(m.bookValuePerShareAnnual);
  const cps = num(m.cashPerSharePerShareQuarterly) ?? num(m.cashPerSharePerShareAnnual);
  let dr = null, cr = null;
  if (mc && shares && bvps != null && de != null) dr = Math.max(0, (de * bvps * shares) / mc);
  if (mc && shares && cps != null) cr = Math.max(0, (cps * shares) / mc);

  let st = 'ok', why = 'نسب AAOIFI ضمن الحد';
  if (DENY_IND.test(ind) || DENY_NAME.test(name)) { st = 'no'; why = `نشاط غير مباح: ${ind || name}`; }
  else if (dr != null && dr >= 0.30) { st = 'no'; why = `الديون ${(dr * 100).toFixed(0)}% من القيمة السوقية`; }
  else if (cr != null && cr >= 0.30) { st = 'no'; why = `النقد والأوراق ذات الفائدة ${(cr * 100).toFixed(0)}% من القيمة السوقية`; }
  else if (DOUBT_IND.test(ind)) { st = 'doubt'; why = `قطاع يحتاج تحقق: ${ind}`; }
  else if (dr == null || !ind) { st = 'unknown'; why = 'بيانات مالية ناقصة'; }
  return { st, why, ind, name, sector: sectorOf(ind), dr: dr == null ? null : +dr.toFixed(3), cr: cr == null ? null : +cr.toFixed(3) };
}

export async function check(sym) {
  if (!finnhub.enabled()) return { st: 'unknown', why: 'لا يوجد مفتاح Finnhub' };
  try {
    const [p, m] = await Promise.all([finnhub.profile(sym), finnhub.metric(sym)]);
    const r = { ...evaluate(p || {}, m || {}), at: Date.now() };
    loadCache()[sym] = r;
    return r;
  } catch (e) {
    warn(`shariah ${sym}`, e);
    return { st: 'unknown', why: 'تعذر الفحص' };
  }
}

// Screens a queue of symbols in the background, most liquid first, saving progress as it goes.
export async function screenQueue(symbols, { budgetMs = 10 * 60000, onProgress } = {}) {
  const t0 = Date.now();
  let done = 0;
  for (const s of symbols) {
    if (Date.now() - t0 > budgetMs) break;
    if (!needsCheck(s)) continue;
    await check(s);
    done++;
    if (done % 20 === 0) { saveCache(); onProgress && onProgress(done); }
  }
  saveCache();
  return done;
}
