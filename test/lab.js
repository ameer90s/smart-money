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
  const out = await runLab(universe, DEFAULTS, { days: 5, testDays: 1 });

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
  console.log(out.variants.slice(0, 8).map((v) => `${v.key}: n=${v.all.n} net=${v.all.avgNet}`).join('\n'));
} finally {
  mock.kill();
}
console.log(`\n${n} lab checks passed`);
