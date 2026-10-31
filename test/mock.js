// Mock market for end-to-end tests: Alpaca REST + stream, Finnhub, ntfy, GitHub Gist, FF calendar.
// Uses the same simulated clock as the engine (SIM_START / SIM_SPEED).
import http from 'node:http';
import crypto from 'node:crypto';
import { now, ny, nyToUtc, addDays, dowOf } from '../engine/clock.js';

const PORT = Number(process.env.MOCK_PORT || 18080);
const DAY = process.env.MOCK_DAY; // YYYY-MM-DD of the simulated session

const SYMS = {
  NOVX: { pc: 22.5, ind: 'Technology', avg: 3e6, path: 'orb' },
  HLXA: { pc: 39.0, ind: 'Pharmaceuticals', avg: 2e6, path: 'vwap' },
  KRNA: { pc: 18.0, ind: 'Machinery', avg: 2.5e6, path: 'flag' },
  BANKX: { pc: 30.0, ind: 'Banking', avg: 4e6, path: 'orb' },
  VELO: { pc: 64.0, ind: 'Retail', avg: 1.5e6, path: 'drift' },
  ORBT: { pc: 12.0, ind: 'Electrical Equipment', avg: 3e6, path: 'fail' },
  SUNQ: { pc: 48.0, ind: 'Semiconductors', avg: 2e6, path: 'late' },
  DIPX: { pc: 25.0, ind: 'Software', avg: 3e6, path: 'dip' },
  ...Object.fromEntries(['AAAA', 'BBBB', 'CCCC', 'DDDD', 'EEEE', 'FFFF', 'GGGG', 'HHHH'].map((s, i) => [s, { pc: 15 + i * 7, ind: i % 2 ? 'Software' : 'Semiconductors', avg: 2e6, path: 'flat' }])),
  SPY: { pc: 600, ind: '', avg: 6e7, path: 'spy' }, QQQ: { pc: 520, ind: '', avg: 4e7, path: 'spy' },
  XLK: { pc: 230, ind: '', avg: 8e6, path: 'spy' }, XLF: { pc: 50, ind: '', avg: 8e6, path: 'flat' },
};
for (const e of ['XLC', 'XLV', 'XLE', 'XLU', 'XLRE', 'XLB', 'XLP', 'XLY', 'XLI']) SYMS[e] = { pc: 80, ind: '', avg: 5e6, path: 'flat' };
const ASSETS = [
  ...Object.keys(SYMS).filter((s) => !s.startsWith('XL') && s !== 'SPY' && s !== 'QQQ').map((s) => ({ symbol: s, name: s === 'BANKX' ? 'Bankx Bancorp Inc' : `${s} Inc`, exchange: 'NASDAQ', tradable: true })),
  { symbol: 'SPY', name: 'SPDR S&P 500 ETF Trust', exchange: 'ARCA', tradable: true },
  { symbol: 'TQQQ', name: 'ProShares UltraPro QQQ', exchange: 'NASDAQ', tradable: true },
];

const hash = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
const noise = (s, m) => Math.sin(m * 0.7 + hash(s)) * 0.0015 + Math.sin(m * 0.23 + hash(s) / 7) * 0.002;

