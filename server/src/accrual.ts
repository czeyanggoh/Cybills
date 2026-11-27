import { getBillById, parseAmount, setBillAccrual, type Bill } from './store.js';
import { cashModeFor } from './cashMode.js';
import { attachBillFileTo, relay, accountsForOrg, xeroInvoiceUrl } from './xero.js';

// The OPENING ENTRY for a contract paid off in later invoices: the asset taken
// up against the amount accrued.
//
// A renovation quotation lists what is being bought; the asset goes on the
// balance sheet then, and each progress invoice that follows is coded to the
// accrual (Dr accrued expenses, Cr trade payable) by its billing plan. Cze, 27
// Nov 2026: it is posted as a BILL of 0.00 — the asset lines positive, the
// accrued expense line the same figure negative — so no manual journal is
// needed, and a bill line on a fixed asset account is what Xero drafts an asset
// from.
//
// It is not the document being published: `xeroInvoiceId` stays empty, the
// record is its own (`Bill.accrual`), and publishing or moving the document is
// refused while it stands.

type Org = { id: string; tenantId: string; name?: string };
type Out = { status: number; body: any };

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const cents = (v: unknown) => Math.round(parseAmount(v as never) * 100);
const ASSET_TYPES = new Set(['FIXED', 'NONCURRENT', 'CURRENT', 'PREPAYMENT', 'INVENTORY']);
const LIABILITY_TYPES = new Set(['CURRLIAB', 'LIABILITY', 'TERMLIAB']);
const SOURCE_TYPE = /^(quotation|quote|pro.?forma( invoice)?|other)$/i;

const fail = (status: number, error: string, message: string): Out => ({ status, body: { error, message } });
const xeroErrors = (record: any): string[] =>
  (record?.ValidationErrors ?? []).map((e: any) => String(e?.Message ?? e)).filter(Boolean);

