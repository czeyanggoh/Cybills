import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { fetchCashAccounts } from '@/lib/organisations';
import { todayIso } from '@/lib/claimDate';

// A claim published in cash mode IS the reimbursement: one Spend Money, so it
// needs the account the money left and the day it did. Asked once, for however
// many claims are being published.
export default function CashClaimModal({ open, organisationId, count = 1, onClose, onConfirm }) {
  const [accounts, setAccounts] = useState(null); // null = loading
  const [paidFrom, setPaidFrom] = useState('');
  const [paidDate, setPaidDate] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || !organisationId) return undefined;
    let alive = true;
    setAccounts(null);
    setPaidFrom('');
    setPaidDate(todayIso());
    setError('');
    fetchCashAccounts(organisationId)
      .then((list) => {
        if (!alive) return;
        setAccounts(list);
        if (list.length === 1) setPaidFrom(list[0].accountId);
      })
      .catch((err) => {
        if (!alive) return;
        setAccounts([]);
        setError(`Could not load the bank accounts from Xero: ${err.message}`);
      });
    return () => {
      alive = false;
    };
  }, [open, organisationId]);

  if (!open) return null;
  const field = 'h-9 flex-1 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={onClose} aria-hidden="true" />
      <div className="relative w-full max-w-md rounded-lg bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-base font-semibold tracking-tight">Publish to Xero as Spend Money</h2>
          <button type="button" onClick={onClose} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-3 p-6">
          <p className="text-sm text-muted-foreground">
            {count === 1 ? 'The claim posts' : `Each of the ${count} claims posts`} as money already paid to the claimant. Say where it was
            paid from, and when.
          </p>
          <label className="flex items-center gap-3 text-sm">
            <span className="w-24 shrink-0 text-muted-foreground">Paid from</span>
            <select value={paidFrom} onChange={(e) => setPaidFrom(e.target.value)} disabled={!accounts} className={field}>
              <option value="">{accounts ? 'Select a bank or card account' : 'Loading accounts…'}</option>
              {(accounts ?? []).map((a) => (
                <option key={a.accountId} value={a.accountId}>
                  {a.label}
                  {a.currency ? ` · ${a.currency}` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-3 text-sm">
            <span className="w-24 shrink-0 text-muted-foreground">Date paid</span>
            <input type="date" value={paidDate} onChange={(e) => setPaidDate(e.target.value)} className={field} />
          </label>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 border-t px-6 py-4">
          <button type="button" onClick={onClose} className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted">
            Cancel
          </button>
          <button
            type="button"
            disabled={!paidFrom || !paidDate}
            onClick={() => onConfirm({ paidFrom, paidDate })}
            className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            Publish
          </button>
        </div>
      </div>
    </div>
  );
}
