import { useState, useEffect } from 'react';
import { VAULT_FILES } from '@/data/vaultFiles';

// Client-side store for Vault files uploaded via the Add-documents drawer. The
// seeded files live in src/data/vaultFiles.js; uploads are recorded in
// localStorage (metadata only — there's no Vault backend yet) and shown on top
// of the seed list.
const KEY = 'cybills.vault.files.v1';
export const VAULT_CHANGED_EVENT = 'cybills:vault-changed';

function read() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]');
  } catch {
    return [];
  }
}
function write(list) {
  localStorage.setItem(KEY, JSON.stringify(list));
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
export function addVaultFiles(files, { creator = 'Astrid Yang', access = 'Practice & Admin users' } = {}) {
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
      uploaded: true,
    };
  });
  write([...added, ...read()]);
  return added;
}

export function getVaultFiles() {
  return [...read(), ...VAULT_FILES];
}

export function useVaultFiles() {
  const [, bump] = useState(0);
  useEffect(() => {
    const sync = () => bump((n) => n + 1);
    window.addEventListener(VAULT_CHANGED_EVENT, sync);
    return () => window.removeEventListener(VAULT_CHANGED_EVENT, sync);
  }, []);
  return getVaultFiles();
}
