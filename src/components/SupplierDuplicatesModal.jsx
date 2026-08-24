import { useMemo } from 'react';
import { X, AlertTriangle } from 'lucide-react';
import { findDuplicateGroups } from '@/lib/supplierDuplicates';

// Lists suspected duplicate supplier NAMES (same entity spelled/typed two ways)
// so they can be cleaned up. Suppliers come from Xero contacts, so the actual
// merge happens in Xero — this surfaces what to look at, and lets you jump
// straight to setting a shared rule for a name.
export default function SupplierDuplicatesModal({ open, names, onClose, onPick }) {
  const groups = useMemo(() => (open ? findDuplicateGroups(names) : []), [open, names]);
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={onClose} aria-hidden="true" />
      <div className="relative flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-lg bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-base font-semibold tracking-tight">Supplier duplicates</h2>
          <button type="button" onClick={onClose} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-6">
          {groups.length === 0 ? (
            <p className="rounded-md border bg-muted/20 px-4 py-10 text-center text-sm text-muted-foreground">
              No likely duplicates found. Every supplier name looks distinct.
            </p>
          ) : (
            <>
              <p className="mb-4 flex items-start gap-2 rounded-md border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} />
                <span>
                  {groups.length} group{groups.length === 1 ? '' : 's'} of names look like the same supplier. Because
                  suppliers come from Xero, merge the contacts in Xero — here you can jump to any name to set its rule.
                </span>
              </p>
              <div className="space-y-4">
                {groups.map((group, i) => (
                  <div key={i} className="rounded-lg border">
                    <div className="border-b bg-muted/30 px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Possible match &middot; {group.length} names
                    </div>
                    <ul className="divide-y">
                      {group.map((name) => (
                        <li key={name} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
                          <span className="min-w-0 truncate font-medium">{name}</span>
                          <button
                            type="button"
                            onClick={() => onPick?.(name)}
                            className="shrink-0 whitespace-nowrap text-xs font-medium text-emerald-600 hover:underline"
                          >
                            Set rule
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-end border-t px-6 py-4">
          <button type="button" onClick={onClose} className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
