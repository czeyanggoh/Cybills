// Whose documents the Costs pages are looking at: this person's own, or the
// whole client entity's — one Xero tenant's book.
//
// Remembered exactly as the rest of the list view is (sessionStorage: a stretch
// of work rather than a saved preference, so a new tab is its own and tomorrow
// starts clean), but deliberately NOT useListView, because two separate
// components read this one: the Costs page draws the toggle, and the rail's own
// badge counts the list that toggle decides. useListView reads its store once,
// on mount, so the badge would sit on whatever was chosen the last time the
// rail happened to render — the "badge says 15 while the tabs add up to 8" this
// app has already been bitten by once. So it is a store with an event: whoever
// changes it, everybody reading it hears.
import { useEffect, useState } from 'react';

const KEY = 'cybills.costs.person';
export const PERSON_SCOPE_EVENT = 'cybills:person-scope';

export const DEFAULT_PERSON_SCOPE = 'everyone';

// Only the two we know. A value from another release — or a browser that
// refuses storage — falls back to the whole book, which is what the page showed
// before this control existed.
export function readPersonScope() {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw === 'mine' || raw === 'everyone' ? raw : DEFAULT_PERSON_SCOPE;
  } catch {
    return DEFAULT_PERSON_SCOPE;
  }
}

export function setPersonScope(value) {
  const next = value === 'mine' ? 'mine' : 'everyone';
  try {
    sessionStorage.setItem(KEY, next);
  } catch {
    /* nothing to do: the page works, it just won't remember */
  }
  window.dispatchEvent(new CustomEvent(PERSON_SCOPE_EVENT, { detail: next }));
  return next;
}

// useState's shape, shared: every caller re-renders on a change made anywhere.
export function usePersonScope() {
  const [scope, setScope] = useState(readPersonScope);
  useEffect(() => {
    const onChange = () => setScope(readPersonScope());
    window.addEventListener(PERSON_SCOPE_EVENT, onChange);
    return () => window.removeEventListener(PERSON_SCOPE_EVENT, onChange);
  }, []);
  return [scope, setPersonScope];
}
