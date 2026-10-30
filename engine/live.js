// Live channel to the app without opening any port on the server: the engine writes
// live.json to a private GitHub Gist; the app (through its Vercel function) reads it and
// writes settings.json back, which the engine picks up.
import { ENV, DEFAULTS } from './config.js';
import { request } from './http.js';
import { warn } from './log.js';

const enabled = () => !!(ENV.gistId && ENV.gistToken);
const H = () => ({ Authorization: `Bearer ${ENV.gistToken}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'smart-money-engine' });

let lastJson = '';
export async function publish(obj) {
  if (!enabled()) return false;
  const content = JSON.stringify(obj);
  if (content === lastJson) return true;
  try {
    await request(`${ENV.githubApi}/gists/${ENV.gistId}`, { method: 'PATCH', headers: H(), body: JSON.stringify({ files: { 'live.json': { content } } }), perMin: 20, tries: 2 });
    lastJson = content;
    return true;
  } catch (e) { warn('gist publish', e); return false; }
}

// Settings a viewer may change in the app. Anything else in settings.json is ignored.
const ALLOWED = ['capital', 'feePerSide', 'dailyLossStop', 'maxRecsDay', 'watchMax', 'useNews', 'allowDoubtful', 'notifyRec', 'notifyMgmt', 'notifyBrief', 'ntfyTopic'];
const LIMITS = { capital: [100, 1e6], feePerSide: [0, 10], dailyLossStop: [1, 1e5], maxRecsDay: [1, 10], watchMax: [5, 12] };

export function sanitize(s) {
  const out = {};
  for (const k of ALLOWED) {
    if (!(k in (s || {}))) continue;
    let v = s[k];
    if (k === 'ntfyTopic') { if (typeof v === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(v)) out[k] = v; continue; }
    if (typeof DEFAULTS[k] === 'boolean') { out[k] = !!v; continue; }
    v = Number(v);
    if (!isFinite(v)) continue;
    const [lo, hi] = LIMITS[k] || [-Infinity, Infinity];
    out[k] = Math.max(lo, Math.min(hi, v));
  }
  return out;
}

export async function readSettings() {
  if (!enabled()) return null;
  try {
    const g = await request(`${ENV.githubApi}/gists/${ENV.gistId}`, { headers: H(), perMin: 20, tries: 2 });
    const f = g.files && g.files['settings.json'];
    if (!f) return {};
    let content = f.content;
    if (f.truncated && f.raw_url) content = await request(f.raw_url, { headers: H(), json: false });
    const s = JSON.parse(content || '{}');
    return { settings: sanitize(s), commands: Array.isArray(s.commands) ? s.commands.slice(-20) : [] };
  } catch (e) { warn('gist settings', e); return null; }
}
