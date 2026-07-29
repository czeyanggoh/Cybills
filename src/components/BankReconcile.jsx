import { useState } from 'react';
import { Check, Link2, RotateCcw } from 'lucide-react';
import { RECON_ACCOUNTS, useBankFeed, reconcile, reconcileAll } from '@/lib/bankRecon';
import { formatDate } from '@/lib/date';
import { cn } from '@/lib/utils';

// Bank reconciliation: match each bank-feed transaction to the cost it pays.
export default function BankReconcile() {
  const feed = useBankFeed();
  const [acct, setAcct] = useState('all');

  const rows = acct === 'all' ? feed : feed.filter((t) => t.accountId === acct);
  const reconciledCount = feed.filter((t) => t.reconciled).length;
  const matchable = feed.filter((t) => t.suggestedCostId && !t.reconciled).length;
  const acctLabel = (id) => RECON_ACCOUNTS.find((a) => a.id === id)?.bank || id;
  const money = (t) => `${t.type === 'credit' ? '+' : '−'}SGD ${Number(t.amount).toFixed(2)}`;

  const TABS = [{ id: 'all', bank: 'All accounts' }, ...RECON_ACCOUNTS];

  return (
    <>
      {/* Account filter + summary */}
      <div className="mb-4 flex flex-wrap items-center gap-2 border-b pb-3">
        {TABS.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => setAcct(a.id)}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm transition-colors',
              acct === a.id ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted'
            )}
          >
            {a.bank}
            {a.number ? <span className="ml-1.5 text-xs opacity-70">·{a.number.slice(-4)}</span> : null}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-3">
          <span className="text-sm text-muted-foreground">{reconciledCount} of {feed.length} reconciled</span>
          <button
            type="button"
            onClick={reconcileAll}
            disabled={!matchable}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            <Link2 className="h-3.5 w-3.5" /> Auto-reconcile matches
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[820px] text-sm">
          <thead className="border-b bg-muted/40 text-left text-muted-foreground">
            <tr>
              <th className="px-3 py-2.5 font-medium">Date</th>
              <th className="px-3 py-2.5 font-medium">Account</th>
              <th className="px-3 py-2.5 font-medium">Bank description</th>
              <th className="px-3 py-2.5 text-right font-medium">Amount</th>
              <th className="px-3 py-2.5 font-medium">Matches cost</th>
              <th className="px-3 py-2.5 text-right font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} className={cn('border-b last:border-0', t.reconciled && 'bg-emerald-50/50')}>
                <td className="whitespace-nowrap px-3 py-3 tabular-nums text-muted-foreground">{formatDate(t.date)}</td>
                <td className="whitespace-nowrap px-3 py-3">{acctLabel(t.accountId)}</td>
                <td className="px-3 py-3">{t.description}</td>
                <td className={cn('whitespace-nowrap px-3 py-3 text-right tabular-nums', t.type === 'credit' ? 'text-emerald-700' : '')}>{money(t)}</td>
                <td className="px-3 py-3 text-muted-foreground">
                  {t.suggestedCostId ? (
                    <span className="inline-flex items-center gap-1">
                      <Link2 className="h-3.5 w-3.5" /> {t.suggestedSupplier || 'Cost'}
                    </span>
                  ) : (
                    <span className="text-xs italic text-muted-foreground/70">No cost — bank only</span>
                  )}
                </td>
                <td className="px-3 py-3 text-right">
                  {t.reconciled ? (
                    <span className="inline-flex items-center gap-2">
                      <span className="inline-flex items-center gap-1 rounded bg-foreground px-2 py-0.5 text-xs font-medium text-background">
                        <Check className="h-3 w-3" /> Reconciled
                      </span>
                      <button type="button" onClick={() => reconcile(t.id, false)} title="Undo" className="text-muted-foreground hover:text-foreground">
                        <RotateCcw className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  ) : t.suggestedCostId ? (
                    <button
                      type="button"
                      onClick={() => reconcile(t.id, true)}
                      className="inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted"
                    >
                      Reconcile
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => reconcile(t.id, true)}
                      title="Mark this bank-only line as reconciled"
                      className="inline-flex h-8 items-center rounded-md border px-3 text-sm text-muted-foreground transition-colors hover:bg-muted"
                    >
                      Mark done
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-16 text-center text-sm text-muted-foreground">No transactions for this account.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        Matched against your Costs. Reconciling ties a bank line to the cost it pays; bank-only lines
        (fees, interest, transfers) can be marked done.
      </p>
    </>
  );
}
