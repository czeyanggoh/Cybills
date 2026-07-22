import { useState } from 'react';
import { X, ChevronDown } from 'lucide-react';
import { addBankAccount, CURRENCIES } from '@/lib/bankAccounts';

// "Add bank account" dialog — a manual bank account (Name required, Account
// number + Currency optional).
export default function AddBankAccountModal({ open, onClose, onAdded }) {
  const [name, setName] = useState('');
  const [number, setNumber] = useState('');
  const [currency, setCurrency] = useState('SGD');
  if (!open) return null;

  const add = () => {
    const acct = addBankAccount({ name, number, currency });
    if (!acct) return;
    onAdded?.(acct);
    setName('');
    setNumber('');
    setCurrency('SGD');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={onClose} aria-hidden="true" />
      <div className="relative w-full max-w-lg overflow-hidden rounded-lg bg-background shadow-xl">
        <div className="flex h-14 items-center justify-between border-b px-6">
          <h2 className="text-base font-semibold tracking-tight">Add bank account</h2>
          <button type="button" onClick={onClose} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 p-6">
          <label className="flex items-center gap-4 text-sm">
            <span className="w-32 shrink-0 text-muted-foreground">Name <span className="text-destructive">*</span></span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              placeholder="e.g. DBS Current Account"
              className="h-10 flex-1 rounded-md border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <label className="flex items-center gap-4 text-sm">
            <span className="w-32 shrink-0 text-muted-foreground">Account number</span>
            <input
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              placeholder="Add account number"
              className="h-10 flex-1 rounded-md border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <label className="flex items-center gap-4 text-sm">
            <span className="w-32 shrink-0 text-muted-foreground">Currency</span>
            <div className="relative flex-1">
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="h-10 w-full appearance-none rounded-md border bg-background px-3 pr-9 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            </div>
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-6 py-4">
          <button type="button" onClick={onClose} className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted">Cancel</button>
          <button
            type="button"
            onClick={add}
            disabled={!name.trim()}
            className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
