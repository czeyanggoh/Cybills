// Client-side persistence for edits to the sample (mock) Costs documents.
// Real uploaded bills persist server-side; the seeded sample rows have no
// backend, so their edits (category, status moves, field changes) are kept in
// localStorage per browser. Keyed by the sample doc id.
const KEY = 'cybills:doc-overrides';

// Fires after any override change so open lists/details can refresh.
export const DOC_OVERRIDES_EVENT = 'cybills:doc-overrides-changed';

export function getDocOverrides() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') || {};
  } catch {
    return {};
  }
}

export function setDocOverride(id, patch) {
  const all = getDocOverrides();
  all[id] = { ...(all[id] || {}), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // storage full / unavailable — non-fatal
  }
  window.dispatchEvent(new Event(DOC_OVERRIDES_EVENT));
}

// Merge a stored override onto a sample doc (no-op when none exists).
export function applyOverride(doc, overrides) {
  const o = overrides[doc.id];
  return o ? { ...doc, ...o } : doc;
}
