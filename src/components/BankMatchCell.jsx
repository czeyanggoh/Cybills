import { useEffect, useRef, useState } from 'react';
import { Landmark, Check, X } from 'lucide-react';
import { formatDate } from '@/lib/date';
import { autofillBankPayment, clearBankPayment } from '@/lib/bankStore';
import { notifyBillsChanged } from '@/lib/bills';
import { cn } from '@/lib/utils';

// The Match column of the Costs inbox — Dext's Bank match, on the document's
// own row.
//
// A bank statement line that CYWorkspace's auto bank reconciliation could not
// settle, and that agrees with this document on the money, the date window and
// the supplier's name, is this document's PAYMENT: the item has been paid. The
// chip says so ("Match found", or "Matches found" when more than one line
// could be it), and "Autofill payment" is the person accepting it — Paid goes
// on, the bank account becomes the payment method, and the line is kept on the
// document so that PUBLISH records the payment from that account on the
// statement date, which is what makes the line reconcile in Xero. Nothing
// reaches Xero here; that is the publish's job, and the publish dialog says so.

const money = (line) => `${line.currency ? `${line.currency} ` : ''}${Math.abs(Number(line.amount) || 0).toFixed(2)}`;

function Popover({ anchorRef, onClose, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const away = (e) => {
      if (ref.current?.contains(e.target) || anchorRef.current?.contains(e.target)) return;
      onClose();
    };
    // Claimed, so the app-wide Escape (lib/escapeToClose) doesn't also close
    // whatever the popover sits on.
    const esc = (e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [anchorRef, onClose]);
  return (
    <div
      ref={ref}
      role="dialog"
      onClick={(e) => e.stopPropagation()}
      className="absolute left-0 top-full z-30 mt-2 w-80 rounded-lg bg-neutral-900 p-4 text-left text-sm text-neutral-50 shadow-xl"
    >
      <span className="absolute -top-1.5 left-6 h-3 w-3 rotate-45 bg-neutral-900" aria-hidden="true" />
      {children}
    </div>
  );
}

export default function BankMatchCell({ doc, matches = [], onChanged }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const anchor = useRef(null);
  const pending = doc.bankMatch;

  const stop = (e) => e.stopPropagation();

  const fill = async (line) => {
    setBusy(true);
    setError('');
    try {
      const out = await autofillBankPayment(doc.id, line);
      setOpen(false);
      notifyBillsChanged();
      onChanged?.(out);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    setError('');
    try {
      await clearBankPayment(doc.id);
      setOpen(false);
      notifyBillsChanged();
      onChanged?.(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (!pending && !matches.length) return <span className="text-muted-foreground">—</span>;

  return (
    <div className="relative inline-block" onClick={stop}>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex items-center gap-1.5 whitespace-nowrap rounded px-2 py-1 text-xs font-medium transition-colors',
          pending ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200' : 'bg-amber-100 text-amber-900 hover:bg-amber-200'
        )}
        title={pending ? 'Payment filled from the bank feed — recorded when this document is published' : 'This item matches an outgoing payment in the bank feed'}
      >
        {pending ? <Check className="h-3.5 w-3.5" /> : <Landmark className="h-3.5 w-3.5" />}
        {pending ? 'Payment filled' : matches.length > 1 ? 'Matches found' : 'Match found'}
      </button>

      {open && (
        <Popover anchorRef={anchor} onClose={() => setOpen(false)}>
          <p className="font-semibold">Bank match</p>
          {pending ? (
            <>
              <p className="mt-2 text-neutral-300">
                This item will be recorded as paid from <span className="text-neutral-50">{pending.bankAccountName || 'the bank account'}</span> on{' '}
                <span className="text-neutral-50">{formatDate(pending.date)}</span> ({money(pending)}) when it is published, so the statement line
                reconciles in Xero.
              </p>
              {pending.reference || pending.description ? (
                <p className="mt-1 truncate text-xs text-neutral-400" title={pending.reference || pending.description}>{pending.description || pending.reference}</p>
              ) : null}
              <button type="button" onClick={clear} disabled={busy} className="mt-3 inline-flex items-center gap-1 text-sm text-sky-300 hover:underline disabled:opacity-50">
                <X className="h-3.5 w-3.5" /> Clear payment
              </button>
            </>
          ) : (
            <>
              <p className="mt-2 text-neutral-300">
                This item matches an outgoing payment in your bank feed, meaning that this item has been paid. Autofill the payment
                fields so that it can be reconciled easily when you publish.
              </p>
              <ul className="mt-3 space-y-2">
                {matches.map(({ line, confidence }) => (
                  <li key={line.key} className="rounded border border-neutral-700 px-2.5 py-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="tabular-nums text-neutral-200">{formatDate(line.date)}</span>
                      <span className="tabular-nums font-medium">−{money(line)}</span>
                    </div>
                    <div className="truncate text-xs text-neutral-400" title={line.description || line.reference}>
                      {line.bank_account_name ? `${line.bank_account_name} · ` : ''}{line.description || line.reference || 'No description'}
                    </div>
                    <div className="mt-1.5 flex items-center justify-between gap-2">
                      <span className={cn('text-[11px]', confidence === 'firm' ? 'text-emerald-300' : 'text-amber-300')}>
                        {confidence === 'firm' ? 'Names this supplier' : 'Same amount, close date'}
                      </span>
                      <button type="button" onClick={() => fill(line)} disabled={busy} className="text-sm text-sky-300 hover:underline disabled:opacity-50">
                        {busy ? 'Filling…' : 'Autofill payment'}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
          {error ? <p className="mt-2 text-xs text-red-300">{error}</p> : null}
        </Popover>
      )}
    </div>
  );
}
