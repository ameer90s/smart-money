// Strategy defaults (version S1.0) and environment. Everything a viewer can change
// in the app's settings is merged on top of these at runtime (see live.js).
import path from 'node:path';

// Exit families the lab compares: 'mgmt' is the three-target management, the others sell everything at k·R.
export const EXIT_FAMILIES = { mgmt: null, r1: 1, r15: 1.5, r2: 2 };
export const EXIT_FAMILY_AR = { mgmt: 'إدارة بثلاثة أهداف', r1: 'هدف 1R (بيع كامل)', r15: 'هدف 1.5R (بيع كامل)', r2: 'هدف 2R (بيع كامل)' };
export const STATE_NAMES_AR = { trendUp: 'اتجاه صاعد', trendDown: 'اتجاه هابط', range: 'جانبي', choppy: 'متذبذب بشدة' };

export const VERSION = 'S1.3';
export const APP_VERSION = '1.3.3';

export const DEFAULTS = {
  capital: 1000,          // virtual account, USD
  feePerSide: 1,          // eToro commission per open/close, USD
  minPrice: 3,
  maxPrice: 200,
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
  // Learning phase (12 Nov): every setup may become a recommendation. The statistical gates (probability, expected
  // value) are still computed and logged but no longer block, because they did not separate winners from losers and
  // kept almost every signal out. The structural gates stay (stop, spread, extension, cost, window, market, earnings,
  // daily limits). A pause approved on an analyst proposal is recorded but not enforced. While a counted
  // recommendation is open, new ones are issued too, but only tracked (counted: false): they never enter the
  // weekly target, the balance or the daily limits, and send no phone alert.
  learnPhase: true,
  learnProbFloor: 0.06,        // sanity floors for the learning phase: only the extreme tail is blocked (about the lowest 5%
  learnEvFloor: -1.2,          // of signals by probability and by expected value); the normal gates only log
  stateMinN: 30,               // a setup with at least this many cases in the current market state...
  stateBadEv: -0.15,           // ...and a shrunk mean below this takes no primary slot there: it is tracked only
  recSetups: ['ORB5', 'ORB15', 'VWAP', 'FLAG', 'EMA', 'DIP', 'PMH', 'PDH'], // setups that may become recommendations
  recMinN: 30,                 // other setups qualify once the model has this many trades for them...
  recMinEv: 0.10,              // ...and their expected value (R, shrunk, adjusted for the market state) reaches this
  fixedR: { DIP: 1.5 },        // single target at k·R, sell everything there (as tested in the lab)
  stopAtrMinBy: { DIP: 1.0 },  // per-setup minimum stop distance in 5-minute ATRs
  trialGross: true,            // trial week: probability/value gates before fees (fees still shown and charged)
  inplayMax: 20,               // names kept on the stream after leaving the watchlist (for the dip setup)
  touchFire: ['DIP'],          // these fire as in the lab: price touches the trigger within touchWindowMin of the
  touchWindowMin: 3,           // signal bar (no 20-second hold), and not more than 0.25R above it
  // Best setting per pattern found in the lab (31 Oct; chosen on the older 60 of 90 sessions, before
  // fees). Tracked as shadow only: matching live signals are tagged and their results recorded.
  profiles: [
    { id: 'ORB5-a', setup: 'ORB5', tod: [0, 30], minRvol: 2, minChg: 5, exit: 'r15', desc: 'أول 30 دقيقة · حجم ×2 وفوق · مرتفع 5% وفوق · هدف 1.5R', lab: { train: 0.09, test: -0.11 } },
    { id: 'ORB15-a', setup: 'ORB15', tod: [0, 30], maxExt: 0.5, minChg: 5, exit: 'mgmt', desc: 'أول 30 دقيقة · قريب من VWAP (أقل من 0.5 ATR) · مرتفع 5% وفوق', lab: { train: 0.40, test: 0.12 } },
    { id: 'VWAP-a', setup: 'VWAP', tod: [30, 120], regime: ['up'], maxExt: 1.0, maxRvol: 2, exit: 'mgmt', desc: '10:00–11:30 · السوق صاعد · قريب من VWAP (أقل من 1 ATR) · حجم أقل من ×2', lab: { train: 0.28, test: 0.59 } },
    { id: 'FLAG-a', setup: 'FLAG', regimeNot: ['down'], minChg: 5, exit: 'mgmt', desc: 'السوق مو هابط · مرتفع 5% وفوق', lab: { train: 0.07, test: 0.06 } },
    { id: 'EMA-a', setup: 'EMA', tod: [30, 1e9], maxRvol: 2, stopAtr: 1.0, exit: 'r2', desc: 'بعد 10:00 · حجم أقل من ×2 · وقف 1 ATR وفوق · هدف 2R', lab: { train: 0.04, test: 0.11 } },
  ],
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

// Grid searched for the dynamic stop (5-minute ATRs) and target (R multiples); also the bounds of any proposal.
export const DYN_STOPS = [0.5, 0.75, 1, 1.5, 2];
export const DYN_TARGETS = [1, 1.5, 2];
