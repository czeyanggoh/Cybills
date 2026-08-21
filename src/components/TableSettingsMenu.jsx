import { useEffect, useRef, useState } from 'react';
import { Settings2 } from 'lucide-react';
import {
  COST_COLUMNS,
  DENSITIES,
  getTablePrefs,
  resetTablePrefs,
  saveTablePrefs,
  useTablePrefs,
} from '@/lib/tablePrefs';
import { cn } from '@/lib/utils';

// The gear beside the search box: which columns the table shows, and how
// tightly it packs the rows. Choices apply as you make them and save
// themselves, like everything else — Reset puts the defaults back.
export default function TableSettingsMenu({ table = 'costs', columns = COST_COLUMNS }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef(null);
  const [pos, setPos] = useState(null);
  // The toolbar wraps, so the gear can sit at either end of the row depending on
  // the window. Anchoring the panel to a fixed side therefore put it off-screen
  // one way or the other — over the table's checkbox column on a narrow window,
  // past the right edge on a wide one. Measure the button instead and clamp the
  // panel inside the viewport.
  useEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const r = buttonRef.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.min(416, window.innerWidth - 24);
      const left = Math.min(Math.max(12, r.right - width), window.innerWidth - width - 12);
      setPos({ top: r.bottom + 6, left, width });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);
  const prefs = useTablePrefs(table);
  const optional = columns.filter((c) => !c.fixed);
  const primary = optional.filter((c) => c.primary);
  const additional = optional.filter((c) => !c.primary);
  const hiddenCount = optional.filter((c) => !prefs.columns[c.key]).length;

  const toggle = (key) => {
    const current = getTablePrefs(table);
    saveTablePrefs(table, {
      ...current,
      columns: { ...current.columns, [key]: !current.columns[key] },
    });
  };
  const setDensity = (density) => saveTablePrefs(table, { ...getTablePrefs(table), density });

  const Check = ({ column }) => (
    <label className="flex cursor-pointer items-center gap-2 py-1 text-sm">
      <input
        type="checkbox"
        checked={Boolean(prefs.columns[column.key])}
        onChange={() => toggle(column.key)}
        className="h-4 w-4 accent-black"
      />
      <span className="truncate">{column.label}</span>
    </label>
  );

  return (
    <div className="relative">
      <button
        type="button"
        ref={buttonRef}
        onClick={() => setOpen((o) => !o)}
        aria-label="Table settings"
        title="Columns and density"
        className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Settings2 className={cn('h-4 w-4', hiddenCount > 0 && 'text-foreground')} strokeWidth={1.75} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden="true" />
          <div
            style={pos ? { top: pos.top, left: pos.left, width: pos.width } : { visibility: 'hidden' }}
            className="fixed z-30 max-h-[70vh] overflow-auto rounded-lg border bg-background p-4 shadow-lg"
          >
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Primary columns</p>
            <div className="grid grid-cols-2 gap-x-6">
              {primary.map((c) => <Check key={c.key} column={c} />)}
            </div>

            <p className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Additional columns</p>
            <div className="grid grid-cols-2 gap-x-6">
              {additional.map((c) => <Check key={c.key} column={c} />)}
            </div>

            <p className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Table density</p>
            <div className="flex gap-2">
              {DENSITIES.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDensity(d)}
                  className={cn(
                    'inline-flex h-8 flex-1 items-center justify-center rounded-md border text-sm transition-colors',
                    prefs.density === d ? 'border-foreground bg-muted font-medium text-foreground' : 'hover:bg-muted',
                  )}
                >
                  {d}
                </button>
              ))}
            </div>

            <div className="mt-4 flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">Changes apply straight away.</span>
              <div className="flex gap-2">
                <button type="button" onClick={() => resetTablePrefs(table)} className="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-muted">Reset</button>
                <button type="button" onClick={() => setOpen(false)} className="inline-flex h-8 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90">Done</button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
