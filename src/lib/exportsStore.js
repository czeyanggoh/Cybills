// Records of generated exports (Costs/Sales/Expense claims/Bank), so they can be
// re-downloaded from the Exports tab. Metadata lives in localStorage; the actual
// file blob lives in IndexedDB keyed by the export id.
//
// Every record belongs to ONE client entity, and the tab shows only that
// entity's. An export is named after the company whose books it came from, so a
// shared list doesn't merely look untidy — it tells whoever opens DART
// Consulting the name of another client, from the filename alone.

import { useEffect, useState } from 'react';

const KEY = 'cybills.exports.v1';
export const EXPORTS_EVENT = 'cybills:exports-changed';

// Mirrors blobStore.js: the active entity is read straight from localStorage
// rather than imported, because organisations.js → listsStore.js → here would
// cycle. Same key, same event name.
const ACTIVE_ORG_KEY = 'cybills:active-organisation';
export const ORGANISATION_EVENT = 'cybills:organisation-changed';
function activeOrg() {
  try {
    return localStorage.getItem(ACTIVE_ORG_KEY) || '';
  } catch {
    return '';
  }
}

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
  const entry = { id, kind, orgId: activeOrg(), name, filename, format, csvFormat, count, exportedBy, generated: stamp() };
  write([entry, ...read()]);
  return entry;
}

// Remove one recorded export (its metadata; the stored blob ages out on its own).
export function deleteExport(id) {
  write(read().filter((e) => e.id !== id));
}

// Repair the rows written before the exporter had a name to record, which
// stored the literal string "You".
//
// "You" means a different person to every reader, and these rows are read by
// whoever opens the Exports tab. Rewriting them is safe here and nowhere else:
// this list lives in localStorage, so every row in it was generated in THIS
// browser — "You" can only ever have been the person now looking at it.
//
// Only ever runs with a real name in hand, so a slow-loading identity can't
// blank a row, and it no-ops once there is nothing left to fix.
export function repairExportedBy(name) {
  const who = String(name || '').trim();
  if (!who || who === 'You') return 0;
  const list = read();
  let fixed = 0;
  const next = list.map((e) => {
    const by = String(e.exportedBy || '').trim();
    if (by && by !== 'You') return e;
    fixed += 1;
    return { ...e, exportedBy: who };
  });
  if (fixed) write(next);
  return fixed;
}

export function getExports(kind) {
  const org = activeOrg();
  return read().filter((e) => (!kind || e.kind === kind) && (e.orgId || '') === org);
}

// Hand the records written before exports were per-entity to the PRIMARY one.
// They pre-date any client entity existing, so they are the practice's own —
// the same rule the server applies to the settings blobs that were workspace-
// wide before they became per-entity (adoptLegacySettings). Idempotent, and it
// does nothing until the organisations list has actually loaded, so an
// unstamped record is never handed to the wrong entity.
export function adoptLegacyExports(primaryOrgId) {
  const primary = String(primaryOrgId || '').trim();
  if (!primary) return 0;
  const list = read();
  let adopted = 0;
  const next = list.map((e) => {
    if (e.orgId) return e;
    adopted += 1;
    return { ...e, orgId: primary };
  });
  if (adopted) write(next);
  return adopted;
}

export function useExports(kind) {
  const [list, setList] = useState(() => getExports(kind));
  useEffect(() => {
    const sync = () => setList(getExports(kind));
    sync(); // re-filter immediately when the tab (kind) changes, not only on events
    window.addEventListener(EXPORTS_EVENT, sync);
    // Switching entity switches the list with it, the same way every other
    // per-entity store re-reads on this event.
    window.addEventListener(ORGANISATION_EVENT, sync);
    return () => {
      window.removeEventListener(EXPORTS_EVENT, sync);
      window.removeEventListener(ORGANISATION_EVENT, sync);
    };
  }, [kind]);
  return list;
}
