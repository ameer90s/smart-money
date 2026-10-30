// Alpaca REST: market data (free plan: IEX real-time, SIP historical older than 15 min),
// clock/calendar/assets from the trading API.
import { ENV } from './config.js';
import { request, qs } from './http.js';

const H = () => ({ 'APCA-API-KEY-ID': ENV.alpacaKey, 'APCA-API-SECRET-KEY': ENV.alpacaSecret, Accept: 'application/json' });
const DATA_PER_MIN = Number(process.env.ALPACA_PER_MIN || 180); // free plan allows 200/min

const data = (p, params) => request(`${ENV.alpacaData}${p}${qs(params)}`, { headers: H(), perMin: DATA_PER_MIN });
// Paper and live keys use different trading hosts; try the configured one, then the other.
let tradingBase = ENV.alpacaTrading;
async function trade(p, params) {
  try { return await request(`${tradingBase}${p}${qs(params)}`, { headers: H(), perMin: 150 }); }
  catch (e) {
    if (![401, 403].includes(e.status) || process.env.ALPACA_TRADING_URL) throw e;
    tradingBase = tradingBase.includes('paper') ? 'https://api.alpaca.markets' : 'https://paper-api.alpaca.markets';
    return request(`${tradingBase}${p}${qs(params)}`, { headers: H(), perMin: 150 });
  }
}

function chunks(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export const alpaca = {
  clock: () => trade('/v2/clock'),
  calendar: (start, end) => trade('/v2/calendar', { start, end }),
  assets: () => trade('/v2/assets', { status: 'active', asset_class: 'us_equity' }),

  async snapshots(symbols, feed = 'iex') {
    const out = {};
    for (const part of chunks([...new Set(symbols)], 200)) {
      const r = await data('/v2/stocks/snapshots', { symbols: part.join(','), feed });
      Object.assign(out, r.snapshots || r);
    }
    return out;
  },

  // Multi-symbol bars with pagination. Returns { SYM: [{t,o,h,l,c,v,vw,n}] }.
  async bars(symbols, { timeframe = '1Min', start, end, feed = 'iex', limit = 10000, per = 100 } = {}) {
    const out = {};
    for (const part of chunks([...new Set(symbols)], per)) {
      let token;
      do {
        const r = await data('/v2/stocks/bars', { symbols: part.join(','), timeframe, start, end, feed, limit, adjustment: 'raw', page_token: token, sort: 'asc' });
        for (const [s, arr] of Object.entries(r.bars || {})) (out[s] = out[s] || []).push(...arr);
        token = r.next_page_token;
      } while (token);
    }
    return out;
  },

  movers: (top = 50) => data('/v1beta1/screener/stocks/movers', { top }),
  mostActives: (top = 50) => data('/v1beta1/screener/stocks/most-actives', { by: 'volume', top }),
  news: (symbols, start, limit = 50) => data('/v1beta1/news', { symbols: symbols.join(','), start, limit, sort: 'desc' }),
};
