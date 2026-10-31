// Model de-duplication and the incremental historical replay, against the mock market.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-model-'));
const PORT = 19080 + Math.floor(Math.random() * 500);
Object.assign(process.env, {
  DATA_DIR: dir, MOCK_DAY: '2026-10-28', MOCK_PORT: String(PORT),
  ALPACA_KEY: 'k', ALPACA_SECRET: 's', ALPACA_DATA_URL: `http://localhost:${PORT}`, ALPACA_TRADING_URL: `http://localhost:${PORT}`,
});

// A model file as written before de-duplication existed: one trade counted twice.
const dup = { setup: 'VWAP', mfe: 1, score: 'mid', tod: 'open', regime: 'flat', src: 'backtest', day: '2026-10-12', sym: 'AAA' };
fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify({ v: 1, samples: [dup, { ...dup }, { setup: 'ORB5', mfe: 0.2, src: 'seed' }], calib: [], trainedAt: 0, sources: { backtest: 2, seed: 1 } }));
const at = Date.now();
fs.writeFileSync(path.join(dir, 'shariah.json'), JSON.stringify({ NOVX: { st: 'ok', at }, HLXA: { st: 'ok', at }, KRNA: { st: 'ok', at }, BANKX: { st: 'no', at } }));

const mock = spawn(process.execPath, ['test/mock.js'], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => mock.stdout.once('data', r));
const feeds = async () => (await (await fetch(`http://localhost:${PORT}/__captured`)).json()).feeds;

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log(`PASS  ${name}`); };
try {
  const model = await import('../engine/model.js');
  const { bootstrap } = await import('../engine/backtest.js');
  const { DEFAULTS } = await import('../engine/config.js');

  await t('duplicates in an old model file are removed on load', () => {
    const m = model.load();
    assert.equal(m.samples.length, 2);
    assert.deepEqual(m.sources, { backtest: 1, seed: 1 });
    assert.ok(model.wasReplayed('2026-10-12', 'AAA'), 'replay tracking seeded from samples');
  });

  await t('the same trade is not added twice; another source is', () => {
    assert.equal(model.addSample({ ...dup, mfe: 3 }), false);
    assert.equal(model.addSample({ ...dup, src: 'live' }), true);
    assert.equal(model.load().sources.live, 1);
  });

  // Walk-forward replay of one past session on the mock market (its calendar has one day).
  const universe = { symbols: ['NOVX', 'HLXA', 'KRNA', 'ORBT', 'SUNQ', 'BANKX'].map((s, i) => ({ s, adv: [5e7, 3e7, 2e7, 4e7, 2e7, 9e7][i] })) };
  for (const s of ['ORBT', 'SUNQ']) fs.writeFileSync(path.join(dir, 'shariah.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(dir, 'shariah.json'), 'utf8')), [s]: { st: 'ok', at } }));
  let first = 0;
  await t('walk-forward replay: live funnel, no hindsight, retires old samples', async () => {
    first = await bootstrap(universe, DEFAULTS, { days: 5, budgetMs: 120000, minReplay: 1 });
    assert.ok(model.wasReplayed('2026-10-28', '*2'));
    const S = model.load().samples;
    const rep = S.filter((s) => s.src === 'replay');
    assert.ok(rep.length >= 1, 'replay produced signals');
    assert.ok(rep.every((s) => s.sym !== 'BANKX'), 'non-compliant stock never replayed');
    assert.ok(rep.every((s) => s.day === '2026-10-28' && ['lo', 'mid', 'hi'].includes(s.score)));
    assert.equal(S.filter((s) => s.src === 'backtest').length, 0, 'hindsight samples retired');
    const keys = S.filter((s) => s.day && s.sym).map((s) => `${s.src}|${s.day}|${s.sym}|${s.setup}`);
    assert.equal(new Set(keys).size, keys.length);
  });

  await t('a second replay is incremental: no new requests, no new samples', async () => {
    const before = await feeds();
    const size = model.load().samples.length;
    const second = await bootstrap(universe, DEFAULTS, { days: 5, budgetMs: 120000, minReplay: 1 });
    const after = await feeds();
    assert.equal(second, 0);
    assert.equal(model.load().samples.length, size);
    assert.deepEqual(after, before);
  });

  await t('replay state survives a save', () => {
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'model.json'), 'utf8'));
    assert.ok(saved.replayed['2026-10-28|*2']);
    assert.equal(saved.samples.length, model.load().samples.length);
  });
  await t('AI proposals carry a reason and an effect, and are never applied by themselves', async () => {
    for (let i = 0; i < 20; i++) model.addSample({ setup: 'DIP', mfe: i < 4 ? 2 : 0.4, src: 'seed' });
    const { rulesReport } = await import('../engine/analyst.js');
    const rep = rulesReport('2026-10-30');
    const p = rep.proposals.find((x) => x.id === 'pause-DIP');
    assert.ok(p, 'pause proposal for a weak recommendable setup');
    assert.ok(!rep.proposals.some((x) => x.id === 'pause-ORB5' || x.id === 'pause-VWAP'), 'no pause proposals for logged-only setups');
    assert.ok(p.why && /حالة|حالات/.test(p.why) && p.effect);
    assert.ok(rep.proposals.every((x) => !('status' in x) || x.status === 'new'));
  });
  console.log(`(replay added ${first} signals: ${model.load().samples.filter((x) => x.src === 'replay').map((x) => `${x.sym}/${x.setup}`).join(', ')})`);
} finally {
  mock.kill();
}
console.log(`\n${n} model checks passed`);
