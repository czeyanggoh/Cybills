import { useEffect, useMemo, useState } from 'react';
import { X, ChevronDown, CheckCircle2 } from 'lucide-react';
import {
  useOrganisations,
  getActiveOrganisationId,
  fetchXeroAccounts,
  fetchXeroTaxRates,
  publishBillToXero,
} from '@/lib/organisations';
import { useGstRegistered } from '@/lib/businessProfile';
import { accountCodeFromCategory } from '@/data/xeroAccounts';

// "Publish to Xero" dialog — posts a stored cost document to the linked Xero
// organisation as a supplier bill (ACCPAY), through the cyworkspace relay.
// The caller passes the persisted bill's id plus the on-screen field values
// (supplier/total/date may have unsaved edits — the server posts the SAVED
// bill, so the parent saves before opening this dialog).
export default function PublishToXeroModal({ open, onClose, bill, onPublished }) {
  const { data: organisations = [] } = useOrganisations();
  const [organisationId, setOrganisationId] = useState('');
  const [accounts, setAccounts] = useState(null); // null = loading
  const [taxRates, setTaxRates] = useState(null);
  const [accountCode, setAccountCode] = useState('');
  const [taxType, setTaxType] = useState('');
  const [status, setStatus] = useState('DRAFT');
  const [dueDate, setDueDate] = useState('');
  const [error, setError] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [done, setDone] = useState(null); // { invoiceNumber, status }
  // A company that isn't GST-registered publishes everything as No Tax, whatever
  // the bill still carries — the last gate before a stale code reaches Xero.
  const gstRegistered = useGstRegistered();

  // Reset + preselect the active organisation each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    const active = getActiveOrganisationId();
    setOrganisationId(
      organisations.some((o) => o.id === active) ? active : organisations[0]?.id ?? ''
    );
    setStatus('DRAFT');
    // Prefer the doc's computed due date (from Extraction settings), else the
    // invoice date.
    setDueDate(
      /^\d{4}-\d{2}-\d{2}$/.test(bill?.dueDate ?? '')
        ? bill.dueDate
        : /^\d{4}-\d{2}-\d{2}$/.test(bill?.date ?? '')
          ? bill.date
          : ''
    );
    setError('');
    setDone(null);
  }, [open]);

  // Load the chosen organisation's chart of accounts + tax rates.
  useEffect(() => {
    if (!open || !organisationId) return;
    let alive = true;
    setAccounts(null);
    setTaxRates(null);
    setAccountCode('');
    setTaxType('');
    setError('');
    Promise.all([fetchXeroAccounts(organisationId), fetchXeroTaxRates(organisationId)])
      .then(([acc, rates]) => {
        if (!alive) return;
        setAccounts(acc);
        setTaxRates(rates);
        // Preselect the Xero account the OCR categorised this bill into (its
        // category is a "<code> - <name>" chart-of-accounts label).
        const code = accountCodeFromCategory(bill?.category);
        const match = code ? acc.find((a) => a.code === code) : null;
        if (match) setAccountCode(match.code);
        // Tax rate: prefer the doc's own tax rate (matched by name), else fall
        // back to the selected account's default.
        const noTax = rates.find((t) => t.taxType === 'NONE' || /^no tax$/i.test(t.name));
        if (!gstRegistered) {
          setTaxType(noTax?.taxType ?? '');
          return;
        }
        const byName = bill?.taxRate ? rates.find((t) => t.name === bill.taxRate) : null;
        if (byName) setTaxType(byName.taxType);
        else if (match?.taxType && rates.some((t) => t.taxType === match.taxType)) setTaxType(match.taxType);
      })
      .catch((err) => {
        if (!alive) return;
        setAccounts([]);
        setTaxRates([]);
        setError(`Could not load this organisation's Xero settings: ${err.message}`);
      });
    return () => {
      alive = false;
    };
  }, [open, organisationId]);

  // Expense-y accounts first (that's what supplier bills code to), but keep
  // the full chart available below a divider for the odd asset/other posting.
  const groupedAccounts = useMemo(() => {
    const list = accounts ?? [];
    const isExpense = (a) => ['EXPENSE', 'OVERHEADS', 'DIRECTCOSTS'].includes(a.type);
    return { expense: list.filter(isExpense), other: list.filter((a) => !isExpense(a)) };
  }, [accounts]);

  // When an account is picked, default the tax rate to the account's own
  // default (exactly what Xero's UI does).
  const pickAccount = (code) => {
    setAccountCode(code);
    if (!gstRegistered) return; // stays No Tax
    const acc = (accounts ?? []).find((a) => a.code === code);
    if (acc?.taxType && (taxRates ?? []).some((t) => t.taxType === acc.taxType)) {
      setTaxType(acc.taxType);
    }
  };

  if (!open) return null;

  const loadingRefs = organisationId && (accounts === null || taxRates === null);
  const canPublish = Boolean(organisationId && accountCode && taxType && !publishing && !done);
  const organisation = organisations.find((o) => o.id === organisationId);

  const publish = async () => {
    setPublishing(true);
    setError('');
    try {
      const result = await publishBillToXero(organisationId, {
        billId: bill.id,
        accountCode,
        taxType,
        status,
        dueDate: dueDate || undefined,
      });
      setDone(result.invoice);
      onPublished?.(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setPublishing(false);
    }
  };

  const selectClass =
    'h-9 w-full appearance-none rounded-md border bg-background px-3 pr-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={onClose} aria-hidden="true" />
      <div className="relative flex max-h-[90vh] w-full max-w-md flex-col overflow-y-auto rounded-lg bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-base font-semibold tracking-tight">Publish to Xero</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {done ? (
          <div className="flex flex-col items-center gap-3 p-8 text-center">
            <CheckCircle2 className="h-10 w-10 text-green-600" />
            <p className="text-sm">
              Posted to <span className="font-medium">{organisation?.tenantName || 'Xero'}</span> as
              a {done.status === 'DRAFT' ? 'draft ' : ''}bill
              {done.invoiceNumber ? ` (${done.invoiceNumber})` : ''}.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-2 inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            <div className="space-y-3 p-6">
              <p className="text-sm text-muted-foreground">
                Posts <span className="font-medium text-foreground">{bill?.supplier || 'this document'}</span>
                {bill?.total ? ` · ${bill.currency || ''} ${bill.total}` : ''} as a supplier bill.
              </p>

              {organisations.length === 0 ? (
                <p className="text-sm text-destructive">
                  No organisations yet — add one from the workspace menu (top left) first.
                </p>
              ) : (
                <>
                  <label className="flex items-center gap-3 text-sm">
                    <span className="w-28 shrink-0 text-muted-foreground">Organisation</span>
                    <div className="relative flex-1">
                      <select
                        value={organisationId}
                        onChange={(e) => setOrganisationId(e.target.value)}
                        className={selectClass}
                      >
                        {organisations.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.name}
                          </option>
                        ))}
                      </select>
                      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    </div>
                  </label>

                  <label className="flex items-center gap-3 text-sm">
                    <span className="w-28 shrink-0 text-muted-foreground">Account</span>
                    <div className="relative flex-1">
                      <select
                        value={accountCode}
                        onChange={(e) => pickAccount(e.target.value)}
                        disabled={loadingRefs}
                        className={selectClass}
                      >
                        <option value="">{loadingRefs ? 'Loading accounts…' : 'Select an account'}</option>
                        {groupedAccounts.expense.map((a) => (
                          <option key={a.code} value={a.code}>
                            {a.code} — {a.name}
                          </option>
                        ))}
                        {groupedAccounts.other.length > 0 && <option disabled>──────────</option>}
                        {groupedAccounts.other.map((a) => (
                          <option key={a.code} value={a.code}>
                            {a.code} — {a.name}
                          </option>
                        ))}
                      </select>
                      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    </div>
                  </label>

                  <label className="flex items-center gap-3 text-sm">
                    <span className="w-28 shrink-0 text-muted-foreground">Tax rate</span>
                    <div className="relative flex-1">
                      <select
                        value={taxType}
                        onChange={(e) => setTaxType(e.target.value)}
                        disabled={loadingRefs}
                        className={selectClass}
                      >
                        <option value="">{loadingRefs ? 'Loading tax rates…' : 'Select a tax rate'}</option>
                        {(taxRates ?? [])
                          .filter((t) => gstRegistered || t.taxType === 'NONE' || /^no tax$/i.test(t.name))
                          .map((t) => (
                          <option key={t.taxType} value={t.taxType}>
                            {t.name} ({t.rate}%)
                          </option>
                        ))}
                      </select>
                      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    </div>
                  </label>

                  <label className="flex items-center gap-3 text-sm">
                    <span className="w-28 shrink-0 text-muted-foreground">Due date</span>
                    <input
                      type="date"
                      value={dueDate}
                      onChange={(e) => setDueDate(e.target.value)}
                      className="h-9 flex-1 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  </label>

                  <label className="flex items-center gap-3 text-sm">
                    <span className="w-28 shrink-0 text-muted-foreground">Post as</span>
                    <div className="relative flex-1">
                      <select value={status} onChange={(e) => setStatus(e.target.value)} className={selectClass}>
                        <option value="DRAFT">Draft</option>
                        <option value="SUBMITTED">Awaiting approval</option>
                        <option value="AUTHORISED">Approved (awaiting payment)</option>
                      </select>
                      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    </div>
                  </label>
                </>
              )}

              {error && <p className="text-sm text-destructive">{error}</p>}
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
                disabled={!canPublish}
                onClick={publish}
                className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {publishing ? 'Publishing…' : 'Publish'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
