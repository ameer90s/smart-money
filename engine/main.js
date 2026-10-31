// Smart Money engine. Runs the trading day end to end:
// prepare (universe, Shariah screen, model, week) → pre-market → session scan, watchlist,
// signals, recommendations → flat before the bell → audit, analyst, backup.
import fs from 'node:fs';
import { DEFAULTS, ENV, VERSION, APP_VERSION } from './config.js';
import { now, ny, sleep, nyToUtc, hmToMin, minToHm, fallbackSession, addDays } from './clock.js';
import { log, warn, recentErrors } from './log.js';
import { alpaca } from './alpaca.js';
import { callsPerMinute } from './http.js';
import { Stream } from './stream.js';
import { readJSON, writeJSON, DayCollection, dayRel, listDays } from './store.js';
import { buildUniverse, loadUniverse, tradable, screenUniverse, universeCounts, UNIVERSE_WIN } from './universe.js';
import { check as shariahCheck, statusOf, needsCheck, recordOf, saveCache } from './shariah.js';
import { scan, features, score as scoreOf, flags as flagsOf } from './scanner.js';
import { Watchlist } from './watchlist.js';
import { plan as makePlan } from './planner.js';
import { Recs, weekStats } from './recs.js';
import { marketContext, REGIME_AR, SECTOR_NAMES } from './market.js';
import { buildWeek, loadWeek, dayRules, recordOutcomes } from './events.js';
import { auditDay } from './audit.js';
import { bootstrap } from './backtest.js';
import { runAnalyst, CAUSE_AR, FAIL_AR } from './analyst.js';
import { finnhub } from './finnhub.js';
import * as model from './model.js';
import * as live from './live.js';
import { sync as gitSync } from './gitsync.js';
import { notify } from './notify.js';

const STARTED = now();
const STATE_REL = 'state.json';
let state = readJSON(STATE_REL, { cmdSeen: [], flags: {} });
state.flags = state.flags || {};
state.cmdSeen = state.cmdSeen || [];
let cfg = { ...DEFAULTS, ...(state.settings || {}) };
const saveState = () => writeJSON(STATE_REL, state);
const flagDone = (k) => !!state.flags[k];
const setFlag = (k) => { state.flags[k] = now(); saveState(); };

const rt = { cycle: 0, lastCycleAt: 0, cycleMs: 0, scanned: 0, active: 0, cands: 0, pre: [], mkt: null, stream: null, wl: null, recs: null, day: null, sess: null, phase: 'starting' };

function exitWith(reason) {
  log(`exit: ${reason}`);
  try { rt.recs && rt.recs.flush(); model.save(); saveCache(); saveState(); } catch {}
  try { gitSync(`exit ${reason}`); } catch {}
  if (ENV.reasonFile) try { fs.writeFileSync(ENV.reasonFile, reason); } catch {}
  try { rt.stream && rt.stream.stop(); } catch {}
  process.exit(0);
}

function shouldStop() {
  if (ENV.maxMin && (now() - STARTED) / 60000 >= ENV.maxMin) return 'max';
  if (ENV.untilNy && ny().min >= hmToMin(ENV.untilNy)) return 'until';
  return null;
}

async function refreshSettings() {
  const r = await live.readSettings();
  if (!r) return;
  cfg = { ...DEFAULTS, ...r.settings };
  if (r.settings.ntfyTopic) ENV.ntfyTopic = r.settings.ntfyTopic;
  state.settings = r.settings;
  for (const c of r.commands || []) {
    if (!c || !c.id || state.cmdSeen.includes(c.id)) continue;
    state.cmdSeen.push(c.id);
    if (c.type === 'entered' && rt.recs) rt.recs.markUserEntry(c.rec, Number(c.price));
    if (c.type === 'test-ntfy') notify({ title: 'تنبيه تجريبي · Smart Money', message: 'التنبيهات شغالة وتوصلك والجوال مقفل.', priority: 4, tags: ['bell'] });
    if (c.type === 'proposal') {
      const props = readJSON('proposals.json', []);
      const p = props.find((x) => x.id === c.proposal);
      if (p && ['approved', 'rejected'].includes(c.status)) { p.status = c.status; p.decidedAt = now(); writeJSON('proposals.json', props); }
    }
  }
  state.cmdSeen = state.cmdSeen.slice(-200);
  if (rt.recs) rt.recs.cfg = cfg;
  if (rt.wl) rt.wl.cfg = cfg;
  saveState();
}

