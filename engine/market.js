// Market and sector context from SPY/QQQ and the SPDR sector funds (used only as
// context, never traded).
import { alpaca } from './alpaca.js';
import { ny } from './clock.js';
import { warn } from './log.js';

export const SECTOR_ETFS = ['XLK', 'XLC', 'XLV', 'XLF', 'XLE', 'XLU', 'XLRE', 'XLB', 'XLP', 'XLY', 'XLI'];
export const SECTOR_NAMES = { XLK: 'تقنية', XLC: 'اتصالات', XLV: 'صحة', XLF: 'مالية', XLE: 'طاقة', XLU: 'مرافق', XLRE: 'عقار', XLB: 'مواد', XLP: 'استهلاكي أساسي', XLY: 'استهلاكي', XLI: 'صناعة', SPY: 'عام' };

export function snapPrice(s) {
  return (s && s.latestTrade && s.latestTrade.p) || (s && s.dailyBar && s.dailyBar.c) || null;
}

// Daily bar belongs to today (NY)? Before the first trade of the day, snapshots still carry yesterday's bar.
export function isToday(bar, today = ny().ymd) {
  return !!bar && ny(Date.parse(bar.t)).ymd === today;
}

// Daily bars are stamped at midnight New York; allow a few hours of slack around it.
export function isTodayDaily(bar, today = ny().ymd) {
  return !!bar && ny(Date.parse(bar.t) + 6 * 3600e3).ymd === today;
}

export function prevClose(s, today = ny().ymd) {
  if (!s) return null;
  if (s.dailyBar && !isTodayDaily(s.dailyBar, today)) return s.dailyBar.c;
  return s.prevDailyBar ? s.prevDailyBar.c : null;
}

export async function marketContext() {
  try {
    const snaps = await alpaca.snapshots(['SPY', 'QQQ', ...SECTOR_ETFS]);
    const today = ny().ymd;
    const one = (sym) => {
      const s = snaps[sym];
      const p = snapPrice(s), pc = prevClose(s, today);
      const vw = s && isTodayDaily(s.dailyBar, today) ? s.dailyBar.vw : null;
      return { p, chg: p && pc ? +((p / pc - 1) * 100).toFixed(2) : 0, vw, above: vw ? p > vw : null };
    };
    const spy = one('SPY'), qqq = one('QQQ');
    let regime = 'flat';
    if (spy.above === true && spy.chg > 0.2) regime = 'up';
    else if (spy.above === false && spy.chg < -0.3) regime = 'down';
    const sectors = {};
    for (const e of SECTOR_ETFS) sectors[e] = +(one(e).chg - spy.chg).toFixed(2);
    return { at: Date.now(), spy, qqq, regime, sectors };
  } catch (e) {
    warn('marketContext', e);
    return null;
  }
}

export const REGIME_AR = { up: 'صاعد', flat: 'متذبذب', down: 'هابط' };

// The free data plan quotes IEX only, and IEX is often not at the best price, so its
// bid/ask gap overstates the real (consolidated) spread — sometimes by dollars. The real
// spread is never wider than one venue's own quote, so: estimate the typical spread from
// the stock's average daily dollar volume, and use the IEX quote only when it is tighter.
export function typicalSpreadBps(adv) {
  if (!adv) return 15;
  if (adv >= 500e6) return 2;
  if (adv >= 100e6) return 3;
  if (adv >= 30e6) return 5;
  if (adv >= 10e6) return 10;
  return 20;
}

// Rounded up to whole cents (the tick size), never below one cent.
export function estSpread(price, adv) {
  return Math.max(0.01, Math.ceil((price * typicalSpreadBps(adv)) / 100 - 1e-9) / 100);
}

export function effectiveSpread(price, quoteSpread, adv) {
  const est = estSpread(price, adv);
  return quoteSpread != null && quoteSpread > 0 ? Math.min(quoteSpread, est) : est;
}
