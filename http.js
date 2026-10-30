// Small fetch wrapper: timeout, retries with backoff, per-host rate limiting, call counters.
import { warn } from './log.js';

const buckets = new Map();
export const calls = { total: 0, byHost: {}, lastMinute: [] };

function limiter(host, perMin) {
  if (!buckets.has(host)) buckets.set(host, { perMin, stamps: [] });
  const b = buckets.get(host);
  b.perMin = perMin;
  return b;
}

async function waitSlot(b) {
  for (;;) {
    const t = Date.now();
    b.stamps = b.stamps.filter((x) => t - x < 60000);
    if (b.stamps.length < b.perMin) { b.stamps.push(t); return; }
    await new Promise((r) => setTimeout(r, 250));
  }
}

export function callsPerMinute(host) {
  const t = Date.now();
  let n = 0;
  for (const [k, b] of buckets) if (k.startsWith(`${host}|`)) n += b.stamps.filter((x) => t - x < 60000).length;
  return n;
}

export async function request(url, { method = 'GET', headers = {}, body, perMin = 120, tries = 3, timeout = 20000, json = true } = {}) {
  const host = new URL(url).host;
  const b = limiter(`${host}|${perMin}`, perMin);
  let lastErr;
  for (let i = 0; i < tries; i++) {
    await waitSlot(b);
    calls.total++;
    calls.byHost[host] = (calls.byHost[host] || 0) + 1;
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(url, { method, headers, body, signal: ctl.signal });
      clearTimeout(to);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`${res.status} ${host}`);
        await new Promise((r) => setTimeout(r, 1000 * (i + 1) * (res.status === 429 ? 3 : 1)));
        continue;
      }
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        const e = new Error(`${res.status} ${host}${new URL(url).pathname} ${txt.slice(0, 160)}`);
        e.status = res.status;
        throw e;
      }
      if (!json) return await res.text();
      const txt = await res.text();
      return txt ? JSON.parse(txt) : {};
    } catch (e) {
      clearTimeout(to);
      lastErr = e;
      if (e.status && e.status < 500 && e.status !== 429) throw e;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  warn(`request ${host}`, lastErr);
  throw lastErr;
}

export function qs(params) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}
