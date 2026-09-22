import type { Bill } from './store.js';
import { zeroCodeName } from './jurisdiction.js';
import {
  getBillById,
  listBills,
  parseAmount,
  recordPrepaymentAllocation,
  setBillPrepayment,
  updateBill,
} from './store.js';
import { attachBillFileTo, relay } from './xero.js';

// A quotation or pro-forma PAID IN ADVANCE, and the invoice that uses it up.
//
// The quotation is recorded in Xero as an OVERPAYMENT to the supplier — a
// SPEND-OVERPAYMENT bank transaction from the account it was paid out of,
// carrying the quotation's own number as its reference — rather than published
// as a bill, which would post the same spending twice once the tax invoice
// arrives. When that invoice is published, the overpayment is ALLOCATED against
// the new bill, which is what Xero's own "apply the overpayment" does by hand.
//
// The rules (which types, which invoice uses which prepayment) are NOT written
// here: they are the pure module the document page reads too
// (src/lib/prepayment.js), loaded by path the way paymentProof.ts loads its own,
// so the page's "will be applied on publish" and what publishing actually does
// cannot disagree.

type PrepaymentRules = {
  isAdvanceDocument: (type: unknown) => boolean;
  advancePatch: (doc: unknown, noTaxName?: string) => Record<string, unknown>;
  prepaymentRemainingCents: (doc: unknown) => number;
  prepaymentCandidates: (invoice: unknown, docs: unknown[]) => Array<{
    doc: Bill;
    reference: string;
    remainingCents: number;
    amountCents: number;
    tie: 'reference' | 'supplier';
    firm: boolean;
  }>;
  firmPrepayment: (invoice: unknown, docs: unknown[]) => { doc: Bill; amountCents: number; reference: string } | null;
};

let rules: PrepaymentRules | null = null;
let tried = false;

export async function loadPrepaymentRules(): Promise<PrepaymentRules | null> {
  if (tried) return rules;
  tried = true;
  try {
    const url = new URL('../../src/lib/prepayment.js', import.meta.url).href;
    const mod = (await import(url)) as Partial<PrepaymentRules>;
    rules =
      typeof mod?.isAdvanceDocument === 'function' && typeof mod?.prepaymentCandidates === 'function'
        ? (mod as PrepaymentRules)
        : null;
  } catch (e) {
    console.error('[prepayment] rules unavailable', e);
    rules = null;
  }
  return rules;
}

/** Whether a stored document is a quotation / pro-forma. */
export async function isAdvanceDoc(b: { documentType?: unknown } | null | undefined): Promise<boolean> {
  const r = await loadPrepaymentRules();
  return Boolean(r && b && r.isAdvanceDocument(b.documentType));
}

/**
 * Hold a document typed as a quotation / pro-forma to what the type says: No
 * Tax, with its reason. Mutates `patch`; runs only on a write that SETS the type,
 * the way keepPaymentProofInStep does, so a code picked afterwards is kept.
 */
export async function keepAdvanceInStep(
  current: Partial<Bill> | null,
  patch: Record<string, unknown>,
  where: { ws: string; orgId: string } | null = null
): Promise<boolean> {
  if (!('documentType' in patch)) return false;
  const r = await loadPrepaymentRules();
  if (!r) return false;
  const doc = { ...(current || {}), ...patch } as Partial<Bill> & Record<string, unknown>;
  if (!r.isAdvanceDocument(doc.documentType)) return false;
  if (doc.xeroInvoiceId || doc.prepayment) return false;
  if (['deleted', 'merged', 'expenseclaim'].includes(String(doc.status || ''))) return false;
  // The zero code by the name THIS entity's chart gives it (jurisdiction.ts).
  const out = r.advancePatch(doc, where ? await zeroCodeName(where.ws, where.orgId) : undefined);
  if (!Object.keys(out).length) return false;
  Object.assign(patch, out);
  if ('taxRate' in out) {
    const owned = Array.isArray(current?.ruleFields) ? current!.ruleFields : [];
    if (owned.includes('taxRate')) patch.ruleFields = owned.filter((f) => f !== 'taxRate');
  }
  return true;
}

type Org = { id: string; tenantId: string; tenantName?: string; name?: string };
type Out = { status: number; body: any };

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toISOString().slice(0, 10);
const xeroErrors = (record: any): string[] =>
  (record?.ValidationErrors ?? []).map((e: any) => String(e?.Message ?? e)).filter(Boolean);

/**
 * Record a quotation as an overpayment to its supplier, paid out of `bankAccount`
 * on `date`. The whole document total unless `amount` says less (a deposit on a
 * larger quotation). The quotation is then set aside — its money is in Xero,
 * waiting on the invoice — and marked Paid from that account.
 */
