import { cors, authorized, configured, gistFiles } from './_lib.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!configured()) return res.status(503).json({ error: 'not_configured' });
  if (!authorized(req)) return res.status(401).json({ error: 'pin' });
  try {
    const f = await gistFiles();
    const live = f['live.json'] ? JSON.parse(f['live.json']) : null;
    const settings = f['settings.json'] ? JSON.parse(f['settings.json']) : {};
    if (!live) return res.status(200).json({ waiting: true, settings });
    res.status(200).json({ ...live, savedSettings: settings });
  } catch (e) {
    res.status(502).json({ error: 'upstream', detail: String(e.message || e) });
  }
}