async function sessionFor(day) {
  try {
    const cal = await alpaca.calendar(day, day);
    const d = (cal || []).find((x) => x.date === day);
    return d ? { date: day, open: d.open, close: d.close } : null;
  } catch (e) {
    warn('calendar', e);
    return fallbackSession(day);
  }
}

// ---------- live payload for the app ----------
function compactRec(r) {
  return {
    id: r.id, day: r.day, sym: r.sym, name: r.name, setup: r.setup, label: r.label, sector: r.sector, version: r.version,
    firedAt: r.firedAt, firedNy: r.firedNy, validUntil: r.validUntil, status: r.status, stopNow: r.stopNow,
    t1: r.t1, t2: r.t2, t3: r.t3, last: r.last, maxP: r.maxP, minP: r.minP, plan: r.plan, sh: r.sh,
    reasons: r.reasons, timeline: r.timeline, result: r.result || null, exit: r.exit || null, exitReason: r.exitReason || null,
    user: r.user, sip: r.sip ? { r: r.sip.r, best: r.sip.best, reason: r.sip.reason } : null, nValues: countValues(r.snapshot),
  };
}
function countValues(o) { let n = 0; const walk = (x) => { if (x && typeof x === 'object') Object.values(x).forEach(walk); else n++; }; walk(o); return n; }

function recentDays(n) { return listDays().slice(-n); }

function buildLive() {
  const day = rt.day || ny().ymd;
  const u = loadUniverse();
  const counts = universeCounts(u);
  const latestAnalystDay = [...listDays()].reverse().find((d) => fs.existsSync(`${ENV.dataDir}/days/${d}/analyst.json`));
  const week = loadWeek(day);
  const wl = rt.wl;
  const regime = rt.mkt ? rt.mkt.regime : 'flat';
  const todayRecs = rt.recs ? rt.recs.all() : readJSON(dayRel(day, 'recs.json'), []);
  const history = [];
  for (const d of recentDays(6)) if (d !== day) history.push(...readJSON(dayRel(d, 'recs.json'), []).map(compactRec));
  return {
    v: 1, at: now(), app: APP_VERSION, version: VERSION,
    server: { runner: ENV.runner, startedAt: STARTED, phase: rt.phase, cycle: rt.cycle, lastCycleAt: rt.lastCycleAt, cycleMs: rt.cycleMs, callsPerMin: callsPerMinute(new URL(ENV.alpacaData).host), ws: rt.stream ? rt.stream.status() : null, errors: recentErrors() },
    session: rt.sess ? { day, open: rt.sess.open, close: rt.sess.close } : { day, open: null, close: null },
    market: rt.mkt ? { ...rt.mkt, regimeAr: REGIME_AR[rt.mkt.regime] } : null,
    universe: { liquid: u ? u.liquid : 0, counts, tradable: counts.ok + (cfg.allowDoubtful ? counts.doubt : 0), builtDay: u ? u.day : null },
    funnel: { universe: counts.ok, scanned: rt.scanned, active: rt.active, candidates: rt.cands, watch: wl ? wl.items.size : 0, recs: todayRecs.length },
    pre: rt.pre.slice(0, 12),
    watch: wl ? wl.view(regime, new Set(todayRecs.filter((r) => r.status === 'active').map((r) => r.sym))) : [],
    exited: wl ? wl.exited.slice(-10).map((x) => ({ ...x, atNy: ny(x.at).hm })) : [],
    recs: todayRecs.map(compactRec),
    signals: readJSON(dayRel(day, 'signals.json'), []).slice(-40).map((x) => ({ id: x.id, sym: x.sym, setup: x.setup, label: x.label, firedNy: x.firedNy, accepted: x.accepted, why: x.why, score: x.score, p1: x.plan.targets[0].prob, ev: x.plan.ev, entry: x.plan.entry, sim: x.sim ? { r: x.sim.r, best: x.sim.best, reason: x.sim.reason } : null })),
    history,
    stats: { today: rt.recs ? rt.recs.stats() : null, week: weekStats(day), targetUsd: +(cfg.capital * 0.01).toFixed(2), capital: cfg.capital },
    analyst: latestAnalystDay ? readJSON(dayRel(latestAnalystDay, 'analyst.json'), null) : null,
    proposals: readJSON('proposals.json', []).slice(-20),
    model: model.summary(),
    strategy: { version: VERSION, params: strategyParams() },
    week: week ? { week: week.week, econ: week.econ, earnings: week.earnings, sessions: week.sessions, rules: dayRules(week, day) } : null,
    settings: cfg,
    labels: { causes: CAUSE_AR, fails: FAIL_AR, sectors: SECTOR_NAMES },
  };
}

