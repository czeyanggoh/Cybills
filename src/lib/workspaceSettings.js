import { useState, useEffect } from 'react';
import { blobStore } from '@/lib/blobStore';

// Which of the primary workspaces a client entity actually uses (Business
// settings -> Business profile -> Workspaces). Only Sales so far, because it is
// the only one an accounting practice routinely does NOT run from here: the
// client raises its own invoices in Xero, so the tab, its uploader and its
// export formats are a whole section of the app pointing at paper that never
// arrives. Hiding it is the entity's own decision rather than a deploy-wide one
// — the same entity may switch it on the day it starts sending sales documents
// in — so it is a per-entity blob like the profile it sits under.
//
// It hides a SECTION; it destroys nothing. Sales documents already captured
// stay in the book and still appear in Submission history, so switching it back
// on returns the tab with its contents intact.

const KEY = 'cybills.workspaces.v1';
export const WORKSPACES_EVENT = 'cybills:workspaces-changed';

// Off by default: the practice asked for the section to be gone, and an entity
// that wants it says so.
export const DEFAULT_WORKSPACES = { sales: false };

const emit = () => window.dispatchEvent(new Event(WORKSPACES_EVENT));
// `inheritLegacy: false` for the same reason the profile sets it: this is one
// entity's answer about its own way of working, not a value worth borrowing
// from the practice's books.
const store = blobStore(KEY, DEFAULT_WORKSPACES, emit, { perOrg: true, inheritLegacy: false });

export function getWorkspaceSettings() {
  return { ...DEFAULT_WORKSPACES, ...(store.get() || {}) };
}

export function saveWorkspaceSettings(next) {
  store.set({ ...DEFAULT_WORKSPACES, ...next });
  emit();
}

// Is the Sales workspace shown at all? Anything other than an explicit `true`
// counts as hidden, so a blob written before this field existed reads as the
// default rather than as a broken value.
export function salesEnabled() {
  return getWorkspaceSettings().sales === true;
}

// Has the server said yet? A tab that appears a moment late is nothing; a
// ROUTE that redirects on the default before the answer lands would throw
// somebody off their own Sales page for as long as the fetch takes, so the
// route guard waits on this and every other reader ignores it.
export function salesSettled() {
  return store.ready();
}

// Reactive read: `on` for the many callers that only decide what to SHOW, and
// `settled` beside it for the route guard, which must not act on the default.
// Every gate in the app reads this one hook, so the rail, the routes, the
// uploader and the settings rows can never disagree about whether the section
// exists.
export function useSalesWorkspace() {
  const read = () => ({ on: salesEnabled(), settled: salesSettled() });
  const [state, setState] = useState(read);
  useEffect(() => {
    const sync = () => setState(read());
    sync(); // the answer may have landed between first render and this effect
    window.addEventListener(WORKSPACES_EVENT, sync);
    return () => window.removeEventListener(WORKSPACES_EVENT, sync);
  }, []);
  return state;
}

export function useSalesEnabled() {
  return useSalesWorkspace().on;
}