export async function recordPrepayment(
  organisation: Org,
  ws: string,
  bill: Bill,
  opts: {
    bankAccountCode?: string;
    // Xero's AccountID for the bank account — what a machine caller holds (a
    // bank account in Xero need not have a Code at all).
    bankAccountId?: string;
    bankAccountName?: string;
    date?: string;
    amount?: unknown;
    // The Xero contact to hold the overpayment on. A payment run names the one
    // it saved the payee's bank details on; without it the supplier's NAME is
    // matched, and Xero creates a contact for a name it has not seen.
    contactId?: string;
    // Added to the Reference Xero shows (a payment run's PV number), after the
    // quotation's own number, which stays first so the overpayment still says
    // which paper it was paid against.
    reference?: string;
    by: string;
  }
): Promise<Out> {
  if (!(await isAdvanceDoc(bill))) {
    return { status: 422, body: { error: 'not_advance', message: 'Only a quotation or a pro-forma invoice is recorded as a prepayment. Set the document’s Type first.' } };
  }
  if (bill.prepayment?.overpaymentId) {
    return { status: 409, body: { error: 'already_recorded', message: 'This quotation is already recorded as a prepayment in Xero.', prepayment: bill.prepayment } };
  }
  if (bill.xeroInvoiceId) {
    return { status: 409, body: { error: 'already_posted', message: 'This document is already a bill in Xero. Clear the Xero link (and void the bill in Xero) before recording it as a prepayment.' } };
  }
  const supplier = String(bill.supplier ?? '').trim();
  if (!supplier || supplier.toLowerCase() === 'unknown supplier') {
    return { status: 400, body: { error: 'no_supplier', message: 'Name the supplier first — the prepayment is held on their contact in Xero.' } };
  }
  const code = String(opts.bankAccountCode ?? '').trim();
  const accountId = String(opts.bankAccountId ?? '').trim();
  const contactId = String(opts.contactId ?? '').trim();
  if (!code && !accountId) return { status: 400, body: { error: 'no_bank_account', message: 'Pick the bank account the quotation was paid from.' } };
  const date = ISO.test(String(opts.date ?? '')) ? String(opts.date) : today();
  const total = parseAmount(bill.total);
  const asked = opts.amount === undefined || opts.amount === '' ? total : parseAmount(opts.amount);
  const amount = Math.round(asked * 100) / 100;
  if (!(amount > 0)) return { status: 400, body: { error: 'no_amount', message: 'The prepayment needs an amount above 0.' } };
  if (total > 0 && amount > total + 0.004) {
    return { status: 400, body: { error: 'amount_too_large', message: `The prepayment (${amount.toFixed(2)}) is more than the quotation’s total (${total.toFixed(2)}).` } };
  }
  const reference = String(bill.invoiceNumber ?? '').trim();
  const currency = String(bill.currency ?? '').trim().toUpperCase();
  const label = /pro.?forma/i.test(String(bill.documentType ?? '')) ? 'Pro-forma invoice' : 'Quotation';

  const transaction: Record<string, unknown> = {
    Type: 'SPEND-OVERPAYMENT',
    Contact: contactId ? { ContactID: contactId } : { Name: supplier },
    BankAccount: accountId ? { AccountID: accountId } : { Code: code },
    Date: date,
    // The quotation's own number, so the overpayment says in Xero which paper
    // it was paid against — and so the invoice that quotes it can find it.
    Reference: [reference ? `${label} ${reference}` : `${label} prepayment`, String(opts.reference ?? '').trim()]
      .filter(Boolean)
      .join(' · ')
      .slice(0, 255),
    LineAmountTypes: 'NoTax',
    LineItems: [
      {
        Description: [`Prepayment on ${label.toLowerCase()}`, reference, String(bill.description ?? '').replace(/^\*\s*/, '').trim()]
          .filter(Boolean)
          .join(' — ')
          .slice(0, 4000),
        LineAmount: amount,
      },
    ],
  };
  if (currency) transaction.CurrencyCode = currency;

  const result = await relay('BankTransactions', {
    method: 'PUT',
    tenantId: organisation.tenantId,
    query: { summarizeErrors: 'false' },
    body: { BankTransactions: [transaction] },
  });
  const record = result.ok ? result.data?.BankTransactions?.[0] : null;
  const errors = xeroErrors(record);
  const overpaymentId = String(record?.OverpaymentID ?? '');
  if (!result.ok || !record || record.HasErrors || errors.length || !overpaymentId) {
    return { status: result.ok ? 422 : result.status >= 500 ? 502 : result.status, body: {
      error: result.ok ? 'xero_validation_failed' : result.error,
      message: errors.length ? errors.join(' ') : result.ok ? 'Xero did not create the overpayment.' : result.message,
    } };
  }

  const prepayment: NonNullable<Bill['prepayment']> = {
    overpaymentId,
    bankTransactionId: String(record.BankTransactionID ?? ''),
    amount,
    currency: String(record.CurrencyCode ?? currency),
    date,
    reference,
    bankAccount: {
      code: code || String(record.BankAccount?.Code ?? ''),
      name: String(opts.bankAccountName || record.BankAccount?.Name || '').trim(),
    },
    contactId: String(record.Contact?.ContactID ?? ''),
    recordedAt: new Date().toISOString(),
    recordedBy: opts.by,
    allocations: [],
    before: { status: String(bill.status ?? ''), paid: Boolean(bill.paid), paymentMethod: String(bill.paymentMethod ?? '') },
  };
  setBillPrepayment(ws, bill.id, prepayment);
  // The quotation itself goes on the overpayment's bank transaction: until the
  // tax invoice arrives that is the only record of this money in Xero, and a
  // prepayment with no paper behind it is what an auditor asks about.
  // Best-effort like a bill's attachment — the money is already recorded, and a
  // failed upload is reported on the reply rather than undoing it.
  const attachment = await attachBillFileTo(organisation.tenantId, 'BankTransactions', prepayment.bankTransactionId, bill);
  // Paid, from that account, and out of the working list: its money is in Xero
  // now, held on the supplier's contact until the invoice arrives.
  const patch: Partial<Bill> = { paid: true };
  if (prepayment.bankAccount.name) patch.paymentMethod = prepayment.bankAccount.name;
  if (['new', 'viewed', 'review', 'ready', 'processing'].includes(String(bill.status ?? ''))) patch.status = 'archived';
  updateBill(ws, bill.id, patch);

  // An invoice that ARRIVED FIRST and is already in Xero is not waiting on
  // anything: apply to it now rather than leaving the money sitting there.
  const applied = await applyToPublishedInvoices(organisation, ws, bill.id, opts.by);

  return { status: 200, body: { ok: true, prepayment, applied, attachment, bill: getBillById(ws, bill.id) } };
}