function strategyParams() {
  return [
    { k: 'حد دخول قائمة المراقبة', rule: 'درجة الإمكانية', now: `${cfg.watchEnter}+` },
    { k: 'أقصى امتداد عن VWAP', rule: 'بوحدات ATR 5 دقائق', now: `${cfg.extMaxAtr5} ATR` },
    { k: 'وقف الخسارة', rule: `هيكلي، بين ${cfg.stopAtrMin} و${cfg.stopAtrMax} ATR 5د`, now: 'متغير' },
    { k: 'احتمال الهدف 1', rule: 'من بيانات النموذج', now: `≥ ${Math.round(cfg.probMinT1 * 100)}%` },
    { k: 'القيمة المتوقعة', rule: 'بعد العمولة والسبريد', now: `≥ ${cfg.evMin}R` },
    { k: 'الهدف 1 مقابل التكلفة', rule: 'أضعاف العمولة والسبريد', now: `≥ ${cfg.costMult}×` },
    { k: 'نافذة التوصيات', rule: 'بتوقيت نيويورك', now: `${cfg.recFrom}–${cfg.recTo}` },
    { k: 'الحدود اليومية', rule: 'توصيات · خسارة توقف اليوم', now: `${cfg.maxRecsDay} · ${cfg.dailyLossStop}$` },
  ];
}

let lastPublish = 0;
async function publishLive(force = false) {
  if (!force && now() - lastPublish < 30000) return;
  lastPublish = now();
  const obj = buildLive();
  writeJSON('live.json', obj);
  await live.publish(obj);
}

// ---------- preparation ----------
async function prepare(day) {
  rt.phase = 'preparing';
  let u = loadUniverse();
  if (!u || u.day !== day) {
    try { u = await buildUniverse(cfg, day); } catch (e) { warn('buildUniverse', e); }
  }
  if (!u) return null;
  // Screen the most liquid unscreened names first, within a time budget before the open.
  const untilOpen = nyToUtc(day, '09:25') - now();
  await screenUniverse(u, Math.max(60000, Math.min(untilOpen, 25 * 60000)));
  // Quick replay before the open only when the model is nearly empty; the full one runs in maintenance.
  if (model.load().samples.length < 150 && !flagDone(`btq-${day}`)) {
    setFlag(`btq-${day}`);
    try { await bootstrap(u, cfg, { days: 10, budgetMs: Math.max(60000, Math.min(nyToUtc(day, '09:28') - now(), 20 * 60000)) }); } catch (e) { warn('bootstrap', e); }
  }
  let week = loadWeek(day);
  if (!week) { try { week = await buildWeek(day, tradable(u, true).map((x) => x.s)); } catch (e) { warn('week', e); } }
  rt.mkt = await marketContext();
  return u;
}

