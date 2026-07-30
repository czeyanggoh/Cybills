import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { env } from './env.js';

// Generic dependency-free JSON collection store — the same atomic-write +
// in-memory-cache pattern as the bills store (store.ts), one file per
// collection under .data. Deliberately no DB/native dep: the VPS recompiles
// native modules on every `npm ci`, so a JSON file is the lowest-risk backing
// store. Swapping this for SQLite/Postgres later is mechanical.

const DATA_DIR = env.BILLS_DATA_DIR || fileURLToPath(new URL('../.data', import.meta.url));
const caches: Record<string, unknown[]> = {};
const fileFor = (name: string) => `${DATA_DIR}/${name}.json`;

export function loadCollection<T>(name: string): T[] {
  if (caches[name]) return caches[name] as T[];
  try {
    const f = fileFor(name);
    const parsed = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
    caches[name] = Array.isArray(parsed?.items) ? parsed.items : [];
  } catch (err) {
    console.error(`[jsonStore] could not read ${name}; starting empty`, err);
    caches[name] = [];
  }
  return caches[name] as T[];
}

export function saveCollection<T>(name: string, items: T[]): void {
  caches[name] = items as unknown[];
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${fileFor(name)}.tmp`;
  writeFileSync(tmp, JSON.stringify({ items }, null, 2));
  renameSync(tmp, fileFor(name));
}
