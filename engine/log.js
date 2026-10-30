import { ny } from './clock.js';

const errors = [];

export function log(...a) {
  console.log(`[${ny().hm}]`, ...a);
}

export function warn(where, e) {
  const msg = `${where}: ${e && e.message ? e.message : e}`;
  console.warn(`[${ny().hm}] WARN`, msg);
  errors.push({ t: Date.now(), msg });
  if (errors.length > 50) errors.shift();
}

export function recentErrors() { return errors.slice(-10); }
export function errorCountSince(t) { return errors.filter((e) => e.t >= t).length; }
