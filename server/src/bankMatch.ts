import { Router } from 'express';
import { env, googleEnabled, xeroEnabled } from './env.js';
import { readSession } from './auth.js';
import { WORKSPACE_ID } from './workspace.js';
import { loadCollection, saveCollection } from './jsonStore.js';
import {
  dataScopeForOrg,
  getOrganisation,
  listOrganisations,
  type Organisation,
} from './organisations.js';
import {
  getBillById,
  markBillXeroPayment,
  parseAmount,
  updateBill,
  type Bill,
} from './store.js';
import {
  baseCurrencyFor,
  fetchXeroInvoice,
  paymentFromInvoice,
  postBillToXero,
  postingCodesFor,
  relay,
} from './xero.js';
import { canAccessOrg, effectiveRoleFor, isBusinessAdminRole, memberForSession } from './users.js';
import { syncWhatsappReaction } from './waReactions.js';

// Bank match: settling a bank statement line against the document it pays.
//
// CYWorkspace's auto bank reconciliation reads a client's Xero Bank
// Reconciliation report and settles each unreconciled statement line against
// the Xero bill it pays. A line it CANNOT settle is, more often than not, a
// document that is still only here — read, coded, marked Ready, never
// published — because as far as Xero is concerned that bill does not exist.
// This module is both halves of closing that gap, and they share one act:
//
//   settleBillAgainstLine — publish the document AUTHORISED if it is not yet in
//   Xero, then record a PAYMENT against it from the bank account, on the
//   statement date, for the statement amount, carrying the bank's reference.
//   That payment is what Xero's own reconciliation then matches the statement
//   line to, which is exactly what Dext's Bank Match does when an item is
//   matched: the bill and its payment appear together, and the line clears.
//
// The two roads to it:
//
//   The BROWSER — the Bank tab. CYBills asks CYWS for the lines its run left
//   outstanding (§ GET /outstanding), the page suggests the document each pays
//   (src/lib/bankMatch.js), and a person confirms one (§ POST /match).
//
//   The MACHINE — CYWS's run itself. It already looks past Xero to Dext's
//   review pile for the invoice behind a line; now it asks here too
//   (GET /api/payments/bank-candidates in payments.ts), matches with its own
//   engine, and asks us to publish and pay (POST /api/payments/bills/:id/settle).
//
// Both roads write the same payment into the same live ledger, so they cannot
// hold different standards about the money: a line is settled against a
// document only when the two agree TO THE CENT, in the currency the bank moved
// — held by `docAmountFor`, which is the SAME function the page draws its
// suggestions with (loaded by path from src/lib/bankMatch.js, the way
// mileage.ts loads mileage.js), so a document the page offers can never be
// refused here for its amount, and one the page would never offer can never be
// paid by asking the API directly. A payment for a different figure would leave
// a part-paid bill in the ledger that nobody asked for.
//
// Every settlement is RECORDED (the `bank-lines` collection): CYWS hands the
// same lines back until the statement line is reconciled in Xero, so a line
// already settled here must be shown as settled rather than offered again — and
// a run re-pressed after a failure half way through must find its earlier
// settlements rather than paying them twice.

export const bankRouter = Router();

// --- the rules, shared with the page -----------------------------------------
// src/lib/bankMatch.js, loaded by path. Only two of its functions are needed
// here: the money check and the line key.
type BankRules = {
  lineKey: (line: unknown) => string;
  docAmountFor: (doc: unknown, line: unknown) => number | null;
  isMoneyOut: (line: unknown) => boolean;
  matchable: (doc: unknown) => boolean;
};
let rules: BankRules | null = null;
let triedRules = false;
export async function bankRules(): Promise<BankRules | null> {
  if (triedRules) return rules;
  triedRules = true;
  try {
    const url = new URL('../../src/lib/bankMatch.js', import.meta.url).href;
    const mod = (await import(url)) as Partial<BankRules>;
    rules =
      typeof mod?.lineKey === 'function' &&
      typeof mod?.docAmountFor === 'function' &&
      typeof mod?.isMoneyOut === 'function' &&
      typeof mod?.matchable === 'function'
        ? (mod as BankRules)
        : null;
  } catch (e) {
    console.error('[bank] match rules unavailable', e);
    rules = null;
  }
  return rules;
}