// Percent move vs previous close at NY minute-of-day m (float).
function pctAt(sym, m) {
  const P = SYMS[sym].path;
  const lerp = (pts) => {
    if (m <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) if (m <= pts[i][0]) { const [a, x] = pts[i - 1], [b, y] = pts[i]; return x + ((y - x) * (m - a)) / (b - a); }
    return pts[pts.length - 1][1];
  };
  const H = (h, mm = 0) => h * 60 + mm;
  if (P === 'orb') return lerp([[H(4), 0.02], [H(8), 0.05], [H(9, 20), 0.06], [H(9, 30), 0.05], [H(9, 36), 0.065], [H(9, 40), 0.045], [H(9, 44), 0.06], [H(9, 47), 0.058], [H(9, 50), 0.0655], [H(9, 52), 0.071], [H(10, 5), 0.085], [H(10, 30), 0.11], [H(11, 0), 0.12], [H(16), 0.10]]) + noise(sym, m) * 0.3;
  if (P === 'vwap') return lerp([[H(4), 0], [H(9, 30), 0.01], [H(10, 0), 0.055], [H(10, 20), 0.03], [H(10, 26), 0.031], [H(10, 32), 0.036], [H(10, 45), 0.06], [H(11, 30), 0.075], [H(16), 0.07]]) + noise(sym, m) * 0.2;
  if (P === 'flag') return lerp([[H(4), 0], [H(9, 30), 0.005], [H(9, 50), 0.01], [H(10, 2), 0.06], [H(10, 14), 0.052], [H(10, 16), 0.055], [H(10, 20), 0.07], [H(10, 50), 0.09], [H(16), 0.08]]) + noise(sym, m) * 0.15;
  if (P === 'fail') return lerp([[H(4), 0.03], [H(9, 30), 0.05], [H(9, 36), 0.07], [H(9, 40), 0.055], [H(9, 44), 0.065], [H(9, 48), 0.0725], [H(9, 52), 0.078], [H(10, 2), 0.06], [H(10, 20), 0.035], [H(16), 0.03]]) + noise(sym, m) * 0.2;
  if (P === 'late') return lerp([[H(4), 0], [H(9, 30), 0.004], [H(12, 0), 0.01], [H(12, 40), 0.06], [H(13, 0), 0.05], [H(13, 6), 0.053], [H(13, 12), 0.068], [H(14, 30), 0.072], [H(16), 0.06]]) + noise(sym, m) * 0.15;
  // Strong open, sharp flush well below VWAP, then a steady recovery (the dip setup).
  if (P === 'dip') return lerp([[H(4), 0.02], [H(9, 30), 0.05], [H(9, 50), 0.09], [H(10, 0), 0.085], [H(10, 20), 0.03], [H(10, 22), 0.031], [H(10, 45), 0.055], [H(11, 0), 0.065], [H(16), 0.06]]) + noise(sym, m) * 0.1;
  if (P === 'drift') return lerp([[H(4), 0], [H(9, 30), 0.02], [H(16), 0.03]]) + noise(sym, m);
  if (P === 'spy') return lerp([[H(4), 0.001], [H(9, 30), 0.002], [H(16), 0.006]]) + noise(sym, m) * 0.2;
  return noise(sym, m) * 2;
}
const priceAt = (sym, m) => +(SYMS[sym].pc * (1 + pctAt(sym, m))).toFixed(2);
const volAt = (sym, m) => {
  const base = SYMS[sym].avg / 390;
  const mo = m - 570;
  const shape = mo < 0 ? 0.05 : mo < 30 ? 3 : mo < 90 ? 1.4 : mo < 330 ? 0.7 : 1.6;
  const mover = ['orb', 'vwap', 'flag', 'fail', 'late', 'dip'].includes(SYMS[sym].path) ? 3.5 : 1;
  return Math.round(base * shape * mover * (1 + 0.3 * Math.sin(m + hash(sym))));
};
const nyMin = (t) => { const p = ny(t); return p.hh * 60 + p.mm; };

