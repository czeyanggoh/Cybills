import { useEffect, useState } from 'react';
import { blobStore } from '@/lib/blobStore';
import { ORGANISATION_EVENT } from '@/lib/organisations';

// What THIS entity calls its two project lists.
//
// "Projects" is Xero's word for a tracking category, and for an entity linked to
// Xero it is the right one — the list is Xero's and so is the name. A BRIDGE
// entity has no Xero and no tracking categories, so the list is its own, and so
// is what it is for: Red Alpha's is a secondment PO number, and calling that
// column "Projects" made people look for something that isn't there.
//
// So the label is the entity's to set. The stored FIELD is still `project` /
// `project2` everywhere — the document, the API, the Xero tracking category it
// posts to, the CSV headers an accountant imports against. Only the word on
// screen changes, which is the only part that was ever wrong.
const KEY = 'cybills.project-labels.v1';
export const PROJECT_LABELS_EVENT = 'cybills:project-labels-changed';
const emit = () => window.dispatchEvent(new Event(PROJECT_LABELS_EVENT));
// Per entity, and NOT inherited from the workspace-wide blob: this names one
// entity's own list, so borrowing another company's word for it is worse than
// falling back to the plain default.
const store = blobStore(KEY, {}, emit, { perOrg: true, inheritLegacy: false });

export const DEFAULT_PROJECT_LABELS = { project: 'Projects', project2: 'Projects 2' };

const clean = (v, fallback) => String(v ?? '').trim() || fallback;

export function getProjectLabels() {
  const saved = store.get();
  const o = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  return {
    project: clean(o.project, DEFAULT_PROJECT_LABELS.project),
    project2: clean(o.project2, DEFAULT_PROJECT_LABELS.project2),
  };
}

export function setProjectLabels(next) {
  const now = getProjectLabels();
  store.set({ ...now, ...next });
  emit();
}

export function useProjectLabels() {
  const [labels, setLabels] = useState(getProjectLabels);
  useEffect(() => {
    const sync = () => setLabels(getProjectLabels());
    window.addEventListener(PROJECT_LABELS_EVENT, sync);
    // Switching entity switches the setting with it, so the labels have to
    // follow — otherwise the page keeps the previous entity's word for its list.
    window.addEventListener(ORGANISATION_EVENT, sync);
    return () => {
      window.removeEventListener(PROJECT_LABELS_EVENT, sync);
      window.removeEventListener(ORGANISATION_EVENT, sync);
    };
  }, []);
  return labels;
}

// The singular form, for a field that names ONE of them ("Project" on a
// document, not "Projects" the list). A label ending in "s" loses it; anything
// else is left exactly as typed, because guessing at English plurals is how
// "PO" would become "P".
export function singular(label) {
  const s = String(label ?? '').trim();
  return /[^s]s$/.test(s) ? s.slice(0, -1) : s;
}

// Re-label the two project columns in a column list. The column KEYS stay
// `project` / `project2` — they name the stored field, the table preference and
// the cell renderer — so only what a person reads changes. Used by every table
// that offers those columns, so the header and the Table-settings tick that
// switches it on can never disagree about what it is called.
export function withProjectLabels(columns, labels) {
  const one = { project: singular(labels.project), project2: singular(labels.project2) };
  return (columns || []).map((c) => (one[c.key] ? { ...c, label: one[c.key] } : c));
}