// --- one statement line ------------------------------------------------------
export type BankLine = {
  key: string;
  date: string; // YYYY-MM-DD, the bank's clearing date
  amount: number; // SIGNED: negative is money out
  currency: string; // the bank account's
  reference: string;
  description: string;
  bank_account_id: string; // Xero AccountID, '' when CYWS could not resolve one
  bank_account_name: string;
  bank_account_code?: string; // a person's pick, by chart code, where CYWS had none
  status?: string; // CYWS's verdict on the line: no_match, below_min_confidence, …
  reason?: string;
  contact?: string;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// A line as it arrives — from CYWS (snake_case) or from the page (the same
// shape, echoed back) — read into one, or null when it is not a line at all.
export async function readLine(raw: any): Promise<BankLine | null> {
  const mod = await bankRules();
  if (!raw || typeof raw !== 'object' || !mod) return null;
  const date = String(raw.date ?? raw.payment_date ?? '').slice(0, 10);
  const amount = Number(raw.amount ?? raw.signed_amount);
  if (!ISO_DATE.test(date) || !Number.isFinite(amount) || amount === 0) return null;
  const line: BankLine = {
    key: '',
    date,
    amount,
    currency: String(raw.currency ?? raw.bank_account_currency ?? '').trim().toUpperCase(),
    reference: String(raw.reference ?? '').trim(),
    description: String(raw.description ?? '').trim(),
    bank_account_id: String(raw.bank_account_id ?? '').trim(),
    bank_account_name: String(raw.bank_account_name ?? '').trim(),
    bank_account_code: String(raw.bank_account_code ?? '').trim(),
    status: String(raw.status ?? '').trim(),
    reason: String(raw.reason ?? '').trim(),
    contact: raw.contact == null ? '' : String(raw.contact),
  };
  line.key = mod.lineKey(line);
  return line;
}

// --- what has been done to a line --------------------------------------------
// One row per settlement or dismissal, per entity. A settlement remembers the
// payment it made so it can be undone, and what the document said before so an
// undo puts it back.
export type BankLineRecord = {
  id: string;
  orgId: string; // the entity's data scope
  tenantId: string;
  kind: 'match' | 'dismissed';
  key: string;
  line: BankLine;
  billId?: string;
  invoiceId?: string;
  paymentId?: string;
  paidBefore?: boolean;
  paymentMethodBefore?: string;
  publishedHere?: boolean; // the settle did the publishing, not somebody earlier
  via: 'browser' | 'cyws';
  at: string;
  by: string;
};

const COLLECTION = 'bank-lines';
export function loadRecords(): BankLineRecord[] {
  return loadCollection<BankLineRecord>(COLLECTION);
}
function saveRecords(items: BankLineRecord[]): void {
  saveCollection(COLLECTION, items);
}
export function recordsFor(orgId: string): BankLineRecord[] {
  return loadRecords().filter((r) => r.orgId === orgId);
}
function newId(): string {
  return `bl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// --- settling ----------------------------------------------------------------
export type SettleResult = { status: number; body: any };

/**
 * Settle one document against one statement line: publish it AUTHORISED if it
 * is not yet in Xero, record the payment, and remember the match.
 *
 * `opts.contactId` is the payables road's contact-by-id (see payments.ts —
 * CYWS makes the contact first, so the bill lands on the one carrying the
 * payee's bank details). `opts.force` is not offered: a document already in
 * Xero is PAID, not re-posted.
 */
export async function settleBillAgainstLine(
  req: any,
  organisation: Organisation,
  ws: string,
  bill: Bill,
  line: BankLine,
  opts: { via: 'browser' | 'cyws'; by: string; contactId?: string; accountCode?: string; taxType?: string }
): Promise<SettleResult> {
  const mod = await bankRules();
  if (!mod) return { status: 500, body: { error: 'rules_unavailable', message: 'The bank match rules could not be loaded.' } };

  // Idempotent on the LINE: a run re-pressed after a failure half way through
  // must find its earlier settlement rather than paying it twice, and the same
  // line offered to the page again must not make a second payment.
  const existing = recordsFor(ws).find((r) => r.kind === 'match' && r.key === line.key);
  if (existing) {
    if (existing.billId === bill.id) {
      return { status: 200, body: { ok: true, already_settled: true, match: existing, bill: getBillById(ws, bill.id) } };
    }
    return { status: 409, body: {
      error: 'line_already_matched',
      message: 'This statement line has already been matched to another document. Undo that match first.',
      match: existing,
    } };
  }

  // Money out only. Money in is a customer paying or a supplier refunding, and
  // neither is a cost document — a refund against a credit note is a different
  // record in Xero and is not attempted here.
  if (!mod.isMoneyOut(line)) {
    return { status: 422, body: { error: 'money_in', message: 'This statement line is money coming IN, and a cost document is money going out.' } };
  }
  if (!mod.matchable(bill)) {
    return { status: 409, body: {
      error: 'not_matchable',
      message: `“${bill.supplier || 'This document'}” can’t be settled: it is on an expense claim, merged away, a credit note, or Xero already says it is paid.`,
    } };
  }
  // THE check. To the cent, in the currency the bank moved, and never a
  // converted guess: a foreign-currency document answers with the figure it
  // restated itself in (see docAmountFor), or not at all.
  const mine = mod.docAmountFor(bill, line);
  const cents = (n: number) => Math.round(n * 100);
  if (mine == null || cents(mine) !== Math.abs(cents(line.amount))) {
    return { status: 422, body: {
      error: 'amount_mismatch',
      message: mine == null
        ? `“${bill.supplier}” is billed in ${bill.currency || 'another currency'} and states no ${line.currency || 'bank-currency'} figure, so it can’t be compared with this ${line.currency || ''} line.`
        : `“${bill.supplier}” is ${bill.currency || ''} ${mine.toFixed(2)}, and this statement line is ${line.currency || ''} ${Math.abs(line.amount).toFixed(2)}. A payment for a different figure would leave a part-paid bill.`,
    } };
  }
  // Somewhere to pay it FROM. CYWS resolves the bank account off the report's
  // own heading; where it could not, the page lets a person pick one by code.
  const account: Record<string, string> | null = line.bank_account_id
    ? { AccountID: line.bank_account_id }
    : line.bank_account_code
      ? { Code: line.bank_account_code }
      : null;
  if (!account) {
    return { status: 422, body: { error: 'no_bank_account', message: 'This statement line names no bank account to pay from. Pick one.' } };
  }

  // Publish first, where it is not yet in Xero. AUTHORISED, and not the entity's
  // own publishStatus: Xero will not take a payment against a DRAFT or a
  // SUBMITTED bill, and the whole point of this act is the payment. The bank
  // line IS the approval — the money has left.
  let invoiceId = String(bill.xeroInvoiceId ?? '');
  let publishedHere = false;
  let published: any = null;
  if (!invoiceId) {
    let accountCode = String(opts.accountCode ?? '').trim();
    let taxType = String(opts.taxType ?? '').trim();
    if (!accountCode || !taxType) {
      const posting = await postingCodesFor(WORKSPACE_ID, organisation.id, bill);
      if (!posting.ok) return { status: 422, body: { error: posting.error, message: posting.message } };
      accountCode = posting.accountCode;
      taxType = posting.taxType;
    }
    const out = await postBillToXero(req, organisation, ws, bill, {
      accountCode,
      taxType,
      status: 'AUTHORISED',
      contactId: opts.contactId,
    });
    if (out.status !== 200) return out;
    published = out.body;
    invoiceId = String(out.body?.invoice?.invoiceId ?? '');
    publishedHere = true;
    if (!invoiceId) return { status: 502, body: { error: 'publish_failed', message: 'Xero returned no invoice id for the published bill.' } };
  } else if (String(bill.xeroDocType ?? 'ACCPAY') !== 'ACCPAY') {
    return { status: 409, body: { error: 'credit_note', message: 'A credit note is money the supplier owes us; it is not paid from a bank account.' } };
  } else {
    // Already in Xero, and possibly still DRAFT or SUBMITTED there — a bill the
    // automatic publish-after-reading sent into an approval queue. Xero refuses
    // a payment against either, so the bill is approved first: the money has
    // left the bank, which is as approved as a bill gets.
    const state = String(bill.xeroStatus ?? '').toUpperCase();
    if (state && state !== 'AUTHORISED' && state !== 'PAID') {
      const approve = await relay('Invoices', {
        method: 'POST',
        tenantId: organisation.tenantId,
        query: { summarizeErrors: 'false' },
        body: { Invoices: [{ InvoiceID: invoiceId, Status: 'AUTHORISED' }] },
      });
      const inv = approve.ok ? approve.data?.Invoices?.[0] : null;
      const errs: string[] = (inv?.ValidationErrors ?? []).map((e: any) => String(e.Message ?? e));
      if (!approve.ok || !inv || errs.length) {
        return { status: 422, body: {
          error: 'not_approved',
          message: `Xero would not approve the bill for payment: ${errs.length ? errs.join(' ') : approve.ok ? 'it refused.' : (approve as any).message}`,
        } };
      }
    }
  }

  // The payment. Amount in the INVOICE's currency — Xero applies a payment to a
  // bill in the bill's own currency — and, where the bank account is in another,
  // the rate that carries the bank's figure onto it. Xero's CurrencyRate on a
  // payment is FOREIGN PER BASE, the same way round as on the invoice
  // (currencyRateFor in xero.ts): it divides the amount by it to reach what the
  // bank moved. USD 17.17 paid as SGD 22.20 is a rate of 0.7734.
  const invoiceAmount = parseAmount(bill.total);
  const bankAmount = Math.abs(line.amount);
  const billCurrency = String(bill.currency ?? '').trim().toUpperCase();
  const payment: Record<string, unknown> = {
    Invoice: { InvoiceID: invoiceId },
    Account: account,
    Date: line.date,
    Amount: invoiceAmount,
    Reference: (line.reference || line.description).slice(0, 255),
  };
  if (line.currency && billCurrency && line.currency !== billCurrency && bankAmount > 0) {
    payment.CurrencyRate = Number((invoiceAmount / bankAmount).toFixed(6));
  }
  const paid = await relay('Payments', {
    method: 'PUT',
    tenantId: organisation.tenantId,
    query: { summarizeErrors: 'false' },
    body: { Payments: [payment] },
  });
  const record = paid.ok ? paid.data?.Payments?.[0] : null;
  const errors: string[] = (record?.ValidationErrors ?? []).map((e: any) => String(e.Message ?? e));
  if (!paid.ok || !record || record.HasValidationErrors || errors.length) {
    return { status: paid.ok ? 422 : paid.status >= 500 ? 502 : paid.status, body: {
      error: paid.ok ? 'payment_refused' : paid.error,
      message: errors.length ? errors.join(' ') : paid.ok ? 'Xero rejected the payment.' : paid.message,
      // The bill IS in the ledger now, even though the payment is not — say so,
      // so the caller does not post it a second time.
      invoice_id: invoiceId,
      published_here: publishedHere,
    } };
  }
  const paymentId = String(record.PaymentID ?? '');

  // What Xero now says about the bill, read back rather than assumed — the same
  // three fields the webhook and the payments sweep record, through the same
  // writer, so a bill paid here says exactly what one paid in Xero says.
  const invoice = await fetchXeroInvoice(organisation.tenantId, invoiceId);
  const xero = invoice
    ? paymentFromInvoice(invoice)
    : { xeroStatus: 'PAID', xeroPaidDate: line.date, xeroPaymentRef: String(payment.Reference ?? '') };
  markBillXeroPayment(ws, bill.id, xero);
  // And the document's own Paid toggle: this IS the payment, from THIS account.
  const paidBefore = Boolean(bill.paid);
  const paymentMethodBefore = String(bill.paymentMethod ?? '');
  const patch: Partial<Bill> = { paid: true };
  if (line.bank_account_name && !paymentMethodBefore) patch.paymentMethod = line.bank_account_name;
  updateBill(ws, bill.id, patch);
  // The tick on the WhatsApp message the receipt arrived in turns green.
  void syncWhatsappReaction(ws, bill.id);

  const match: BankLineRecord = {
    id: newId(),
    orgId: ws,
    tenantId: organisation.tenantId,
    kind: 'match',
    key: line.key,
    line,
    billId: bill.id,
    invoiceId,
    paymentId,
    paidBefore,
    paymentMethodBefore,
    publishedHere,
    via: opts.via,
    at: new Date().toISOString(),
    by: opts.by,
  };
  saveRecords([...loadRecords(), match]);

  return { status: 200, body: {
    ok: true,
    invoice: published?.invoice ?? {
      invoiceId,
      invoiceNumber: String(invoice?.InvoiceNumber ?? bill.invoiceNumber ?? ''),
      status: xero.xeroStatus,
    },
    published: publishedHere ? { lines: published?.lines, perLine: published?.perLine, attachment: published?.attachment } : null,
    payment: { paymentId, date: line.date, amount: invoiceAmount, currency: billCurrency, reference: payment.Reference },
    match,
    bill: getBillById(ws, bill.id),
  } };
}

/**
 * Undo a settlement: delete the payment in Xero, record what the bill says
 * now, put the document's Paid toggle back, and forget the match. The bill
 * stays published — publishing is not undone by unmatching, and the line goes
 * back to being outstanding for somebody to settle against the right document.
 */
export async function undoSettlement(record: BankLineRecord, organisation: Organisation): Promise<SettleResult> {
  const ws = record.orgId;
  if (record.paymentId) {
    const gone = await relay(`Payments/${encodeURIComponent(record.paymentId)}`, {
      method: 'POST',
      tenantId: organisation.tenantId,
      body: { Status: 'DELETED' },
    });
    // Xero has the last word — a payment already reconciled at its end cannot
    // be deleted from here, and it says so in its own words.
    if (!gone.ok) {
      return { status: gone.status >= 500 ? 502 : 409, body: {
        error: 'payment_not_deleted',
        message: `Xero would not delete the payment: ${gone.message}`,
      } };
    }
  }
  const bill = record.billId ? getBillById(ws, record.billId) : null;
  if (bill) {
    const invoice = record.invoiceId ? await fetchXeroInvoice(organisation.tenantId, record.invoiceId) : null;
    if (invoice) markBillXeroPayment(ws, bill.id, paymentFromInvoice(invoice));
    else markBillXeroPayment(ws, bill.id, { xeroStatus: 'AUTHORISED', xeroPaidDate: '', xeroPaymentRef: '' });
    updateBill(ws, bill.id, { paid: Boolean(record.paidBefore), paymentMethod: record.paymentMethodBefore ?? '' });
  }
  saveRecords(loadRecords().filter((r) => r.id !== record.id));
  return { status: 200, body: { ok: true, bill: bill ? getBillById(ws, bill.id) : null } };
}

// --- the outstanding lines, from CYWS ----------------------------------------
// GET https://cyworkspace.cy-bm.sg/api/webhooks/cybills/bank-recon/outstanding?tenant_id=…
// Contract: deploy/BANK-MATCH.md.
export type OutstandingResult =
  | { ok: true; lines: BankLine[]; retrievedAt: string; reports: Array<{ name: string; retrieved_at: string }>; tenantName: string }
  | { ok: false; error: string; message: string; status: number };

export async function fetchOutstandingFromCyws(tenantId: string): Promise<OutstandingResult> {
  if (!env.CYWORKSPACE_RELAY_URL || !env.CYWORKSPACE_API_KEY) {
    return { ok: false, status: 503, error: 'cyws_not_configured', message: 'Set CYWORKSPACE_API_KEY (and CYWORKSPACE_RELAY_URL) in server/.env.' };
  }
  const url = new URL(`${env.CYWORKSPACE_RELAY_URL.replace(/\/+$/, '')}/api/webhooks/cybills/bank-recon/outstanding`);
  url.searchParams.set('tenant_id', tenantId);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'X-API-Key': env.CYWORKSPACE_API_KEY, Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    return { ok: false, status: 502, error: 'cyws_unreachable', message: `Could not reach CYWorkspace: ${err instanceof Error ? err.message : String(err)}` };
  }
  const data: any = await res.json().catch(() => null);
  if (!res.ok) {
    // An older CYWS has no such route and answers Express's bare 404 — which is
    // told apart from a JSON refusal, because "CYWS needs updating" and "CYWS
    // has never run a reconciliation for this client" are different people's
    // problems.
    if (res.status === 404 && !data?.error) {
      return { ok: false, status: 404, error: 'route_missing', message: 'CYWorkspace does not offer bank reconciliation results yet (it needs updating — see deploy/BANK-MATCH.md).' };
    }
    return { ok: false, status: res.status, error: String(data?.error ?? 'cyws_error'), message: String(data?.message ?? `CYWorkspace answered ${res.status}.`) };
  }
  const raw: any[] = Array.isArray(data?.lines) ? data.lines : [];
  const base = await baseCurrencyFor(tenantId).catch(() => '');
  const lines: BankLine[] = [];
  for (const r of raw) {
    const line = await readLine({ ...r, currency: r?.currency || r?.bank_account_currency || base });
    if (line) lines.push(line);
  }
  return {
    ok: true,
    lines,
    retrievedAt: String(data?.retrieved_at ?? ''),
    reports: Array.isArray(data?.reports) ? data.reports.map((x: any) => ({ name: String(x?.name ?? ''), retrieved_at: String(x?.retrieved_at ?? '') })) : [],
    tenantName: String(data?.tenant?.tenant_name ?? ''),
  };
}

// --- the browser's routes ----------------------------------------------------
// All session-guarded (index.ts), all scoped by X-Org-Id like the Costs API.
// Business Admin, the same bar as the Costs inbox: the page shows every
// document in the entity and writes payments into its ledger.

function organisationFor(req: any): Organisation | null {
  const ws = WORKSPACE_ID;
  const requested = String(req.header('X-Org-Id') || '').trim();
  if (requested) return getOrganisation(ws, requested);
  return listOrganisations(ws).find((o) => o.tenantId) ?? null;
}

function mayUse(req: any, orgId: string): boolean {
  const me = memberForSession(req);
  if (!me) return !googleEnabled; // dev/mock mode has no session to judge
  if (!canAccessOrg(me, orgId)) return false;
  return isBusinessAdminRole(effectiveRoleFor(me, orgId));
}

// The entity, its book, and whether the caller may work in it — or the
// refusal, written. A bridge entity has no Xero and no bank of its own, and its
// costs reach the ledger only as lines of a claim's bill, so it has nothing to
// match.
function requireBankEntity(req: any, res: any): { organisation: Organisation; ws: string } | null {
  if (!xeroEnabled) {
    res.status(503).json({ error: 'xero_not_configured', message: 'Set CYWORKSPACE_API_KEY (and CYWORKSPACE_RELAY_URL) in server/.env to enable Xero.' });
    return null;
  }
  const organisation = organisationFor(req);
  if (!organisation) {
    res.status(404).json({ error: 'organisation_not_found' });
    return null;
  }
  if (!mayUse(req, organisation.id)) {
    res.status(403).json({ error: 'forbidden', message: 'Only a Business Admin of this entity can match bank lines.' });
    return null;
  }
  if (!organisation.tenantId) {
    res.status(409).json({ error: 'no_xero_connection', message: `"${organisation.name}" isn't connected to Xero, so there is no bank to reconcile.` });
    return null;
  }
  return { organisation, ws: dataScopeForOrg(organisation.id) };
}

