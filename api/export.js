// Export of the permanent record (data branch) for a date range:
// /api/export?from=YYYY-MM-DD&to=YYYY-MM-DD&kind=recs|signals|watch|scanner|all&fmt=csv|json
import { cors, authorized, configured, repoDir, repoFile } from './_lib.js';

const KINDS = ['recs', 'signals', 'watch', 'scanner'];

const COLS = {
  recs: [['day', (r) => r.day], ['time_ny', (r) => r.firedNy], ['symbol', (r) => r.sym], ['setup', (r) => r.setup], ['version', (r) => r.version], ['entry', (r) => r.plan.entry], ['stop', (r) => r.plan.stop], ['R', (r) => r.plan.R], ['t1', (r) => r.plan.targets[0].price], ['p_t1', (r) => r.plan.targets[0].prob], ['t2', (r) => r.plan.targets[1].price], ['p_t2', (r) => r.plan.targets[1].prob], ['t3', (r) => r.plan.targets[2].price], ['p_t3', (r) => r.plan.targets[2].prob], ['shares', (r) => r.plan.sizing.shares], ['status', (r) => r.status], ['exit', (r) => r.exit], ['exit_reason', (r) => r.exitReason], ['net_usd', (r) => r.result && r.result.net], ['r_multiple', (r) => r.result && r.result.r], ['sip_r', (r) => r.sip && r.sip.r], ['user_entry', (r) => r.user && r.user.entry]],
  signals: [['day', (r) => r.day], ['time_ny', (r) => r.firedNy], ['symbol', (r) => r.sym], ['setup', (r) => r.setup], ['version', (r) => r.version], ['accepted', (r) => r.accepted], ['rejected_by', (r) => (r.why || []).join('|')], ['score', (r) => r.score], ['regime', (r) => r.regime], ['entry', (r) => r.plan.entry], ['stop', (r) => r.plan.stop], ['p_t1', (r) => r.plan.targets[0].prob], ['ev', (r) => r.plan.ev], ['ext_atr', (r) => r.plan.ext], ['sim_r', (r) => r.sim && r.sim.r], ['sim_mfe', (r) => r.sim && r.sim.mfe], ['sim_best', (r) => r.sim && r.sim.best], ['sim_reason', (r) => r.sim && r.sim.reason]],
  watch: [['day', (r) => r.day], ['added_ms', (r) => r.t], ['symbol', (r) => r.sym], ['score', (r) => r.score], ['direct', (r) => r.direct], ['why', (r) => (r.why || []).join('|')], ['chg', (r) => r.feats && r.feats.chg], ['rvol', (r) => r.feats && r.feats.rvol], ['dropped_ms', (r) => r.dropAt], ['drop_reason', (r) => r.dropReason], ['max_up_pct', (r) => r.after && r.after.maxUp], ['max_down_pct', (r) => r.after && r.after.maxDown]],
  scanner: [['day', (r) => r.day], ['t_ms', (r) => r.t], ['cycle_ms', (r) => r.ms], ['scanned', (r) => r.scanned], ['active', (r) => r.active], ['p90_rvol', (r) => r.p90rvol], ['p90_chg', (r) => r.p90chg], ['ws', (r) => r.ws], ['calls_per_min', (r) => r.calls], ['top', (r) => (r.top || []).map((x) => x.join(':')).join('|')]],
};

const csvCell = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export default async function handler(req, res) {
  cors(res);
  if (!configured()) return res.status(503).json({ error: 'not_configured' });
  if (!authorized(req)) return res.status(401).json({ error: 'pin' });
  const q = req.query || {};
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : '0000-00-00';
  const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : '9999-99-99';
  const kinds = q.kind === 'all' || !q.kind ? KINDS : KINDS.filter((k) => k === q.kind);
  try {
    const days = (await repoDir('days')).filter((d) => d >= from && d <= to).sort().slice(-62);
    const data = Object.fromEntries(kinds.map((k) => [k, []]));
    await Promise.all(days.map(async (d) => {
      for (const k of kinds) {
        const txt = await repoFile(`days/${d}/${k}.json`);
        if (!txt) continue;
        for (const row of JSON.parse(txt)) data[k].push({ day: d, ...row });
      }
    }));
    for (const k of kinds) data[k].sort((a, b) => (a.day + (a.firedAt || a.t || 0)).localeCompare(b.day + (b.firedAt || b.t || 0)));
    if (q.fmt === 'csv') {
      const k = kinds[0];
      const cols = COLS[k];
      const lines = [cols.map((c) => c[0]).join(','), ...data[k].map((r) => cols.map((c) => { try { return csvCell(c[1](r)); } catch { return ''; } }).join(','))];
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="smart-money-${k}-${days[0] || from}_${days[days.length - 1] || to}.csv"`);
      return res.status(200).send(`﻿${lines.join('\n')}`);
    }
    if (q.download) res.setHeader('Content-Disposition', `attachment; filename="smart-money-${days[0] || from}_${days[days.length - 1] || to}.json"`);
    res.status(200).json({ from, to, days, ...data });
  } catch (e) {
    res.status(502).json({ error: 'upstream', detail: String(e.message || e) });
  }
}