/**
 * Take a prepayment back out of Xero. Only while nothing has been allocated
 * from it — an allocation is money already used against a bill, and pulling
 * the overpayment out from under it is Xero's to refuse. Xero's words are
 * passed back when it does.
 */
export async function undoPrepayment(organisation: Org, ws: string, bill: Bill): Promise<Out> {
  const p = bill.prepayment;
  if (!p?.overpaymentId) return { status: 409, body: { error: 'not_recorded', message: 'This document has no prepayment recorded.' } };
  if ((p.allocations || []).length) {
    return { status: 409, body: { error: 'allocated', message: 'Part of this prepayment has already been applied to an invoice in Xero. Remove that allocation in Xero first.' } };
  }
  const result = await relay(`BankTransactions/${encodeURIComponent(p.bankTransactionId)}`, {
    method: 'POST',
    tenantId: organisation.tenantId,
    query: { summarizeErrors: 'false' },
    body: { BankTransactions: [{ BankTransactionID: p.bankTransactionId, Status: 'DELETED' }] },
  });
  const record = result.ok ? result.data?.BankTransactions?.[0] : null;
  const errors = xeroErrors(record);
  if (!result.ok || errors.length) {
    return { status: result.ok ? 422 : result.status >= 500 ? 502 : result.status, body: {
      error: result.ok ? 'xero_validation_failed' : result.error,
      message: `${errors.length ? errors.join(' ') : (result as any).message} Remove the overpayment in Xero by hand if it will not delete from here.`,
    } };
  }
  setBillPrepayment(ws, bill.id, null);
  const before = p.before;
  const patch: Partial<Bill> = { paid: before ? before.paid : false };
  if (before) patch.paymentMethod = before.paymentMethod;
  if (bill.status === 'archived') patch.status = before?.status && before.status !== 'archived' ? before.status : 'new';
  updateBill(ws, bill.id, patch);
  return { status: 200, body: { ok: true, bill: getBillById(ws, bill.id) } };
}

/**
 * Allocate a recorded prepayment against an invoice's Xero bill. The amount is
 * what is left of the prepayment, capped at the invoice's total (a deposit
 * larger than the invoice leaves the rest for the next one). Xero refuses an
 * allocation to a DRAFT or SUBMITTED bill, and its words are passed back.
 */
