// Alpaca real-time stream (IEX on the free plan, max 30 symbols). Node 22 global WebSocket.
import { ENV } from './config.js';
import { log, warn } from './log.js';

export class Stream {
  constructor({ feed = 'iex', onTrade, onBar } = {}) {
    this.feed = feed;
    this.onTrade = onTrade || (() => {});
    this.onBar = onBar || (() => {});
    this.want = new Set();
    this.subscribed = new Set();
    this.ws = null;
    this.authed = false;
    this.connected = false;
    this.retry = 0;
    this.closed = false;
    this.lastMsg = 0;
    this.drops = 0;
  }

  start() {
    if (this.ws || this.closed) return;
    const url = `${ENV.alpacaStream}/v2/${this.feed}`;
    let ws;
    try { ws = new WebSocket(url); } catch (e) { warn('stream connect', e); return this.reconnect(); }
    this.ws = ws;
    ws.onopen = () => { this.connected = true; };
    ws.onmessage = (ev) => this.handle(ev.data);
    ws.onerror = (e) => warn('stream', e.message || 'error');
    ws.onclose = () => {
      this.ws = null; this.authed = false; this.connected = false; this.subscribed.clear();
      if (!this.closed) { this.drops++; this.reconnect(); }
    };
  }

  reconnect() {
    const ms = Math.min(30000, 1000 * 2 ** this.retry++);
    setTimeout(() => this.start(), ms);
  }

  stop() { this.closed = true; try { this.ws && this.ws.close(); } catch {} }

  send(o) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }

  handle(raw) {
    this.lastMsg = Date.now();
    let msgs;
    try { msgs = JSON.parse(typeof raw === 'string' ? raw : raw.toString()); } catch { return; }
    for (const m of [].concat(msgs)) {
      if (m.T === 'success' && m.msg === 'connected') this.send({ action: 'auth', key: ENV.alpacaKey, secret: ENV.alpacaSecret });
      else if (m.T === 'success' && m.msg === 'authenticated') { this.authed = true; this.retry = 0; log('stream authenticated'); this.sync(); }
      else if (m.T === 'error') warn('stream', `${m.code} ${m.msg}`);
      else if (m.T === 'subscription') this.subscribed = new Set(m.trades || []);
      else if (m.T === 't') this.onTrade(m.S, { t: Date.parse(m.t), p: m.p, s: m.s });
      else if (m.T === 'b' || m.T === 'u') this.onBar(m.S, { t: m.t, o: m.o, h: m.h, l: m.l, c: m.c, v: m.v, vw: m.vw, n: m.n }, m.T === 'u');
    }
  }

  set(symbols) {
    this.want = new Set(symbols.slice(0, 30));
    this.start();
    if (this.authed) this.sync();
  }

  sync() {
    const add = [...this.want].filter((s) => !this.subscribed.has(s));
    const del = [...this.subscribed].filter((s) => !this.want.has(s));
    if (del.length) this.send({ action: 'unsubscribe', trades: del, bars: del, updatedBars: del });
    if (add.length) this.send({ action: 'subscribe', trades: add, bars: add, updatedBars: add });
  }

  status() {
    return { connected: this.connected && this.authed, symbols: this.want.size, lastMsgAgoSec: this.lastMsg ? Math.round((Date.now() - this.lastMsg) / 1000) : null, drops: this.drops };
  }
}
