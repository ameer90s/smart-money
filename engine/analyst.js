// Daily analyst: classifies why trades lost, finds missed opportunities, and proposes changes
// in any area (discovery, entry, stop, targets, timing, setups) with a what-if from recorded
// signals. Rule-based by default; adds a written report from Claude when a key is configured.
import { ENV, DEFAULTS, EXIT_FAMILIES, EXIT_FAMILY_AR, STATE_NAMES_AR, DYN_STOPS, DYN_TARGETS } from './config.js';
import { request } from './http.js';
import { readJSON, writeJSON, dayRel, listDays } from './store.js';
import * as model from './model.js';
import { STATES } from './regime.js';
import { warn } from './log.js';

const CAUSE_AR = { noise: 'وقف داخل ضجيج السهم', ext: 'دخول ممتد بعد دفعة', market: 'السوق انعكس', late: 'اكتشاف متأخر', spread: 'سيولة أو سبريد', time: 'لم يتحرك (خروج بالوقت)', other: 'أخرى' };
const FAIL_AR = { prob: 'الاحتمال', ev: 'القيمة المتوقعة', rr: 'العائد للمخاطرة', cost: 'التكلفة', stop: 'وقف بعيد', spread: 'السبريد', ext: 'الامتداد', window: 'خارج الوقت', max: 'الحد اليومي', dailyLoss: 'حد الخسارة', cooldown: 'التهدئة', dup: 'تكرار', earnings: 'يوم أرباح', market: 'السوق هابط', shadow: 'نمط للمراقبة فقط', paused: 'نمط موقوف بقرارك', busy: 'صفقة مفتوحة', probFloor: 'احتمال شبه معدوم', evFloor: 'قيمة متوقعة سيئة جداً' };

// Arabic counted nouns: 3–10 take the plural, 11 and up the singular.
const cn = (k, plural, singular) => `${k} ${k >= 3 && k <= 10 ? plural : singular}`;

export function classifyLoss(x) {
  const sim = x.sim || x.sip || {};
  const p = x.plan || {};
  if (sim.reason === 'timestop' || (sim.reason === 'eod' && Math.abs(sim.r) < 0.3)) return 'time';
  if (sim.afterStopT1) return 'noise';
  if ((p.ext || 0) > 1.5 && (sim.mfe || 0) < 0.4) return 'ext';
  if (x.regime === 'down' || (x.snapshot && x.snapshot.market && x.snapshot.market.regime === 'down')) return 'market';
  const f = x.feats || (x.snapshot && x.snapshot.feats) || {};
  if ((f.chg || 0) > 15 || (f.rangeAtr || 0) > 1.6) return 'late';
  if (p.spread && p.R && p.spread / p.R > 0.12) return 'spread';
  return 'other';
}

// Signals from Monday up to this day (the week-to-date sample used for the Friday review).
function weekSig(day) {
  const monday = mondayOf(day);
  return listDays().filter((d) => d >= monday && d <= day).flatMap((d) => readJSON(dayRel(d, 'signals.json'), []));
}

function recent(nDays) {
  const days = listDays().slice(-nDays);
  const sig = [], recs = [];
  for (const d of days) {
    sig.push(...readJSON(dayRel(d, 'signals.json'), []));
    recs.push(...readJSON(dayRel(d, 'recs.json'), []));
  }
  return { days, sig, recs };
}

// Compare every filter on the same sample: how many signals it stopped, how many of those reached 1R,
// and what they would have earned. Accepted signals are the baseline. Sim data comes from the audit.
export function filterCompare(sig) {
  const rows = sig.filter((s) => s.sim && typeof s.sim.mfe === 'number');
  const by = {};
  for (const s of rows) {
    const keys = s.accepted === false ? (s.why && s.why.length ? s.why : ['other']) : ['accepted', ...(s.weak || [])];
    for (const k of new Set(keys)) (by[k] = by[k] || []).push(s);
  }
  return Object.entries(by).map(([rule, a]) => ({
    rule, n: a.length,
    reached1R: a.filter((s) => s.sim.mfe >= 1).length,
    wins: a.filter((s) => typeof s.sim.r === 'number' && s.sim.r > 0).length,
    avgR: +(a.reduce((p, s) => p + (typeof s.sim.r === 'number' ? s.sim.r : 0), 0) / a.length).toFixed(2),
  })).sort((x, y) => y.n - x.n);
}

