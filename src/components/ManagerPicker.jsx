import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

// A person's direct managers, as a cell on a roster table: tick as many as may
// approve their claims. Whoever submits a claim picks one of them.
//
// Saved once, when the list closes, so ticking three people is one write rather
// than three racing each other. Same fixed-position placement as the Manage
// menu: the table scrolls, and a clipped axis clips the list with it.
export default function ManagerPicker({ value = [], options = [], onSave, label }) {
  const [draft, setDraft] = useState(null); // ids while open, else null
  const [pos, setPos] = useState(null);
  const buttonRef = useRef(null);
  const open = draft !== null;

  useEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const r = buttonRef.current?.getBoundingClientRect();
      if (!r) return;
      const width = 256; // w-64
      const left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
      const below = window.innerHeight - r.bottom;
      setPos(
        below < 300 && r.top > below
          ? { left, bottom: window.innerHeight - r.top + 4, maxHeight: r.top - 16 }
          : { left, top: r.bottom + 4, maxHeight: below - 16 }
      );
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  // Somebody already set who is no longer offered (since deactivated) still
  // shows, so they can be seen and unticked.
  const nameFor = new Map(options.map((o) => [o.id, o.name]));
  const known = value.filter((id) => nameFor.has(id));
  const summary = !value.length
    ? '— None —'
    : known.length
      ? `${nameFor.get(known[0])}${known.length > 1 ? ` +${known.length - 1}` : ''}`
      : `${value.length} set`;

  const close = () => {
    const next = draft || [];
    setDraft(null);
    setPos(null);
    if (next.join('|') !== value.join('|')) onSave(next);
  };
  const toggle = (id) => setDraft((d) => (d.includes(id) ? d.filter((x) => x !== id) : [...d, id]));
  const listed = [
    ...options,
    ...value.filter((id) => !nameFor.has(id)).map((id) => ({ id, name: 'No longer available' })),
  ];

  return (
    <>
      <button
        type="button"
        ref={buttonRef}
        onClick={() => (open ? close() : setDraft(value))}
        aria-label={label}
        aria-expanded={open}
        title={known.map((id) => nameFor.get(id)).join(', ')}
        className="flex h-8 w-44 items-center justify-between gap-1 rounded-md border bg-background px-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="min-w-0 truncate">{summary}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={close} aria-hidden="true" />
          <div
            style={pos || { visibility: 'hidden' }}
            className="fixed z-40 flex w-64 flex-col rounded-md border bg-background shadow-lg"
          >
            <div className="min-h-0 flex-1 overflow-auto py-1">
              {listed.length === 0 && <p className="px-3 py-2 text-sm text-muted-foreground">Nobody else to choose.</p>}
              {listed.map((o) => (
                <label key={o.id} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted">
                  <input type="checkbox" checked={draft.includes(o.id)} onChange={() => toggle(o.id)} />
                  <span className="min-w-0 truncate">{o.name}</span>
                </label>
              ))}
            </div>
            <div className="flex items-center justify-between border-t px-3 py-2">
              <button type="button" onClick={() => setDraft([])} className="text-xs text-muted-foreground hover:text-foreground">
                Clear
              </button>
              <button type="button" onClick={close} className="inline-flex h-7 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90">
                Done
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
