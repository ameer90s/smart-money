// Historical news timestamps: splitting of crowded windows, budget, counts.
import assert from 'node:assert/strict';
import { fetchNewsHistory, newsCounts } from '../engine/newshist.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log(`PASS  ${name}`); };
const D = (d) => Date.parse(`${d}T12:00:00Z`) / 1000;

await t('windows that look truncated are split until they fit', async () => {
  const calls = [];
  const fh = { enabled: () => true, news: async (s, from, to) => { calls.push([from, to]); const days = (Date.parse(to) - Date.parse(from)) / 864e5 + 1; return Array.from({ length: Math.round(days * 20) }, (_, i) => ({ datetime: D(from) + i })); } };
  const { map, stats } = await fetchNewsHistory(['AAA'], '2026-10-01', '2026-10-30', { fh, chunkDays: 29 });
  assert.ok(calls.length > 1 && stats.truncated === 0);
  assert.ok(map.AAA.length > 100 && map.AAA.every((x, i, a) => i === 0 || x >= a[i - 1]));
});
await t('a symbol that errors is skipped, the rest still load', async () => {
  const fh = { enabled: () => true, news: async (s) => { if (s === 'BAD') throw new Error('x'); return [{ datetime: D('2026-10-05') }]; } };
  const { map, stats } = await fetchNewsHistory(['BAD', 'OK'], '2026-10-01', '2026-10-10', { fh });
  assert.equal(map.OK.length, 1); assert.deepEqual(map.BAD, []); assert.equal(stats.errors, 1);
});
await t('the time budget stops the fetch and leaves later symbols out', async () => {
  const fh = { enabled: () => true, news: async () => { await new Promise((r) => setTimeout(r, 15)); return []; } };
  const { map } = await fetchNewsHistory(['A', 'B', 'C', 'D'], '2026-10-01', '2026-10-03', { fh, budgetMs: 20 });
  assert.ok(Object.keys(map).length < 4);
});
await t('disabled Finnhub returns an empty map', async () => assert.deepEqual((await fetchNewsHistory(['A'], '2026-10-01', '2026-10-03', { fh: { enabled: () => false } })).map, {}));
await t('counts: last 24h, pre-open window, last 60 minutes', () => {
  const open = Date.parse('2026-10-05T13:30:00Z'), fill = open + 90 * 60000;
  const times = [open - 3 * 3600e3, open - 30 * 3600e3, fill - 30 * 60000, fill - 2 * 3600e3];
  assert.deepEqual(newsCounts(times, fill, open), [3, 2, 1]);
  assert.equal(newsCounts(undefined, fill, open), null);
});
console.log(`${n} news history checks passed`);
