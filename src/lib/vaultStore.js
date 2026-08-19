import { useState, useEffect } from 'react';
import { VAULT_FILES } from '@/data/vaultFiles';
import { putVaultBlob, deleteVaultBlob } from '@/lib/vaultBlobs';

// Client-side store for the Vault (uploads, folders, deletes, moves). The seeded
// files live in src/data/vaultFiles.js; metadata is recorded in localStorage and
// layered on top of the seed list, while uploaded file bytes go to IndexedDB
// (see vaultBlobs.js) so the detail page can preview them.
const KEY = 'cybills.vault.v2';
export const VAULT_CHANGED_EVENT = 'cybills:vault-changed';

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (Array.isArray(raw)) return { uploaded: raw, folders: [], hidden: [], moves: {}, overrides: {} }; // v1 migrate
    return { uploaded: [], folders: [], hidden: [], moves: {}, overrides: {}, ...(raw || {}) };
  } catch {
    return { uploaded: [], folders: [], hidden: [], moves: {}, overrides: {} };
  }
}
function write(state) {
  localStorage.setItem(KEY, JSON.stringify(state));
  window.dispatchEvent(new Event(VAULT_CHANGED_EVENT));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function today() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

// Uppercase file-type badge from a filename (e.g. "JPG", "PDF", "PNG").
export function fileTypeBadge(name) {
  const parts = String(name || '').split('.');
  const ext = parts.length > 1 ? parts.pop().toUpperCase() : '';
  return ext && ext.length <= 4 ? ext : 'FILE';
}

let seq = 0;
export function addVaultFiles(files, { creator = 'You', access = 'Practice & Admin users', folder = '' } = {}) {
  const state = read();
  const now = today();
  const added = files.map((f) => {
    seq += 1;
    const id = `uvf_${Date.now()}_${seq}`;
    // Persist the actual bytes so the file can be previewed / copied later.
    void putVaultBlob(id, f);
    return {
      id,
      name: f.name,
      size: f.size,
      type: f.type || '',
      dateAdded: now,
      creator,
      access,
      folder,
      uploaded: true,
    };
  });
  write({ ...state, uploaded: [...added, ...state.uploaded] });
  return added;
}

// --- Per-file overrides (editable detail fields, flag, access) --------------
export function getVaultOverride(id) {
  return read().overrides?.[id] || {};
}
export function setVaultOverride(id, patch) {
  const state = read();
  const overrides = { ...(state.overrides || {}) };
  overrides[id] = { ...(overrides[id] || {}), ...patch };
  write({ ...state, overrides });
}

// A single file (seed or uploaded) with its override + current folder applied.
export function getVaultFileById(id) {
  const file = getVaultFiles().find((f) => f.id === id);
  return file || null;
}

// All files, seed + uploaded, with deletes removed and moves + overrides applied.
export function getVaultFiles() {
  const { uploaded, hidden, moves, overrides = {} } = read();
  const hiddenSet = new Set(hidden);
  const apply = (f) => ({ ...f, folder: moves[f.id] ?? f.folder ?? '', ...overrides[f.id] });
  const seed = VAULT_FILES.filter((f) => !hiddenSet.has(f.id)).map(apply);
  return [...uploaded.map(apply), ...seed];
}

export function getVaultFolders() {
  return read().folders;
}

export function addVaultFolder(name) {
  const n = String(name || '').trim();
  if (!n) return;
  const state = read();
  if (!state.folders.includes(n)) write({ ...state, folders: [n, ...state.folders] });
}

export function removeVaultFiles(ids) {
  const set = new Set(ids);
  const state = read();
  const uploaded = state.uploaded.filter((f) => !set.has(f.id));
  const seedRemoved = VAULT_FILES.filter((f) => set.has(f.id)).map((f) => f.id);
  const overrides = { ...(state.overrides || {}) };
  for (const id of ids) { delete overrides[id]; void deleteVaultBlob(id); }
  write({ ...state, uploaded, overrides, hidden: [...new Set([...state.hidden, ...seedRemoved])] });
}

export function moveVaultFiles(ids, folder) {
  const set = new Set(ids);
  const state = read();
  const uploaded = state.uploaded.map((f) => (set.has(f.id) ? { ...f, folder } : f));
  const moves = { ...state.moves };
  for (const f of VAULT_FILES) if (set.has(f.id)) moves[f.id] = folder;
  write({ ...state, uploaded, moves });
}

function useVaultVersion() {
  const [, bump] = useState(0);
  useEffect(() => {
    const sync = () => bump((n) => n + 1);
    window.addEventListener(VAULT_CHANGED_EVENT, sync);
    return () => window.removeEventListener(VAULT_CHANGED_EVENT, sync);
  }, []);
}

export function useVaultFiles() {
  useVaultVersion();
  return getVaultFiles();
}
export function useVaultFolders() {
  useVaultVersion();
  return getVaultFolders();
}
