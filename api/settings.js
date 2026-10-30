// Saves app settings and one-off commands (e.g. "I entered at 24.20", approve a proposal,
// send a test notification) to settings.json in the gist. The engine validates and applies them.
import { cors, authorized, configured, gistFiles, gistWrite, readBody } from './_lib.js';

const KEYS = ['capital', 'feePerSide', 'dailyLossStop', 'maxRecsDay', 'watchMax', 'useNews', 'allowDoubtful', 'notifyRec', 'notifyMgmt', 'notifyBrief', 'ntfyTopic'];
const CMDS = ['entered', 'proposal', 'test-ntfy'];

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!configured()) return res.status(503).json({ error: 'not_configured' });
  if (!authorized(req)) return res.status(401).json({ error: 'pin' });
  try {
    const body = await readBody(req);
    const f = await gistFiles();
    const cur = f['settings.json'] ? JSON.parse(f['settings.json']) : {};
    for (const k of KEYS) if (body.settings && k in body.settings) cur[k] = body.settings[k];
    if (body.command && CMDS.includes(body.command.type)) {
      cur.commands = [...(cur.commands || []), { ...body.command, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now() }].slice(-30);
    }
    cur.updatedAt = Date.now();
    await gistWrite('settings.json', JSON.stringify(cur));
    res.status(200).json({ ok: true, settings: cur });
  } catch (e) {
    res.status(502).json({ error: 'upstream', detail: String(e.message || e) });
  }
}
