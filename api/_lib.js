// Shared helpers for the Vercel functions. Environment variables (set in Vercel):
//   GH_TOKEN  — GitHub token with Gist read/write and read access to the repository
//   GIST_ID   — the private gist the engine writes live.json to
//   GH_REPO   — owner/repo of this project (data branch holds the permanent record)
//   APP_PIN   — the PIN the app asks for (optional but recommended)
const API = process.env.GITHUB_API_URL || 'https://api.github.com';

export function cors(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-pin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

export function authorized(req) {
  const pin = process.env.APP_PIN;
  if (!pin) return true;
  const given = req.headers['x-pin'] || (req.query && req.query.pin);
  return given === pin;
}

export function configured() {
  return !!(process.env.GH_TOKEN && process.env.GIST_ID);
}

async function gh(path, opts = {}) {
  const r = await fetch(`${API}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'smart-money-app', ...(opts.headers || {}) },
  });
  if (!r.ok) {
    const e = new Error(`GitHub ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return r;
}

export async function gistFiles() {
  const g = await (await gh(`/gists/${process.env.GIST_ID}`)).json();
  const out = {};
  for (const [name, f] of Object.entries(g.files || {})) {
    out[name] = f.truncated && f.raw_url ? await (await fetch(f.raw_url)).text() : f.content;
  }
  return out;
}

export async function gistWrite(name, content) {
  await gh(`/gists/${process.env.GIST_ID}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files: { [name]: { content } } }) });
}

export async function repoFile(path) {
  const repo = process.env.GH_REPO;
  try {
    const r = await gh(`/repos/${repo}/contents/${path}?ref=data`, { headers: { Accept: 'application/vnd.github.raw' } });
    return await r.text();
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

export async function repoDir(path) {
  const repo = process.env.GH_REPO;
  try {
    const r = await gh(`/repos/${repo}/contents/${path}?ref=data`);
    return (await r.json()).map((x) => x.name);
  } catch (e) {
    if (e.status === 404) return [];
    throw e;
  }
}

export async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
