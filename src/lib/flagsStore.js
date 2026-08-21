import { useState, useEffect } from 'react';
import { blobStore } from '@/lib/blobStore';

// Additional colour flags used to organise the Costs / Sales inbox. Configured
// in Business settings → Lists → Flags (label + visibility per colour), stored
// server-side so the whole workspace shares them.

const KEY = 'cybills.flags.v1';
export const FLAGS_EVENT = 'cybills:flags-changed';

export const DEFAULT_FLAGS = [
  { color: 'orange', label: 'Orange', visible: true },
  { color: 'yellow', label: 'Yellow', visible: true },
  { color: 'green', label: 'Green', visible: true },
  { color: 'blue', label: 'Blue', visible: true },
  { color: 'purple', label: 'Purple', visible: true },
];

const emit = () => window.dispatchEvent(new Event(FLAGS_EVENT));
const store = blobStore(KEY, DEFAULT_FLAGS, emit, { perOrg: true });

export function getFlags() {
  const v = store.get();
  return Array.isArray(v) && v.length ? v : DEFAULT_FLAGS;
}

export function setFlags(next) {
  store.set(next);
  emit();
}

export function updateFlag(color, patch) {
  setFlags(getFlags().map((f) => (f.color === color ? { ...f, ...patch } : f)));
}

// Reactive read of the flags config.
export function useFlags() {
  const [flags, setFlagsState] = useState(getFlags);
  useEffect(() => {
    const sync = () => setFlagsState(getFlags());
    window.addEventListener(FLAGS_EVENT, sync);
    return () => window.removeEventListener(FLAGS_EVENT, sync);
  }, []);
  return flags;
}