// Monday of the week that contains this day (YYYY-MM-DD).
function mondayOf(day) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export function rulesReport(day) {
  const { sig, recs } = recent(10);
  const today = { sig: sig.filter((s) => s.day === day), recs: recs.filter((r) => r.day === day) };
  const audited = sig.filter((s) => s.sim);
  const losers = audited.filter((s) => s.accepted !== false && s.sim.r < 0).slice(-40);
  const causes = {};
  for (const s of losers) { const c = classifyLoss(s); causes[c] = (causes[c] || 0) + 1; }
  const nL = losers.length || 1;
  const causeList = Object.entries(causes).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ k, label: CAUSE_AR[k], pct: Math.round((v / nL) * 100), n: v }));

  const missed = audited.filter((s) => !s.accepted && s.sim.t1);
  const missedBy = {};
  for (const s of missed) for (const f of s.why || []) (missedBy[f] = missedBy[f] || []).push(s);

  const bullets = [];
  const closed = today.recs.filter((r) => r.status === 'closed' && r.counted !== false);
  const tracked = today.recs.filter((r) => r.status === 'closed' && r.counted === false && r.result);
  const net = closed.reduce((a, r) => a + r.result.net, 0);
  const cnt = (k) => (k === 1 ? 'توصية واحدة' : k === 2 ? 'توصيتان' : `${k} توصيات`);
  bullets.push(closed.length ? `${cnt(closed.length)} اليوم: ${closed.filter((r) => r.result.net > 0).length} رابحة و${closed.filter((r) => r.result.net <= 0).length} خاسرة. الصافي ${net >= 0 ? '+' : ''}${net.toFixed(2)}$.` : 'ما صدرت توصيات اليوم.');
  if (tracked.length) bullets.push(`توصيات للمراقبة فقط (ما دخلت الهدف): ${tracked.map((r) => `${r.sym} ${r.setup} ${r.result.r >= 0 ? '+' : ''}${r.result.r.toFixed(2)}R`).join(' · ')}.`);
  for (const r of closed.filter((x) => x.result.net < 0)) bullets.push(`سبب خسارة ${r.sym}: ${CAUSE_AR[classifyLoss(r)]}.`);
  const tMissed = today.sig.filter((s) => !s.accepted && s.sim && s.sim.t1);
  if (tMissed.length) bullets.push(`فرص فاتت اليوم ووصلت الهدف 1: ${tMissed.slice(0, 4).map((s) => `${s.sym} (${(s.why || []).map((f) => FAIL_AR[f] || f).join('، ')})`).join(' · ')}.`);
  const tProf = today.sig.filter((s) => s.profile && s.profileSim);
  if (tProf.length) bullets.push(`إشارات طابقت أفضل إعداد لنمطها (للمراقبة): ${tProf.slice(0, 5).map((s) => `${s.sym} ${s.setup} ${s.profileSim.r >= 0 ? '+' : ''}${s.profileSim.r.toFixed(2)}R`).join(' · ')}.`);
  const tAll = today.sig.filter((s) => s.sim);
  if (tAll.length) bullets.push(`إشارات اليوم ${tAll.length}: متوسط ${(tAll.reduce((a, s) => a + s.sim.r, 0) / tAll.length).toFixed(2)}R بالمحاكاة.`);

  // Proposals with a what-if computed on recorded signals.
  const props = [];
  const avgR = (xs) => (xs.length ? xs.reduce((a, s) => a + s.sim.r, 0) / xs.length : 0);
  if ((causes.noise || 0) / nL >= 0.35 && losers.length >= 8) props.push({ id: 'stop-floor', aspect: 'الوقف', text: 'ارفع أقل مسافة للوقف من 0.5 إلى 0.7 ATR 5د مع تقليل الكمية', why: `${Math.round((causes.noise / nL) * 100)}% من آخر ${cn(losers.length, 'خسائر', 'خسارة')} كانت «${CAUSE_AR.noise}»: السهم ضرب الوقف ورجع وصل الهدف 1`, effect: 'وقف أبعد شوي يتحمل ضجيج السهم، والكمية تقل عشان تبقى المخاطرة نفسها بالدولار' });
  if ((causes.ext || 0) / nL >= 0.25 && losers.length >= 8) props.push({ id: 'ext-max', aspect: 'الدخول', text: 'خفّض أقصى امتداد عن VWAP من 2.0 إلى 1.5 ATR', why: `${Math.round((causes.ext / nL) * 100)}% من آخر ${cn(losers.length, 'خسائر', 'خسارة')} كانت «${CAUSE_AR.ext}»: الدخول جا بعد ما السهم ارتفع كثير عن متوسطه`, effect: 'يرفض الدخول لما يكون السهم ممتد، ويقل عدد التوصيات المتأخرة' });
  for (const [f, xs] of Object.entries(missedBy)) {
    if (xs.length < 5) continue;
    props.push({ id: `relax-${f}`, aspect: f === 'window' ? 'التوقيت' : f === 'prob' || f === 'ev' ? 'الاحتمال' : 'الاكتشاف', text: `راجع شرط «${FAIL_AR[f] || f}»: رفض ${cn(xs.length, 'فرص', 'فرصة')} وصلت الهدف 1`, why: `الشرط رفض ${cn(xs.length, 'إشارات', 'إشارة')}، ولما أعدت تشغيلها على البيانات الكاملة وصلت الهدف 1، ومتوسطها ${avgR(xs).toFixed(2)}R`, effect: `تخفيف هالشرط يزيد التوصيات. نحتاج نتأكد إنه ما يدخل صفقات خاسرة أكثر من الفرص اللي يكسبها` });
  }
  // Pause proposals only for setups that can recommend. A one-target setup is judged on its
  // average result (time exits included), not on how often it reaches the target.
  const per = model.perSetup();
  for (const s of DEFAULTS.recSetups || []) {
    if ((DEFAULTS.fixedR || {})[s]) {
      const ex = model.expectancy(s);
      if (ex.n >= 30 && ex.ev < 0) props.push({ id: `pause-${s}`, aspect: 'النمط', text: `أوقف نمط ${s} مؤقتاً`, why: `متوسط النتيجة ${ex.ev.toFixed(2)}R قبل العمولة على ${cn(ex.n, 'حالات', 'حالة')} (يشمل الخروج بالوقت)، يعني خاسر`, effect: 'ما يطلع توصيات من هالنمط لين يرجع متوسطه موجب' });
    } else {
      const o = per[s];
      if (o && o.n >= 15 && o.t15 < 0.3) props.push({ id: `pause-${s}`, aspect: 'النمط', text: `أوقف نمط ${s} مؤقتاً`, why: `وصل 1.5R في ${Math.round(o.t15 * 100)}% بس من ${cn(o.n, 'حالات', 'حالة')}، والنمط اللي ما عنده أي ميزة يوصل تقريباً 40%`, effect: 'ما يطلع توصيات من هالنمط لين تتحسن أرقامه' });
    }
  }
  const byTod = {};
  for (const s of audited) (byTod[model.todBucket(s.minAfterOpen || 60)] = byTod[model.todBucket(s.minAfterOpen || 60)] || []).push(s);
  const TOD_AR = { open: 'أول 30 دقيقة', morning: 'الصباح', midday: 'منتصف اليوم', late: 'آخر الجلسة' };
  for (const [k, xs] of Object.entries(byTod)) if (xs.length >= 10 && avgR(xs) < -0.2) props.push({ id: `tod-${k}`, aspect: 'التوقيت', text: `شدّد الشروط في ${TOD_AR[k]}`, why: `إشارات ${TOD_AR[k]} متوسطها ${avgR(xs).toFixed(2)}R على ${cn(xs.length, 'إشارات', 'إشارة')}، يعني خاسرة بالمتوسط`, effect: `توصيات أقل في ${TOD_AR[k]}، وتبقى بس الإشارات الأقوى` });

  props.push(...tuneProposals());
  props.push(...dynProposals());
  props.push(...extProposals());
  return { day, at: Date.now(), source: 'rules', bullets, causes: causeList, proposals: props, losers: losers.length, filters: filterCompare(sig), filtersWeek: filterCompare(weekSig(day)) };
}

