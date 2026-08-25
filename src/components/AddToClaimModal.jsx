import { useState } from 'react';
import { X, ChevronDown } from 'lucide-react';
import { useClaims } from '@/lib/claimStore';
import { useClaimantNames } from '@/lib/userStore';
import { useOrganisations, getActiveOrganisationId } from '@/lib/organisations';
import SearchSelect from '@/components/SearchSelect';
import { cn } from '@/lib/utils';

// "Add item to expense claim" dialog — add to an existing claim or spin up a
// new one. UI-only: confirming closes and reports the chosen claim.
export default function AddToClaimModal({ open, onClose, onAdd, count = 1 }) {
  const [mode, setMode] = useState('existing');
  const [claim, setClaim] = useState('');
  const [newClaim, setNewClaim] = useState({ claimFor: '', name: '', endDate: '' });
  const claims = useClaims();
  // A colleague can be claimed for in the practice's OWN entity — that is where
  // their own expenses belong — and nowhere else.
  const { data: organisations = [] } = useOrganisations();
  const activeOrg = organisations.find((o) => o.id === getActiveOrganisationId()) || organisations[0];
  const userNames = useClaimantNames({ ownEntity: Boolean(activeOrg?.isPrimary) });

  if (!open) return null;

  const canAdd = mode === 'existing' ? Boolean(claim) : Boolean(newClaim.claimFor);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={onClose} aria-hidden="true" />
      <div className="relative flex max-h-[90vh] w-full max-w-md flex-col overflow-y-auto rounded-lg bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-base font-semibold tracking-tight">
            Add {count} item{count === 1 ? '' : 's'} to expense claim
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6">
          {/* Existing / New tabs */}
          <div className="mb-5 inline-flex rounded-md border p-0.5 text-sm">
            {[
              { key: 'existing', label: 'Existing claim' },
              { key: 'new', label: 'New claim' },
            ].map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setMode(t.key)}
                className={cn(
                  'rounded px-3 py-1.5 transition-colors',
                  mode === t.key ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          {mode === 'existing' ? (
            <label className="flex items-center gap-3 text-sm">
              <span className="w-28 shrink-0 text-muted-foreground">Expense claim</span>
              <div className="relative flex-1">
                <select
                  value={claim}
                  onChange={(e) => setClaim(e.target.value)}
                  className="h-9 w-full appearance-none rounded-md border bg-background px-3 pr-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">Select a claim</option>
                  {claims.map((c) => (
                    <option key={c.id} value={c.id}>{c.name} · {c.claimFor}</option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              </div>
            </label>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-3 text-sm">
                <span className="w-28 shrink-0 text-muted-foreground">Claim for <span className="text-destructive">*</span></span>
                <div className="flex-1">
                  <SearchSelect
                    value={newClaim.claimFor}
                    options={userNames}
                    placeholder="Select a person"
                    onChange={(v) => setNewClaim((s) => ({ ...s, claimFor: v }))}
                  />
                </div>
              </div>
              <label className="flex items-center gap-3 text-sm">
                <span className="w-28 shrink-0 text-muted-foreground">Claim name</span>
                <input
                  value={newClaim.name}
                  onChange={(e) => setNewClaim((s) => ({ ...s, name: e.target.value }))}
                  placeholder="e.g. July Expenses"
                  className="h-9 flex-1 rounded-md border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                />
              </label>
              <label className="flex items-center gap-3 text-sm">
                <span className="w-28 shrink-0 text-muted-foreground">End date</span>
                <input
                  type="date"
                  value={newClaim.endDate}
                  onChange={(e) => setNewClaim((s) => ({ ...s, endDate: e.target.value }))}
                  className="h-9 flex-1 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </label>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canAdd}
            onClick={() => onAdd?.(mode === 'existing' ? { claimId: claim } : { newClaim })}
            className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
