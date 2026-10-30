// Focused watchlist (≤ watchMax names) on the real-time stream. Holds today's 1-minute bars,
// re-detects setups on every closed bar and fires a signal once price holds above a trigger.
import { alpaca } from './alpaca.js';
import { buildCtx, detect } from './setups.js';
import { isoNy, ny, now } from './clock.js';
import { ms } from './indicators.js';
import * as model from './model.js';
import { warn } from './log.js';

export class Watchlist {
  constructor({ cfg, stream, today, openMs, onSignal, onEvent }) {
    this.cfg = cfg; this.stream = stream; this.today = today; this.openMs = openMs;
    this.onSignal = onSignal; this.onEvent = onEvent;
    this.items = new Map();
    this.exited = [];
  }

  symbols() { return [...this.items.keys()]; }

  async add(c, { direct = false } = {}) {
    if (this.items.has(c.sym)) return;
    let bars = [];
    try {
      const r = await alpaca.bars([c.sym], { timeframe: '1Min', start: isoNy(this.today, '04:00'), end: new Date(now()).toISOString(), feed: 'iex' });
      bars = r[c.sym] || [];
    } catch (e) { warn(`bars ${c.sym}`, e); }
    const it = {
      sym: c.sym, name: c.name, sector: c.sector, addedAt: now(), scoreAtAdd: c.score, score: c.score, trend: [c.score],
      feats: pickFeats(c), why: c.flags || [], direct,
      bars, ctx: null, armed: [], cross: {}, fired: new Set(), last: c.price, spread: c.spread,
      pdh: c.pdh, atrD: c.atrD, hasRec: false,
    };
    this.items.set(c.sym, it);
    this.recompute(it);
    this.stream.set(this.streamSymbols());
    this.onEvent('watch_add', { sym: c.sym, score: c.score, direct, why: it.why, feats: it.feats, t: now() });
  }

  drop(sym, reason) {
    const it = this.items.get(sym);
    if (!it || it.hasRec) return;
    this.items.delete(sym);
    this.exited.push({ sym, at: now(), reason, scoreAtAdd: it.scoreAtAdd, score: it.score });
    this.stream.set(this.streamSymbols());
    this.onEvent('watch_drop', { sym, reason, score: it.score, t: now() });
  }

  streamSymbols() { return [...this.items.keys()]; }

  // Called each scan cycle with the ranked candidates.
  async update(cands) {
    const cfg = this.cfg;
    const byS = Object.fromEntries(cands.map((c) => [c.sym, c]));
    for (const it of this.items.values()) {
      const c = byS[it.sym];
      if (c) { it.score = c.score; it.why = c.flags; it.feats = pickFeats(c); it.spread = c.spread ?? it.spread; this.onPrice(it.sym, c.price, now()); }
      it.trend.push(it.score); if (it.trend.length > 30) it.trend.shift();
      const dwell = (now() - it.addedAt) / 60000;
      if (!it.hasRec && dwell >= cfg.watchMinDwellMin && it.score < cfg.watchExit) this.drop(it.sym, `ضعف الزخم (الدرجة ${it.scoreAtAdd} ← ${it.score})`);
    }
    for (const c of cands) {
      if (this.items.has(c.sym) || c.score < cfg.watchEnter) continue;
      if (this.items.size >= cfg.watchMax) {
        const weakest = [...this.items.values()].filter((x) => !x.hasRec).sort((a, b) => a.score - b.score)[0];
        if (!weakest || weakest.score >= c.score - 5) continue;
        this.drop(weakest.sym, `استُبدل بسهم أقوى (${c.sym})`);
      }
      await this.add(c, { direct: c.score >= 85 });
    }
  }

  onBar(sym, bar, updated) {
    const it = this.items.get(sym);
    if (!it) return;
    const i = it.bars.findIndex((b) => b.t === bar.t);
    if (i >= 0) it.bars[i] = bar; else it.bars.push(bar);
    if (!updated) this.recompute(it);
  }

  recompute(it) {
    it.ctx = buildCtx(it.bars, this.openMs, { pdh: it.pdh, atrD: it.atrD });
    if (!it.ctx) { it.armed = []; return; }
    it.armed = detect(it.ctx).filter((s) => !it.fired.has(s.type));
    for (const k of Object.keys(it.cross)) if (!it.armed.find((s) => s.type === k)) delete it.cross[k];
  }

  onPrice(sym, p, t) {
    const it = this.items.get(sym);
    if (!it || !p) return;
    it.last = p;
    const cfg = this.cfg;
    for (const s of it.armed) {
      if (it.fired.has(s.type)) continue;
      const R = s.trigger - s.stopStruct;
      if (p >= s.trigger && p <= s.trigger + 0.25 * R) {
        if (!it.cross[s.type]) it.cross[s.type] = t;
        else if (t - it.cross[s.type] >= cfg.confirmSec * 1000) {
          it.fired.add(s.type);
          delete it.cross[s.type];
          this.onSignal(it, s);
        }
      } else if (p < s.trigger) delete it.cross[s.type];
    }
  }

  view(regime, activeSyms = null) {
    return [...this.items.values()].map((it) => {
      const a = it.armed[0];
      let stage = 'watch', next = 'ينتظر نمط دخول', prob = null;
      const isActive = activeSyms ? activeSyms.has(it.sym) : it.hasRec;
      if (isActive) { stage = 'active'; next = 'توصية نشطة'; }
      else if (a) {
        stage = 'near';
        next = `الشرط الناقص: ${a.label} فوق ${a.trigger.toFixed(2)}`;
        prob = model.prob(a.type, 1.5, { score: model.scoreBucket(it.score), tod: model.todBucket(it.ctx ? it.ctx.minAfterOpen : 0), regime }).p;
      } else if (it.trend.length >= 3 && it.score > it.trend[it.trend.length - 3]) stage = 'early';
      const c = it.ctx;
      return {
        sym: it.sym, name: it.name, sector: it.sector, score: it.score, scoreAtAdd: it.scoreAtAdd,
        since: ny(it.addedAt).hm, price: it.last, chg: it.feats.chg, rvol: it.feats.rvol,
        vwapAtr: c ? +((it.last - c.vwap) / c.a5).toFixed(2) : null, atr5: c ? +c.a5.toFixed(3) : null,
        spread: it.spread, why: it.why, stage, next, prob, direct: it.direct,
        armed: it.armed.map((s) => ({ type: s.type, label: s.label, trigger: s.trigger })),
      };
    });
  }
}

function pickFeats(c) {
  return { price: c.price, chg: +c.chg.toFixed(2), gap: +c.gap.toFixed(2), rvol: c.rvol == null ? null : +c.rvol.toFixed(2), rangeAtr: +c.rangeAtr.toFixed(2), aboveVw: c.aboveVw, posInRange: +c.posInRange.toFixed(2), accel: c.accel == null ? null : +c.accel.toFixed(2), spread: c.spread, score: c.score, sector: c.sector };
}

export { ms };
