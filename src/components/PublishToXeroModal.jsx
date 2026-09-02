import { useCallback, useEffect, useMemo, useState } from 'react';
import { X, ChevronDown, CheckCircle2 } from 'lucide-react';
import {
  useOrganisations,
  getActiveOrganisationId,
  fetchXeroAccounts,
  fetchXeroTaxRates,
  publishBillToXero,
  updateBillInXero,
} from '@/lib/organisations';
import { lineItemsPostable } from '@/lib/bills';
import { useGstRegistered } from '@/lib/businessProfile';
import { useExtractionSettings, PUBLISH_STATUSES } from '@/lib/extractionSettings';
import { accountCodeFromCategory } from '@/data/xeroAccounts';
import ComboSelect from '@/components/ComboSelect';

// "Publish to Xero" dialog — posts a stored cost document to the linked Xero
// organisation as a supplier bill (ACCPAY), through the cyworkspace relay.
// The caller passes the persisted bill's id plus the on-screen field values
// (supplier/total/date may have unsaved edits — the server posts the SAVED
// bill, so the parent saves before opening this dialog).
// One dialog, two errands. `mode` is 'publish' for a document that has never
// reached Xero, and 'update' for one whose bill is already there and whose
// figures have since been corrected here. They ask the same questions — account
// code, tax code, date — and the difference is only whether the answer creates a
// bill or restates one, so a second dialog would be the same form twice, drifting.
export default function PublishToXeroModal({ open, onClose, bill, onPublished, mode = 'publish' }) {
  const updating = mode === 'update';
  const { data: organisations = [] } = useOrganisations();
  const [organisationId, setOrganisationId] = useState('');
  const [accounts, setAccounts] = useState(null); // null = loading
  const [taxRates, setTaxRates] = useState(null);
  const [accountCode, setAccountCode] = useState('');
  const [taxType, setTaxType] = useState('');
  // The entity's own answer to "post as what?" — see publishStatus in
  // extractionSettings.js. Read live rather than captured, so a change to the
  // setting reaches the next dialog that opens.
  const publishStatus = useExtractionSettings().publishStatus || 'AUTHORISED';
  const [status, setStatus] = useState(publishStatus);
  const [dueDate, setDueDate] = useState('');
  const [error, setError] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [done, setDone] = useState(null); // { invoiceNumber, status }
  const [postedLines, setPostedLines] = useState(0); // how many lines actually went up
  // Whether the document's own file made it onto the Xero bill. Reported rather
  // than swallowed: a bill in the ledger without its paper is worth knowing
  // about at the moment it happens, not weeks later in an audit.
  const [attachment, setAttachment] = useState(null);
  // Whether the posted lines were marked billable to the customer (Xero's
  // billable expense). Null when the document wasn't marked rebillable.
  const [rebilled, setRebilled] = useState(null);
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
    // Updating starts at "leave it alone": the bill already has a status, and
    // somebody fixing an account code has not asked to move it through the
    // approval workflow as a side effect.
    setStatus(mode === 'update' ? '' : publishStatus);
    // Shows the invoice date, because that is what will post: the due date
    // follows the date actually sent to Xero, so a date shifted for a locked
    // period can't leave the due date sitting before the bill. Change it here to
    // post something else.
    setDueDate(/^\d{4}-\d{2}-\d{2}$/.test(bill?.date ?? '') ? bill.date : '');
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
  // the full chart available below for the odd asset/other posting.
  const accountCodes = useMemo(() => {
    const list = accounts ?? [];
    const isExpense = (a) => ['EXPENSE', 'OVERHEADS', 'DIRECTCOSTS'].includes(a.type);
    return [...list.filter(isExpense), ...list.filter((a) => !isExpense(a))].map((a) => a.code);
  }, [accounts]);

  // Non-GST orgs only ever post No Tax, so that's the whole list for them.
  const taxTypes = useMemo(
    () =>
      (taxRates ?? [])
        .filter((t) => gstRegistered || t.taxType === 'NONE' || /^no tax$/i.test(t.name))
        .map((t) => t.taxType),
    [taxRates, gstRegistered]
  );

  const taxRateLabel = useCallback(
    (type) => {
      const t = (taxRates ?? []).find((x) => x.taxType === type);
      return t ? `${t.name} (${t.rate}%)` : String(type ?? '');
    },
    [taxRates]
  );

  const accountLabel = useCallback(
    (code) => {
      const a = (accounts ?? []).find((x) => x.code === code);
      return a ? `${a.code} — ${a.name}` : String(code ?? '');
    },
    [accounts]
  );

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

  // What the document's own line items will do on the way up — the server posts
  // them as the bill's lines when they are provably the same money as the
  // document, and one summary line when they aren't. Said here, before the
  // button, because losing a breakdown you can see on screen is a bad surprise.
  const lines = lineItemsPostable(bill?.lineItems, bill?.total, bill?.tax);
  const money = (v) => `${bill?.currency || ''} ${(Number(String(v ?? '').replace(/[^0-9.-]/g, '')) || 0).toFixed(2)}`.trim();

  const loadingRefs = organisationId && (accounts === null || taxRates === null);
  // Line items that contradict the document block the publish outright — the
  // server refuses it too (see perLineItems in server/src/xero.ts); this is so
  // the button says why instead of the request failing after the click.
  // The same completeness the server requires, and the same bulk publish skips
  // on — stated here so the button says what is missing before the click, rather
  // than the request failing after it.
  const missing = (() => {
    const out = [];
    const txt = (v) => String(v ?? '').trim();
    if (!txt(bill?.supplier) || txt(bill?.supplier).toLowerCase() === 'unknown supplier') out.push('a supplier');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(txt(bill?.date))) out.push('a date');
    if (!txt(bill?.category) || txt(bill?.category).toLowerCase() === 'uncategorised') out.push('a category');
    if (!(Number(String(bill?.total ?? '').replace(/[^0-9.-]/g, '')) > 0)) out.push('a total above 0');
    return out;
  })();
  const hasDate = missing.length === 0;
  const canPublish = Boolean(
    organisationId && accountCode && taxType && hasDate && !publishing && !done && (lines.rows === 0 || lines.postable)
  );
  const organisation = organisations.find((o) => o.id === organisationId);

  const publish = async () => {
    setPublishing(true);
    setError('');
    try {
      const send = updating ? updateBillInXero : publishBillToXero;
      const result = await send(organisationId, {
        billId: bill.id,
        accountCode,
        taxType,
        // Updating: only send a status when the reviewer picked one, so
        // correcting an approved bill's coding can't knock it back to draft.
        status: updating && !status ? undefined : status,
        dueDate: dueDate || undefined,
      });
      setDone(result.invoice);
      setPostedLines(Number(result.lines) || 0);
      setAttachment(result.attachment ?? null);
      setRebilled(result.rebilled ?? null);
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
          <h2 className="text-base font-semibold tracking-tight">{updating ? 'Update the bill in Xero' : 'Publish to Xero'}</h2>
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
              {updating ? 'Updated in ' : 'Posted to '}
              <span className="font-medium">{organisation?.tenantName || 'Xero'}</span>
              {updating ? '' : ` as a ${done.status === 'DRAFT' ? 'draft ' : ''}bill`}
              {done.invoiceNumber ? ` (${done.invoiceNumber})` : ''}
              {postedLines > 1 ? `, as ${postedLines} line items` : ''}.
            </p>
            {attachment?.ok && (
              <p className="text-xs text-muted-foreground">The document is attached to it under Related Files.</p>
            )}
            {/* A cost meant to be recharged and silently not marked is money
                nobody bills for, so it is said either way. */}
            {rebilled?.ok && (
              <p className="max-w-sm text-xs text-muted-foreground">
                Billed back to the customer: {rebilled.linked} line{rebilled.linked === 1 ? '' : 's'} marked as a
                billable expense in Xero, ready for their next invoice.
              </p>
            )}
            {rebilled && !rebilled.ok && (
              <p className="max-w-sm text-xs text-amber-700">
                The bill posted, but it could not be marked billable to the customer: {rebilled.error} Assign it by
                hand in Xero with “Assign expenses to a customer”.
              </p>
            )}
            {attachment && !attachment.ok && (
              <p className="max-w-sm text-xs text-amber-700">
                The bill posted, but its file could not be attached: {attachment.error} You can retry with
                “Send file to Xero” on the document, or attach it by hand in Xero.
              </p>
            )}
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
                {updating ? 'Sends ' : 'Posts '}
                <span className="font-medium text-foreground">{bill?.supplier || 'this document'}</span>
                {bill?.total ? ` · ${bill.currency || ''} ${bill.total}` : ''}
                {updating ? ' to the bill it already created in Xero, replacing what is there.' : ' as a supplier bill.'}
              </p>
              {/* The paper names somebody else. Said again HERE because this is
                  the irreversible half: a bill published into the wrong client's
                  ledger claims that client's input tax on a supply made to
                  another company, and the fix afterwards is a void. */}
              {bill?.entityCheck?.status === 'mismatch' && (
                <p className="rounded-md border border-amber-600/40 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  This document is billed to{' '}
                  <span className="font-medium">{bill.entityCheck.billedTo || 'another company'}</span>, not to this
                  entity. Check it is filed under the right client before it goes into this ledger.
                </p>
              )}
              {updating && (
                <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  Xero decides what may still change: a bill that has been paid or voided refuses an
                  update, and says so.
                </p>
              )}

              {lines.rows > 0 &&
                (lines.postable ? (
                  <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    As <span className="font-medium text-foreground">{lines.rows} line items</span>, each with its own
                    account{lines.hasProjects ? ' and project' : ''} — they add up to the document&rsquo;s total.
                  </p>
                ) : (
                  <p className="rounded-md border border-amber-600/30 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    {lines.reason === 'tax' ? (
                      <>
                        <span className="font-medium">Can&rsquo;t publish yet.</span> The {lines.rows} line items carry{' '}
                        {money(lines.linesTax)} of tax, but this document&rsquo;s tax is {money(bill?.tax)}. Fix the Tax
                        column on the document first.
                      </>
                    ) : (
                      <>
                        <span className="font-medium">Can&rsquo;t publish yet.</span> The {lines.rows} line items add up
                        to {money(lines.linesTotal)}, not {money(bill?.total)} — out by{' '}
                        {money(Math.abs(lines.outBy))}. Fix the lines (or the document&rsquo;s total) first, so the bill
                        in Xero adds up to the same money as the paper.
                      </>
                    )}
                  </p>
                ))}

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
                      <ComboSelect
                        aria-label="Account"
                        value={accountCode}
                        options={accountCodes}
                        onChange={pickAccount}
                        format={accountLabel}
                        disabled={Boolean(loadingRefs)}
                        emptyLabel={loadingRefs ? 'Loading accounts…' : 'Select an account'}
                        placeholder="Type a code or name…"
                      />
                    </div>
                  </label>

                  <label className="flex items-center gap-3 text-sm">
                    <span className="w-28 shrink-0 text-muted-foreground">Tax rate</span>
                    <div className="relative flex-1">
                      <ComboSelect
                        aria-label="Tax rate"
                        value={taxType}
                        options={taxTypes}
                        onChange={setTaxType}
                        format={taxRateLabel}
                        disabled={Boolean(loadingRefs)}
                        emptyLabel={loadingRefs ? 'Loading tax rates…' : 'Select a tax rate'}
                        placeholder="Type a rate name…"
                      />
                    </div>
                  </label>

                  <label className="flex items-center gap-3 text-sm">
                    <span className="w-28 shrink-0 text-muted-foreground">Due date</span>
                    <input
                      type="date"
                      value={dueDate}
                      onChange={(e) => setDueDate(e.target.value)}
                      title="Defaults to the invoice date, so the pair stays together if the date shifts for a locked period"
                      className="h-9 flex-1 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  </label>

                  <label className="flex items-center gap-3 text-sm">
                    <span className="w-28 shrink-0 text-muted-foreground">{updating ? 'Status' : 'Post as'}</span>
                    <div className="relative flex-1">
                      <select value={status} onChange={(e) => setStatus(e.target.value)} className={selectClass}>
                        {updating && <option value="">Leave as it is</option>}
                        {PUBLISH_STATUSES.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    </div>
                  </label>
                </>
              )}

              {/* Same voice as the line-items block above: say what is wrong and
                  where to fix it, rather than greying the button out silently. */}
              {missing.length > 0 && (
                <p className="rounded-md border border-amber-600/30 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  <span className="font-medium">Can&rsquo;t publish yet.</span> This document still needs{' '}
                  {missing.join(', ')}. Fill it in on the document first — a bill goes into a live ledger, and a
                  missing date would land it in whatever period today falls in.
                </p>
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
                {publishing ? (updating ? 'Sending…' : 'Publishing…') : updating ? 'Send update' : 'Publish'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