function minuteBars(sym, startMs, endMs) {
  const out = [];
  const d0 = ny(startMs).ymd;
  for (let t = Math.ceil(startMs / 60000) * 60000; t + 60000 <= endMs; t += 60000) {
    const p = ny(t);
    if (p.ymd !== d0 && ny(t).ymd !== DAY) continue;
    const m = p.hh * 60 + p.mm;
    if (m < 240 || m >= 960) continue;
    const o = priceAt(sym, m), c = priceAt(sym, m + 1);
    const h = +Math.max(o, c, priceAt(sym, m + 0.5)).toFixed(2) + 0.01, l = +Math.min(o, c, priceAt(sym, m + 0.5)).toFixed(2) - 0.01;
    out.push({ t: new Date(t).toISOString(), o, h: +h.toFixed(2), l: +l.toFixed(2), c, v: volAt(sym, m), vw: +((o + c + h + l) / 4).toFixed(3), n: 50 });
  }
  return out;
}
function dailyBars(sym, startYmd, endYmd) {
  const out = [];
  for (let d = startYmd; d <= endYmd; d = addDays(d, 1)) {
    const w = dowOf(d);
    if (w === 0 || w === 6) continue;
    const k = hash(sym + d) % 100 / 100;
    const c = SYMS[sym].pc * (1 + (k - 0.5) * 0.02);
    out.push({ t: new Date(nyToUtc(d, '00:00')).toISOString(), o: +(c * 0.995).toFixed(2), h: +(c * 1.02).toFixed(2), l: +(c * 0.98).toFixed(2), c: +c.toFixed(2), v: Math.round(SYMS[sym].avg * (0.8 + k * 0.4)), vw: +c.toFixed(2), n: 1000 });
  }
  return out;
}
function snapshot(sym) {
  const t = now();
  const m = nyMin(t) + ny(t).ss / 60;
  const openMs = nyToUtc(DAY, '04:00');
  const bars = minuteBars(sym, openMs, t);
  const p = priceAt(sym, Math.min(m, 959.9));
  const pc = SYMS[sym].pc;
  const daily = bars.length ? { t: new Date(nyToUtc(DAY, '00:00')).toISOString(), o: bars.find((b) => nyMin(Date.parse(b.t)) >= 570)?.o || bars[0].o, h: Math.max(...bars.map((b) => b.h), p), l: Math.min(...bars.map((b) => b.l), p), c: p, v: bars.reduce((a, b) => a + b.v, 0), vw: bars.reduce((a, b) => a + b.vw * b.v, 0) / Math.max(1, bars.reduce((a, b) => a + b.v, 0)) } : null;
  return {
    latestTrade: { t: new Date(t).toISOString(), p, s: 100 },
    // NOVX: IEX is away from the best price, so its own bid/ask gap is wide (as seen live).
    latestQuote: sym === 'NOVX' ? { t: new Date(t).toISOString(), bp: +(p - 0.6).toFixed(2), ap: +(p + 0.6).toFixed(2), bs: 1, as: 1 } : { t: new Date(t).toISOString(), bp: +(p - 0.01).toFixed(2), ap: +(p + 0.01).toFixed(2), bs: 3, as: 4 },
    minuteBar: bars[bars.length - 1] || null,
    dailyBar: daily || { t: new Date(nyToUtc(addDays(DAY, -1), '00:00')).toISOString(), o: pc, h: pc, l: pc, c: pc, v: SYMS[sym].avg, vw: pc },
    prevDailyBar: daily ? { t: new Date(nyToUtc(addDays(DAY, -1), '00:00')).toISOString(), o: pc, h: +(pc * 1.01).toFixed(2), l: +(pc * 0.99).toFixed(2), c: pc, v: SYMS[sym].avg, vw: pc } : { t: new Date(nyToUtc(addDays(DAY, -2), '00:00')).toISOString(), c: pc },
  };
}

export const captured = { ntfy: [], gist: { 'settings.json': { content: '{}' } }, gistPatches: 0, feeds: {}, sipRecent: 0 };

function send(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const q = Object.fromEntries(u.searchParams);
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const p = u.pathname;
    if (p === '/v2/clock') return send(res, 200, { is_open: true, timestamp: new Date(now()).toISOString() });
    if (p === '/v2/calendar') return send(res, 200, q.start <= DAY && q.end >= DAY ? [{ date: DAY, open: '09:30', close: '16:00' }] : []);
    if (p === '/v2/assets') return send(res, 200, ASSETS);
    if (p === '/v2/stocks/snapshots') return send(res, 200, Object.fromEntries(q.symbols.split(',').filter((s) => SYMS[s]).map((s) => [s, snapshot(s)])));
    if (p === '/v2/stocks/bars') {
      captured.feeds[q.feed || 'none'] = (captured.feeds[q.feed || 'none'] || 0) + 1;
      // Free plan: consolidated (SIP) data only when it is over 15 minutes old.
      if (q.feed === 'sip' && Date.parse(q.end) > now() - 15 * 60000) { captured.sipRecent++; return send(res, 403, { message: 'subscription does not permit querying recent SIP data' }); }
      const syms = q.symbols.split(',').filter((s) => SYMS[s]);
      const out = {};
      for (const s of syms) {
        if (q.timeframe === '1Day') out[s] = dailyBars(s, q.start.slice(0, 10), q.end.slice(0, 10));
        else out[s] = minuteBars(s, Date.parse(q.start), Math.min(Date.parse(q.end), now()));
      }
      return send(res, 200, { bars: out, next_page_token: null });
    }
    if (p === '/v1beta1/screener/stocks/movers') return send(res, 200, { gainers: [{ symbol: 'NOVX' }, { symbol: 'HLXA' }, { symbol: 'BANKX' }, { symbol: 'ORBT' }], losers: [] });
    if (p === '/v1beta1/screener/stocks/most-actives') return send(res, 200, { most_actives: [{ symbol: 'KRNA' }] });
    if (p === '/v1beta1/news') return send(res, 200, { news: [] });
    if (p === '/fh/stock/profile2') return send(res, 200, { name: ASSETS.find((a) => a.symbol === q.symbol)?.name, finnhubIndustry: SYMS[q.symbol]?.ind || 'Technology', shareOutstanding: 100, marketCapitalization: 5000 });
    if (p === '/fh/stock/metric') return send(res, 200, { metric: { 'totalDebt/totalEquityQuarterly': 0.2, bookValuePerShareQuarterly: 10, cashPerSharePerShareQuarterly: 3, marketCapitalization: 5000 } });
    if (p === '/fh/company-news') return send(res, 200, q.symbol === 'NOVX' ? [{ headline: 'NOVX wins contract' }] : []);
    if (p === '/fh/calendar/earnings') return send(res, 200, { earningsCalendar: [{ symbol: 'VELO', date: DAY, hour: 'amc' }] });
    if (p === '/ff') return send(res, 200, [{ title: 'ISM Manufacturing PMI', country: 'USD', date: new Date(nyToUtc(DAY, '10:00')).toISOString(), impact: 'High', forecast: '49.5', previous: '49.1' }]);
    if (p === '/ntfy' || p === '/ntfy/') { try { captured.ntfy.push(JSON.parse(body)); } catch {} return send(res, 200, { id: 'x' }); }
    if (p === '/__captured') return send(res, 200, captured);
    if (p.startsWith('/gists/')) {
      if (req.method === 'PATCH') { const b = JSON.parse(body); for (const [k, v] of Object.entries(b.files || {})) captured.gist[k] = { content: v.content }; captured.gistPatches++; }
      return send(res, 200, { files: Object.fromEntries(Object.entries(captured.gist).map(([k, v]) => [k, { content: v.content, truncated: false }])) });
    }
    send(res, 404, { message: `mock: no route ${p}` });
  });
});

