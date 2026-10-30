// Phone notifications through ntfy (arrive with the phone locked).
import { ENV } from './config.js';
import { request } from './http.js';
import { warn } from './log.js';

export async function notify({ title, message, priority = 3, tags = [], click, topic }) {
  const t = topic || ENV.ntfyTopic;
  if (!t) return false;
  try {
    await request(ENV.ntfyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: t, title, message, priority, tags, click: click || ENV.appUrl || undefined }),
      perMin: 30, tries: 2,
    });
    return true;
  } catch (e) { warn('ntfy', e); return false; }
}
