// Tuning proposals per market state, approved-proposal lookup, repeated-error ledger, state edge.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-tune-'));
process.env.DATA_DIR = dir;
const write = (rel, obj) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), JSON.stringify(obj)); };
const { tuneProposals, tuneFor, errorsLedger } = await import('../engine/analyst.js');
const model = await import('../engine/model.js');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`PASS  ${name}`); };

// ---- lab rows: ORB15 in choppy (r2 best, beats mgmt out of sample), ORB15 in range (no real gain), ORB5 in trendUp (too few)
const rows = [];
const mk = (ty, st, d, x) => rows.push({ ty, st, d, x });
for (let i = 0; i < 60; i++) mk('ORB15', 'choppy', `2026-08-${String(1 + (i % 20)).padStart(2, '0')}`, { mgmt: -0.1, r1: 0, r15: 0.05, r2: 0.2 });
for (let i = 0; i < 30; i++) mk('ORB15', 'choppy', `2026-10-${String(1 + (i % 20)).padStart(2, '0')}`, { mgmt: -0.05, r1: 0, r15: 0.05, r2: 0.15 });
for (let i = 0; i < 60; i++) mk('ORB15', 'range', `2026-08-${String(1 + (i % 20)).padStart(2, '0')}`, { mgmt: 0, r1: 0.01, r15: 0.02, r2: 0.1 });
for (let i = 0; i < 30; i++) mk('ORB15', 'range', `2026-10-${String(1 + (i % 20)).padStart(2, '0')}`, { mgmt: 0.05, r1: 0.04, r15: 0.04, r2: 0.06 });
for (let i = 0; i < 10; i++) mk('ORB5', 'trendUp', `2026-08-0${1 + (i % 9)}`, { mgmt: 0, r1: 0, r15: 0, r2: 0.5 });
for (let i = 0; i < 70; i++) mk('DIP', 'range', `2026-08-${String(1 + (i % 20)).padStart(2, '0')}`, { mgmt: 0.3, r1: 0.1, r15: 0, r2: -0.1 });
for (let i = 0; i < 30; i++) mk('DIP', 'range', `2026-10-${String(1 + (i % 20)).padStart(2, '0')}`, { mgmt: 0.2, r1: 0.1, r15: 0, r2: -0.1 });
write('lab/trades-latest.json', { at: 1, testFrom: '2026-09-22', costs: {}, rows });

t('tuning: proposes the exit that wins on older sessions and still beats the current one out of sample', () => {
  const p = tuneProposals();
  const ids = p.map((x) => x.id);
  assert.ok(ids.includes('tune-ORB15-choppy-r2'), ids.join());
  const one = p.find((x) => x.id === 'tune-ORB15-choppy-r2');
  assert.match(one.why, /60|90/); assert.ok(one.gain >= 0.05);
});
t('tuning: no proposal when the gain out of sample is too small, the cell is too small, or the current exit is the best', () => {
  const ids = tuneProposals().map((x) => x.id);
  assert.ok(!ids.some((i) => i.startsWith('tune-ORB15-range')), ids.join());
  assert.ok(!ids.some((i) => i.startsWith('tune-ORB5-')));
  // DIP's current exit is the fixed 1.5R family (net 0.00 here); management beats it on both samples, so that IS proposed
  assert.ok(ids.includes('tune-DIP-range-mgmt'), ids.join());
});
t('tuning: without state in the lab rows nothing is proposed', () => {
  write('lab/trades-latest.json', { at: 1, testFrom: '2026-09-22', costs: {}, rows: rows.map(({ st, ...r }) => r) });
  assert.deepEqual(tuneProposals(), []);
});

t('approved tuning proposal is found for its setup and state only', () => {
  write('proposals.json', [{ id: 'tune-ORB15-choppy-r2', status: 'approved' }, { id: 'tune-VWAP-range-r1', status: 'new' }, { id: 'tune-ORB5-range-mgmt', status: 'rejected' }, { id: 'pause-DIP', status: 'approved' }]);
  assert.deepEqual(tuneFor('ORB15', 'choppy'), { id: 'tune-ORB15-choppy-r2', fam: 'r2' });
  assert.equal(tuneFor('ORB15', 'range'), null);
  assert.equal(tuneFor('VWAP', 'range'), null);
  assert.equal(tuneFor('ORB5', 'range'), null);
  assert.equal(tuneFor('ORB15', null), null);
});

// ---- repeated errors: ext losses in two weeks (3+ each), VWAP losses by time in one week only
const sig = (setup, r, extra = {}) => ({ setup, accepted: false, why: [], plan: { ext: 0 }, sim: { r, mfe: 0.1, t1: false }, ...extra });
write('days/2026-11-02/signals.json', [...Array.from({ length: 3 }, () => sig('EMA', -1, { plan: { ext: 2.2 } })), ...Array.from({ length: 4 }, () => sig('VWAP', -0.1, { sim: { r: -0.1, mfe: 0.2, reason: 'timestop' } })), ...Array.from({ length: 3 }, () => sig('ORB15', 1.5, { why: ['prob'], sim: { r: 1.5, mfe: 2, t1: true } }))]);
write('days/2026-11-09/signals.json', [...Array.from({ length: 3 }, () => sig('EMA', -1, { plan: { ext: 2.4 } })), ...Array.from({ length: 3 }, () => sig('ORB15', 1.1, { why: ['prob'], sim: { r: 1.1, mfe: 2, t1: true } }))]);
t('errors: a loss cause that recurs in two weeks is flagged, a one-week pattern is not', () => {
  const led = errorsLedger();
  const keys = led.repeated.map((r) => r.key);
  assert.ok(keys.includes('loss|ext'), keys.join());
  assert.ok(keys.includes('loss|ext|EMA'));
  assert.ok(keys.includes('missed|prob'));
  assert.ok(!keys.includes('loss|time'), 'time losses happened in one week only');
  const e = led.repeated.find((r) => r.key === 'loss|ext');
  assert.equal(e.weeks.length, 2); assert.equal(e.total, 6);
  assert.ok(fs.existsSync(path.join(dir, 'errors.json')));
});

// ---- state edge
write('model.json', { v: 1, samples: [...Array.from({ length: 40 }, (_, i) => ({ setup: 'ORB5', mfe: 1, r: -0.5, state: 'choppy', src: 'live', day: 'd', sym: `S${i}` })), { setup: 'ORB5', mfe: 1, r: 2, state: 'range', src: 'live', day: 'd', sym: 'X' }, { setup: 'ORB5', mfe: 1, r: 1, src: 'live', day: 'd', sym: 'X' }], calib: [], trainedAt: 1, sources: {} });
t('state edge: shrunk mean per setup and state; none without state', () => {
  const c = model.stateEdge('ORB5', 'choppy');
  assert.equal(c.n, 40); assert.ok(c.ev < 0 && c.ev > -0.5, String(c.ev));
  assert.equal(model.stateEdge('ORB5', 'range').n, 1);
  assert.equal(model.stateEdge('ORB5', null).n, 0);
  assert.equal(model.stateEdge('VWAP', 'choppy').n, 0);
});

console.log(`\n${n} tune checks passed`);
