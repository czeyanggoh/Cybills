import { useState, useEffect } from 'react';
import { blobStore } from '@/lib/blobStore';

// Which colour flag is assigned to a given entity (an expense claim, a claim
// line item, or a cost document — all keyed by their id). Stored as a shared,
// server-backed map { [id]: colour } so a flag one person sets is visible to
// everyone. The available colours + labels come from the Flags list settings
// (see flagsStore); this only records the assignments.

const KEY = 'cybills.flag-assignments.v1';
export const FLAG_ASSIGNMENTS_EVENT = 'cybills:flag-assignments-changed';

const emit = () => window.dispatchEvent(new Event(FLAG_ASSIGNMENTS_EVENT));
const store = blobStore(KEY, {}, emit);

export function getFlagAssignments() {
  const v = store.get();
  return v && typeof v === 'object' ? v : {};
}

export function getAssignedFlag(id) {
  return getFlagAssignments()[id] || '';
}

// Assign (or, with an empty colour, clear) the flag on one entity.
export function setAssignedFlag(id, colour) {
  const map = { ...getFlagAssignments() };
  if (colour) map[id] = colour;
  else delete map[id];
  store.set(map);
  emit();
}

// Reactive read of the whole assignment map.
export function useFlagAssignments() {
  const [map, setMap] = useState(getFlagAssignments);
  useEffect(() => {
    const sync = () => setMap(getFlagAssignments());
    window.addEventListener(FLAG_ASSIGNMENTS_EVENT, sync);
    return () => window.removeEventListener(FLAG_ASSIGNMENTS_EVENT, sync);
  }, []);
  return map;
}
