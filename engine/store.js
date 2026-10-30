// Append-only, versioned record on disk. Nothing here is ever deleted or reset by a
// strategy change: every record carries the strategy version it was produced under.
import fs from 'node:fs';
import path from 'node:path';
import { ENV } from './config.js';

const DIR = ENV.dataDir;

function ensure(p) { fs.mkdirSync(path.dirname(p), { recursive: true }); }

export function file(rel) { return path.join(DIR, rel); }

export function readJSON(rel, def) {
  try { return JSON.parse(fs.readFileSync(file(rel), 'utf8')); } catch { return def; }
}

export function writeJSON(rel, obj) {
  const p = file(rel);
  ensure(p);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, p);
}

export function appendLine(rel, obj) {
  const p = file(rel);
  ensure(p);
  fs.appendFileSync(p, `${JSON.stringify(obj)}\n`);
}

export const dayRel = (day, name) => `days/${day}/${name}`;

// Per-day collections kept as JSON arrays keyed by id, so updates replace in place.
export class DayCollection {
  constructor(day, name) {
    this.rel = dayRel(day, `${name}.json`);
    this.items = readJSON(this.rel, []);
    this.dirty = false;
  }
  upsert(item) {
    const i = this.items.findIndex((x) => x.id === item.id);
    if (i >= 0) this.items[i] = item; else this.items.push(item);
    this.dirty = true;
    return item;
  }
  all() { return this.items; }
  flush() { if (this.dirty) { writeJSON(this.rel, this.items); this.dirty = false; } }
}

export function listDays() {
  try { return fs.readdirSync(file('days')).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort(); } catch { return []; }
}
