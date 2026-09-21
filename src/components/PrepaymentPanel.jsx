import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, HandCoins, Info } from 'lucide-react';
import { applyPrepayment, fetchXeroPaymentMethods, recordPrepayment, resolveCategorisationOrgId, undoPrepayment } from '@/lib/organisations';
import { costPath, notifyBillsChanged } from '@/lib/bills';
import { isAdvanceDocument, prepaymentCandidates, prepaymentRemainingCents } from '@/lib/prepayment';
import { formatDate } from '@/lib/date';
import { cn } from '@/lib/utils';

// A quotation or pro-forma paid in advance, and the invoice that uses it up —
// on the document page, from either side (src/lib/prepayment.js has the rules).
//
// On a QUOTATION: record it in Xero as a prepayment (an overpayment to the
// supplier) from the bank account it was paid out of, or — once recorded — what
// is left of it, the invoices it has been applied to, and Undo while none has.
// On an INVOICE: the prepayments it used, else the one it will use when
// published (a firm match, applied by itself), else the ones it could use, with
// Apply once the bill is in Xero. Renders nothing for anything else.

const money = (currency, n) => `${currency ? `${currency} ` : ''}${(Number(n) || 0).toFixed(2)}`;
const toIso = (v) => {
  const s = String(v ?? '');
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
};
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const actionCls =
  'inline-flex h-9 items-center rounded-md border-2 border-foreground px-4 text-sm font-semibold transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50';
const linkCls = 'text-sm text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50';
const inputCls = 'h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';

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
          {done ? <Check className="h-5 w-5" /> : <HandCoins className="h-5 w-5" strokeWidth={1.75} />}
          {title}
        </div>
        {children}
        {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
      </div>
    </div>
  );
}