export async function allocatePrepayment(
  organisation: Org,
  ws: string,
  fromId: string,
  invoiceBillId: string,
  opts: { by: string; auto: boolean; amount?: unknown }
): Promise<Out> {
  const r = await loadPrepaymentRules();
  const from = getBillById(ws, fromId);
  const invoice = getBillById(ws, invoiceBillId);
  if (!r || !from || !invoice) return { status: 404, body: { error: 'bill_not_found' } };
  if (!from.prepayment?.overpaymentId) {
    return { status: 409, body: { error: 'not_recorded', message: 'That quotation has no prepayment recorded in Xero.' } };
  }
  if (!invoice.xeroInvoiceId || String(invoice.xeroDocType || 'ACCPAY') !== 'ACCPAY') {
    return { status: 409, body: { error: 'not_published', message: 'Publish the invoice to Xero first — the prepayment is applied to its bill there.' } };
  }
  if ((invoice.prepaymentsApplied || []).some((a) => a.fromId === fromId)) {
    return { status: 409, body: { error: 'already_applied', message: 'This prepayment is already applied to this invoice.' } };
  }
  const remaining = r.prepaymentRemainingCents(from);
  const invoiceCents = Math.round(parseAmount(invoice.total) * 100);
  const askedCents = opts.amount === undefined || opts.amount === '' ? Infinity : Math.round(parseAmount(opts.amount) * 100);
  const cents = Math.min(remaining, invoiceCents, askedCents);
  if (!(cents > 0)) {
    return { status: 409, body: { error: 'nothing_left', message: 'Nothing is left of this prepayment to apply.' } };
  }
  const amount = cents / 100;
  const date = ISO.test(String(invoice.date ?? '')) && String(invoice.date) >= from.prepayment.date ? String(invoice.date) : from.prepayment.date;
  const result = await relay(`Overpayments/${encodeURIComponent(from.prepayment.overpaymentId)}/Allocations`, {
    method: 'PUT',
    tenantId: organisation.tenantId,
    query: { summarizeErrors: 'false' },
    body: { Allocations: [{ Invoice: { InvoiceID: invoice.xeroInvoiceId }, Amount: amount, Date: date }] },
  });
  const record = result.ok ? result.data?.Allocations?.[0] : null;
  const errors = xeroErrors(record);
  if (!result.ok || errors.length || (result.ok && !record)) {
    return { status: result.ok ? 422 : result.status >= 500 ? 502 : result.status, body: {
      error: result.ok ? 'xero_validation_failed' : result.error,
      message: errors.length ? errors.join(' ') : result.ok ? 'Xero did not apply the prepayment.' : result.message,
    } };
  }
  const written = recordPrepaymentAllocation(ws, fromId, invoiceBillId, {
    invoiceId: invoice.xeroInvoiceId,
    amount,
    date,
    at: new Date().toISOString(),
    by: opts.by,
    auto: opts.auto,
  });
  return { status: 200, body: {
    ok: true,
    amount,
    reference: from.prepayment.reference,
    fromId,
    fromDisplayId: from.displayId || '',
    // A prepayment smaller than the invoice leaves the rest of the bill to pay.
    invoiceRemaining: Math.max(0, invoiceCents - cents) / 100,
    bill: written?.invoice ?? getBillById(ws, invoiceBillId),
  } };
}

/**
 * The prepayment an invoice about to be published will use by itself, or null.
 * What postBillToXero reads to know it must publish AUTHORISED — Xero allocates
 * to nothing less.
 */
export async function firmPrepaymentFor(ws: string, invoice: Bill): Promise<{ doc: Bill; amountCents: number; reference: string } | null> {
  const r = await loadPrepaymentRules();
  if (!r || invoice.prepaymentsApplied?.length || (await isAdvanceDoc(invoice))) return null;
  return r.firmPrepayment(invoice, listBills(ws));
}

// Once a quotation is recorded, every invoice of the supplier's already in Xero
// that it FIRMLY belongs to takes it — the invoice arrived first and was
// published before anybody recorded the advance. Best-effort: the prepayment is
// in Xero either way, and a refusal is reported beside it.
async function applyToPublishedInvoices(organisation: Org, ws: string, fromId: string, by: string): Promise<any[]> {
  const r = await loadPrepaymentRules();
  if (!r) return [];
  const out: any[] = [];
  const book = listBills(ws);
  for (const inv of book) {
    if (!inv.xeroInvoiceId || String(inv.xeroDocType || 'ACCPAY') !== 'ACCPAY') continue;
    if (['PAID', 'VOIDED', 'DELETED'].includes(String(inv.xeroStatus ?? '').toUpperCase())) continue;
    if (inv.prepaymentsApplied?.length) continue;
    const firm = r.firmPrepayment(inv, listBills(ws));
    if (!firm || firm.doc.id !== fromId) continue;
    const res = await allocatePrepayment(organisation, ws, fromId, inv.id, { by, auto: true });
    out.push({ billId: inv.id, displayId: inv.displayId || '', ok: res.status === 200, ...(res.status === 200 ? { amount: res.body.amount } : { message: res.body?.message }) });
    if (!r.prepaymentRemainingCents(getBillById(ws, fromId))) break;
  }
  return out;
}
