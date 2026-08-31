import { useState } from 'react';
import { X } from 'lucide-react';
import { useClaims, isClaimArchived, formatClaimDate } from '@/lib/claimStore';
import { useClaimantNames } from '@/lib/userStore';
import { useOrganisations, getActiveOrganisationId } from '@/lib/organisations';
import SearchSelect from '@/components/SearchSelect';
import ComboSelect from '@/components/ComboSelect';
import { cn } from '@/lib/utils';

// "Add item to expense claim" dialog — add to an existing claim or spin up a
// new one. UI-only: confirming closes and reports the chosen claim.
// The last day of the month we are in, as the date input wants it.
function endOfThisMonth() {
  const now = new Date();
  // Day 0 of next month IS the last day of this one, which also gets February
  // and leap years right without a table.
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${last.getFullYear()}-${pad(last.getMonth() + 1)}-${pad(last.getDate())}`;
}

export default function AddToClaimModal({ open, onClose, onAdd, count = 1 }) {
  const [mode, setMode] = useState('existing');
  const [claim, setClaim] = useState('');
  // A claim covers a month, and the date that closes it is the end of that
  // month — so it is filled in rather than asked for. Somebody raising a claim
  // on the 27th means "August", and typing 31 Aug into a date picker to say so
  // is work the app can do. Still editable: a claim that genuinely ends
  // mid-month is a real thing, just not the common one.
  const [newClaim, setNewClaim] = useState({ claimFor: '', name: '', endDate: endOfThisMonth() });
  const allClaims = useClaims();
  // Only the claims an item can actually go onto. The dropdown offered every
  // claim ever made — six entries where the Expense claims page showed two —
  // including ones already published to Xero, where a line added here would
  // never reach the ledger, and approved ones, which the server refuses outright
  // (409 claim_locked). Offering those is offering a dead end.
  const claims = allClaims.filter((c) => !isClaimArchived(c) && c.approvalStatus !== 'approved');
  // Named, then told apart. Three claims called "Expense claim" for the same
  // person are indistinguishable on name alone, so the person, the date and the
  // total come along — and because the picker searches the label, they are also
  // what you can type to find one.
  const byId = new Map(claims.map((c) => [c.id, c]));
  const labelFor = (c) =>
    c
      ? [c.name, c.claimFor, c.endDate ? formatClaimDate(c.endDate) : '', `${c.currency || 'SGD'} ${c.total}`]
          .filter(Boolean)
          .join(' · ')
      : '';
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
                {/* A search box, not a dropdown you can type into. A month of
                    claims is dozens of lines that mostly read "Expense claim",
                    so being handed all of them on a click was never the useful
                    half — each is labelled with the person, the date and the
                    total, and all of that is searchable, so "cze aug" or
                    "41.60" reaches one directly. Nothing is listed until
                    something is typed. */}
                <ComboSelect
                  variant="search"
                  value={claim}
                  onChange={setClaim}
                  options={claims.map((c) => c.id)}
                  format={(id) => labelFor(byId.get(id))}
                  placeholder={claims.length ? 'Search claims by name, person or amount' : 'No open claims — make a new one'}
                  aria-label="Expense claim"
                  disabled={!claims.length}
                />
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
