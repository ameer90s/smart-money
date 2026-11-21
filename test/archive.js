// Catalyst archive and Finnhub history probe, with a fake Finnhub.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-arch-'));
process.env.DATA_DIR = dir;
const day = '2026-11-20';
fs.mkdirSync(path.join(dir, 'days', day), { recursive: true });
fs.writeFileSync(path.join(dir, 'days', day, 'signals.json'), JSON.stringify([{ sym: 'AAA' }, { sym: 'BBB' }]));
fs.writeFileSync(path.join(dir, 'days', day, 'watch.json'), JSON.stringify([{ sym: 'BBB' }, { sym: 'CCC' }]));
const { archiveCatalysts, probeFinnhub, daySymbols } = await import('../engine/archive.js');

const calls = [];
const fh = {
  enabled: () => true,
  news: async (s, from, to) => { calls.push(['news', s, from, to]); return s === 'CCC' ? [] : [{ datetime: 1763640000, headline: `${s} beats ${'x'.repeat(300)}`, source: 'Wire' }]; },
  earnings: async (from, to) => { calls.push(['earn', from, to]); return { earningsCalendar: [{ symbol: 'AAA', hour: 'bmo', epsActual: 1.2, epsEstimate: 1.0 }, { symbol: 'ZZZ', hour: 'amc' }] }; },
};
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log(`PASS  ${name}`); };

await t('day symbols are the union of signals and watchlist', () => assert.deepEqual(daySymbols(day).sort(), ['AAA', 'BBB', 'CCC']));
await t('archive keeps compact news per stock and the earnings rows', async () => {
  const out = await archiveCatalysts(day, fh);
  assert.deepEqual(Object.keys(out.news).sort(), ['AAA', 'BBB']);
  assert.ok(out.news.AAA[0].h.length <= 160 && out.news.AAA[0].t === 1763640000000);
  assert.equal(out.earnings.length, 2); assert.equal(out.earnings[0].epsA, 1.2);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'days', day, 'catalyst.json'), 'utf8')).day, day);
});
await t('archive does nothing without a Finnhub key', async () => assert.equal(await archiveCatalysts(day, { enabled: () => false }), null));
await t('a failing request never breaks the archive', async () => {
  const bad = { enabled: () => true, news: async () => { throw new Error('boom'); }, earnings: async () => { throw new Error('nope'); } };
  const out = await archiveCatalysts(day, bad);
  assert.deepEqual(out.news, {}); assert.deepEqual(out.earnings, []);
});
await t('probe reports how far back news and earnings are served', async () => {
  const out = await probeFinnhub('2026-11-21', fh);
  assert.equal(out.news.length, 5); assert.equal(out.earnings.length, 5);
  assert.equal(out.news[0].count, 1); assert.equal(out.earnings[2].withActual, 1);
  assert.ok(fs.existsSync(path.join(dir, 'lab', 'finnhub-probe.json')));
});
await t('probe records errors instead of throwing', async () => {
  const bad = { enabled: () => true, news: async () => { throw new Error('403 plan'); }, earnings: async () => ({ earningsCalendar: [] }) };
  const out = await probeFinnhub('2026-11-21', bad);
  assert.match(out.news[0].error, /403/); assert.equal(out.earnings[0].count, 0);
});
console.log(`${n} archive checks passed`);
