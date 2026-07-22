// Records of Vault bulk-downloads (Dext keeps the generated ZIP archives here).
// Persisted in localStorage; each entry captures the archive name, item count
// and when it was created.

import { useEffect, useState } from 'react';

const KEY = 'cybills.vault.downloads.v1';
export const VAULT_DOWNLOADS_EVENT = 'cybills:vault-downloads-changed';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function stamp() {
  const d = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${time}`;
}

function readAll() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function writeAll(list) {
  localStorage.setItem(KEY, JSON.stringify(list));
  window.dispatchEvent(new Event(VAULT_DOWNLOADS_EVENT));
}

export function getVaultDownloads() {
  return readAll();
}

let seq = 0;
export function recordVaultDownload({ name, count }) {
  seq += 1;
  const entry = {
    id: `dl_${Date.now().toString(36)}_${seq}`,
    name: name || `vault-export-${seq}.zip`,
    count: count || 0,
    created: stamp(),
  };
  writeAll([entry, ...readAll()]);
  return entry;
}

export function removeVaultDownloads(ids) {
  const set = new Set(ids);
  writeAll(readAll().filter((d) => !set.has(d.id)));
}

export function useVaultDownloads() {
  const [list, setList] = useState(getVaultDownloads);
  useEffect(() => {
    const sync = () => setList(getVaultDownloads());
    window.addEventListener(VAULT_DOWNLOADS_EVENT, sync);
    return () => window.removeEventListener(VAULT_DOWNLOADS_EVENT, sync);
  }, []);
  return list;
}
