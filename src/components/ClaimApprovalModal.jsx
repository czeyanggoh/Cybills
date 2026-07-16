import { useState } from 'react';
import { X, ChevronDown, Search, Check } from 'lucide-react';
import { USERS } from '@/data/users';
import { cn } from '@/lib/utils';

// Searchable approver picker mirroring Dext's. Approvers come from the Users
// list; the selected value is the person's display name.
function ApproverSelect({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const filtered = USERS.filter(
    (u) =>
      u.name.toLowerCase().includes(query.toLowerCase()) ||
      u.email.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div className="relative flex-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 w-full items-center justify-between rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className={cn('truncate', !value && 'text-muted-foreground')}>{value || 'Select an approver'}</span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="absolute left-0 right-0 z-20 mt-1 overflow-hidden rounded-md border bg-background shadow-lg">
            <div className="relative border-b p-2">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search"
                className="h-8 w-full rounded-md border bg-background pl-8 pr-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
            <ul className="max-h-56 overflow-auto py-1">
              {filtered.map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(u.name);
                      setOpen(false);
                      setQuery('');
                    }}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{u.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{u.email}</span>
                    </span>
                    {value === u.name && <Check className="h-4 w-4 shrink-0" />}
                  </button>
                </li>
              ))}
              {filtered.length === 0 && (
                <li className="px-3 py-4 text-center text-sm text-muted-foreground">No users found.</li>
              )}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

// "Submit for approval" dialog — choose an approver, then confirm.
export default function ClaimApprovalModal({ open, onClose, onSubmit }) {
  const [approver, setApprover] = useState('');

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={onClose} aria-hidden="true" />
      <div className="relative w-full max-w-md overflow-visible rounded-lg bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-base font-semibold tracking-tight">Submit for approval</h2>
          <button type="button" onClick={onClose} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6">
          <p className="mb-4 text-sm text-muted-foreground">
            Choose a user to approve the claim. The user will be notified, and can approve the claim
            from inside the claim in their account.
          </p>
          <label className="flex items-center gap-3 text-sm">
            <span className="w-24 shrink-0 text-muted-foreground">Approver</span>
            <ApproverSelect value={approver} onChange={setApprover} />
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-6 py-4">
          <button type="button" onClick={onClose} className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted">
            Cancel
          </button>
          <button
            type="button"
            disabled={!approver}
            onClick={() => onSubmit(approver)}
            className={cn(
              'inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90',
              !approver && 'opacity-50'
            )}
          >
            Submit
          </button>
        </div>
      </div>
    </div>
  );
}
