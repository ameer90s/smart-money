// Backs the data folder up to the repository's `data` branch (the permanent record the
// app's exports read from). The data folder is a checkout of that branch.
import { execFileSync } from 'node:child_process';
import { ENV } from './config.js';
import { log, warn } from './log.js';

const ID = ['-c', 'user.name=smart-money-bot', '-c', 'user.email=smart-money-bot@users.noreply.github.com'];
const git = (args) => execFileSync('git', [...ID, ...args], { cwd: ENV.dataDir, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

export function sync(message = 'data') {
  if (!ENV.gitSync) return false;
  try {
    git(['add', '-A']);
    const status = git(['status', '--porcelain']);
    if (!status.trim()) return true;
    git(['commit', '-q', '-m', `${message} [skip ci] [vercel skip]`]);
    try { git(['push', '-q', 'origin', 'HEAD:data']); }
    catch {
      git(['pull', '-q', '--rebase', '-X', 'theirs', 'origin', 'data']);
      git(['push', '-q', 'origin', 'HEAD:data']);
    }
    log('data synced');
    return true;
  } catch (e) { warn('gitsync', e.stderr ? e.stderr.toString() : e); return false; }
}
