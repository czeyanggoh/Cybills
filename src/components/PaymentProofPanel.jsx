import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Banknote, Check, Info } from 'lucide-react';
import { applyPaymentProof, costPath, fetchProofMatches, notifyBillsChanged, unapplyPaymentProof } from '@/lib/bills';
import { isPaymentProof } from '@/lib/paymentProof';
import { formatDate } from '@/lib/date';
import { cn } from '@/lib/utils';

// A payment proof and the invoices it pays, on the document page — from either
// side. On a PROOF: the invoices it settles (with Undo), else the matches the
// rules found (src/lib/proofMatch.js) with Apply, and a picker for choosing the
// invoices by hand when nothing adds up by itself. On an INVOICE: the proof that
// paid it, or a proof in the book that could. Renders nothing for a document
// that is neither, which is most of them.

const money = (currency, n) => `${currency ? `${currency} ` : ''}${(Number(n) || 0).toFixed(2)}`;
const cents = (n) => Math.round((Number(String(n ?? '').replace(/[^0-9.-]/g, '')) || 0) * 100);

const REASON_WORDS = {
  number: 'Quotes the invoice number',
  name: 'Paid to this supplier',
  amount: 'Same amount',
  combo: 'Adds up exactly',
  ambiguous: 'One of several that fit',
};
const describe = (reasons) => (reasons || []).map((r) => REASON_WORDS[r]).filter(Boolean).join(' · ');

const actionCls =
  'inline-flex h-9 items-center rounded-md border-2 border-foreground px-4 text-sm font-semibold transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50';
const linkCls = 'text-sm text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50';

// At module scope rather than inside the panel: a component declared in a
// render is a NEW component every render, which would remount its children —
// the hand-picker's checkboxes and its scroll position with them.
function Frame({ done, title, note, error, children }) {
  return (
    <div className="space-y-3">
      {note ? (
        <div className="flex items-start gap-2 rounded-lg border bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground">
          <Info className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} />
          <p>{note}</p>
        </div>
      ) : null}
      <div className="rounded-lg border bg-background p-4">
        <div className={cn('mb-3 flex items-center gap-2 text-base font-semibold', done ? 'text-emerald-700' : 'text-amber-600')}>
          {done ? <Check className="h-5 w-5" /> : <Banknote className="h-5 w-5" strokeWidth={1.75} />}
          {title}
        </div>
        {children}
        {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
      </div>
    </div>
  );
}

function InvoiceRow({ row, onOpen }) {
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <button type="button" onClick={() => onOpen(row.id)} className="min-w-0 text-left hover:underline">
        <span className="font-medium">{row.supplier || 'Unknown supplier'}</span>
        <span className="text-muted-foreground">
          {row.invoiceNumber ? ` · ${row.invoiceNumber}` : ''}
          {row.date ? ` · ${formatDate(row.date)}` : ''}
        </span>
      </button>
      <span className="shrink-0 tabular-nums">{money(row.currency, row.total)}</span>
    </div>
  );
}

