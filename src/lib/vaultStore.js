import { useState, useEffect } from 'react';
import { VAULT_FILES } from '@/data/vaultFiles';

// Client-side store for the Vault (uploads, folders, deletes, moves). The seeded
// files live in src/data/vaultFiles.js; everything the user does is recorded in
// localStorage (metadata only — there's no Vault backend yet) and layered on top
// of the seed list.
const KEY = 'cybills.vault.v2';
export const VAULT_CHANGED_EVENT = 'cybills:vault-changed';

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (Array.isArray(raw)) return { uploaded: raw, folders: [], hidden: [], moves: {} }; // v1 migrate
    return { uploaded: [], folders: [], hidden: [], moves: {}, ...(raw || {}) };
  } catch {
    return { uploaded: [], folders: [], hidden: [], moves: {} };
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
export function addVaultFiles(files, { creator = 'Astrid Yang', access = 'Practice & Admin users', folder = '' } = {}) {
  const state = read();
  const now = today();
  const added = files.map((f) => {
    seq += 1;
    return {
      id: `uvf_${Date.now()}_${seq}`,
      name: f.name,
      size: f.size,
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

// All files, seed + uploaded, with deletes removed and moves applied.
export function getVaultFiles() {
  const { uploaded, hidden, moves } = read();
  const hiddenSet = new Set(hidden);
  const seed = VAULT_FILES.filter((f) => !hiddenSet.has(f.id)).map((f) => ({
    ...f,
    folder: moves[f.id] ?? f.folder ?? '',
  }));
  return [...uploaded.map((f) => ({ ...f, folder: moves[f.id] ?? f.folder ?? '' })), ...seed];
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
  write({ ...state, uploaded, hidden: [...new Set([...state.hidden, ...seedRemoved])] });
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