// ---------- the trading day ----------
async function runDay(day, sess) {
  rt.day = day; rt.sess = sess;
  const openMs = nyToUtc(day, sess.open);
  const closeMs = nyToUtc(day, sess.close);
  const flatMs = Math.min(nyToUtc(day, cfg.flatAt), closeMs - 5 * 60000);
  const recToMin = Math.min(hmToMin(cfg.recTo), hmToMin(sess.close) - 30);

  const u = await prepare(day);
  if (!u) { warn('day', 'no universe'); await sleep(10 * 60000); return; }
  let list = tradable(u, cfg.allowDoubtful);
  const bySym = Object.fromEntries(u.symbols.map((x) => [x.s, x]));
  log(`${day}: tradable ${list.length} of ${u.liquid} liquid`);

  const signals = new DayCollection(day, 'signals');
  const watchLog = readJSON(dayRel(day, 'watch.json'), []);
  const scanLog = readJSON(dayRel(day, 'scanner.json'), []);
  const onEvent = (type, e) => {
    if (type === 'watch_add') watchLog.push({ sym: e.sym, t: e.t, score: e.score, direct: e.direct, why: e.why, feats: e.feats });
    if (type === 'watch_drop') { const w = [...watchLog].reverse().find((x) => x.sym === e.sym && !x.dropAt); if (w) { w.dropAt = e.t; w.dropReason = e.reason; } }
    writeJSON(dayRel(day, 'watch.json'), watchLog);
  };
  const recs = new Recs({ cfg, day, onEvent });
  rt.recs = recs;
  const stream = new Stream({
    onTrade: (s, tr) => { rt.wl && rt.wl.onPrice(s, tr.p, tr.t); recs.onPrice(s, tr.p, tr.t); },
    onBar: (s, b, upd) => { rt.wl && rt.wl.onBar(s, b, upd); },
  });
  rt.stream = stream;
  const rules = () => dayRules(loadWeek(day), day);

  const onSignal = (it, setup) => {
    try {
      const t = now();
      const regime = rt.mkt ? rt.mkt.regime : 'flat';
      const R = rules();
      const eff = { ...cfg, probMinT1: cfg.probMinT1 + (R.probBoost || 0), recTo: minToHm(recToMin) };
      const p = makePlan(setup, it.ctx, { spread: it.spread }, eff, { score: it.score, regime });
      const why = [...p.fails, ...recs.guard(it.sym, eff)];
      if ((R.earningsToday || []).includes(it.sym)) why.push('earnings');
      if (regime === 'down' && p.targets[0].prob < eff.probMinT1 + 0.1) why.push('market');
      if (R.halfSizeUntil && ny(t).min < hmToMin(R.halfSizeUntil)) {
        p.sizing.shares = Math.floor((p.sizing.shares / 2) * 100) / 100;
        p.sizing.cost = +(p.sizing.shares * p.entry).toFixed(2);
        p.sizing.halfSize = true;
        p.sizing.riskUsd = +(p.sizing.shares * p.R + p.sizing.fees).toFixed(2);
        for (const tg of p.targets) tg.netUsd = +(p.sizing.shares * (tg.price - p.entry) - p.sizing.fees).toFixed(2);
      }
      const accepted = why.length === 0;
      const sig = { id: `${day}-${it.sym}-${setup.type}-${t}`, day, sym: it.sym, setup: setup.type, label: setup.label, firedAt: t, firedNy: ny(t).hm, plan: p, accepted, why, score: it.score, minAfterOpen: it.ctx.minAfterOpen, regime, feats: it.feats, version: VERSION };
      signals.upsert(sig); signals.flush();
      log(`signal ${it.sym} ${setup.type} ${accepted ? 'ACCEPTED' : `rejected (${why.join(',')})`}`);
      if (accepted) {
        recs.issue({ it, setup, plan: p, feats: it.feats, market: rt.mkt, sh: recordOf(it.sym), events: R.events });
        publishLive(true);
      }
    } catch (e) { warn('onSignal', e); }
  };
  const wl = new Watchlist({ cfg, stream, today: day, openMs, onSignal, onEvent });
  rt.wl = wl;

  // Pre-market: opening candidates and the morning brief.
  while (now() < openMs - 60000) {
    const stop = shouldStop(); if (stop) exitWith(stop);
    rt.phase = 'premarket';
    try {
      await refreshSettings();
      const res = await scan(list, [], { minAfterOpen: 1, today: day });
      rt.pre = res.top.filter((r) => r.gap >= 2 && r.price >= cfg.minPrice).slice(0, 20).map((r) => ({ sym: r.sym, gap: +r.gap.toFixed(2), price: r.price, vol: r.vol, name: r.name }));
      rt.scanned = res.scanned;
      if (!flagDone(`brief-${day}`) && ny().min >= hmToMin('09:00')) {
        setFlag(`brief-${day}`);
        rt.mkt = await marketContext();
        const R = rules();
        if (cfg.notifyBrief) notify({ title: 'تقرير الصباح · Smart Money', message: `SPY ${rt.mkt ? `${rt.mkt.spy.chg >= 0 ? '+' : ''}${rt.mkt.spy.chg}%` : '—'} · ${R.events.length ? `أحداث: ${R.events.join('، ')}` : 'لا أحداث قوية'}\nمرشحو الافتتاح: ${rt.pre.slice(0, 5).map((x) => `${x.sym} +${x.gap}%`).join(' · ') || '—'}`, priority: 3, tags: ['sunrise'] });
      }
      await publishLive(true);
    } catch (e) { warn('premarket', e); }
    await sleep(cfg.preScanEverySec * 1000);
  }
  while (now() < openMs) await sleep(2000);

  // Session.
  rt.phase = 'session';
  let extras = [];
  let newsSet = new Set();
  let lastNews = 0, lastSync = now(), lastSettings = 0, lastMkt = 0, lastMinuteLogged = -1, lastExtras = 0;
  if (!flagDone(`open-${day}`)) { setFlag(`open-${day}`); }
  while (now() < flatMs) {
    const stop = shouldStop(); if (stop) exitWith(stop);
    const t0 = now();
    try {
      if (t0 - lastSettings > 60000) { lastSettings = t0; await refreshSettings(); list = tradable(u, cfg.allowDoubtful); }
      if (t0 - lastMkt > 60000) { lastMkt = t0; rt.mkt = (await marketContext()) || rt.mkt; }
      if (t0 - lastExtras > 5 * 60000) {
        lastExtras = t0;
        try {
          const [mv, ma] = await Promise.all([alpaca.movers(50), alpaca.mostActives(50)]);
          extras = [...new Set([...(mv.gainers || []).map((x) => x.symbol), ...(ma.most_actives || []).map((x) => x.symbol)])];
          // Screen liquid movers that have not been checked yet (a few per cycle).
          let k = 0;
          for (const s of extras) { if (bySym[s] && needsCheck(s) && k < 4) { await shariahCheck(s); k++; } }
          if (k) { saveCache(); list = tradable(u, cfg.allowDoubtful); }
        } catch (e) { warn('movers', e); }
      }
      const minAfterOpen = (now() - openMs) / 60000;
      const res = await scan(list, extras, { minAfterOpen, today: day, sectorRel: rt.mkt ? rt.mkt.sectors : {}, newsSet });
      rt.scanned = res.scanned; rt.active = res.active;
      if (cfg.useNews && finnhub.enabled() && t0 - lastNews > 10 * 60000) {
        lastNews = t0;
        for (const r of res.top.slice(0, 12)) {
          try { const n = await finnhub.news(r.sym, day, day); if (n && n.length) newsSet.add(r.sym); } catch {}
        }
      }
      const cands = res.top.filter((r) => r.price >= cfg.minPrice && r.price <= cfg.maxPrice && r.chg > 0);
      rt.cands = cands.filter((c) => c.score >= cfg.watchExit).length;
      // Keep names with an active recommendation on the stream even if their score fades.
      for (const r of recs.active()) {
        if (!wl.items.has(r.sym)) {
          const f = features(r.sym, res.snaps[r.sym], bySym[r.sym] || { avgIexVol: 0 }, minAfterOpen, day);
          if (f) { f.score = scoreOf(f); f.flags = flagsOf(f); await wl.add(f); const it = wl.items.get(r.sym); if (it) it.hasRec = true; }
        }
        const s = res.snaps[r.sym];
        const p = s && s.latestTrade ? s.latestTrade.p : null;
        if (p) recs.onPrice(r.sym, p, now());
      }
      await wl.update(cands);
      recs.flush();
      rt.cycle++; rt.lastCycleAt = now(); rt.cycleMs = now() - t0;
      const mNow = Math.floor(minAfterOpen);
      if (mNow !== lastMinuteLogged) {
        lastMinuteLogged = mNow;
        scanLog.push({ t: now(), ms: res.ms, scanned: res.scanned, active: res.active, p90rvol: +res.p90rvol.toFixed(2), p90chg: +res.p90chg.toFixed(2), top: res.top.slice(0, 5).map((r) => [r.sym, r.score]), ws: stream.status().connected, calls: callsPerMinute(new URL(ENV.alpacaData).host) });
        writeJSON(dayRel(day, 'scanner.json'), scanLog);
      }
      await publishLive();
      if (now() - lastSync > 10 * 60000) { lastSync = now(); saveState(); await recordOutcomes(loadWeek(day)); gitSync(`session ${day} ${ny().hm}`); }
    } catch (e) { warn('cycle', e); }
    const wait = cfg.scanEverySec * 1000 - (now() - t0);
    if (wait > 0) await sleep(wait);
  }

  // Flat before the bell.
  rt.phase = 'closing';
  const priceOf = (sym) => { const it = wl.items.get(sym); return it ? it.last : null; };
  recs.flatten(priceOf, now());
  stream.set([]);
  while (now() < closeMs) { const st = shouldStop(); if (st) exitWith(st); await publishLive(); await sleep(15000); }
  if (!flagDone(`eod-${day}`)) {
    setFlag(`eod-${day}`);
    const st = recs.stats(), wk = weekStats(day);
    if (cfg.notifyBrief) notify({ title: 'انتهى يوم التداول · Smart Money', message: `اليوم: ${st.issued} توصية · الصافي ${st.net >= 0 ? '+' : ''}${st.net}$\nالأسبوع: ${wk.net >= 0 ? '+' : ''}${wk.net}$ من هدف ${(cfg.capital * 0.01).toFixed(0)}$`, priority: 3, tags: ['checkered_flag'] });
  }

  // After the close: SIP data is available 15 minutes later.
  rt.phase = 'audit';
  while (now() < closeMs + 17 * 60000) { const st = shouldStop(); if (st) exitWith(st); await publishLive(); await sleep(30000); }
  if (!flagDone(`audit-${day}`)) {
    try { await auditDay(day, cfg); setFlag(`audit-${day}`); } catch (e) { warn('audit', e); }
    try { await runAnalyst(day); } catch (e) { warn('analyst', e); }
    try { await recordOutcomes(loadWeek(day)); } catch {}
  }
  rt.phase = 'done';
  await publishLive(true);
  gitSync(`day ${day} done`);
  rt.wl = null; rt.recs = null;
}