export default function PrepaymentPanel({ doc, book, mayPublish, onChanged }) {
  const navigate = useNavigate();
  const [orgId, setOrgId] = useState('');
  const [banks, setBanks] = useState(null);
  const [bank, setBank] = useState('');
  const [date, setDate] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const advance = isAdvanceDocument(doc?.type);
  const recorded = Boolean(doc?.prepayment?.overpaymentId);
  const applied = Array.isArray(doc?.prepaymentsApplied) ? doc.prepaymentsApplied : [];
  const candidates = useMemo(
    () => (!advance && doc && !applied.length ? prepaymentCandidates(doc, book || []) : []),
    [advance, doc, applied.length, book]
  );
  const needsXero = (advance && !recorded) || (!advance && candidates.length > 0);

  useEffect(() => {
    setError('');
    setAmount(doc?.total ? String(doc.total) : '');
    setDate(toIso(doc?.date) || todayIso());
  }, [doc?.id, doc?.total, doc?.date]);

  useEffect(() => {
    if (!needsXero || orgId) return;
    let alive = true;
    resolveCategorisationOrgId().then((id) => alive && setOrgId(id || ''));
    return () => { alive = false; };
  }, [needsXero, orgId]);

  useEffect(() => {
    if (!advance || recorded || !orgId || banks) return;
    let alive = true;
    fetchXeroPaymentMethods(orgId)
      .then((list) => {
        if (!alive) return;
        const only = (list || []).filter((m) => String(m.type).toUpperCase() === 'BANK' && m.code);
        setBanks(only);
        // The bank account it says it was paid from, if one is named.
        const named = only.find((m) => m.label === doc?.paymentMethod || m.name === doc?.paymentMethod);
        setBank((named || only[0])?.code || '');
      })
      .catch(() => alive && setBanks([]));
    return () => { alive = false; };
  }, [advance, recorded, orgId, banks, doc?.paymentMethod]);

  if (!doc?.persisted) return null;
  if (!advance && !applied.length && !candidates.length) return null;

  const run = async (key, fn) => {
    setBusy(key);
    setError('');
    try {
      const out = await fn();
      notifyBillsChanged();
      await onChanged?.(out?.bill ?? null);
    } catch (err) {
      setError(err?.message || 'Something went wrong.');
    } finally {
      setBusy('');
    }
  };

  // ── A quotation / pro-forma ───────────────────────────────────────────────
  if (advance) {
    const p = doc.prepayment;
    if (recorded) {
      const remaining = prepaymentRemainingCents(doc) / 100;
      const allocs = Array.isArray(p.allocations) ? p.allocations : [];
      return (
        <Frame
          done
          title={`Prepaid ${money(p.currency, p.amount)}`}
          note={
            remaining > 0.004
              ? `Held in Xero as an overpayment to ${doc.supplier || 'the supplier'}. The tax invoice that follows — quoting ${p.reference || 'this quotation'}, or the next one from this supplier — uses it up when it is published.`
              : 'Used up in full against the invoices below.'
          }
          error={error}
        >
          <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
            <dt className="text-muted-foreground">Paid</dt>
            <dd>{formatDate(p.date)} from {p.bankAccount?.name || p.bankAccount?.code || 'the bank'}</dd>
            <dt className="text-muted-foreground">Reference</dt>
            <dd>{p.reference || '—'}</dd>
            <dt className="text-muted-foreground">Left to apply</dt>
            <dd>{money(p.currency, remaining)}</dd>
          </dl>
          {allocs.length ? (
            <div className="mt-3 space-y-1 border-t pt-3 text-sm">
              {allocs.map((a) => (
                <div key={`${a.billId}-${a.at}`} className="flex items-center justify-between gap-3">
                  <button type="button" onClick={() => navigate(costPath({ id: a.billId, displayId: a.displayId }))} className="hover:underline">
                    Applied to invoice {a.displayId || a.billId}
                  </button>
                  <span className="text-muted-foreground">
                    {money(p.currency, a.amount)} · {formatDate(a.date)}{a.auto ? ' · automatic' : ''}
                  </span>
                </div>
              ))}
            </div>
          ) : mayPublish ? (
            <div className="mt-3">
              <button
                type="button"
                className={linkCls}
                disabled={Boolean(busy)}
                onClick={() => {
                  if (!window.confirm('Take this prepayment back out of Xero? The overpayment is deleted there and the document returns to the inbox.')) return;
                  run('undo', async () => undoPrepayment(await resolveCategorisationOrgId(), doc.id));
                }}
              >
                {busy === 'undo' ? 'Removing…' : 'Undo — remove the prepayment from Xero'}
              </button>
            </div>
          ) : null}
        </Frame>
      );
    }

    if (doc.xeroInvoiceId) return null; // published as a bill before this existed
    const supplierMissing = !doc.supplier || String(doc.supplier).toLowerCase() === 'unknown supplier';
    return (
      <Frame
        title="Paid in advance?"
        note="A quotation or pro-forma is not a tax invoice, so it is not published as a bill. Once it is paid, record the payment here: it goes to Xero as a prepayment to the supplier, and the tax invoice that follows uses it up when it is published."
        error={error}
      >
        {!mayPublish ? (
          <p className="text-sm text-muted-foreground">Somebody who can publish to Xero records the prepayment.</p>
        ) : (
          <div className="space-y-3">
            <label className="grid grid-cols-[8rem_1fr] items-center gap-3 text-sm">
              <span className="text-muted-foreground">Paid from</span>
              <select value={bank} onChange={(e) => setBank(e.target.value)} className={inputCls} disabled={!banks?.length}>
                {banks === null ? <option>Loading bank accounts…</option> : null}
                {banks && !banks.length ? <option value="">No bank accounts in Xero</option> : null}
                {(banks || []).map((m) => (
                  <option key={m.code} value={m.code}>{m.label}</option>
                ))}
              </select>
            </label>
            <label className="grid grid-cols-[8rem_1fr] items-center gap-3 text-sm">
              <span className="text-muted-foreground">Date paid</span>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
            </label>
            <label className="grid grid-cols-[8rem_1fr] items-center gap-3 text-sm">
              <span className="text-muted-foreground">Amount paid ({doc.currency || 'SGD'})</span>
              <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" className={inputCls} />
            </label>
            <div className="flex items-center gap-3">
              <button
                type="button"
                className={actionCls}
                disabled={Boolean(busy) || !bank || !orgId || supplierMissing}
                title={supplierMissing ? 'Name the supplier first' : ''}
                onClick={() => {
                  const name = (banks || []).find((m) => m.code === bank)?.label || '';
                  if (!window.confirm(`Record ${money(doc.currency, amount)} paid to ${doc.supplier} from ${name || 'this bank account'} on ${date} as a prepayment in Xero?`)) return;
                  run('record', () => recordPrepayment(orgId, { billId: doc.id, bankAccountCode: bank, bankAccountName: name, date, amount }));
                }}
              >
                {busy === 'record' ? 'Recording…' : 'Record prepayment in Xero'}
              </button>
              {supplierMissing ? <span className="text-xs text-muted-foreground">Name the supplier first.</span> : null}
            </div>
          </div>
        )}
      </Frame>
    );
  }

  // ── An invoice ────────────────────────────────────────────────────────────
  if (applied.length) {
    return (
      <Frame done title="Prepayment applied" error={error}>
        <div className="space-y-1 text-sm">
          {applied.map((a) => (
            <div key={`${a.fromId}-${a.at}`} className="flex items-center justify-between gap-3">
              <button type="button" onClick={() => navigate(costPath({ id: a.fromId, displayId: a.fromDisplayId }))} className="hover:underline">
                {a.reference ? `Quotation ${a.reference}` : `Quotation ${a.fromDisplayId || a.fromId}`}
              </button>
              <span className="text-muted-foreground">
                {money(doc.currency, a.amount)} · {formatDate(a.date)}{a.auto ? ' · automatic' : ''}
              </span>
            </div>
          ))}
        </div>
      </Frame>
    );
  }

  const published = Boolean(doc.xeroInvoiceId) && String(doc.xeroDocType || 'ACCPAY') === 'ACCPAY';
  const settled = ['PAID', 'VOIDED', 'DELETED'].includes(String(doc.xeroStatus || '').toUpperCase());
  const firm = candidates.filter((c) => c.firm);
  const onlyFirm = firm.length === 1 ? firm[0] : null;
  return (
    <Frame
      title={onlyFirm && !published ? 'Prepayment will be applied' : 'Prepayment found'}
      note={
        onlyFirm && !published
          ? `This invoice follows ${onlyFirm.reference ? `quotation ${onlyFirm.reference}` : 'a quotation'}, paid in advance. Publishing it posts the bill Approved and applies the prepayment to it.`
          : published
            ? 'A quotation from this supplier was paid in advance. Apply it to this bill if it was paid towards this invoice.'
            : 'A quotation from this supplier was paid in advance. Publish this invoice, then apply the prepayment if it was paid towards it.'
      }
      error={error}
    >
      <div className="space-y-2 text-sm">
        {candidates.map((c) => (
          <div key={c.doc.id} className="flex flex-wrap items-center justify-between gap-3">
            <button type="button" onClick={() => navigate(costPath(c.doc))} className="min-w-0 text-left hover:underline">
              <span className="font-medium">{c.reference ? `Quotation ${c.reference}` : 'Quotation'}</span>
              <span className="text-muted-foreground">
                {' '}· {money(c.doc.prepayment.currency, c.remainingCents / 100)} left · paid {formatDate(c.doc.prepayment.date)}
                {' · '}{c.tie === 'reference' ? 'Quoted on this invoice' : 'Same supplier'}
              </span>
            </button>
            {published && !settled && mayPublish ? (
              <button
                type="button"
                className={actionCls}
                disabled={Boolean(busy)}
                onClick={() => run(`apply-${c.doc.id}`, async () => applyPrepayment(await resolveCategorisationOrgId(), doc.id, c.doc.id))}
              >
                {busy === `apply-${c.doc.id}` ? 'Applying…' : `Apply ${money(c.doc.prepayment.currency, c.amountCents / 100)}`}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </Frame>
  );
}