export default function PaymentProofPanel({ doc, onChanged }) {
  const navigate = useNavigate();
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState(() => new Set());
  const proof = isPaymentProof(doc?.type);
  // Asked again whenever what the answer depends on changes on this page.
  const depends = [doc?.id, doc?.type, doc?.total, doc?.date, doc?.supplier, (doc?.paysBills || []).join(','), doc?.paidByProof?.proofId || ''].join('|');

  useEffect(() => {
    let alive = true;
    if (!doc?.id) return undefined;
    fetchProofMatches(doc.id).then((out) => { if (alive) setInfo(out); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depends]);

  const pickedTotal = useMemo(
    () => (info?.candidates || []).filter((c) => picked.has(c.id)).reduce((s, c) => s + cents(c.total), 0),
    [info, picked]
  );

  if (!info) return null;
  const open = (id) => navigate(costPath(id));

  const run = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      notifyBillsChanged();
      setPicking(false);
      setPicked(new Set());
      setInfo(await fetchProofMatches(doc.id));
      await onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // --- an invoice ------------------------------------------------------------------
  if (!proof) {
    if (info.kind !== 'invoice') return null;
    if (info.paidBy) {
      const p = info.paidBy;
      return (
        <Frame done title="Paid by payment proof" error={error}>
          <div className="space-y-3">
            <InvoiceRow row={p} onOpen={open} />
            <p className="text-xs text-muted-foreground">
              {p.auto ? 'Matched automatically — the proof names this supplier and its amount adds up exactly.' : 'Matched by hand.'}
              {doc?.xeroInvoiceId ? ' This bill is already in Xero, so what Xero says about its payment stands there.' : ''}
            </p>
            <button type="button" disabled={busy} onClick={() => run(() => unapplyPaymentProof(p.id))} className={linkCls}>
              Not this payment — undo
            </button>
          </div>
        </Frame>
      );
    }
    if (!info.offers?.length) return null;
    return (
      <Frame
        title="Payment proof found"
        note="A payment proof in the book adds up to this invoice. Apply it to mark this invoice paid, so it is not paid a second time."
        error={error}
      >
        <div className="space-y-4">
          {info.offers.map((o, i) => (
            <div key={`${o.proof.id}-${o.ids.join('|')}`} className={cn('space-y-2', i > 0 && 'border-t pt-3')}>
              <InvoiceRow row={o.proof} onOpen={open} />
              {o.docs.length > 1 ? <p className="text-xs text-muted-foreground">Pays {o.docs.length} invoices together, this one included.</p> : null}
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" disabled={busy} onClick={() => run(() => applyPaymentProof(o.proof.id, o.ids))} className={actionCls}>
                  {busy ? 'Applying…' : 'Mark paid by this proof'}
                </button>
                <span className={cn('text-xs', o.confidence === 'firm' ? 'text-emerald-700' : 'text-amber-700')}>{describe(o.reasons)}</span>
              </div>
            </div>
          ))}
        </div>
      </Frame>
    );
  }

  // --- a payment proof -------------------------------------------------------------
  if (info.kind !== 'proof') return null;
  const proofCents = cents(doc.total);

  if (info.applied?.length) {
    return (
      <Frame
        done
        title={`Pays ${info.applied.length} invoice${info.applied.length === 1 ? '' : 's'}`}
        note="A payment proof is not published to Xero. It marks the invoices it pays as paid, so they are not paid a second time."
        error={error}
      >
        <div className="space-y-2">
          {info.applied.map((row) => <InvoiceRow key={row.id} row={row} onOpen={open} />)}
          <p className="pt-1 text-xs text-muted-foreground">
            {info.auto ? 'Matched automatically — only one set of this payee’s invoices adds up to the payment exactly.' : 'Matched by hand.'}
          </p>
          <button type="button" disabled={busy} onClick={() => run(() => unapplyPaymentProof(doc.id))} className={linkCls}>
            Undo — these invoices are not paid by this
          </button>
        </div>
      </Frame>
    );
  }

  const matches = info.matches || [];
  const candidates = info.candidates || [];
  const toggle = (id) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Frame
      title={matches.length ? 'Invoices this pays' : 'No invoice matched yet'}
      note={
        matches.length
          ? 'A payment proof is not published to Xero. Apply the invoices it pays to mark them paid.'
          : `Nothing unpaid in the book from this payee adds up to ${money(doc.currency, doc.total)}. It matches itself when the invoice arrives — or pick the invoices it pays below.`
      }
      error={error}
    >
      <div className="space-y-4">
        {matches.map((m, i) => (
          <div key={m.ids.join('|')} className={cn('space-y-2', i > 0 && 'border-t pt-3')}>
            {m.docs.map((row) => <InvoiceRow key={row.id} row={row} onOpen={open} />)}
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <button type="button" disabled={busy} onClick={() => run(() => applyPaymentProof(doc.id, m.ids))} className={actionCls}>
                {busy ? 'Applying…' : m.docs.length > 1 ? `Mark these ${m.docs.length} paid` : 'Mark paid'}
              </button>
              <span className={cn('text-xs', m.confidence === 'firm' ? 'text-emerald-700' : 'text-amber-700')}>{describe(m.reasons)}</span>
            </div>
          </div>
        ))}

        {candidates.length > 0 && (
          <div className={cn(matches.length > 0 && 'border-t pt-3')}>
            {!picking ? (
              <button type="button" onClick={() => setPicking(true)} className="text-sm underline-offset-2 hover:underline">
                Pick the invoices by hand
              </button>
            ) : (
              <div className="space-y-2">
                <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
                  {candidates.map((row) => (
                    <label key={row.id} className="flex items-start gap-2">
                      <input type="checkbox" className="mt-1 h-4 w-4 accent-black" checked={picked.has(row.id)} onChange={() => toggle(row.id)} />
                      <div className="min-w-0 flex-1">
                        <InvoiceRow row={row} onOpen={open} />
                      </div>
                    </label>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-3 pt-1">
                  <button
                    type="button"
                    disabled={busy || !picked.size || pickedTotal !== proofCents}
                    onClick={() => run(() => applyPaymentProof(doc.id, [...picked]))}
                    className={actionCls}
                  >
                    {picked.size ? `Mark ${picked.size} paid` : 'Mark paid'}
                  </button>
                  <span className={cn('text-xs tabular-nums', picked.size && pickedTotal === proofCents ? 'text-emerald-700' : 'text-muted-foreground')}>
                    {money(doc.currency, pickedTotal / 100)} of {money(doc.currency, doc.total)}
                    {picked.size && pickedTotal !== proofCents ? ' — must add up exactly' : ''}
                  </span>
                  <button type="button" onClick={() => { setPicking(false); setPicked(new Set()); }} className={linkCls}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Frame>
  );
}