const who = (req: any) => String(readSession(req)?.email ?? '');

// GET /api/bank/outstanding — the lines CYWS's last run left unsettled for this
// entity's Xero, with what this entity has already done about each.
bankRouter.get('/outstanding', async (req, res) => {
  const scope = requireBankEntity(req, res);
  if (!scope) return;
  const { organisation, ws } = scope;
  const out = await fetchOutstandingFromCyws(organisation.tenantId);
  const records = recordsFor(ws);
  if (!out.ok) {
    // Still answer with what is known here: the matches already made are a
    // record of payments in a live ledger, and are worth showing even when the
    // source of new lines is down.
    return res.status(200).json({
      ok: false,
      error: out.error,
      message: out.message,
      lines: [],
      records,
      tenant: { id: organisation.tenantId, name: organisation.tenantName || organisation.name },
    });
  }
  res.json({
    ok: true,
    lines: out.lines,
    retrieved_at: out.retrievedAt,
    reports: out.reports,
    records,
    tenant: { id: organisation.tenantId, name: out.tenantName || organisation.tenantName || organisation.name },
  });
});

// POST /api/bank/match — { billId, line } — a person settling one line.
bankRouter.post('/match', async (req, res) => {
  const scope = requireBankEntity(req, res);
  if (!scope) return;
  const { organisation, ws } = scope;
  const billId = String(req.body?.billId ?? '').trim();
  const line = await readLine(req.body?.line);
  if (!billId || !line) {
    return res.status(400).json({ error: 'missing_field', message: 'billId and a statement line (date, amount, reference) are required.' });
  }
  const bill = getBillById(ws, billId);
  if (!bill) return res.status(404).json({ error: 'bill_not_found' });
  const out = await settleBillAgainstLine(req, organisation, ws, bill, line, {
    via: 'browser',
    by: who(req),
    accountCode: req.body?.accountCode,
    taxType: req.body?.taxType,
  });
  res.status(out.status).json(out.body);
});

