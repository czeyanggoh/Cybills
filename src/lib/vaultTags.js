// Vault tags, persisted in localStorage. A tag has a name, optional rules
// (free-text describing when it applies), and an auto-apply flag (Dext's
// "apply this tag automatically to matching documents").

import { useEffect, useState } from 'react';

const KEY = 'cybills.vault.tags.v1';
export const VAULT_TAGS_EVENT = 'cybills:vault-tags-changed';

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
  window.dispatchEvent(new Event(VAULT_TAGS_EVENT));
}

export function getVaultTags() {
  return readAll();
}

let seq = 0;
// Add one or more tags. Each row: { name, rules, autoApply }. Blank names are
// skipped; duplicate names (case-insensitive) are ignored. Returns added count.
export function addVaultTags(rows) {
  const list = readAll();
  const existing = new Set(list.map((t) => t.name.toLowerCase()));
  const fresh = [];
  for (const r of rows) {
    const name = String(r.name || '').trim();
    if (!name || existing.has(name.toLowerCase())) continue;
    existing.add(name.toLowerCase());
    seq += 1;
    fresh.push({
      id: `tag_${Date.now().toString(36)}_${seq}`,
      name,
      rules: String(r.rules || '').trim(),
      autoApply: Boolean(r.autoApply),
    });
  }
  if (fresh.length) writeAll([...fresh, ...list]);
  return fresh.length;
}

export function removeVaultTags(ids) {
  const set = new Set(ids);
  writeAll(readAll().filter((t) => !set.has(t.id)));
}

export function useVaultTags() {
  const [list, setList] = useState(getVaultTags);
  useEffect(() => {
    const sync = () => setList(getVaultTags());
    window.addEventListener(VAULT_TAGS_EVENT, sync);
    return () => window.removeEventListener(VAULT_TAGS_EVENT, sync);
  }, []);
  return list;
}
