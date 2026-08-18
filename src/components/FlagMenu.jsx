import { useState, useRef, useEffect } from 'react';
import { Flag } from 'lucide-react';
import { useFlags } from '@/lib/flagsStore';
import { setAssignedFlag, useFlagAssignments } from '@/lib/flagAssignments';
import { cn } from '@/lib/utils';

// Colour → Tailwind text colour. Full class strings so the JIT keeps them.
export const FLAG_TEXT = {
  orange: 'text-orange-500',
  yellow: 'text-yellow-500',
  green: 'text-green-500',
  blue: 'text-blue-500',
  purple: 'text-purple-500',
};

// A flag icon that opens a small colour picker. `id` is the entity being
// flagged (claim id, item id, …). Colours + labels come from the Flags list
// settings; only flags marked Visible are offered.
export default function FlagMenu({ id, size = 'sm' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const flags = useFlags();
  const assignments = useFlagAssignments();
  const current = assignments[id] || '';
  const options = flags.filter((f) => f.visible);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const dim = size === 'lg' ? 'h-4 w-4' : 'h-3.5 w-3.5';

  return (
    <span className="relative inline-flex" ref={ref}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        aria-label={current ? 'Change flag' : 'Add flag'}
        title={current ? `Flagged ${current}` : 'Add flag'}
        className="inline-flex items-center"
      >
        <Flag
          className={cn(dim, current ? FLAG_TEXT[current] : 'text-muted-foreground/60 hover:text-foreground')}
          strokeWidth={1.75}
          fill={current ? 'currentColor' : 'none'}
        />
      </button>
      {open && (
        <div
          className="absolute left-0 top-6 z-[60] w-44 rounded-md border bg-background p-1 shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          {options.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">No flags enabled. Turn them on in Settings → Lists → Flags.</p>
          ) : (
            options.map((f) => (
              <button
                key={f.color}
                type="button"
                onClick={() => { setAssignedFlag(id, current === f.color ? '' : f.color); setOpen(false); }}
                className={cn('flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted', current === f.color && 'bg-muted')}
              >
                <Flag className={cn('h-3.5 w-3.5', FLAG_TEXT[f.color])} fill="currentColor" />
                <span className="flex-1 truncate">{f.label}</span>
                {current === f.color && <span className="text-xs text-muted-foreground">✓</span>}
              </button>
            ))
          )}
          {current && (
            <button
              type="button"
              onClick={() => { setAssignedFlag(id, ''); setOpen(false); }}
              className="mt-1 flex w-full items-center gap-2 rounded border-t px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted"
            >
              Clear flag
            </button>
          )}
        </div>
      )}
    </span>
  );
}