// Minimal WebSocket server (text frames) for the Alpaca stream.
const clients = new Set();
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const c = { socket, subs: new Set(), authed: false, buf: Buffer.alloc(0) };
  clients.add(c);
  const sendText = (obj) => {
    const data = Buffer.from(JSON.stringify(obj));
    const len = data.length;
    const head = len < 126 ? Buffer.from([0x81, len]) : len < 65536 ? Buffer.from([0x81, 126, len >> 8, len & 255]) : null;
    if (!head) return;
    try { socket.write(Buffer.concat([head, data])); } catch {}
  };
  c.send = sendText;
  sendText([{ T: 'success', msg: 'connected' }]);
  socket.on('data', (chunk) => {
    c.buf = Buffer.concat([c.buf, chunk]);
    while (c.buf.length >= 2) {
      const op = c.buf[0] & 15;
      let len = c.buf[1] & 127, off = 2;
      if (len === 126) { len = c.buf.readUInt16BE(2); off = 4; }
      const masked = c.buf[1] & 128;
      const need = off + (masked ? 4 : 0) + len;
      if (c.buf.length < need) break;
      const mask = masked ? c.buf.slice(off, off + 4) : null;
      const payload = c.buf.slice(off + (masked ? 4 : 0), need);
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      c.buf = c.buf.slice(need);
      if (op === 8) { socket.end(); clients.delete(c); return; }
      if (op !== 1) continue;
      let m; try { m = JSON.parse(payload.toString()); } catch { continue; }
      if (m.action === 'auth') { c.authed = true; sendText([{ T: 'success', msg: 'authenticated' }]); }
      if (m.action === 'subscribe') { (m.trades || []).forEach((s) => c.subs.add(s)); sendText([{ T: 'subscription', trades: [...c.subs], bars: [...c.subs] }]); }
      if (m.action === 'unsubscribe') { (m.trades || []).forEach((s) => c.subs.delete(s)); sendText([{ T: 'subscription', trades: [...c.subs], bars: [...c.subs] }]); }
    }
  });
  socket.on('close', () => clients.delete(c));
  socket.on('error', () => clients.delete(c));
});

let lastMinute = null;
setInterval(() => {
  const t = now();
  const m = nyMin(t);
  for (const c of clients) {
    if (!c.authed) continue;
    const msgs = [];
    for (const s of c.subs) if (SYMS[s]) msgs.push({ T: 't', S: s, p: priceAt(s, m + ny(t).ss / 60), s: 100, t: new Date(t).toISOString() });
    if (lastMinute !== null && m !== lastMinute) {
      for (const s of c.subs) if (SYMS[s]) { const b = minuteBars(s, t - 120000, Math.floor(t / 60000) * 60000).pop(); if (b) msgs.push({ T: 'b', S: s, ...b }); }
    }
    if (msgs.length) c.send(msgs);
  }
  lastMinute = m;
}, 250);

server.listen(PORT, () => console.log(`mock market on :${PORT} for ${DAY}`));
