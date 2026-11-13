// Dynamic stop/target proposals: out-of-sample, shrinkage, bounds, approved lookup, planner override.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-dyn-'));
process.env.DATA_DIR = dir;
const write = (rel, obj) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), JSON.stringify(obj)); };
const { dynProposals, dynFor, extProposals, extFor, confirmProposals, confirmFor, monitorApproved, applyMonitor, applyReverts } = await import('../engine/analyst.js');
const { plan } = await import('../engine/planner.js');
const { DEFAULTS, DYN_STOPS, DYN_TARGETS } = await import('../engine/config.js');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`PASS  ${name}`); };

// grid [stop][target] gross R. "good": wide stop (index 3 = 1.5 ATR) with 1.5R target wins; the reference (1 ATR, 1.5R) loses.
const grid = (best) => DYN_STOPS.map((_, si) => DYN_TARGETS.map((_, ki) => (si === best[0] && ki === best[1] ? 0.4 : -0.1)));
const rows = [];
const mk = (ty, st, d, g) => rows.push({ ty, st, d, e: 20, sp: 0.02, a5: 0.2, g });
for (let i = 0; i < 60; i++) mk('VWAP', 'range', `2026-08-${String(1 + (i % 20)).padStart(2, '0')}`, grid([3, 1]));
for (let i = 0; i < 30; i++) mk('VWAP', 'range', `2026-10-${String(1 + (i % 20)).padStart(2, '0')}`, grid([3, 1]));
// noise: the best cell flips between train and test, so no proposal
for (let i = 0; i < 60; i++) mk('FLAG', 'choppy', `2026-08-${String(1 + (i % 20)).padStart(2, '0')}`, grid([0, 0]));
for (let i = 0; i < 30; i++) mk('FLAG', 'choppy', `2026-10-${String(1 + (i % 20)).padStart(2, '0')}`, grid([2, 1]));
// tiny cell
for (let i = 0; i < 10; i++) mk('EMA', 'trendUp', `2026-08-0${1 + (i % 9)}`, grid([4, 2]));
write('lab/trades-latest.json', { at: 1, testFrom: '2026-09-22', rows });

t('dyn: proposes the stop/target pair that wins in train and holds in test, within the grid', () => {
  const p = dynProposals();
  const one = p.find((x) => x.id === 'dyn-VWAP-range-s1_5-k1_5');
  assert.ok(one, p.map((x) => x.id).join());
  assert.ok(one.gain >= 0.05 && /خارج العينة/.test(one.why));
});
t('dyn: nothing for unstable or tiny cells', () => {
  const ids = dynProposals().map((x) => x.id);
  assert.ok(!ids.some((i) => /^dyn-(FLAG|EMA)-/.test(i)), ids.join());
});
t('dyn: only approved proposals are looked up', () => {
  write('proposals.json', [{ id: 'dyn-VWAP-range-s1_5-k1_5', status: 'pending' }]);
  assert.equal(dynFor('VWAP', 'range'), null);
  write('proposals.json', [{ id: 'dyn-VWAP-range-s1_5-k1_5', status: 'approved' }]);
  const d = dynFor('VWAP', 'range');
  assert.deepEqual([d.stopAtr, d.k], [1.5, 1.5]);
  assert.equal(dynFor('VWAP', 'choppy'), null);
  assert.equal(dynFor('ORB5', 'range'), null);
});
t('planner: approved fixed stop distance replaces the structural stop', () => {
  const setup = { type: 'VWAP', label: 'x', trigger: 20, stopStruct: 19.9, ext: 0.5 };
  const ctx = { a5: 0.2, hod: 21, pmHigh: null, pdh: null, minAfterOpen: 60 };
  const base = plan(setup, ctx, { spread: 0.01 }, { ...DEFAULTS, capital: 5000 }, {});
  const dyn = plan(setup, ctx, { spread: 0.01 }, { ...DEFAULTS, capital: 5000, stopFixedAtr: { VWAP: 1.5 } }, {});
  assert.ok(Math.abs(dyn.R - 0.3) < 1e-9, String(dyn.R));
  assert.notEqual(base.R, dyn.R);
});

// extension cap: far-from-VWAP trades lose, near ones win, in both samples
const er = [];
const mkE = (ty, st, d, ext, m) => er.push({ ty, st, d, ext, e: 20, sp: 0.02, R: 0.2, x: { mgmt: m } });
for (let i = 0; i < 80; i++) mkE('EMA', 'range', `2026-08-${String(1 + (i % 20)).padStart(2, '0')}`, i % 2 ? 0.4 : 1.8, i % 2 ? 0.5 : -0.6);
for (let i = 0; i < 40; i++) mkE('EMA', 'range', `2026-10-${String(1 + (i % 20)).padStart(2, '0')}`, i % 2 ? 0.4 : 1.8, i % 2 ? 0.5 : -0.6);
for (let i = 0; i < 80; i++) mkE('ORB5', 'range', `2026-08-${String(1 + (i % 20)).padStart(2, '0')}`, i % 2 ? 0.4 : 1.8, 0.1);
for (let i = 0; i < 40; i++) mkE('ORB5', 'range', `2026-10-${String(1 + (i % 20)).padStart(2, '0')}`, i % 2 ? 0.4 : 1.8, 0.1);
write('lab/trades-latest.json', { at: 1, testFrom: '2026-09-22', rows: er });
t('ext: proposes a tighter cap only when it helps in both samples', () => {
  const ids = extProposals().map((x) => x.id);
  assert.ok(ids.some((i) => /^ext-EMA-range-c(0_5|1)$/.test(i)), ids.join());
  assert.ok(!ids.some((i) => i.startsWith('ext-ORB5')), ids.join());
});
t('ext: only approved caps are looked up', () => {
  write('proposals.json', [{ id: 'ext-EMA-range-c1', status: 'pending' }]);
  assert.equal(extFor('EMA', 'range'), null);
  write('proposals.json', [{ id: 'ext-EMA-range-c1', status: 'approved' }]);
  assert.equal(extFor('EMA', 'range').cap, 1);
  assert.equal(extFor('EMA', 'choppy'), null);
});