// POST /api/bank/matches/:id/undo — take the payment off again.
bankRouter.post('/matches/:id/undo', async (req, res) => {
  const scope = requireBankEntity(req, res);
  if (!scope) return;
  const { organisation, ws } = scope;
  const record = recordsFor(ws).find((r) => r.id === req.params.id && r.kind === 'match');
  if (!record) return res.status(404).json({ error: 'match_not_found' });
  const out = await undoSettlement(record, organisation);
  res.status(out.status).json(out.body);
});

// POST /api/bank/lines/dismiss — { line } — "this is not a cost": a transfer,
// a fee, payroll. The line stops being offered here; nothing is written to Xero.
bankRouter.post('/lines/dismiss', async (req, res) => {
  const scope = requireBankEntity(req, res);
  if (!scope) return;
  const { organisation, ws } = scope;
  const line = await readLine(req.body?.line);
  if (!line) return res.status(400).json({ error: 'missing_field', message: 'A statement line (date, amount, reference) is required.' });
  const records = loadRecords();
  const already = records.find((r) => r.orgId === ws && r.key === line.key);
  if (already) return res.json({ ok: true, record: already });
  const record: BankLineRecord = {
    id: newId(), orgId: ws, tenantId: organisation.tenantId, kind: 'dismissed', key: line.key, line,
    via: 'browser', at: new Date().toISOString(), by: who(req),
  };
  saveRecords([...records, record]);
  res.json({ ok: true, record });
});

// POST /api/bank/lines/:id/restore — offer a dismissed line again.
bankRouter.post('/lines/:id/restore', async (req, res) => {
  const scope = requireBankEntity(req, res);
  if (!scope) return;
  const records = loadRecords();
  const record = records.find((r) => r.id === req.params.id && r.orgId === scope.ws && r.kind === 'dismissed');
  if (!record) return res.status(404).json({ error: 'record_not_found' });
  saveRecords(records.filter((r) => r.id !== record.id));
  res.json({ ok: true });
});
