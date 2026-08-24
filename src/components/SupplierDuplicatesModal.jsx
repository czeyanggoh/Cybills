import { X, AlertTriangle } from 'lucide-react';
import { findDuplicateGroups, pairsInGroup } from '@/lib/supplierDuplicates';
import {
  dismissDuplicatePairs,
  dismissedDuplicateCount,
  dismissedDuplicatePairs,
  restoreDuplicateSuggestions,
  useSupplierList,
} from '@/lib/supplierList';

// Lists suspected duplicate supplier NAMES (the same entity spelled or typed two
// ways) so they can be cleaned up in one place: merge the group, or reject the
// suggestion outright.
//
// Rejecting matters as much as merging. These are guesses from spelling, and a
// guess that cannot be told "no" comes back every time the dialog is opened —
// so "Not a duplicate" is recorded per pair and the suggestion never returns.
export default function SupplierDuplicatesModal({ open, names, onClose, onPick, onMerge }) {
  useSupplierList(); // re-render when a suggestion is rejected or restored
  if (!open) return null;
  // Computed on render rather than memoised: the grouping is pure and the dialog
  // is only mounted while it is open, and a memo would have to be keyed on the
  // rejected-pair set as well as the names — a staleness bug waiting to happen,
  // in exchange for nothing on a list this size.
  const dismissedCount = dismissedDuplicateCount();
  const groups = findDuplicateGroups(names, { dismissed: dismissedDuplicatePairs() });

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
              {dismissedCount
                ? 'No suggestions left to review — the rest were marked as different suppliers.'
                : 'No likely duplicates found. Every supplier name looks distinct.'}
            </p>
          ) : (
            <>
              <p className="mb-4 flex items-start gap-2 rounded-md border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} />
                <span>
                  {groups.length} group{groups.length === 1 ? '' : 's'} of names look like the same supplier. These are
                  guesses from spelling — <strong className="font-medium text-foreground">Merge</strong> the ones that
                  are one supplier, and mark the rest as different so they stop being suggested.
                </span>
              </p>
              <div className="space-y-4">
                {groups.map((group, i) => (
                  <div key={i} className="rounded-lg border">
                    <div className="flex items-center justify-between gap-3 border-b bg-muted/30 px-3 py-2">
                      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Possible match &middot; {group.length} names
                      </span>
                      <div className="flex shrink-0 items-center gap-2">
                        <button
                          type="button"
                          onClick={() => dismissDuplicatePairs(pairsInGroup(group))}
                          className="whitespace-nowrap rounded-md border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-muted"
                        >
                          Not a duplicate
                        </button>
                        <button
                          type="button"
                          onClick={() => onMerge?.(group)}
                          className="whitespace-nowrap rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
                        >
                          Merge
                        </button>
                      </div>
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

        <div className="flex items-center justify-between gap-3 border-t px-6 py-4">
          {dismissedCount > 0 ? (
            <button
              type="button"
              onClick={restoreDuplicateSuggestions}
              className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Restore {dismissedCount} rejected suggestion{dismissedCount === 1 ? '' : 's'}
            </button>
          ) : (
            <span />
          )}
          <button type="button" onClick={onClose} className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