export async function recordAccrual(
  organisation: Org,
  ws: string,
  scope: string,
  bill: Bill,
  opts: {
    date?: unknown;
    accrualAccountCode?: unknown;
    lines?: unknown;
    by: string;
    // This document's page, for Xero's "Go to CYBills" button.
    url?: string;
  }
): Promise<Out> {
  if (cashModeFor(organisation.id)) {
    return fail(409, 'cash_mode', 'This entity is in cash mode, so there are no bills to record an accrual with.');
  }
  if ((bill.kind || 'cost') !== 'cost' || !SOURCE_TYPE.test(String(bill.documentType ?? '').trim())) {
    return fail(422, 'not_a_quotation', 'Only a quotation, pro-forma invoice or agreement takes up an asset and accrual. Set the document’s Type first.');
  }
  if (bill.accrual?.invoiceId) return fail(409, 'already_recorded', 'The asset and accrual are already recorded in Xero for this document.');
  if (bill.xeroInvoiceId || bill.paperworkMatch) return fail(409, 'already_posted', 'This document is already in Xero.');
  if (['processing', 'expenseclaim', 'merged', 'deleted'].includes(String(bill.status ?? ''))) {
    return fail(409, 'not_available', 'This document is still being read, or its money is accounted for elsewhere.');
  }
  const supplier = String(bill.supplier ?? '').trim();
  if (!supplier || supplier.toLowerCase() === 'unknown supplier') return fail(400, 'no_supplier', 'Name the supplier first.');
  const date = String(opts.date ?? '');
  if (!ISO.test(date)) return fail(400, 'no_date', 'Choose the date of the entry.');

  const rows = (Array.isArray(opts.lines) ? opts.lines : []).map((raw) => {
    const l = (raw ?? {}) as Record<string, unknown>;
    return {
      accountCode: String(l.accountCode ?? '').trim(),
      description: String(l.description ?? '').trim().slice(0, 4000),
      cents: cents(l.amount),
    };
  });
  if (!rows.length || rows.length > 100) return fail(400, 'no_lines', 'Add at least one asset line (100 at most).');
  if (rows.some((r) => !(r.cents > 0))) return fail(400, 'no_amount', 'Every asset line needs an amount above 0.');
  const total = rows.reduce((s, r) => s + r.cents, 0);
  const quoted = cents(bill.total);
  if (quoted > 0 && total > quoted) {
    return fail(400, 'amount_too_large', `The asset lines (${(total / 100).toFixed(2)}) come to more than the document’s total (${(quoted / 100).toFixed(2)}).`);
  }

  const chart = await accountsForOrg(ws, organisation.id);
  if (!chart.length) return fail(502, 'no_chart', 'The chart of accounts could not be read from Xero. Try again.');
  const find = (code: string) => chart.find((a) => a.code === code && !a.systemAccount);
  for (const r of rows) {
    const account = find(r.accountCode);
    if (!account || !ASSET_TYPES.has(account.type.toUpperCase())) {
      return fail(422, 'not_an_asset', `"${r.accountCode || 'blank'}" is not an asset account in this Xero.`);
    }
  }
  const accrualCode = String(opts.accrualAccountCode ?? '').trim();
  const accrual = find(accrualCode);
  if (!accrual || !LIABILITY_TYPES.has(accrual.type.toUpperCase())) {
    return fail(422, 'not_a_liability', `"${accrualCode || 'blank'}" is not a liability account in this Xero.`);
  }

  const reference = String(bill.invoiceNumber ?? '').trim() || String(bill.displayId ?? bill.id);
  const line = (code: string, description: string, amount: number) => ({
    Description: description,
    Quantity: 1,
    UnitAmount: amount / 100,
    AccountCode: code,
    TaxType: 'NONE',
  });
  const invoice: Record<string, unknown> = {
    Type: 'ACCPAY',
    Contact: { Name: supplier },
    Date: date,
    DueDate: date,
    Status: 'AUTHORISED',
    // Named apart from the quotation's number, which the real invoices may quote.
    InvoiceNumber: `${reference} accrual`.slice(0, 255),
    LineAmountTypes: 'NoTax',
    LineItems: [
      ...rows.map((r) => line(r.accountCode, r.description || `Asset per ${reference}`, r.cents)),
      line(accrual.code, `Accrued per ${reference}`, -total),
    ],
  };
  const currency = String(bill.currency ?? '').trim().toUpperCase();
  if (currency) invoice.CurrencyCode = currency;
  const url = xeroInvoiceUrl(String(opts.url ?? ''));
  if (url) invoice.Url = url;

  const result = await relay('Invoices', {
    method: 'PUT',
    tenantId: organisation.tenantId,
    query: { summarizeErrors: 'false' },
    body: { Invoices: [invoice] },
  });
  const record = result.ok ? result.data?.Invoices?.[0] : null;
  const errors = xeroErrors(record);
  const invoiceId = String(record?.InvoiceID ?? '');
  if (!result.ok || !record || record.HasErrors || errors.length || !invoiceId) {
    return fail(
      result.ok ? 422 : result.status >= 500 ? 502 : result.status,
      result.ok ? 'xero_validation_failed' : String(result.error),
      errors.length ? errors.join(' ') : result.ok ? 'Xero did not create the bill.' : String(result.message)
    );
  }
  setBillAccrual(scope, bill.id, {
    invoiceId,
    amount: total / 100,
    currency,
    date,
    accrualAccount: { code: accrual.code, name: accrual.name },
    lines: rows.map((r) => ({ accountCode: r.accountCode, description: r.description, amount: r.cents / 100 })),
    recordedAt: new Date().toISOString(),
    recordedBy: opts.by,
  });
  // The quotation on the bill: what the asset was taken up from. Best-effort,
  // and reported, like any bill's attachment.
  const attachment = await attachBillFileTo(organisation.tenantId, 'Invoices', invoiceId, bill);
  return { status: 200, body: { ok: true, invoiceId, attachment, bill: getBillById(scope, bill.id) } };
}

/** Void the zero bill and forget it — or only forget it, where Xero already has. */
export async function undoAccrual(organisation: Org, scope: string, bill: Bill): Promise<Out> {
  const a = bill.accrual;
  if (!a?.invoiceId) return fail(409, 'not_recorded', 'This document has no accrual recorded.');
  const path = `Invoices/${encodeURIComponent(a.invoiceId)}`;
  const gone = (s: unknown) => ['VOIDED', 'DELETED'].includes(String(s ?? '').toUpperCase());
  const read = await relay(path, { method: 'GET', tenantId: organisation.tenantId });
  if (!read.ok) return fail(read.status >= 500 ? 502 : read.status, String(read.error), String(read.message));
  if (!gone(read.data?.Invoices?.[0]?.Status)) {
    const result = await relay(path, {
      method: 'POST',
      tenantId: organisation.tenantId,
      query: { summarizeErrors: 'false' },
      body: { Invoices: [{ InvoiceID: a.invoiceId, Status: 'VOIDED' }] },
    });
    const record = result.ok ? result.data?.Invoices?.[0] : null;
    const errors = xeroErrors(record);
    if (!result.ok || errors.length) {
      return fail(
        result.ok ? 422 : result.status >= 500 ? 502 : result.status,
        result.ok ? 'xero_validation_failed' : String(result.error),
        `${errors.length ? errors.join(' ') : String((result as any).message)} Void the bill in Xero by hand, then press Undo again.`
      );
    }
  }
  setBillAccrual(scope, bill.id, null);
  return { status: 200, body: { ok: true, bill: getBillById(scope, bill.id) } };
}
