// Phone notifications through ntfy (arrive with the phone locked).
import { ENV } from './config.js';
import { request } from './http.js';
import { log, warn } from './log.js';

export async function notify({ title, message, priority = 3, tags = [], click, topic }) {
  const t = topic || ENV.ntfyTopic;
  // Without a topic nothing can reach the phone, so say so instead of failing silently.
  if (!t) { warn('ntfy', 'NTFY_TOPIC is empty: phone alert skipped'); return false; }
  try {
    await request(ENV.ntfyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: t, title, message, priority, tags, click: click || ENV.appUrl || undefined }),
      perMin: 30, tries: 2,
    });
    log(`ntfy sent: ${title}`);
    return true;
  } catch (e) { warn('ntfy', e); return false; }
}
