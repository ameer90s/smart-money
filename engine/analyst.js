// Daily analyst: classifies why trades lost, finds missed opportunities, and proposes changes
// in any area (discovery, entry, stop, targets, timing, setups) with a what-if from recorded
// signals. Rule-based by default; adds a written report from Claude when a key is configured.
import { ENV } from './config.js';
import { request } from './http.js';
import { readJSON, writeJSON, dayRel, listDays } from './store.js';
import * as model from './model.js';
import { warn } from './log.js';

const CAUSE_AR = { noise: 'وقف داخل ضجيج السهم', ext: 'دخول ممتد بعد دفعة', market: 'السوق انعكس', late: 'اكتشاف متأخر', spread: 'سيولة أو سبريد', time: 'لم يتحرك (خروج بالوقت)', other: 'أخرى' };
const FAIL_AR = { prob: 'الاحتمال', ev: 'القيمة المتوقعة', rr: 'العائد للمخاطرة', cost: 'التكلفة', stop: 'وقف بعيد', spread: 'السبريد', ext: 'الامتداد', window: 'خارج الوقت', max: 'الحد اليومي', dailyLoss: 'حد الخسارة', cooldown: 'التهدئة', dup: 'تكرار', earnings: 'يوم أرباح', market: 'السوق هابط' };

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

function recent(nDays) {
  const days = listDays().slice(-nDays);
  const sig = [], recs = [];
  for (const d of days) {
    sig.push(...readJSON(dayRel(d, 'signals.json'), []));
    recs.push(...readJSON(dayRel(d, 'recs.json'), []));
  }
  return { days, sig, recs };
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
  const closed = today.recs.filter((r) => r.status === 'closed');
  const net = closed.reduce((a, r) => a + r.result.net, 0);
  const cnt = (k) => (k === 1 ? 'توصية واحدة' : k === 2 ? 'توصيتان' : `${k} توصيات`);
  bullets.push(closed.length ? `${cnt(closed.length)} اليوم: ${closed.filter((r) => r.result.net > 0).length} رابحة و${closed.filter((r) => r.result.net <= 0).length} خاسرة. الصافي ${net >= 0 ? '+' : ''}${net.toFixed(2)}$.` : 'ما صدرت توصيات اليوم.');
  for (const r of closed.filter((x) => x.result.net < 0)) bullets.push(`سبب خسارة ${r.sym}: ${CAUSE_AR[classifyLoss(r)]}.`);
  const tMissed = today.sig.filter((s) => !s.accepted && s.sim && s.sim.t1);
  if (tMissed.length) bullets.push(`فرص فاتت اليوم ووصلت الهدف 1: ${tMissed.slice(0, 4).map((s) => `${s.sym} (${(s.why || []).map((f) => FAIL_AR[f] || f).join('، ')})`).join(' · ')}.`);
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
  const per = model.perSetup();
  for (const [s, o] of Object.entries(per)) if (o.n >= 15 && o.t15 < 0.3) props.push({ id: `pause-${s}`, aspect: 'النمط', text: `أوقف نمط ${s} مؤقتاً`, why: `وصل 1.5R في ${Math.round(o.t15 * 100)}% بس من ${cn(o.n, 'حالات', 'حالة')}، والنمط اللي ما عنده أي ميزة يوصل تقريباً 40%`, effect: 'ما يطلع توصيات من هالنمط. حالياً هو أصلاً تحت حد الثقة 45%، فالإيقاف يثبّت الوضع لين تتحسن أرقامه' });
  const byTod = {};
  for (const s of audited) (byTod[model.todBucket(s.minAfterOpen || 60)] = byTod[model.todBucket(s.minAfterOpen || 60)] || []).push(s);
  const TOD_AR = { open: 'أول 30 دقيقة', morning: 'الصباح', midday: 'منتصف اليوم', late: 'آخر الجلسة' };
  for (const [k, xs] of Object.entries(byTod)) if (xs.length >= 10 && avgR(xs) < -0.2) props.push({ id: `tod-${k}`, aspect: 'التوقيت', text: `شدّد الشروط في ${TOD_AR[k]}`, why: `إشارات ${TOD_AR[k]} متوسطها ${avgR(xs).toFixed(2)}R على ${cn(xs.length, 'إشارات', 'إشارة')}، يعني خاسرة بالمتوسط`, effect: `توصيات أقل في ${TOD_AR[k]}، وتبقى بس الإشارات الأقوى` });

  return { day, at: Date.now(), source: 'rules', bullets, causes: causeList, proposals: props, losers: losers.length };
}

async function claudeReport(day, base) {
  if (!ENV.anthropicKey) return null;
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
      body: JSON.stringify({ model: ENV.anthropicModel, max_tokens: 1500, messages: [{ role: 'user', content: prompt }] }),
      perMin: 5, tries: 2, timeout: 60000,
    });
    const text = (r.content || []).map((c) => c.text || '').join('');
    const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    return { bullets: (j.bullets || []).slice(0, 8), proposals: (j.proposals || []).slice(0, 6).map((p, i) => ({ id: `ai-${day}-${i}`, aspect: p.aspect, text: p.text, why: p.why, effect: p.effect, by: 'claude' })) };
  } catch (e) { warn('claude analyst', e); return null; }
}

export async function runAnalyst(day) {
  const base = rulesReport(day);
  const ai = await claudeReport(day, base);
  const prev = readJSON('proposals.json', []);
  const byId = Object.fromEntries(prev.map((p) => [p.id, p]));
  for (const p of [...base.proposals, ...((ai && ai.proposals) || [])]) {
    if (!byId[p.id]) byId[p.id] = { ...p, status: 'new', createdAt: Date.now(), day };
    else Object.assign(byId[p.id], { why: p.why, effect: p.effect, text: p.text, lastSeen: day });
  }
  const proposals = Object.values(byId).slice(-40);
  writeJSON('proposals.json', proposals);
  const report = { ...base, bullets: ai ? [...ai.bullets] : base.bullets, source: ai ? 'claude' : 'rules' };
  writeJSON(dayRel(day, 'analyst.json'), report);
  return { report, proposals };
}

export { CAUSE_AR, FAIL_AR };
