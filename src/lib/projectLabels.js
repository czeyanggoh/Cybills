import { useEffect, useMemo, useState } from 'react';
import { blobStore } from '@/lib/blobStore';
import { ORGANISATION_EVENT, getActiveOrganisationId, useOrganisations, useXeroTracking } from '@/lib/organisations';

// What THIS entity calls its two project lists.
//
// For an entity linked to Xero the lists ARE its tracking categories, so the
// default name is the category's own — "Outlets", "Staff" — read live from
// Xero. Showing "Projects" above a list Xero calls Outlets made people look for
// a list that isn't there. Only where there is no Xero to ask (a BRIDGE entity,
// which keeps its own lists) does the plain "Projects" / "Projects 2" stand in.
//
// The entity may still type its own word over either. The stored FIELD is
// `project` / `project2` everywhere — the document, the API, the Xero tracking
// category it posts to, the CSV headers an accountant imports against. Only the
// word on screen changes.
const KEY = 'cybills.project-labels.v1';
export const PROJECT_LABELS_EVENT = 'cybills:project-labels-changed';
const emit = () => window.dispatchEvent(new Event(PROJECT_LABELS_EVENT));
// Per entity, and NOT inherited from the workspace-wide blob: this names one
// entity's own list, so borrowing another company's word for it is worse than
// falling back to the default.
const store = blobStore(KEY, {}, emit, { perOrg: true, inheritLegacy: false });

export const DEFAULT_PROJECT_LABELS = { project: 'Projects', project2: 'Projects 2' };

// What was TYPED for each list, or ''. The generic words count as nothing: the
// first version of this saved the resolved labels whenever either was renamed,
// so a stored "Projects" is almost always a default somebody never chose — and
// honouring it would hide the Xero name this is meant to show.
function typedLabels() {
  const saved = store.get();
  const o = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  const own = (k) => {
    const v = String(o[k] ?? '').trim();
    return v === DEFAULT_PROJECT_LABELS[k] ? '' : v;
  };
  return { project: own('project'), project2: own('project2') };
}

export function getProjectLabels(defaults = DEFAULT_PROJECT_LABELS) {
  const typed = typedLabels();
  return {
    project: typed.project || defaults.project || DEFAULT_PROJECT_LABELS.project,
    project2: typed.project2 || defaults.project2 || DEFAULT_PROJECT_LABELS.project2,
  };
}

// Save what was typed. Blank — or the default itself — stores nothing, so the
// list keeps following its Xero name if that is renamed in Xero later.
export function setProjectLabels(next, defaults = DEFAULT_PROJECT_LABELS) {
  const typed = typedLabels();
  for (const [k, v] of Object.entries(next || {})) {
    const s = String(v ?? '').trim();
    typed[k] = s === defaults[k] || s === DEFAULT_PROJECT_LABELS[k] ? '' : s;
  }
  store.set(typed);
  emit();
}

// The names the active entity's Xero gives its two tracking categories, else
// the plain defaults. A bridge entity's tracking call is refused, which leaves
// the defaults — the right answer for a list it keeps itself.
export function useProjectLabelDefaults() {
  const { data: organisations = [] } = useOrganisations();
  const orgId = (organisations.find((o) => o.id === getActiveOrganisationId()) || organisations[0])?.id || '';
  const { data: categories } = useXeroTracking(orgId);
  const first = String(categories?.[0]?.name ?? '').trim();
  const second = String(categories?.[1]?.name ?? '').trim();
  return useMemo(
    () => ({
      project: first || DEFAULT_PROJECT_LABELS.project,
      project2: second || DEFAULT_PROJECT_LABELS.project2,
    }),
    [first, second]
  );
}

export function useProjectLabels() {
  const defaults = useProjectLabelDefaults();
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const sync = () => setVersion((n) => n + 1);
    window.addEventListener(PROJECT_LABELS_EVENT, sync);
    // Switching entity switches the setting with it, so the labels have to
    // follow — otherwise the page keeps the previous entity's word for its list.
    window.addEventListener(ORGANISATION_EVENT, sync);
    return () => {
      window.removeEventListener(PROJECT_LABELS_EVENT, sync);
      window.removeEventListener(ORGANISATION_EVENT, sync);
    };
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => getProjectLabels(defaults), [defaults, version]);
}

// The singular form, for a field that names ONE of them ("Project" on a
// document, not "Projects" the list). A label ending in "s" loses it; anything
// else is left exactly as typed, because guessing at English plurals is how
// "PO" would become "P". "Outlets" becomes "Outlet"; "Staff" stays "Staff".
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
