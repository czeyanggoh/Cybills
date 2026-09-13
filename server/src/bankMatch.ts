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
  setBillBankMatch,
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
import { readSetting } from './settings.js';

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
  // The bank's card fee inside a line, when the line is the document's money
  // plus exactly the entity's configured percent for that bank account.
  feeFor: (doc: unknown, line: unknown, rules: unknown) => CardFee | null;
};
export type CardFee = { percent: number; fee: number; accountCode: string; bankAccount: string };
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
      typeof mod?.matchable === 'function' &&
      typeof mod?.feeFor === 'function'
        ? (mod as BankRules)
        : null;
  } catch (e) {
    console.error('[bank] match rules unavailable', e);
    rules = null;
  }
  return rules;
}

// The entity's card-fee rules (Business settings → Extraction → Bank match →
// Card fees): which bank account adds a fee on a card spend, at what percent,
// and which account the fee posts to. Read from the same extraction-settings
// blob the page writes, so the page and the server match the same lines.
export function cardFeeRules(organisation: { id: string }): unknown[] {
  const s = readSetting<{ cardFeeRules?: unknown }>(WORKSPACE_ID, 'cybills.extraction-settings.v1', organisation.id);
  return Array.isArray(s?.cardFeeRules) ? (s!.cardFeeRules as unknown[]) : [];
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
  // The bank's card fee, added to the BILL as a No Tax line so that one payment
  // of the statement amount is what Xero suggests for the line. Undo takes the
  // line back off after deleting the payment.
  feeLineItemId?: string;
  fee?: CardFee;
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

// --- telling CYWS which lines are spent -----------------------------------------
// A line CYBills has used to record a payment is SPENT: its money is on a bill
// in Xero. CYWS's auto bank reconciliation would otherwise keep proposing it —
// against a Xero bill of the same figure, or another CYBills document — until
// somebody reconciles the statement line in Xero, and a second payment for one
// line is the one outcome this seam exists to prevent. So every settlement, by
// every road (the Bank tab, a published autofill, CYWS's own settle), sends
// CYWS a `used` notice, and an Undo sends `released`, which puts the line back in
// play. Contract: deploy/BANK-MATCH.md § What CYBills tells CYWS.
//
// Queued rather than fired: a notice CYWS never received is a line it may still
// pay twice, so it waits in `bank-line-notices` until CYWS acknowledges it, sent
// in the order they happened (a `used` then a `released` for the same line must
// not arrive the other way round) and retried whenever the Bank tab or the inbox
// asks for lines. Dropped only when CYWS refuses it in its own words (an
// unknown tenant, a malformed line), or after thirty days nobody could deliver it.
type LineNotice = {
  id: string;
  tenantId: string;
  action: 'used' | 'released';
  key: string;
  line: BankLine;
  billId: string;
  itemId: string;
  supplier: string;
  invoiceId: string;
  paymentId: string;
  via: 'browser' | 'cyws';
  at: string;
  tries: number;
};
const NOTICES = 'bank-line-notices';
const NOTICE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function queueLineNotice(record: BankLineRecord, action: 'used' | 'released'): void {
  if (record.kind !== 'match' || !record.tenantId) return;
  const bill = record.billId ? getBillById(record.orgId, record.billId) : null;
  const items = loadCollection<LineNotice>(NOTICES);
  items.push({
    id: newId(),
    tenantId: record.tenantId,
    action,
    key: record.key,
    line: record.line,
    billId: record.billId ?? '',
    itemId: bill?.displayId ?? '',
    supplier: bill?.supplier ?? '',
    invoiceId: record.invoiceId ?? '',
    paymentId: record.paymentId ?? '',
    via: record.via,
    at: new Date().toISOString(),
    tries: 0,
  });
  saveCollection(NOTICES, items);
  void flushLineNotices();
}

let flushing: Promise<void> | null = null;
/** Send whatever is waiting, oldest first. One flush at a time; never throws. */
export function flushLineNotices(): Promise<void> {
  if (!flushing) {
    flushing = sendPendingNotices()
      .catch((err) => console.error('[bank] line notices failed', err))
      .finally(() => { flushing = null; });
  }
  return flushing;
}

async function sendPendingNotices(): Promise<void> {
  if (!env.CYWORKSPACE_RELAY_URL || !env.CYWORKSPACE_API_KEY) return;
  // Re-read each round: a notice queued while this flush is running is sent by
  // it rather than waiting for the next one.
  for (;;) {
    const items = loadCollection<LineNotice>(NOTICES);
    const now = Date.now();
    const live = items.filter((n) => {
      const t = Date.parse(n.at);
      return Number.isFinite(t) && now - t < NOTICE_MAX_AGE_MS;
    });
    if (live.length !== items.length) {
      console.error(`[bank] ${items.length - live.length} line notice(s) to CYWS expired undelivered`);
      saveCollection(NOTICES, live);
    }
    const next = live[0];
    if (!next) return;
    const outcome = await sendLineNotice(next);
    const after = loadCollection<LineNotice>(NOTICES);
    if (outcome === 'retry') {
      saveCollection(NOTICES, after.map((n) => (n.id === next.id ? { ...n, tries: n.tries + 1 } : n)));
      return; // CYWS is down or out of date: the rest wait behind this one, in order
    }
    saveCollection(NOTICES, after.filter((n) => n.id !== next.id));
  }
}

async function sendLineNotice(n: LineNotice): Promise<'sent' | 'retry' | 'dropped'> {
  const url = new URL(`${env.CYWORKSPACE_RELAY_URL.replace(/\/+$/, '')}/api/webhooks/cybills/bank-recon/used`);
  url.searchParams.set('tenant_id', n.tenantId);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'X-API-Key': env.CYWORKSPACE_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        action: n.action,
        key: n.key,
        line: {
          date: n.line.date,
          amount: n.line.amount,
          currency: n.line.currency,
          reference: n.line.reference,
          description: n.line.description,
          bank_account_id: n.line.bank_account_id,
          bank_account_name: n.line.bank_account_name,
        },
        bill_id: n.billId,
        item_id: n.itemId,
        supplier: n.supplier,
        invoice_id: n.invoiceId,
        payment_id: n.paymentId,
        via: n.via,
        at: n.at,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return 'sent';
    const data: any = await res.json().catch(() => null);
    // Down, a key that does not match yet, or an older CYWS with no such route
    // (Express's bare 404): all fixable at CYWS's end, so the notice waits.
    if (res.status >= 500 || res.status === 401 || (res.status === 404 && !data?.error)) {
      console.error(`[bank] CYWS did not take a line notice (${res.status}); will retry`, data?.error ?? '');
      return 'retry';
    }
    console.error(`[bank] CYWS refused a line notice (${res.status}); dropped`, data?.error ?? '', data?.message ?? '');
    return 'dropped';
  } catch (err) {
    console.error('[bank] could not reach CYWS with a line notice; will retry', err instanceof Error ? err.message : String(err));
    return 'retry';
  }
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
  // …or the document's money plus exactly the bank's card fee, on an account
  // the entity has said adds one (feeFor). The payment is still the bill's own
  // figure; the fee is posted beside it in recordPaymentForLine.
  const settledWithFee = mine != null && cents(mine) !== Math.abs(cents(line.amount)) && Boolean(mod.feeFor(bill, line, cardFeeRules(organisation)));
  if (mine == null || (cents(mine) !== Math.abs(cents(line.amount)) && !settledWithFee)) {
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

  return recordPaymentForLine(organisation, ws, bill, line, invoiceId, {
    publishedHere,
    published,
    via: opts.via,
    by: opts.by,
  });
}

// --- the bank's card fee, as a line of the bill ------------------------------------
// Neither CYWS nor CYBills can reconcile a statement line (Xero's API has no
// such call): what clears the line is Xero's own suggestion, and Xero only ever
// suggests ONE transaction of the line's amount. A 17.99 payment beside a 0.18
// spend never qualified, so every fee line needed Find & Match by hand. The fee
// therefore goes on the bill itself (the practice's choice), and one payment of
// 18.17 is what Xero pairs with the 18.17 line.
//
// Added by an UPDATE that re-sends the bill's existing lines with their
// LineItemIDs — Xero replaces a bill's lines with whatever an update sends, so
// a line left out would be deleted — plus the fee line. Idempotent: a bill that
// already carries the fee line (a settle re-pressed) is left as it is.
const FEE_LINE_MARK = 'card fee charged by';
const keepLine = (li: any) => ({
  LineItemID: li.LineItemID,
  Description: li.Description,
  Quantity: li.Quantity,
  UnitAmount: li.UnitAmount,
  AccountCode: li.AccountCode,
  TaxType: li.TaxType,
  TaxAmount: li.TaxAmount,
  ...(Array.isArray(li.Tracking) && li.Tracking.length ? { Tracking: li.Tracking } : {}),
});

// The tracking the fee line carries: the bill's LARGEST line's (by amount).
// Left untagged, a card fee on an HQ bill landed in no outlet at all, so the
// outlet's costs came up short by the fee. With several lines on different
// outlets, the fee follows the one that is most of the money. Nothing when no
// line carries any tracking.
export function feeLineTracking(lines: any[]): Array<{ Name: string; Option: string }> | undefined {
  let best: any = null;
  let bestAmount = -1;
  for (const li of lines || []) {
    const amount = Math.abs((Number(li?.UnitAmount) || 0) * (Number(li?.Quantity) || 1));
    if (amount > bestAmount) {
      best = li;
      bestAmount = amount;
    }
  }
  const tracking = Array.isArray(best?.Tracking)
    ? best.Tracking.filter((t: any) => t?.Name && t?.Option).map((t: any) => ({ Name: String(t.Name), Option: String(t.Option) }))
    : [];
  return tracking.length ? tracking : undefined;
}

async function addCardFeeLine(
  organisation: Organisation,
  invoiceId: string,
  fee: CardFee
): Promise<{ ok: true; lineItemId: string } | { ok: false; message: string }> {
  const invoice = await fetchXeroInvoice(organisation.tenantId, invoiceId);
  if (!invoice) return { ok: false, message: 'The bill could not be read back from Xero to add the fee to it.' };
  const existing: any[] = Array.isArray(invoice.LineItems) ? invoice.LineItems : [];
  const already = existing.find((li) => String(li.Description ?? '').includes(FEE_LINE_MARK));
  if (already) return { ok: true, lineItemId: String(already.LineItemID ?? '') };
  const tracking = feeLineTracking(existing);
  const feeLine = {
    Description: `${fee.percent}% ${FEE_LINE_MARK} ${fee.bankAccount}`,
    Quantity: 1,
    UnitAmount: fee.fee,
    AccountCode: fee.accountCode,
    TaxType: 'NONE',
    TaxAmount: 0,
    // The same outlet (and second category) as the bill's largest line.
    ...(tracking ? { Tracking: tracking } : {}),
  };
  const res = await relay('Invoices', {
    method: 'POST',
    tenantId: organisation.tenantId,
    query: { summarizeErrors: 'false' },
    body: { Invoices: [{ InvoiceID: invoiceId, LineItems: [...existing.map(keepLine), feeLine] }] },
  });
  const inv = res.ok ? res.data?.Invoices?.[0] : null;
  const errs: string[] = (inv?.ValidationErrors ?? []).map((e: any) => String(e.Message ?? e));
  if (!res.ok || !inv || errs.length) {
    return { ok: false, message: errs.length ? errs.join(' ') : res.ok ? 'Xero refused the fee line.' : (res as any).message };
  }
  const added = (Array.isArray(inv.LineItems) ? inv.LineItems : []).find((li: any) => String(li.Description ?? '').includes(FEE_LINE_MARK));
  return { ok: true, lineItemId: String(added?.LineItemID ?? '') };
}

// Take the fee line back off a bill whose payment was just undone, so the bill
// is again the document's own figure. Best-effort: the payment is gone either
// way, and a line Xero will not remove is said in the undo's reply.
async function removeCardFeeLine(organisation: Organisation, invoiceId: string, lineItemId: string): Promise<string> {
  const invoice = await fetchXeroInvoice(organisation.tenantId, invoiceId);
  if (!invoice) return 'The bill could not be read back to remove its card fee line.';
  const existing: any[] = Array.isArray(invoice.LineItems) ? invoice.LineItems : [];
  const kept = existing.filter((li) => (lineItemId ? String(li.LineItemID) !== lineItemId : !String(li.Description ?? '').includes(FEE_LINE_MARK)));
  if (kept.length === existing.length) return '';
  const res = await relay('Invoices', {
    method: 'POST',
    tenantId: organisation.tenantId,
    query: { summarizeErrors: 'false' },
    body: { Invoices: [{ InvoiceID: invoiceId, LineItems: kept.map(keepLine) }] },
  });
  const inv = res.ok ? res.data?.Invoices?.[0] : null;
  const errs: string[] = (inv?.ValidationErrors ?? []).map((e: any) => String(e.Message ?? e));
  return !res.ok || !inv || errs.length ? `Xero would not remove the card fee line: ${errs.length ? errs.join(' ') : (res as any).message ?? 'it refused.'}` : '';
}

/**
 * The payment itself, against a bill that is already in Xero: record it from
 * the bank account, on the statement date, for the bill's own figure; read the
 * bill back and record what Xero now says; turn the document's own Paid toggle
 * on; remember the match. Shared by the two roads that settle a line directly
 * (the Bank tab, CYWS's run) and by PUBLISH, which applies a pending autofill
 * (Bill.bankMatch) the moment the bill exists — so a payment recorded either
 * way is recorded the same way.
 */
export async function recordPaymentForLine(
  organisation: Organisation,
  ws: string,
  bill: Bill,
  line: BankLine,
  invoiceId: string,
  opts: { publishedHere: boolean; published?: any; via: 'browser' | 'cyws'; by: string }
): Promise<SettleResult> {
  const account: Record<string, string> | null = line.bank_account_id
    ? { AccountID: line.bank_account_id }
    : line.bank_account_code
      ? { Code: line.bank_account_code }
      : null;
  if (!account) {
    return { status: 422, body: { error: 'no_bank_account', message: 'This statement line names no bank account to pay from. Pick one.' } };
  }
  const billCurrency = String(bill.currency ?? '').trim().toUpperCase();
  const invoiceAmount = parseAmount(bill.total);
  const bankAmount = Math.abs(line.amount);
  // The bank's card fee inside this line, if the entity has one for this
  // account and the line is exactly the document plus it. The payment stays the
  // bill's own figure; the fee is its own spend, so the line reconciles as both.
  const rulesMod = await bankRules();
  const fee = rulesMod ? rulesMod.feeFor(bill, line, cardFeeRules(organisation)) : null;
  // What the bank moved for the BILL, fee excluded — the figure a rate carries.
  const settledBankAmount = fee ? Math.round((bankAmount - fee.fee) * 100) / 100 : bankAmount;
  // Amount in the INVOICE's currency — Xero applies a payment to a bill in the
  // bill's own currency — and, where the bank account is in another, the rate
  // that carries the bank's figure onto it. Xero's CurrencyRate on a payment is
  // FOREIGN PER BASE, the same way round as on the invoice (currencyRateFor in
  // xero.ts): it divides the amount by it to reach what the bank moved. USD
  // 17.17 paid as SGD 22.20 is a rate of 0.7734.
  // The card fee, as a line of the bill, BEFORE the payment: the payment is
  // then the whole statement amount, the one shape Xero suggests for the line.
  // Refused, the bill is paid its own figure and the fee is reported, so the
  // books are right even though that line needs Find & Match.
  let feeResult: any = null;
  let feeLineItemId = '';
  let payAmount = invoiceAmount;
  if (fee) {
    const added = await addCardFeeLine(organisation, invoiceId, fee);
    if (added.ok) {
      feeLineItemId = added.lineItemId;
      payAmount = Math.round((invoiceAmount + fee.fee) * 100) / 100;
      feeResult = { ok: true, amount: fee.fee, percent: fee.percent, accountCode: fee.accountCode, lineItemId: feeLineItemId };
    } else {
      feeResult = { ok: false, amount: fee.fee, accountCode: fee.accountCode, message: added.message };
    }
  }
  const payment: Record<string, unknown> = {
    Invoice: { InvoiceID: invoiceId },
    Account: account,
    Date: line.date,
    Amount: payAmount,
    Reference: (line.reference || line.description).slice(0, 255),
  };
  if (line.currency && billCurrency && line.currency !== billCurrency && settledBankAmount > 0) {
    payment.CurrencyRate = Number((invoiceAmount / settledBankAmount).toFixed(6));
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
      published_here: opts.publishedHere,
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
  // A pending autofill already turned it on and remembers what stood before;
  // otherwise what stands now is what stood before.
  const paidBefore = bill.bankMatch ? Boolean(bill.bankMatch.paidBefore) : Boolean(bill.paid);
  const paymentMethodBefore = bill.bankMatch ? String(bill.bankMatch.paymentMethodBefore ?? '') : String(bill.paymentMethod ?? '');
  const patch: Partial<Bill> = { paid: true };
  if (line.bank_account_name && !String(bill.paymentMethod ?? '')) patch.paymentMethod = line.bank_account_name;
  updateBill(ws, bill.id, patch);
  // The pending autofill is spent: the settlement is the record now.
  if (bill.bankMatch) setBillBankMatch(ws, bill.id, null);
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
    publishedHere: opts.publishedHere,
    ...(fee ? { fee } : {}),
    ...(feeLineItemId ? { feeLineItemId } : {}),
    via: opts.via,
    at: new Date().toISOString(),
    by: opts.by,
  };
  saveRecords([...loadRecords(), match]);
  // The line is spent: CYWS's reconciliation must never propose it again.
  queueLineNotice(match, 'used');

  return { status: 200, body: {
    ok: true,
    invoice: opts.published?.invoice ?? {
      invoiceId,
      invoiceNumber: String(invoice?.InvoiceNumber ?? bill.invoiceNumber ?? ''),
      status: xero.xeroStatus,
    },
    published: opts.publishedHere ? { lines: opts.published?.lines, perLine: opts.published?.perLine, attachment: opts.published?.attachment } : null,
    payment: { paymentId, date: line.date, amount: payAmount, currency: billCurrency, reference: payment.Reference },
    // The bank's card fee posted beside the payment, or why it was not. Null
    // when the line was the bill's money to the cent.
    fee: feeResult,
    match,
    bill: getBillById(ws, bill.id),
  } };
}

/**
 * Apply a document's pending autofill (Bill.bankMatch) to the bill that has
 * just been published for it. Called by postBillToXero once the bill exists:
 * Dext's "Autofill payment" fills the payment fields in the inbox, and it is
 * the PUBLISH that records the payment — so the person's one act in the inbox
 * is honoured by whichever road later publishes the document (the dialog, the
 * bulk button, the payables hand-off). Never throws; the bill is in the ledger
 * either way, and a refusal is reported beside the publish result.
 */
export async function applyPendingBankPayment(
  organisation: Organisation,
  ws: string,
  billId: string,
  invoiceId: string,
  by: string
): Promise<{ ok: boolean; skipped?: boolean; error?: string; message?: string; payment?: any; fee?: any; match?: BankLineRecord }> {
  const bill = getBillById(ws, billId);
  const pending = bill?.bankMatch;
  if (!bill || !pending) return { ok: true, skipped: true };
  const line = await readLine({
    date: pending.date,
    amount: pending.amount,
    currency: pending.currency,
    reference: pending.reference,
    description: pending.description,
    bank_account_id: pending.bankAccountId,
    bank_account_name: pending.bankAccountName,
    bank_account_code: pending.bankAccountCode,
  });
  if (!line) return { ok: false, error: 'bad_line', message: 'The saved bank line could not be read.' };
  // A line settled since — the Bank tab, or CYWS's run — is not paid twice.
  const already = recordsFor(ws).find((r) => r.kind === 'match' && r.key === line.key);
  if (already) {
    setBillBankMatch(ws, bill.id, null);
    return { ok: true, skipped: true, match: already, message: 'This statement line was already settled.' };
  }
  try {
    const out = await recordPaymentForLine(organisation, ws, bill, line, invoiceId, { publishedHere: true, via: 'browser', by });
    if (out.status !== 200) return { ok: false, error: String(out.body?.error ?? 'payment_failed'), message: String(out.body?.message ?? '') };
    return { ok: true, payment: out.body.payment, fee: out.body.fee, match: out.body.match };
  } catch (err) {
    console.error('[bank] pending payment failed', err);
    return { ok: false, error: 'payment_failed', message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Forget every bank match on a document whose Xero link was CLEARED ("Clear
 * Xero link": the bill was removed at the Xero end, and with it the payment).
 * Without this the match record outlived the bill it paid: the statement line
 * still read as settled on the Bank tab and in the inbox, and CYWS still held it
 * as spent, so the line could be settled by nobody. Nothing is sent to Xero —
 * clearing the link is local by definition, and whatever was there is gone —
 * so this only puts the document's Paid and payment method back to what they
 * were before the match and tells CYWS the line is free again.
 */
export function forgetMatchesForBill(ws: string, billId: string): number {
  const all = loadRecords();
  const mine = all.filter((r) => r.orgId === ws && r.kind === 'match' && r.billId === billId);
  if (!mine.length) return 0;
  saveRecords(all.filter((r) => !mine.includes(r)));
  const first = mine[0];
  updateBill(ws, billId, { paid: Boolean(first.paidBefore), paymentMethod: String(first.paymentMethodBefore ?? '') });
  for (const r of mine) queueLineNotice(r, 'released');
  return mine.length;
}

/**
 * Repair matches that no longer describe anything: the document is gone, or it
 * is no longer linked to the Xero bill the match paid (its link was cleared
 * before Clear Xero link forgot matches, or it has since been published again
 * as a different bill). Such a record held the statement line as settled —
 * on the Bank tab, in the inbox, and at CYWS — with no bill behind it, and no
 * button could release it: the document offered no Clear link any more, and
 * Undo tries to delete a payment Xero no longer has.
 *
 * Run wherever the records are read (the lines route, CYWS's candidates), so a
 * stale match clears itself the next time anybody looks. Nothing goes to Xero.
 * The document's Paid and payment method are put back only while they still
 * say what the match set — a person who has changed them since keeps their
 * change.
 */
export function repairStaleMatches(ws: string): number {
  const all = loadRecords();
  const stale = all.filter((r) => {
    if (r.orgId !== ws || r.kind !== 'match') return false;
    const bill = r.billId ? getBillById(ws, r.billId) : null;
    if (!bill) return true;
    if (!bill.xeroInvoiceId) return true;
    return Boolean(r.invoiceId) && bill.xeroInvoiceId !== r.invoiceId;
  });
  if (!stale.length) return 0;
  saveRecords(all.filter((r) => !stale.includes(r)));
  for (const r of stale) {
    const bill = r.billId ? getBillById(ws, r.billId) : null;
    const method = String(bill?.paymentMethod ?? '');
    const untouched = method === String(r.line?.bank_account_name ?? '') || method === String(r.paymentMethodBefore ?? '');
    if (bill && bill.paid && untouched) {
      updateBill(ws, bill.id, { paid: Boolean(r.paidBefore), paymentMethod: String(r.paymentMethodBefore ?? '') });
    }
    queueLineNotice(r, 'released');
  }
  console.log(`[bank] released ${stale.length} stale match(es) in ${ws}: their documents are no longer linked to the bill the match paid`);
  return stale.length;
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
  // The card fee line comes off the bill with the payment, so the bill is the
  // document's own figure again. Only after the payment is gone: Xero will not
  // change the lines of a bill that is paid.
  let feeNote = '';
  if (record.fee && record.invoiceId) {
    feeNote = await removeCardFeeLine(organisation, record.invoiceId, String(record.feeLineItemId ?? ''));
  }
  const bill = record.billId ? getBillById(ws, record.billId) : null;
  if (bill) {
    const invoice = record.invoiceId ? await fetchXeroInvoice(organisation.tenantId, record.invoiceId) : null;
    if (invoice) markBillXeroPayment(ws, bill.id, paymentFromInvoice(invoice));
    else markBillXeroPayment(ws, bill.id, { xeroStatus: 'AUTHORISED', xeroPaidDate: '', xeroPaymentRef: '' });
    updateBill(ws, bill.id, { paid: Boolean(record.paidBefore), paymentMethod: record.paymentMethodBefore ?? '' });
  }
  saveRecords(loadRecords().filter((r) => r.id !== record.id));
  // The payment is gone from Xero, so the line is free again — for CYWS too.
  queueLineNotice(record, 'released');
  return { status: 200, body: {
    ok: true,
    bill: bill ? getBillById(ws, bill.id) : null,
    // Set only when a card fee line could not be taken back off the bill.
    ...(feeNote ? { feeNote } : {}),
  } };
}

// --- the outstanding lines, from CYWS ----------------------------------------
// GET https://cyworkspace.cy-bm.sg/api/webhooks/cybills/bank-recon/outstanding?tenant_id=…
// Contract: deploy/BANK-MATCH.md.
export type OutstandingResult =
  | { ok: true; lines: BankLine[]; retrievedAt: string; reports: Array<{ name: string; retrieved_at: string }>; tenantName: string; refresh: { requested_at: string; accounts: string[] } | null }
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
    // The last retrieval CYBills asked CYWS for, so the page can say it is
    // still waiting. Absent from an older CYWS.
    refresh: data?.refresh && typeof data.refresh.requested_at === 'string'
      ? { requested_at: String(data.refresh.requested_at), accounts: Array.isArray(data.refresh.accounts) ? data.refresh.accounts.map(String) : [] }
      : null,
  };
}

// POST https://cyworkspace…/api/webhooks/cybills/bank-recon/refresh?tenant_id=…
// Ask CYWS to run the n8n Bank Reconciliation retrieval now, instead of waiting
// for its next scheduled run. The lines arrive later, through CYWS's usual
// auto-bank-recon webhook, and are read on /outstanding as always. Contract:
// deploy/BANK-MATCH.md.
export type RefreshResult =
  | { ok: true; requestedAt: string; accounts: string[]; alreadyRunning: boolean }
  | { ok: false; status: number; error: string; message: string };

export async function requestRefreshFromCyws(tenantId: string): Promise<RefreshResult> {
  if (!env.CYWORKSPACE_RELAY_URL || !env.CYWORKSPACE_API_KEY) {
    return { ok: false, status: 503, error: 'cyws_not_configured', message: 'Set CYWORKSPACE_API_KEY (and CYWORKSPACE_RELAY_URL) in server/.env.' };
  }
  const url = new URL(`${env.CYWORKSPACE_RELAY_URL.replace(/\/+$/, '')}/api/webhooks/cybills/bank-recon/refresh`);
  url.searchParams.set('tenant_id', tenantId);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'X-API-Key': env.CYWORKSPACE_API_KEY, Accept: 'application/json' },
      // Building the payload reads Xero twice before n8n is called.
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    return { ok: false, status: 502, error: 'cyws_unreachable', message: `Could not reach CYWorkspace: ${err instanceof Error ? err.message : String(err)}` };
  }
  const data: any = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 404 && !data?.error) {
      return { ok: false, status: 404, error: 'route_missing', message: 'CYWorkspace cannot start a retrieval from here yet (it needs updating — see deploy/BANK-MATCH.md).' };
    }
    return { ok: false, status: res.status, error: String(data?.error ?? 'cyws_error'), message: String(data?.message ?? `CYWorkspace answered ${res.status}.`) };
  }
  return {
    ok: true,
    requestedAt: String(data?.requested_at ?? ''),
    accounts: Array.isArray(data?.accounts) ? data.accounts.map(String) : [],
    alreadyRunning: Boolean(data?.already_running),
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
  // Anything CYWS has not yet been told about spent lines goes first — the
  // Bank tab and the inbox both ask here, so a notice missed while CYWS was down
  // is retried by the next person who looks.
  // A match whose document is no longer linked to the bill it paid is released
  // before the records are read, so the line shows as outstanding again.
  repairStaleMatches(ws);
  void flushLineNotices();
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
    refresh: out.refresh,
    tenant: { id: organisation.tenantId, name: out.tenantName || organisation.tenantName || organisation.name },
  });
});

