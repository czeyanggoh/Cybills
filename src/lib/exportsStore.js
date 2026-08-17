// Records of generated exports (Costs/Sales/Expense claims/Bank), so they can be
// re-downloaded from the Exports tab. Metadata lives in localStorage; the actual
// file blob lives in IndexedDB keyed by the export id.

import { useEffect, useState } from 'react';

const KEY = 'cybills.exports.v1';
export const EXPORTS_EVENT = 'cybills:exports-changed';

const DB = 'cybills-exports';
const STORE = 'files';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putBlob(id, blob, filename) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ blob, filename }, id);
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* ignore — record still lists the export, download just won't work */
  }
}

export async function getExportBlob(id) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

function read() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function write(list) {
  localStorage.setItem(KEY, JSON.stringify(list));
  window.dispatchEvent(new Event(EXPORTS_EVENT));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function stamp() {
  const d = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${time}`;
}

let seq = 0;
// Record an export and stash its blob for later download. `kind` is
// 'costs' | 'sales' | 'claims' | 'bank'.
export async function recordExport({ kind, name, filename, format, csvFormat = '-', count, exportedBy, blob }) {
  seq += 1;
  const id = `exp_${Date.now().toString(36)}_${seq}`;
  await putBlob(id, blob, filename);
  const entry = { id, kind, name, filename, format, csvFormat, count, exportedBy, generated: stamp() };
  write([entry, ...read()]);
  return entry;
}

export function getExports(kind) {
  return read().filter((e) => !kind || e.kind === kind);
}

export function useExports(kind) {
  const [list, setList] = useState(() => getExports(kind));
  useEffect(() => {
    const sync = () => setList(getExports(kind));
    sync(); // re-filter immediately when the tab (kind) changes, not only on events
    window.addEventListener(EXPORTS_EVENT, sync);
    return () => window.removeEventListener(EXPORTS_EVENT, sync);
  }, [kind]);
  return list;
}
