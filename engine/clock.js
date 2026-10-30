// Time helpers in New York time, with an optional simulated clock for tests
// (SIM_START = ISO time the simulation starts at, SIM_SPEED = multiplier).
const SIM_START = process.env.SIM_START ? Date.parse(process.env.SIM_START) : 0;
const SIM_SPEED = Number(process.env.SIM_SPEED || 1);
const REAL_T0 = Date.now();

export function now() {
  if (!SIM_START) return Date.now();
  return SIM_START + (Date.now() - REAL_T0) * SIM_SPEED;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, SIM_START ? ms / SIM_SPEED : ms));
}

const fmtNy = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
});

export function ny(t = now()) {
  const p = {};
  for (const x of fmtNy.formatToParts(new Date(t))) p[x.type] = x.value;
  const hh = Number(p.hour) % 24, mm = Number(p.minute), ss = Number(p.second);
  return {
    ymd: `${p.year}-${p.month}-${p.day}`,
    hh, mm, ss,
    min: hh * 60 + mm + ss / 60,
    hm: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`,
    dow: p.weekday,
  };
}

export function hmToMin(hm) {
  const [h, m] = String(hm).split(':').map(Number);
  return h * 60 + (m || 0);
}

export function minToHm(m) {
  m = ((Math.round(m) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// Offset (minutes) of New York from UTC at instant t, e.g. -240 in summer, -300 in winter.
export function nyOffsetMin(t = now()) {
  const p = ny(t);
  const [y, mo, d] = p.ymd.split('-').map(Number);
  const asUtc = Date.UTC(y, mo - 1, d, p.hh, p.mm, p.ss);
  return Math.round((asUtc - Math.floor(t / 1000) * 1000) / 60000);
}

// UTC epoch ms of a New York wall-clock time on date ymd.
export function nyToUtc(ymd, hm) {
  const [y, mo, d] = ymd.split('-').map(Number);
  const [h, m] = hm.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, m);
  const off = nyOffsetMin(guess);
  let t = guess - off * 60000;
  const off2 = nyOffsetMin(t);
  if (off2 !== off) t = guess - off2 * 60000;
  return t;
}

export function isoNy(ymd, hm) {
  return new Date(nyToUtc(ymd, hm)).toISOString();
}

export function addDays(ymd, k) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + k)).toISOString().slice(0, 10);
}

export function dowOf(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// Fallback NYSE calendar when the Alpaca calendar endpoint is unavailable.
const HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03',
  '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05',
  '2027-09-06', '2027-11-25', '2027-12-24',
]);
const EARLY = { '2026-11-27': '13:00', '2026-12-24': '13:00', '2027-11-26': '13:00' };

export function fallbackSession(ymd) {
  const w = dowOf(ymd);
  if (w === 0 || w === 6 || HOLIDAYS.has(ymd)) return null;
  return { date: ymd, open: '09:30', close: EARLY[ymd] || '16:00' };
}

export function dayKey(t = now()) { return ny(t).ymd; }
