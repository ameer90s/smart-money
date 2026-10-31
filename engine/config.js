// Strategy defaults (version S1.0) and environment. Everything a viewer can change
// in the app's settings is merged on top of these at runtime (see live.js).
import path from 'node:path';

export const VERSION = 'S1.3';
export const APP_VERSION = '1.3.1';

export const DEFAULTS = {
  capital: 1000,          // virtual account, USD
  feePerSide: 1,          // eToro commission per open/close, USD
  minPrice: 3,
  maxPrice: 500,
  minDollarVol: 5e6,      // SIP 20-day average dollar volume
  scanEverySec: 20,
  preScanEverySec: 60,
  watchMax: 10,
  watchEnter: 62,         // potential score to enter the watchlist
  watchExit: 45,          // score below which a name may leave
  watchMinDwellMin: 5,
  recFrom: '09:35',
  recTo: '15:30',
  flatAt: '15:55',
  maxRecsDay: 3,
  dailyLossStop: 15,      // USD; stops new recommendations for the day
  cooldownLosses: 2,      // consecutive losses that pause recommendations for 30 min
  probMinT1: 0.45,        // minimum probability of reaching target 1 before the stop
  evMin: 0.15,            // minimum expected value (in R, after costs) of the chosen target
  rrMinNet: 1.5,          // target 1 reward:risk after costs
  costMult: 3,            // target 1 distance must cover round-trip costs this many times
  extMaxAtr5: 2.0,        // max distance above VWAP, in 5-minute ATRs
  stopAtrMin: 0.5,
  stopAtrMax: 1.5,
  spreadMaxPct: 0.5,
  spreadMaxR: 0.15,
  confirmSec: 20,         // price must hold above the trigger this long
  timeStopMin: 60,
  // S1.3 — from the walk-forward lab (31 Oct): only the dip setup showed an edge before costs.
  recSetups: ['DIP'],          // setups that may become recommendations; the rest are logged and audited only
  fixedR: { DIP: 1.5 },        // single target at k·R, sell everything there (as tested in the lab)
  stopAtrMinBy: { DIP: 1.0 },  // per-setup minimum stop distance in 5-minute ATRs
  trialGross: true,            // trial week: probability/value gates before fees (fees still shown and charged)
  inplayMax: 20,               // names kept on the stream after leaving the watchlist (for the dip setup)
  allowDoubtful: false,
  useNews: true,
  notifyRec: true,
  notifyMgmt: true,
  notifyBrief: true,
};

const env = process.env;
export const ENV = {
  alpacaKey: env.ALPACA_KEY || '',
  alpacaSecret: env.ALPACA_SECRET || '',
  alpacaData: env.ALPACA_DATA_URL || 'https://data.alpaca.markets',
  alpacaTrading: env.ALPACA_TRADING_URL || 'https://paper-api.alpaca.markets',
  alpacaStream: env.ALPACA_STREAM_URL || 'wss://stream.data.alpaca.markets',
  finnhubKey: env.FINNHUB_KEY || '',
  finnhubUrl: env.FINNHUB_URL || 'https://finnhub.io/api/v1',
  ntfyTopic: env.NTFY_TOPIC || '',
  ntfyUrl: env.NTFY_URL || 'https://ntfy.sh',
  gistId: env.GIST_ID || '',
  gistToken: env.GIST_TOKEN || '',
  githubApi: env.GITHUB_API_URL || 'https://api.github.com',
  anthropicKey: env.ANTHROPIC_API_KEY || '',
  anthropicModel: env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
  anthropicUrl: env.ANTHROPIC_URL || 'https://api.anthropic.com',
  ffUrl: env.FF_CALENDAR_URL || 'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
  appUrl: env.APP_URL || '',
  dataDir: path.resolve(env.DATA_DIR || 'data'),
  gitSync: env.GIT_SYNC === '1',
  runner: env.RUNNER_NAME || (env.GITHUB_ACTIONS ? 'github-actions' : 'server'),
  maxMin: Number(env.MAX_MIN || 0),          // 0 = run forever (VM); GitHub Actions sets ~350
  untilNy: env.UNTIL_NY || '',               // stop at this NY time (HH:MM), empty = never
  reasonFile: env.REASON_FILE || '',
};
