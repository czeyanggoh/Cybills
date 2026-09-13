import { useMemo, useState } from 'react';
import { Landmark, Info, Check } from 'lucide-react';
import { formatDate } from '@/lib/date';
import { useBankLines, invalidateBankLines, autofillBankPayment, clearBankPayment } from '@/lib/bankStore';
import { matchesByDoc, lineKey } from '@/lib/bankMatch';
import { notifyBillsChanged } from '@/lib/bills';
import { cn } from '@/lib/utils';

// The Bank match block on the document page — Dext's, in the Details tab:
// an info line saying the item matches an outgoing payment in the bank feed,
// then the line itself (date, amount, description, bank account) and the
// Autofill payment button. Same lines, same pairing and the same act as the
// inbox's Match column (BankMatchCell.jsx); this is the same match seen from
// the page a reviewer has open. Nothing is written to Xero here — Autofill
// keeps the line on the document, and PUBLISH records the payment.
//
// Renders nothing for a document no line pays and none is pending, which is
// most documents: Dext shows the block only where there is a match to show.

const money = (line) => `${line.currency ? `${line.currency} ` : ''}${Math.abs(Number(line.amount) || 0).toFixed(2)}`;

function Row({ label, children, right }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="text-xs font-medium text-muted-foreground">{label}</div>
        <div className="mt-0.5 break-words text-sm">{children}</div>
      </div>
      {right ? <div className="shrink-0 text-right text-sm font-semibold tabular-nums">{right}</div> : null}
    </div>
  );
}

export default function BankMatchPanel({ doc, onChanged }) {
  const bank = useBankLines({ enabled: Boolean(doc?.id) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = doc?.bankMatch || null;

  const matches = useMemo(() => {
    if (!doc?.id || pending) return [];
    const done = new Set(bank.records.map((r) => r.key));
    const open = bank.lines.filter((l) => !done.has(l.key || lineKey(l)));
    return open.length ? matchesByDoc(open, [doc]).get(doc.id) || [] : [];
  }, [doc, pending, bank.lines, bank.records]);

  if (!pending && !matches.length) return null;

  const run = async (fn) => {
    setBusy(true);
    setError('');
    try {
      const out = await fn();
      invalidateBankLines();
      notifyBillsChanged();
      onChanged?.(out?.bill || null, out);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-lg border bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} />
        <p>
          {pending
            ? 'The payment for this item has been filled from your bank feed. It is recorded in Xero when the item is published, so the statement line reconciles easily.'
            : 'This item matches an outgoing payment in your bank feed, meaning that this item has been paid. Click “Autofill payment” so that it publishes as paid and can be reconciled easily.'}
        </p>
      </div>

      <div className="rounded-lg border bg-background p-4">
        <div className={cn('mb-3 flex items-center gap-2 text-base font-semibold', pending ? 'text-emerald-700' : 'text-amber-600')}>
          {pending ? <Check className="h-5 w-5" /> : <Landmark className="h-5 w-5" strokeWidth={1.75} />}
          Bank match
        </div>

        {pending ? (
          <div className="space-y-3">
            <Row label="Date" right={money(pending)}>{formatDate(pending.date)}</Row>
            <Row label="Description">{pending.description || pending.reference || '—'}</Row>
            <Row label="Bank account">{pending.bankAccountName || pending.bankAccountCode || '—'}</Row>
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <span className="inline-flex items-center gap-1 rounded bg-emerald-100 px-2 py-1 text-xs font-medium text-emerald-800">
                <Check className="h-3.5 w-3.5" /> Payment filled
              </span>
              <button
                type="button"
                onClick={() => run(() => clearBankPayment(doc.id))}
                disabled={busy}
                className="text-sm text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
              >
                Clear payment
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            {matches.map(({ line, confidence }, i) => (
              <div key={line.key || lineKey(line)} className={cn('space-y-3', i > 0 && 'border-t pt-4')}>
                <Row label="Date" right={money(line)}>{formatDate(line.date)}</Row>
                <Row label="Description">{line.description || line.reference || '—'}</Row>
                <Row label="Bank account">{line.bank_account_name || '—'}</Row>
                <div className="flex flex-wrap items-center gap-3 pt-1">
                  <button
                    type="button"
                    onClick={() => run(() => autofillBankPayment(doc.id, line))}
                    disabled={busy}
                    className="inline-flex h-9 items-center rounded-md border-2 border-foreground px-4 text-sm font-semibold transition-colors hover:bg-muted disabled:opacity-50"
                  >
                    {busy ? 'Filling…' : 'Autofill payment'}
                  </button>
                  <span className={cn('text-xs', confidence === 'firm' ? 'text-emerald-700' : 'text-amber-700')}>
                    {confidence === 'firm' ? 'Names this supplier' : 'Same amount, close date'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
        {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
      </div>
    </div>
  );
}
