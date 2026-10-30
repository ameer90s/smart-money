// Checks the Vercel functions against a fake GitHub API (gist + repository contents).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-api-'));
const day = '2026-11-02';
fs.mkdirSync(path.join(dir, 'days', day), { recursive: true });
fs.writeFileSync(path.join(dir, 'days', day, 'recs.json'), JSON.stringify([{ id: 'r1', sym: 'NOVX', firedNy: '10:02', firedAt: 1, setup: 'ORB15', version: 'S1.0', status: 'closed', exit: 25.1, exitReason: 'وصل الهدف 3', result: { net: 25.4, r: 2.1 }, plan: { entry: 24.18, stop: 23.86, R: 0.32, targets: [{ price: 24.66, prob: 0.7 }, { price: 25.1, prob: 0.44 }, { price: 25.7, prob: 0.2 }], sizing: { shares: 41 } } }]));
fs.writeFileSync(path.join(dir, 'days', day, 'signals.json'), JSON.stringify([]));
const gist = { 'live.json': JSON.stringify({ v: 1, at: 1, recs: [] }), 'settings.json': '{}' };

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.headers.authorization !== 'Bearer tok') { res.writeHead(401); return res.end('{}'); }
    if (u.pathname === '/gists/G') {
      if (req.method === 'PATCH') for (const [k, v] of Object.entries(JSON.parse(body).files)) gist[k] = v.content;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ files: Object.fromEntries(Object.entries(gist).map(([k, v]) => [k, { content: v, truncated: false }])) }));
    }
    const m = u.pathname.match(/^\/repos\/o\/r\/contents\/(.*)$/);
    if (m) {
      const p = path.join(dir, m[1]);
      if (!fs.existsSync(p)) { res.writeHead(404); return res.end('{}'); }
      if (fs.statSync(p).isDirectory()) { res.writeHead(200); return res.end(JSON.stringify(fs.readdirSync(p).map((name) => ({ name })))); }
      res.writeHead(200); return res.end(fs.readFileSync(p));
    }
    res.writeHead(404); res.end('{}');
  });
}).listen(0);
await new Promise((r) => srv.once('listening', r));
Object.assign(process.env, { GITHUB_API_URL: `http://localhost:${srv.address().port}`, GH_TOKEN: 'tok', GIST_ID: 'G', GH_REPO: 'o/r', APP_PIN: '1234' });

const call = async (mod, { method = 'GET', query = {}, headers = {}, body } = {}) => {
  const h = (await import(`../api/${mod}.js`)).default;
  const out = { code: 0, headers: {}, body: null };
  const res = {
    setHeader: (k, v) => { out.headers[k.toLowerCase()] = v; },
    status(c) { out.code = c; return this; },
    json(o) { out.body = o; return this; },
    send(s) { out.body = s; return this; },
    end() { return this; },
  };
  await h({ method, query, headers, body }, res);
  return out;
};

let r = await call('live', { headers: {} });
assert.equal(r.code, 401);
r = await call('live', { headers: { 'x-pin': '1234' } });
assert.equal(r.code, 200); assert.equal(r.body.v, 1);
console.log('PASS  /api/live requires the PIN and returns the gist payload');

r = await call('settings', { method: 'POST', headers: { 'x-pin': '1234' }, body: { settings: { capital: 2000, hacker: 1 }, command: { type: 'entered', rec: 'r1', price: 24.2 } } });
assert.equal(r.code, 200);
const saved = JSON.parse(gist['settings.json']);
assert.equal(saved.capital, 2000); assert.equal(saved.hacker, undefined); assert.equal(saved.commands.length, 1); assert.ok(saved.commands[0].id);
r = await call('settings', { method: 'POST', headers: { 'x-pin': '1234' }, body: { command: { type: 'rm -rf' } } });
assert.equal(JSON.parse(gist['settings.json']).commands.length, 1);
console.log('PASS  /api/settings keeps only allowed keys and command types');

r = await call('export', { query: { from: day, to: day, kind: 'recs', fmt: 'csv', pin: '1234' } });
assert.equal(r.code, 200);
assert.match(r.body, /symbol/); assert.match(r.body, /NOVX/);
r = await call('export', { query: { from: day, to: day, kind: 'all', pin: '1234' } });
assert.equal(r.body.recs.length, 1); assert.deepEqual(r.body.days, [day]);
console.log('PASS  /api/export returns CSV and JSON for a date range');
srv.close();
