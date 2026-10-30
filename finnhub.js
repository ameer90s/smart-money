// Finnhub (free tier, 60 calls/min): company profile, basic financials, news, earnings.
import { ENV } from './config.js';
import { request, qs } from './http.js';

const get = (p, params) => request(`${ENV.finnhubUrl}${p}${qs({ ...params, token: ENV.finnhubKey })}`, { perMin: 55 });

export const finnhub = {
  enabled: () => !!ENV.finnhubKey,
  profile: (symbol) => get('/stock/profile2', { symbol }),
  metric: (symbol) => get('/stock/metric', { symbol, metric: 'all' }),
  news: (symbol, from, to) => get('/company-news', { symbol, from, to }),
  earnings: (from, to) => get('/calendar/earnings', { from, to }),
};
