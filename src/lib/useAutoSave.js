import { useEffect, useRef, useState } from 'react';

// Auto-save: nothing in CYBills has a Save button. Watch a value, and once the
// user stops changing it for `delay` ms, persist it.
//
// - The first value is never saved — that's what was just loaded, not an edit.
// - Comparison is structural (JSON), so a re-render that rebuilds an equal
//   object doesn't trigger a write. That matters because most forms re-sync
//   themselves from the store right after a save lands.
// - Each new edit cancels the pending write, so holding a key down is one PATCH
//   at the end rather than one per keystroke.
// - A failed save leaves status 'error' and is retried on the next edit; the
//   value stays in the form either way, so nothing is lost on screen.
//
// Returns 'idle' | 'saving' | 'saved' | 'error' for <SaveStatus />.
export function useAutoSave(value, save, { delay = 700, enabled = true } = {}) {
  const [status, setStatus] = useState('idle');
  const saveRef = useRef(save);
  const valueRef = useRef(value);
  const seen = useRef(null); // the last value we know is persisted
  saveRef.current = save;
  valueRef.current = value;

  const serialised = JSON.stringify(value ?? null);

  useEffect(() => {
    if (!enabled) return undefined;
    // Adopt whatever is on screen when the form becomes live, without saving it.
    if (seen.current === null) {
      seen.current = serialised;
      return undefined;
    }
    if (seen.current === serialised) return undefined;
    setStatus('saving');
    const t = setTimeout(async () => {
      const pending = serialised;
      try {
        await saveRef.current(valueRef.current);
        seen.current = pending;
        setStatus('saved');
      } catch {
        setStatus('error');
      }
    }, delay);
    return () => clearTimeout(t);
  }, [serialised, enabled, delay]);

  return status;
}
