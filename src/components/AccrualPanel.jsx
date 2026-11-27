import { useState } from 'react';
import { Check, ExternalLink, Landmark, Plus, Trash2, X } from 'lucide-react';
import SearchSelect from '@/components/SearchSelect';
import { fetchXeroAccounts, recordAccrual, resolveCategorisationOrgId, undoAccrual } from '@/lib/organisations';
import { accountsForAccrual, accrualLinesFrom } from '@/lib/accrual';
import { xeroBillUrl } from '@/lib/autoPublish';
import { notifyBillsChanged } from '@/lib/bills';
import { isPlanSource } from '@/lib/billingPlan';
import { formatDate } from '@/lib/date';

// On a quotation or agreement: take the asset up against the accrual, posted to
// Xero as a bill of 0.00 (server/src/accrual.ts). The later invoices are coded to
// the accrual by the supplier's billing plan.

const inputCls =
  'h-9 w-full rounded-md border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring';
const actionCls =
  'inline-flex h-9 items-center rounded-md border-2 border-foreground px-4 text-sm font-semibold transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50';
const linkCls = 'text-sm text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50';

const amountOf = (v) => Number(String(v ?? '').replace(/[^0-9.-]/g, '')) || 0;
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
let seq = 0;
const withKey = (l) => ({ ...l, key: `a${(seq += 1)}` });

