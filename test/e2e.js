// End-to-end: runs the engine against the mock market for a simulated morning
// (09:20 → 11:05 New York) and checks recommendations, alerts, live payload and records.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DAY = process.env.MOCK_DAY || '2026-11-02';
const PORT = 18080 + Math.floor(Math.random() * 500);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-e2e-'));
const startIso = process.env.SIM_START || `${DAY}T14:20:00Z`; // 09:20 New York (EST)
const env = {
  ...process.env,
  SIM_START: startIso, SIM_SPEED: process.env.SIM_SPEED || '20', MOCK_DAY: DAY, MOCK_PORT: String(PORT),
  ALPACA_KEY: 'k', ALPACA_SECRET: 's',
  ALPACA_DATA_URL: `http://localhost:${PORT}`, ALPACA_TRADING_URL: `http://localhost:${PORT}`, ALPACA_STREAM_URL: `ws://localhost:${PORT}`,
  FINNHUB_KEY: 'f', FINNHUB_URL: `http://localhost:${PORT}/fh`,
  NTFY_TOPIC: 'test', NTFY_URL: `http://localhost:${PORT}/ntfy`,
  GIST_ID: process.env.NO_GIST ? '' : 'g1', GIST_TOKEN: 't', GITHUB_API_URL: `http://localhost:${PORT}`,
  FF_CALENDAR_URL: `http://localhost:${PORT}/ff`,
  APP_URL: 'https://example.invalid', DATA_DIR: dataDir, UNTIL_NY: process.env.UNTIL_NY || '11:05', MAX_MIN: '0',
};

// Seed the model so the test exercises issuing (on a real server the historical replay does this).
const samples = [];
for (const setup of ['ORB15', 'ORB5', 'VWAP', 'FLAG', 'PMH', 'PDH', 'EMA']) for (let i = 0; i < 60; i++) samples.push({ setup, mfe: [0.3, 0.8, 1.6, 2.1, 2.6, 3.4, 1.8, 4.2, 0.5, 2.0][i % 10], score: 'mid', tod: 'morning', regime: 'flat', src: 'seed' });
fs.writeFileSync(path.join(dataDir, 'model.json'), JSON.stringify({ v: 1, samples, calib: [], trainedAt: 0, sources: { seed: samples.length } }));

const mock = spawn(process.execPath, ['test/mock.js'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => mock.stdout.once('data', r));
const t0 = Date.now();
const eng = spawn(process.execPath, ['engine/main.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
eng.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
eng.stderr.on('data', (d) => { out += d; process.stderr.write(d); });
const code = await new Promise((r) => eng.on('exit', r));
const cap = await (await fetch(`http://localhost:${PORT}/__captured`)).json();
mock.kill();

const read = (rel, def) => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, rel), 'utf8')); } catch { return def; } };
const recs = read(`days/${DAY}/recs.json`, []);
const signals = read(`days/${DAY}/signals.json`, []);
const watch = read(`days/${DAY}/watch.json`, []);
const scanner = read(`days/${DAY}/scanner.json`, []);
const liveObj = cap.gist['live.json'] ? JSON.parse(cap.gist['live.json'].content) : read('live.json', null);

const checks = [
  ['engine exited cleanly', code === 0],
  ['universe excludes ETFs and the bank', !watch.some((w) => ['SPY', 'TQQQ', 'BANKX'].includes(w.sym)) && !recs.some((r) => r.sym === 'BANKX')],
  ['watchlist populated', watch.length >= 2],
  ['signals recorded', signals.length >= 1],
  ['at least one recommendation', recs.length >= 1],
  ['recommendations carry plan, targets and probabilities', recs.every((r) => r.plan && r.plan.targets.length === 3 && r.plan.targets.every((t) => t.prob > 0 && t.prob < 1))],
  ['stop below entry, targets ascending', recs.every((r) => r.plan.stop < r.plan.entry && r.plan.targets[0].price < r.plan.targets[1].price && r.plan.targets[1].price < r.plan.targets[2].price)],
  ['rec alert sent to phone', cap.ntfy.some((n) => /توصية شراء/.test(n.title))],
  ['live payload published to gist', process.env.NO_GIST ? true : !!liveObj && cap.gistPatches > 3],
  ['live payload has watch, recs, stats, market', !!liveObj && Array.isArray(liveObj.watch) && Array.isArray(liveObj.recs) && liveObj.stats && liveObj.market],
  ['scanner minute log written', scanner.length >= 10],
  ['each record tagged with strategy version', recs.every((r) => r.version) && signals.every((s) => s.version)],
];
console.log('\n=== e2e results ===');
let ok = true;
for (const [name, pass] of checks) { console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`); if (!pass) ok = false; }
console.log(`recs: ${recs.map((r) => `${r.sym}/${r.setup} ${r.status}${r.result ? ` ${r.result.net}$` : ''}`).join(', ') || 'none'}`);
console.log(`signals: ${signals.map((s) => `${s.sym}/${s.setup}:${s.accepted ? 'ok' : s.why.join('+')}`).join(', ')}`);
console.log(`ntfy: ${cap.ntfy.map((n) => n.title).join(' | ')}`);
console.log(`data dir: ${dataDir}  real time: ${Math.round((Date.now() - t0) / 1000)}s`);
fs.writeFileSync(path.join(dataDir, 'live-final.json'), JSON.stringify(liveObj, null, 1));
process.exit(ok ? 0 : 1);