// confirmation: waiting 2 minutes drops the losers (they fall back below the trigger) and costs little
const cr = [];
const mkC = (ty, st, d, win) => cr.push({ ty, st, d, e: 20, sp: 0.02, R: 0.2, cf: [[win ? 0.6 : -1, 0.2, 20], win ? [0.5, 0.2, 20.02] : null, win ? [0.5, 0.2, 20.02] : null, win ? [0.4, 0.2, 20.04] : null, win ? [0.3, 0.2, 20.1] : null] });
for (let i = 0; i < 80; i++) mkC('FLAG', 'choppy', `2026-08-${String(1 + (i % 20)).padStart(2, '0')}`, i % 3 === 0);
for (let i = 0; i < 40; i++) mkC('FLAG', 'choppy', `2026-10-${String(1 + (i % 20)).padStart(2, '0')}`, i % 3 === 0);
for (let i = 0; i < 80; i++) mkC('VWAP', 'range', `2026-08-${String(1 + (i % 20)).padStart(2, '0')}`, true);
for (let i = 0; i < 40; i++) mkC('VWAP', 'range', `2026-10-${String(1 + (i % 20)).padStart(2, '0')}`, true);
write('lab/trades-latest.json', { at: 1, testFrom: '2026-09-22', rows: cr });
t('confirm: proposes a wait only when it filters losers in both samples', () => {
  const ids = confirmProposals().map((x) => x.id);
  assert.ok(ids.includes('confirm-FLAG-choppy-m1'), ids.join());
  assert.ok(!ids.some((i) => i.startsWith('confirm-VWAP')), ids.join());
});
t('confirm: only approved waits are looked up', () => {
  write('proposals.json', [{ id: 'confirm-FLAG-choppy-m2', status: 'pending' }]);
  assert.equal(confirmFor('FLAG', 'choppy'), null);
  write('proposals.json', [{ id: 'confirm-FLAG-choppy-m2', status: 'approved' }]);
  assert.equal(confirmFor('FLAG', 'choppy').sec, 120);
  assert.equal(confirmFor('FLAG', 'range'), null);
});

// ---- monitoring after approval
const id = 'dyn-VWAP-range-s1_5-k1_5';
const sg = (r, tag = id) => ({ accepted: true, dyn: tag, sim: { r }, plan: { costR: 0.1 } });
write('proposals.json', [{ id, status: 'approved', text: 'x', decidedAt: Date.parse('2026-11-02T08:00:00Z'), expect: 0.3 }]);
write('days/2026-11-01/signals.json', Array.from({ length: 40 }, () => sg(-1))); // before approval: ignored
write('days/2026-11-03/signals.json', [...Array.from({ length: 10 }, () => sg(1)), sg(5, 'other')]);
t('monitor: collecting until enough live signals, other proposals and pre-approval days ignored', () => {
  const m = monitorApproved();
  assert.equal(m[0].n, 10); assert.equal(m[0].verdict, 'collecting');
});
write('days/2026-11-04/signals.json', Array.from({ length: 25 }, (_, i) => sg(i % 2 ? -1 : 0.2)));
t('monitor: weak live result raises a revert proposal; approving it retires the original', () => {
  const m = monitorApproved();
  assert.equal(m[0].n, 35); assert.equal(m[0].verdict, 'weak', JSON.stringify(m));
  const props = applyMonitor();
  const rev = props.find((p) => p.id === `revert-${id}`);
  assert.ok(rev && rev.status === 'new' && rev.target === id);
  assert.equal(props.find((p) => p.id === id).live.verdict, 'weak');
  rev.status = 'approved';
  applyReverts(props);
  assert.equal(props.find((p) => p.id === id).status, 'reverted');
  write('proposals.json', props);
  assert.equal(dynFor('VWAP', 'range'), null);
});
t('monitor: a good live result stays ok and raises nothing', () => {
  write('proposals.json', [{ id, status: 'approved', text: 'x', decidedAt: Date.parse('2026-11-02T08:00:00Z'), expect: 0.3 }]);
  write('days/2026-11-04/signals.json', Array.from({ length: 25 }, () => sg(0.9)));
  const props = applyMonitor();
  assert.equal(props.find((p) => p.id === id).live.verdict, 'ok');
  assert.ok(!props.some((p) => p.id.startsWith('revert-')));
});
console.log(`${n} checks`);