export default function AccrualPanel({ doc, mayPublish, xeroShortCode = '', onBeforeRecord, onChanged }) {
  const [open, setOpen] = useState(false);
  const [orgId, setOrgId] = useState('');
  const [accounts, setAccounts] = useState({ assets: [], liabilities: [] });
  const [date, setDate] = useState('');
  const [accrualCode, setAccrualCode] = useState('');
  const [lines, setLines] = useState([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const accrual = doc?.accrual;
  if (!doc?.persisted || (doc.kind && doc.kind !== 'cost') || !isPlanSource(doc)) return null;
  if (!accrual && (!mayPublish || doc.xeroInvoiceId || doc.paperworkMatch)) return null;
  const currency = doc.currency || 'SGD';
  const total = lines.reduce((s, l) => s + Math.round(amountOf(l.amount) * 100), 0) / 100;

  const run = async (key, fn) => {
    setBusy(key);
    setError('');
    try {
      await fn();
      notifyBillsChanged();
      await onChanged?.();
      return true;
    } catch (e) {
      setError(e?.message || 'Something went wrong.');
      return false;
    } finally {
      setBusy('');
    }
  };

  const start = async () => {
    setOpen(true);
    setError('');
    setDate(todayIso());
    setLines(accrualLinesFrom(doc, { itemised: false }).map(withKey));
    try {
      const id = await resolveCategorisationOrgId();
      if (!id) throw new Error('No Xero organisation is linked.');
      setOrgId(id);
      const split = accountsForAccrual(await fetchXeroAccounts(id));
      setAccounts(split);
      setAccrualCode((c) => c || split.accrualDefault);
    } catch (e) {
      setError(e?.message || 'The accounts could not be read from Xero.');
    }
  };

  const label = (a) => `${a.code} - ${a.name}`;
  const codeIn = (list, value) => list.find((a) => label(a) === value)?.code || '';
  const shown = (list, code) => {
    const a = list.find((x) => x.code === code);
    return a ? label(a) : '';
  };
  const setLine = (key, patch) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const ready = orgId && date && accrualCode && lines.length && lines.every((l) => l.accountCode && amountOf(l.amount) > 0);
  const itemised = accrualLinesFrom(doc, { itemised: true });

  const record = async () => {
    const to = shown(accounts.liabilities, accrualCode);
    if (!window.confirm(`Post a bill of 0.00 to Xero for ${doc.supplier}: ${currency} ${total.toFixed(2)} to the asset account(s), and the same amount to ${to}?`)) return;
    const ok = await run('record', async () => {
      await onBeforeRecord?.();
      await recordAccrual(orgId, { billId: doc.id, date, accrualAccountCode: accrualCode, lines });
    });
    if (ok) setOpen(false);
  };

  return (
    <div className="rounded-lg border bg-background p-4">
      <div className="mb-2 flex items-center gap-2 text-base font-semibold">
        {accrual ? <Check className="h-5 w-5 text-emerald-700" /> : <Landmark className="h-5 w-5" strokeWidth={1.75} />}
        {accrual ? 'Asset and accrual recorded' : 'Asset and accrual'}
      </div>
      {accrual ? (
        <div className="space-y-2 text-sm">
          <p className="text-muted-foreground">
            {accrual.currency} {Number(accrual.amount).toFixed(2)} taken up on {formatDate(accrual.date)} against{' '}
            {accrual.accrualAccount?.code} - {accrual.accrualAccount?.name}, as a bill of 0.00.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <a
              href={xeroBillUrl(accrual.invoiceId, xeroShortCode)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-medium text-emerald-700 hover:underline"
            >
              Open in Xero <ExternalLink className="h-3.5 w-3.5" />
            </a>
            {mayPublish && (
              <button
                type="button"
                className={linkCls}
                disabled={Boolean(busy)}
                onClick={() => {
                  if (!window.confirm('Void this bill of 0.00 in Xero and remove the record here?')) return;
                  run('undo', async () => undoAccrual(await resolveCategorisationOrgId(), doc.id));
                }}
              >
                {busy === 'undo' ? 'Undoing…' : 'Undo'}
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Buying an asset that will be invoiced in stages? Take it up now against accrued expenses, and code the later
            invoices to that account with a billing plan.
          </p>
          <button type="button" className={actionCls} onClick={start}>Record asset and accrual</button>
        </div>
      )}
      {error && !open && <p className="mt-2 text-sm text-destructive">{error}</p>}

      {open && !accrual && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-foreground/20" onClick={() => !busy && setOpen(false)} aria-hidden="true" />
          <div className="relative flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg bg-background shadow-xl">
            <div className="flex h-14 shrink-0 items-center justify-between border-b px-6">
              <h2 className="text-base font-semibold tracking-tight">Asset and accrual: {doc.supplier}</h2>
              <button type="button" onClick={() => setOpen(false)} disabled={Boolean(busy)} className="text-muted-foreground hover:text-foreground" aria-label="Close">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="flex-1 space-y-4 overflow-auto p-6">
              <p className="rounded-md border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
                Posted to Xero as an approved bill of 0.00 with No Tax: the asset lines, less the same amount to the
                accrual. Enter amounts before GST where the GST will be claimed on the invoices that follow.
              </p>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-[11rem_1fr]">
                <label className="block text-xs text-muted-foreground">
                  <span className="mb-1 block">Date</span>
                  <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
                </label>
                <label className="block text-xs text-muted-foreground">
                  <span className="mb-1 block">Accrued to (credit)</span>
                  <SearchSelect
                    value={shown(accounts.liabilities, accrualCode)}
                    options={accounts.liabilities.map(label)}
                    placeholder="Choose the accrual account"
                    onChange={(v) => setAccrualCode(codeIn(accounts.liabilities, v))}
                  />
                </label>
              </div>

              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">Asset lines (debit)</p>
                {lines.map((l) => (
                  <div key={l.key} className="space-y-2 rounded-md bg-muted/40 p-3">
                    <div className="grid grid-cols-[1fr_9rem_auto] gap-2">
                      <input value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} placeholder="What was bought" aria-label="Asset description" className={inputCls} />
                      <input value={l.amount} onChange={(e) => setLine(l.key, { amount: e.target.value })} inputMode="decimal" placeholder="Amount" aria-label="Asset amount" className={`${inputCls} text-right tabular-nums`} />
                      <button
                        type="button"
                        onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                        disabled={lines.length === 1}
                        aria-label="Remove line"
                        title="Remove line"
                        className="inline-flex h-9 w-9 items-center justify-center rounded-md border bg-background text-muted-foreground hover:bg-muted disabled:opacity-40"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                    <SearchSelect
                      value={shown(accounts.assets, l.accountCode)}
                      options={accounts.assets.map(label)}
                      placeholder="Choose the asset account"
                      onChange={(v) => setLine(l.key, { accountCode: codeIn(accounts.assets, v) })}
                    />
                  </div>
                ))}
                <div className="flex flex-wrap items-center gap-4">
                  <button
                    type="button"
                    onClick={() => setLines((ls) => [...ls, withKey({ description: '', amount: '', accountCode: ls[ls.length - 1]?.accountCode || '' })])}
                    className="inline-flex items-center gap-1 text-sm font-medium text-emerald-600 hover:underline"
                  >
                    <Plus className="h-4 w-4" /> Add line
                  </button>
                  {itemised.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setLines((ls) => itemised.map((x) => withKey({ ...x, accountCode: ls[0]?.accountCode || '' })))}
                      className="text-sm font-medium text-emerald-600 hover:underline"
                    >
                      Use the document’s {itemised.length} items
                    </button>
                  )}
                </div>
              </div>
              <p className="text-right text-sm text-muted-foreground">
                Asset {currency} <span className="font-semibold tabular-nums text-foreground">{total.toFixed(2)}</span>, less accrual{' '}
                {total.toFixed(2)}: bill total 0.00
              </p>
              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>
            <div className="flex shrink-0 justify-end gap-2 border-t px-6 py-4">
              <button type="button" onClick={() => setOpen(false)} disabled={Boolean(busy)} className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium hover:bg-muted">Cancel</button>
              <button type="button" onClick={record} disabled={!ready || Boolean(busy)} className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
                {busy === 'record' ? 'Posting…' : 'Post to Xero'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