// POST /api/bank/refresh — ask CYWS to retrieve the latest unreconciled lines
// from Xero now (its n8n Bank Reconciliation run), rather than waiting for the
// next scheduled one. Answers as soon as CYWS has fired the run; the page then
// re-reads /outstanding until the reports arrive. Business Admin like the rest
// of the tab.
bankRouter.post('/refresh', async (req, res) => {
  const scope = requireBankEntity(req, res);
  if (!scope) return;
  const out = await requestRefreshFromCyws(scope.organisation.tenantId);
  if (!out.ok) return res.status(out.status >= 500 ? 502 : out.status).json({ error: out.error, message: out.message });
  res.json({ ok: true, requested_at: out.requestedAt, accounts: out.accounts, already_running: out.alreadyRunning });
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

// --- Autofill payment: Dext's move, in the inbox --------------------------------
// The Costs inbox's Match column shows, on the document's own row, the bank
// statement line that pays it. "Autofill payment" is the person accepting that:
// it turns Paid on, names the bank account as the payment method, and keeps the
// line on the document (Bill.bankMatch) so that PUBLISH — from the dialog, the
// bulk button, or the payables hand-off — records the payment from that account
// on the statement date the moment the bill exists (applyPendingBankPayment,
// called by postBillToXero). Nothing reaches Xero at autofill time; the person
// is filling in fields, and the ledger is written when they publish, which is
// how Dext does it and why the publish dialog says the payment out loud.
//
// The money is checked HERE, at the moment of accepting, by the same rule the
// Bank tab and the settle route hold — so what publish later records can never
// be a payment for a different figure.

// POST /api/bank/autofill — { billId, line }
bankRouter.post('/autofill', async (req, res) => {
  const scope = requireBankEntity(req, res);
  if (!scope) return;
  const { organisation, ws } = scope;
  const mod = await bankRules();
  const billId = String(req.body?.billId ?? '').trim();
  const line = await readLine(req.body?.line);
  if (!billId || !line || !mod) {
    return res.status(400).json({ error: 'missing_field', message: 'billId and a statement line (date, amount, reference) are required.' });
  }
  const bill = getBillById(ws, billId);
  if (!bill) return res.status(404).json({ error: 'bill_not_found' });
  if (!mod.isMoneyOut(line)) {
    return res.status(422).json({ error: 'money_in', message: 'This statement line is money coming IN, and a cost document is money going out.' });
  }
  if (!mod.matchable(bill)) {
    return res.status(409).json({ error: 'not_matchable', message: `“${bill.supplier || 'This document'}” can’t be paid against a bank line: it is on an expense claim, merged away, a credit note, or Xero already says it is paid.` });
  }
  const mine = mod.docAmountFor(bill, line);
  const cents = (n: number) => Math.round(n * 100);
  // The same money, or the document's plus the bank's card fee (feeFor) — the
  // same rule the settle holds, so what publish later records was accepted here.
  const withFee = mine != null && cents(mine) !== Math.abs(cents(line.amount)) && Boolean(mod.feeFor(bill, line, cardFeeRules(organisation)));
  if (mine == null || (cents(mine) !== Math.abs(cents(line.amount)) && !withFee)) {
    return res.status(422).json({
      error: 'amount_mismatch',
      message: mine == null
        ? `“${bill.supplier}” is billed in ${bill.currency || 'another currency'} and states no ${line.currency || 'bank-currency'} figure, so it can’t be paid against this line.`
        : `“${bill.supplier}” is ${bill.currency || ''} ${mine.toFixed(2)}, and this statement line is ${line.currency || ''} ${Math.abs(line.amount).toFixed(2)}.`,
    });
  }
  const taken = recordsFor(ws).find((r) => r.key === line.key);
  if (taken) {
    return res.status(409).json({ error: taken.kind === 'match' ? 'line_already_matched' : 'line_dismissed', message: taken.kind === 'match' ? 'This statement line has already been settled against a document.' : 'This statement line was set aside as not a cost. Offer it again from the Bank tab first.' });
  }
  // Already in Xero and awaiting payment: there is a bill to pay against right
  // now, so this is the settle itself rather than something to hold for publish.
  if (bill.xeroInvoiceId) {
    const out = await settleBillAgainstLine(req, organisation, ws, bill, line, { via: 'browser', by: who(req) });
    return res.status(out.status).json({ ...out.body, settled: out.status === 200 });
  }
  // What stood before, so Clear can put it back.
  const paidBefore = bill.bankMatch ? Boolean(bill.bankMatch.paidBefore) : Boolean(bill.paid);
  const paymentMethodBefore = bill.bankMatch ? String(bill.bankMatch.paymentMethodBefore ?? '') : String(bill.paymentMethod ?? '');
  setBillBankMatch(ws, bill.id, {
    key: line.key,
    date: line.date,
    amount: line.amount,
    currency: line.currency,
    reference: line.reference,
    description: line.description,
    bankAccountId: line.bank_account_id,
    bankAccountName: line.bank_account_name,
    bankAccountCode: line.bank_account_code || '',
    paidBefore,
    paymentMethodBefore,
    at: new Date().toISOString(),
    by: who(req),
  });
  const patch: Partial<Bill> = { paid: true };
  if (line.bank_account_name) patch.paymentMethod = line.bank_account_name;
  const updated = updateBill(ws, bill.id, patch);
  res.json({ ok: true, settled: false, bill: updated });
});

// POST /api/bank/autofill/clear — { billId } — take the pending payment off
// again, and put Paid and the payment method back to what they were.
bankRouter.post('/autofill/clear', async (req, res) => {
  const scope = requireBankEntity(req, res);
  if (!scope) return;
  const { ws } = scope;
  const billId = String(req.body?.billId ?? '').trim();
  const bill = billId ? getBillById(ws, billId) : null;
  if (!bill) return res.status(404).json({ error: 'bill_not_found' });
  const pending = bill.bankMatch;
  if (!pending) return res.json({ ok: true, bill });
  setBillBankMatch(ws, bill.id, null);
  const updated = updateBill(ws, bill.id, { paid: Boolean(pending.paidBefore), paymentMethod: String(pending.paymentMethodBefore ?? '') });
  res.json({ ok: true, bill: updated });
});