// ---------- non-trading days: maintenance ----------
async function maintenance(day) {
  rt.phase = 'maintenance';
  rt.day = day; rt.sess = null;
  let u = loadUniverse();
  if (!u || (now() - (u.builtAt || 0)) > 3 * 864e5 || (u.win || 35) < UNIVERSE_WIN) { try { u = await buildUniverse(cfg, day); } catch (e) { warn('universe', e); } }
  if (u) {
    await screenUniverse(u, 60 * 60000);
    // Full replay: incremental (already-replayed stock-days are skipped), so it can run every maintenance.
    if (!flagDone(`replay-${day}`)) { setFlag(`replay-${day}`); try { await bootstrap(u, cfg, { days: 45, budgetMs: 60 * 60000 }); } catch (e) { warn('bootstrap', e); } }
    if (!flagDone(`week-${day}`) && ['Sat', 'Sun'].includes(ny().dow)) { setFlag(`week-${day}`); try { await buildWeek(addDays(day, ny().dow === 'Sat' ? 2 : 1), tradable(u, true).map((x) => x.s)); } catch (e) { warn('week', e); } }
  }
  rt.mkt = await marketContext();
  await publishLive(true);
  gitSync(`maintenance ${day}`);
}

async function main() {
  log(`Smart Money engine ${APP_VERSION} (${VERSION}) on ${ENV.runner}, data at ${ENV.dataDir}`);
  if (ENV.reasonFile) try { fs.writeFileSync(ENV.reasonFile, 'running'); } catch {}
  // live.json changes every 30 s and lives in the gist; keep it out of the permanent record's history.
  try { fs.mkdirSync(ENV.dataDir, { recursive: true }); const gi = `${ENV.dataDir}/.gitignore`; if (!fs.existsSync(gi)) fs.writeFileSync(gi, 'live.json\n*.tmp\n'); } catch {}
  await refreshSettings();
  const mode = process.env.MODE || 'auto';
  if (mode === 'maintenance') { await maintenance(ny().ymd); exitWith('done'); }
  for (;;) {
    const stop = shouldStop(); if (stop) exitWith(stop);
    const day = ny().ymd;
    const sess = await sessionFor(day);
    const closeMs = sess ? nyToUtc(day, sess.close) : 0;
    if (sess && now() < closeMs + 25 * 60000 && !flagDone(`audit-${day}`)) {
      await runDay(day, sess);
      if (ENV.untilNy || ENV.maxMin) exitWith('done');
      continue;
    }
    if (!flagDone(`maint-${day}`)) { setFlag(`maint-${day}`); await maintenance(day); }
    if (ENV.untilNy || ENV.maxMin) exitWith('done');
    await publishLive(true);
    await sleep(10 * 60000);
  }
}

process.on('unhandledRejection', (e) => warn('unhandled', e));
main().catch((e) => { warn('main', e); exitWith('error'); });

export { minToHm, statusOf };
