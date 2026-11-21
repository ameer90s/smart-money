// Strategy lab smoke test against the mock market (one past session).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-lab-'));
const PORT = 19600 + Math.floor(Math.random() * 300);
Object.assign(process.env, {
  DATA_DIR: dir, MOCK_DAY: '2026-10-28', MOCK_PORT: String(PORT),
  ALPACA_KEY: 'k', ALPACA_SECRET: 's', ALPACA_DATA_URL: `http://localhost:${PORT}`, ALPACA_TRADING_URL: `http://localhost:${PORT}`,
});
const at = Date.now();
fs.writeFileSync(path.join(dir, 'shariah.json'), JSON.stringify(Object.fromEntries(['NOVX', 'HLXA', 'KRNA', 'ORBT', 'SUNQ'].map((s) => [s, { st: 'ok', at, sector: 'XLK' }]))));
fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify({ v: 1, samples: [{ setup: 'VWAP', mfe: 1, src: 'live', day: '2026-10-30', sym: 'X' }], calib: [], trainedAt: 1, sources: { live: 1 } }));
const modelBefore = fs.readFileSync(path.join(dir, 'model.json'), 'utf8');

const mock = spawn(process.execPath, ['test/mock.js'], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => mock.stdout.once('data', r));
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log(`PASS  ${name}`); };
try {
  const { runLab } = await import('../engine/lab.js');
  const { DEFAULTS } = await import('../engine/config.js');
  const universe = { symbols: ['NOVX', 'HLXA', 'KRNA', 'ORBT', 'SUNQ', 'BANKX'].map((s, i) => ({ s, adv: [5e7, 3e7, 2e7, 4e7, 2e7, 9e7][i] })) };
  const out = await runLab(universe, DEFAULTS, { days: 60, testDays: 1 });

  await t('lab replays the session and writes results', () => {
    assert.equal(out.done, 1);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'lab/latest.json'), 'utf8'));
    assert.equal(saved.variants.length, out.variants.length);
    assert.ok(out.variants.length > 0);
  });
  await t('every variant reports train/test, net of costs, with breakdowns', () => {
    for (const v of out.variants) {
      assert.ok(v.fam && v.exit && v.funnel && v.label && v.exitLabel);
      assert.equal(v.all.n, v.train.n + v.test.n);
      assert.ok(v.all.avgNet <= v.all.avgR, 'costs make net worse than gross');
      assert.ok(Object.keys(v.regime).length >= 1 && Object.keys(v.month).length >= 1);
    }
    const base = out.variants.find((v) => v.key === 'base|mgmt|watch');
    assert.ok(base && base.all.n >= 1, 'current setups replayed through the live funnel');
  });
  await t('the lab never changes the live model', () => {
    assert.equal(fs.readFileSync(path.join(dir, 'model.json'), 'utf8'), modelBefore);
  });
  await t('lab rows carry the stop/target grid and the confirmation delays', () => {
    const f = path.join(dir, 'lab/trades-latest.json');
    const rows = JSON.parse(fs.readFileSync(f, 'utf8')).rows;
    assert.ok(rows.length > 0);
    const r = rows[0];
    assert.equal(r.g.length, 5); assert.equal(r.g[0].length, 3);
    assert.equal(r.cf.length, 5); assert.ok(r.cf[0] === null || r.cf[0].length === 3);
  });
  await t('lab rows record sweep features and what happens after the stop', () => {
    const rows = JSON.parse(fs.readFileSync(path.join(dir, 'lab/trades-latest.json'), 'utf8')).rows;
    for (const r of rows) {
      assert.ok(r.sw && typeof r.sw === 'object');
      assert.ok(r.aft === null || (r.aft.length === 3 && r.aft[0] >= 0));
      assert.ok('lv' in r);
    }
    assert.ok(rows.some((r) => r.aft), 'at least one row hit its stop');
  });
  await t('lab rows record the hold-to-close results, the opening gap and the strength against SPY', () => {
    const rows = JSON.parse(fs.readFileSync(path.join(dir, 'lab/trades-latest.json'), 'utf8')).rows;
    for (const r of rows) {
      assert.equal(r.hd.length, 4); assert.ok(r.hd[0] >= -1.01 && r.hd[1] >= -1.01, JSON.stringify(r.hd)); assert.ok(r.hd[0] >= -1.01 && r.hd[1] >= -1.01 && r.hd[2] >= r.hd[3]);
      assert.ok(typeof r.gap === 'number' && typeof r.rs === 'number');
    }
  });
  await t('sweepReclaim buys the first close back above a swept level, stop under the sweep low', async () => {
    const { sweepReclaim } = await import('../engine/lab.js');
    const bar = (o, h, l, c) => ({ o, h, l, c, v: 1000 });
    const rth = Array.from({ length: 30 }, () => bar(10.2, 10.3, 10.1, 10.2));
    rth[2] = bar(10.2, 10.3, 10.0, 10.2); // opening-range low 10.0
    rth.push(bar(10.1, 10.15, 9.8, 9.9)); // sweeps below 10.0
    rth.push(bar(9.9, 10.15, 9.85, 10.1)); // closes back above, green
    const ctx = { rth, a5: 0.1, vwap: 10.1, last: rth[rth.length - 1] };
    const st = sweepReclaim(ctx, { pdl: 0 });
    assert.ok(st && st.type === 'SWEEP' && st.lvl === 'or15');
    assert.ok(st.stopStruct < 9.8 && st.trigger > 10.15);
    assert.equal(sweepReclaim({ ...ctx, rth: rth.slice(0, 30), last: rth[29] }, { pdl: 0 }), null);
  });
  console.log(out.variants.slice(0, 8).map((v) => `${v.key}: n=${v.all.n} net=${v.all.avgNet}`).join('\n'));
} finally {
  mock.kill();
}
console.log(`\n${n} lab checks passed`);