async function claudeReport(day, base) {
  if (!ENV.anthropicKey) return { error: 'ما فيه مفتاح ANTHROPIC_API_KEY' };
  const { recs, sig } = recent(5);
  const compact = {
    day, rules: base,
    recs: recs.filter((r) => r.day === day).map((r) => ({ sym: r.sym, setup: r.setup, entry: r.plan.entry, stop: r.plan.stop, t: r.plan.targets.map((x) => [x.price, x.prob]), result: r.result, sip: r.sip && { r: r.sip.r, mfe: r.sip.mfe, reason: r.sip.reason }, feats: r.snapshot && r.snapshot.feats })),
    signals: sig.filter((s) => s.day === day && s.sim).slice(0, 40).map((s) => ({ sym: s.sym, setup: s.setup, accepted: s.accepted, why: s.why, r: s.sim.r, mfe: s.sim.mfe, ext: s.plan.ext, regime: s.regime })),
    model: model.summary(),
  };
  const prompt = `أنت محلل تداول يومي لأسهم أمريكية شرعية (شراء فقط). هذه بيانات اليوم من برنامج Smart Money بصيغة JSON.\nحلّل أسباب الخسارة والفرص الضائعة واقترح تحسينات في أي جانب (الاكتشاف، التوقيت، نمط الدخول، الوقف، الأهداف، الإدارة، القطاعات)، وليس فقط تشديد أو تخفيف الشروط. اعتمد على الأرقام فقط ولا تخترع.\nأرجع JSON فقط بالشكل: {"bullets":["..."],"proposals":[{"aspect":"...","text":"...","why":"السبب بالأرقام","effect":"شو بيتغير لو انطبق"}]} باللهجة الخليجية المختصرة.\n\n${JSON.stringify(compact)}`;
  try {
    const r = await request(`${ENV.anthropicUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': ENV.anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      // Thinking off: the report is a short summary of structured data, and thinking was using the whole budget.
      body: JSON.stringify({ model: ENV.anthropicModel, max_tokens: 6000, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: prompt }] }),
      perMin: 5, tries: 2, timeout: 60000,
    });
    const blocks = Array.isArray(r.content) ? r.content : [];
    const text = blocks.filter((c) => c.type === 'text').map((c) => c.text || '').join('');
    // No text back: say what came back instead of a bare JSON parse error.
    if (!text.includes('{')) throw new Error(`رد Claude بدون نص (stop=${r.stop_reason || '-'}, blocks=${blocks.map((c) => c.type).join(',') || '-'}${r.error ? `, ${r.error.type}: ${r.error.message}` : ''})`);
    const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    return { bullets: (j.bullets || []).slice(0, 8), proposals: (j.proposals || []).slice(0, 6).map((p, i) => ({ id: `ai-${day}-${i}`, aspect: p.aspect, text: p.text, why: p.why, effect: p.effect, by: 'claude' })) };
  } catch (e) {
    // Keep the reason in the report so a failed key, empty balance or bad model name is visible
    // (the HTTP error carries the status and the start of Anthropic's message, never the key).
    warn('claude analyst', e);
    return { error: String((e && e.message) || e).slice(0, 240) };
  }
}

// Every audited signal, grouped by setup and market state. Only cells with enough signals can name a best setup.
export function strategyTable() {
  const sig = listDays().flatMap((d) => readJSON(dayRel(d, 'signals.json'), [])).filter((s) => s.sim && typeof s.sim.r === 'number' && s.regime);
  const cells = {};
  for (const s of sig) {
    const k = `${s.setup}|${s.regime}`;
    const c = (cells[k] = cells[k] || { setup: s.setup, regime: s.regime, n: 0, reached1R: 0, wins: 0, sumR: 0 });
    c.n++; c.sumR += s.sim.r; if (s.sim.mfe >= 1) c.reached1R++; if (s.sim.r > 0) c.wins++;
  }
  const MIN_N = 20;
  const rows = Object.values(cells).map((c) => ({ setup: c.setup, regime: c.regime, n: c.n, reached1R: Math.round((c.reached1R / c.n) * 100), win: Math.round((c.wins / c.n) * 100), avgR: +(c.sumR / c.n).toFixed(2) })).sort((a, b) => b.avgR - a.avgR);
  const best = {};
  for (const g of ['up', 'flat', 'down']) {
    const cand = rows.filter((r) => r.regime === g && r.n >= MIN_N);
    best[g] = cand.length && cand[0].avgR > 0 ? { setup: cand[0].setup, n: cand[0].n, avgR: cand[0].avgR } : null;
  }
  // The same table by the finer market state (trend up/down, sideways, choppy). Signals logged before the
  // state existed have none; they are only in the table above.
  const stCells = {};
  for (const s of sig) {
    if (!s.state) continue;
    const k = `${s.setup}|${s.state}`;
    const c = (stCells[k] = stCells[k] || { setup: s.setup, state: s.state, n: 0, reached1R: 0, wins: 0, sumR: 0 });
    c.n++; c.sumR += s.sim.r; if (s.sim.mfe >= 1) c.reached1R++; if (s.sim.r > 0) c.wins++;
  }
  const stRows = Object.values(stCells).map((c) => ({ setup: c.setup, state: c.state, n: c.n, reached1R: Math.round((c.reached1R / c.n) * 100), win: Math.round((c.wins / c.n) * 100), avgR: +(c.sumR / c.n).toFixed(2) })).sort((a, b) => b.avgR - a.avgR);
  const bestState = {};
  for (const g of ['trendUp', 'trendDown', 'range', 'choppy']) {
    const cand = stRows.filter((r) => r.state === g && r.n >= MIN_N);
    bestState[g] = cand.length && cand[0].avgR > 0 ? { setup: cand[0].setup, n: cand[0].n, avgR: cand[0].avgR } : null;
  }
  return { at: Date.now(), minN: MIN_N, rows, best, stateRows: stRows, bestState };
}

// Per (setup, market state): the exit that did best on the older sessions of the lab and still beats the
// current exit on the newer ones (out of sample), net of costs. Needs lab rows that carry the market state
// ('st'), which exist from the first lab run after the state was added. Proposals only; the user approves.
export function tuneProposals(opts = {}) {
  const { minTrain = 40, minTest = 20, margin = 0.05 } = opts;
  const lab = readJSON('lab/trades-latest.json', null);
  if (!lab || !Array.isArray(lab.rows) || !lab.testFrom) return [];
  const cells = {};
  for (const r of lab.rows) {
    if (!r.st || !r.x || !r.ty) continue;
    (cells[`${r.ty}|${r.st}`] = cells[`${r.ty}|${r.st}`] || []).push(r);
  }
  const mean = (xs, f) => xs.reduce((a, r) => a + r.x[f], 0) / xs.length;
  const out = [];
  for (const [key, xs] of Object.entries(cells)) {
    const [ty, st] = key.split('|');
    const tr = xs.filter((r) => r.d < lab.testFrom), te = xs.filter((r) => r.d >= lab.testFrom);
    if (tr.length < minTrain || te.length < minTest) continue;
    const cur = (DEFAULTS.fixedR || {})[ty] ? Object.keys(EXIT_FAMILIES).find((f) => EXIT_FAMILIES[f] === DEFAULTS.fixedR[ty]) || 'mgmt' : 'mgmt';
    const fams = Object.keys(EXIT_FAMILIES).filter((f) => tr.every((r) => typeof r.x[f] === 'number') && te.every((r) => typeof r.x[f] === 'number'));
    if (!fams.includes(cur)) continue;
    const best = fams.slice().sort((a, b) => mean(tr, b) - mean(tr, a))[0];
    if (best === cur) continue;
    const gain = mean(te, best) - mean(te, cur);
    if (gain < margin) continue;
    out.push({
      id: `tune-${ty}-${st}-${best}`, aspect: 'النمط وشكل السوق',
      text: `في سوق «${STATE_NAMES_AR[st] || st}» غيّر خروج ${ty} من «${EXIT_FAMILY_AR[cur]}» إلى «${EXIT_FAMILY_AR[best]}»`,
      why: `الأفضل على الجلسات القديمة (${tr.length} صفقة): ${mean(tr, best).toFixed(2)}R مقابل ${mean(tr, cur).toFixed(2)}R. وعلى الجلسات الأحدث (${te.length} صفقة، خارج العينة): ${mean(te, best).toFixed(2)}R مقابل ${mean(te, cur).toFixed(2)}R بعد العمولة`,
      effect: `إذا انطبق، ${ty} في هذا الشكل من السوق يخرج بـ«${EXIT_FAMILY_AR[best]}». غيره ما يتغير، وتقدر ترجعه برفض الاقتراح`,
      by: 'rules', gain: +gain.toFixed(3),
    });
  }
  return out.sort((a, b) => b.gain - a.gain).slice(0, 6);
}

// Dynamic stop and target per (setup, market state): the (stop in ATRs, target in R) pair from the lab grid that did
// best, net of costs, on the older sessions and still beats the current setting on the newer ones (out of sample).
// Shrinkage: a cell's mean is pulled toward the pooled mean of its setup (weight n/(n+k)) so small cells cannot
// win on noise. Bounds are the grid itself. Proposals only; the user approves each.
export function dynProposals(opts = {}) {
  const { minTrain = 40, minTest = 20, margin = 0.05, shrinkK = 30 } = opts;
  const lab = readJSON('lab/trades-latest.json', null);
  if (!lab || !Array.isArray(lab.rows) || !lab.testFrom) return [];
  const cap = DEFAULTS.capital, fee = 2 * DEFAULTS.feePerSide;
  const net = (r, si, ki) => {
    const sa = DYN_STOPS[si], Rg = sa * r.a5;
    if (!(Rg > 0) || !r.e) return null;
    const cps = fee / Math.max(1, cap / r.e) + (r.sp || 0.01);
    return r.g[si][ki] - cps / Rg;
  };
  const ok = (r) => Array.isArray(r.g) && r.g.length === DYN_STOPS.length && r.a5 > 0;
  const rowsBy = {};
  for (const r of lab.rows) if (ok(r) && r.ty && r.st) (rowsBy[r.ty] = rowsBy[r.ty] || []).push(r);
  const out = [];
  for (const [ty, all] of Object.entries(rowsBy)) {
    const pooled = (si, ki, rs) => { const v = rs.map((r) => net(r, si, ki)).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; };
    const trAll = all.filter((r) => r.d < lab.testFrom);
    for (const st of STATES) {
      const xs = all.filter((r) => r.st === st);
      const tr = xs.filter((r) => r.d < lab.testFrom), te = xs.filter((r) => r.d >= lab.testFrom);
      if (tr.length < minTrain || te.length < minTest) continue;
      const shr = (si, ki) => { const n = tr.length; return (n * pooled(si, ki, tr) + shrinkK * pooled(si, ki, trAll)) / (n + shrinkK); };
      const curS = DEFAULTS.stopFixedAtr && DEFAULTS.stopFixedAtr[ty] ? DYN_STOPS.indexOf(DEFAULTS.stopFixedAtr[ty]) : 2; // 1 ATR is the grid's reference
      const fk = (DEFAULTS.fixedR || {})[ty];
      const curK = fk ? DYN_TARGETS.indexOf(fk) : 1;
      if (curS < 0 || curK < 0) continue;
      let best = null;
      for (let si = 0; si < DYN_STOPS.length; si++) for (let ki = 0; ki < DYN_TARGETS.length; ki++) {
        const v = shr(si, ki);
        if (!best || v > best.v) best = { si, ki, v };
      }
      if (best.si === curS && best.ki === curK) continue;
      const gain = pooled(best.si, best.ki, te) - pooled(curS, curK, te);
      if (gain < margin) continue;
      const S = DYN_STOPS[best.si], K = DYN_TARGETS[best.ki];
      out.push({
        id: `dyn-${ty}-${st}-s${String(S).replace('.', '_')}-k${String(K).replace('.', '_')}`, aspect: 'وقف وهدف ديناميكي',
        text: `في سوق «${STATE_NAMES_AR[st] || st}» خلّ وقف ${ty} ${S} ATR وهدفه ${K}R`,
        why: `الأفضل على الجلسات القديمة (${tr.length} صفقة): ${pooled(best.si, best.ki, tr).toFixed(2)}R. وعلى الأحدث (${te.length} صفقة، خارج العينة): ${pooled(best.si, best.ki, te).toFixed(2)}R مقابل ${pooled(curS, curK, te).toFixed(2)}R للإعداد الحالي، بعد العمولة`,
        effect: `${ty} في هذا الشكل من السوق يستخدم وقف ${S} ATR وهدف ${K}R بدل الإعداد الحالي. غيره ما يتغير`,
        by: 'rules', gain: +gain.toFixed(3),
      });
    }
  }
  return out.sort((a, b) => b.gain - a.gain).slice(0, 6);
}

// The approved dynamic proposal (dyn-<SETUP>-<state>-s<stop>-k<target>) for this setup in this market state, if any.
export function dynFor(setupType, state) {
  if (!state) return null;
  for (const p of readJSON('proposals.json', [])) {
    if (p.status !== 'approved') continue;
    const m = /^dyn-([A-Z0-9]+)-(trendUp|trendDown|range|choppy)-s(\d+(?:_\d+)?)-k(\d+(?:_\d+)?)$/.exec(String(p.id));
    if (m && m[1] === setupType && m[2] === state) return { id: p.id, stopAtr: +m[3].replace('_', '.'), k: +m[4].replace('_', '.') };
  }
  return null;
}

// Dynamic extension cap per (setup, market state): the largest distance from VWAP (in 5-minute ATRs) a signal may
// have, chosen from the lab rows. A tighter cap is proposed only when dropping the more extended trades raises the
// net mean on the older sessions AND on the newer ones (out of sample), and keeps at least a third of the trades.
export function extProposals(opts = {}) {
  const { minTrain = 40, minTest = 20, margin = 0.05, caps = [0.5, 1, 1.5, 2, 3] } = opts;
  const lab = readJSON('lab/trades-latest.json', null);
  if (!lab || !Array.isArray(lab.rows) || !lab.testFrom) return [];
  const cap0 = DEFAULTS.extMaxAtr5, cap = DEFAULTS.capital, fee = 2 * DEFAULTS.feePerSide;
  const net = (r) => { const R = r.R || 0; if (!(R > 0) || !r.e || typeof r.x?.mgmt !== 'number') return null; return r.x.mgmt - (fee / Math.max(1, cap / r.e) + (r.sp || 0.01)) / R; };
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + net(b), 0) / xs.length : 0);
  const cells = {};
  for (const r of lab.rows) if (r.ty && r.st && typeof r.ext === 'number' && net(r) != null && r.ext <= cap0) (cells[`${r.ty}|${r.st}`] = cells[`${r.ty}|${r.st}`] || []).push(r);
  const out = [];
  for (const [key, xs] of Object.entries(cells)) {
    const [ty, st] = key.split('|');
    const tr = xs.filter((r) => r.d < lab.testFrom), te = xs.filter((r) => r.d >= lab.testFrom);
    if (tr.length < minTrain || te.length < minTest) continue;
    let best = null;
    for (const c of caps.filter((c) => c < cap0)) {
      const ktr = tr.filter((r) => r.ext <= c), kte = te.filter((r) => r.ext <= c);
      if (ktr.length < tr.length / 3 || kte.length < Math.max(8, te.length / 3)) continue;
      const gtr = mean(ktr) - mean(tr), gte = mean(kte) - mean(te);
      if (gtr < margin || gte < margin) continue;
      if (!best || gte > best.gte) best = { c, gtr, gte, ntr: ktr.length, nte: kte.length };
    }
    if (!best) continue;
    out.push({
      id: `ext-${ty}-${st}-c${String(best.c).replace('.', '_')}`, aspect: 'حد الامتداد الديناميكي',
      text: `في سوق «${STATE_NAMES_AR[st] || st}» لا تدخل ${ty} إذا ابتعد السعر أكثر من ${best.c} ATR عن VWAP`,
      why: `استبعاد الأبعد يرفع المتوسط ${best.gtr.toFixed(2)}R على الجلسات القديمة (${best.ntr} من ${tr.length}) و${best.gte.toFixed(2)}R على الأحدث خارج العينة (${best.nte} من ${te.length})، بعد العمولة`,
      effect: `${ty} في هذا الشكل من السوق يرفض الإشارات الأبعد من ${best.c} ATR (الحد الحالي ${cap0}). غيره ما يتغير`,
      by: 'rules', gain: +best.gte.toFixed(3),
    });
  }
  return out.sort((a, b) => b.gain - a.gain).slice(0, 6);
}

// The approved extension cap (ext-<SETUP>-<state>-c<cap>) for this setup in this market state, if any.
export function extFor(setupType, state) {
  if (!state) return null;
  for (const p of readJSON('proposals.json', [])) {
    if (p.status !== 'approved') continue;
    const m = /^ext-([A-Z0-9]+)-(trendUp|trendDown|range|choppy)-c(\d+(?:_\d+)?)$/.exec(String(p.id));
    if (m && m[1] === setupType && m[2] === state) return { id: p.id, cap: +m[3].replace('_', '.') };
  }
  return null;
}

// The approved tuning proposal (tune-<SETUP>-<state>-<exit>) for this setup in this market state, if any.
export function tuneFor(setupType, state) {
  if (!state) return null;
  for (const p of readJSON('proposals.json', [])) {
    if (p.status !== 'approved') continue;
    const m = /^tune-([A-Z0-9]+)-(trendUp|trendDown|range|choppy)-(mgmt|r1|r15|r2)$/.exec(String(p.id));
    if (m && m[1] === setupType && m[2] === state) return { id: p.id, fam: m[3] };
  }
  return null;
}

// Mistakes that come back week after week. Rebuilt from the day files on every run: per week, how often each
// loss cause (and each loss cause per setup) occurred among the audited signals that lost, and how often each
// filter turned away a signal that then reached target 1. A key repeats when it appears at least `minPerWeek`
// times in at least two different weeks.
export function errorsLedger(opts = {}) {
  const { minPerWeek = 3, minWeeks = 2 } = opts;
  const weeks = {};
  for (const d of listDays()) {
    const mon = mondayOf(d);
    const w = (weeks[mon] = weeks[mon] || { signals: 0, counts: {} });
    for (const s of readJSON(dayRel(d, 'signals.json'), [])) {
      if (!s.sim) continue;
      w.signals++;
      const add = (k) => { w.counts[k] = (w.counts[k] || 0) + 1; };
      if (s.sim.r < 0) { const c = classifyLoss(s); add(`loss|${c}`); add(`loss|${c}|${s.setup}`); }
      if (!s.accepted && s.sim.t1) for (const f of new Set(s.why || [])) add(`missed|${f}`);
    }
  }
  const keys = new Set(Object.values(weeks).flatMap((w) => Object.keys(w.counts)));
  const repeated = [];
  for (const k of keys) {
    const hit = Object.entries(weeks).filter(([, w]) => (w.counts[k] || 0) >= minPerWeek).map(([mon, w]) => ({ week: mon, n: w.counts[k] }));
    if (hit.length < minWeeks) continue;
    const [kind, a, setup] = k.split('|');
    const label = kind === 'loss' ? `خسائر بسبب «${CAUSE_AR[a] || a}»${setup ? ` في نمط ${setup}` : ''}` : `فرص رابحة رفضها شرط «${FAIL_AR[a] || a}»`;
    repeated.push({ key: k, label, weeks: hit, total: hit.reduce((x, h) => x + h.n, 0) });
  }
  repeated.sort((x, y) => y.weeks.length - x.weeks.length || y.total - x.total);
  const out = { at: Date.now(), weeks, repeated: repeated.slice(0, 12) };
  writeJSON('errors.json', out);
  return out;
}

export async function runAnalyst(day) {
  const base = rulesReport(day);
  const res = await claudeReport(day, base);
  const ai = res && !res.error ? res : null;
  // Daily reports are for information only. Improvement proposals come from the Friday (weekly) review,
  // so small daily samples do not keep changing the strategy.
  const weekly = new Date(`${day}T12:00:00Z`).getUTCDay() === 5;
  if (!weekly) base.proposals = [];
  const prev = readJSON('proposals.json', []);
  const byId = Object.fromEntries(prev.map((p) => [p.id, p]));
  const fresh = new Set(base.proposals.map((p) => p.id));
  for (const p of [...base.proposals, ...(weekly && ai ? ai.proposals || [] : [])]) {
    if (!byId[p.id]) byId[p.id] = { ...p, status: 'new', createdAt: Date.now(), day };
    else Object.assign(byId[p.id], { why: p.why, effect: p.effect, text: p.text, lastSeen: day });
  }
  // A rule-based proposal that the rules no longer support expires instead of waiting forever.
  if (weekly) for (const p of Object.values(byId)) if (p.status === 'new' && p.by !== 'claude' && !fresh.has(p.id)) { p.status = 'expired'; p.expiredAt = Date.now(); }
  const proposals = Object.values(byId).slice(-40);
  writeJSON('proposals.json', proposals);
  const report = { ...base, kind: weekly ? 'weekly' : 'daily', bullets: ai ? [...ai.bullets] : base.bullets, source: ai ? 'claude' : 'rules', ...(res && res.error ? { claudeError: res.error } : {}) };
  const led = errorsLedger();
  report.repeated = led.repeated;
  if (led.repeated.length) report.bullets = [...report.bullets, `أخطاء تتكرر بين الأسابيع: ${led.repeated.slice(0, 3).map((r) => `${r.label} (${r.weeks.length} أسابيع، ${r.total} حالة)`).join(' · ')}.`];
  writeJSON(dayRel(day, 'analyst.json'), report);
  writeJSON('strategy.json', strategyTable());
  return { report, proposals };
}

export { CAUSE_AR, FAIL_AR };
