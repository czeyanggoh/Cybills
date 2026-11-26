import { readSetting } from './settings.js';
import { WORKSPACE_ID } from './workspace.js';

// Cash mode: an entity whose Xero subscription has no bills or invoices — only
// Spend Money and Receive Money (Xero's cash-only plans). Everything CYBills
// publishes for it goes up as a BANK TRANSACTION: money that has moved, from a
// real bank or credit card account, on the day it moved. No bill, no sales
// invoice, no payment.
//
// A leaf: the setting and the shape of the record. The relay calls stay in
// xero.ts beside the bill ones they replace.

// Business settings -> Extraction -> Publishing -> Cash mode. Off unless
// switched on. Asked of the entity whose Xero RECEIVES the posting, so a bridge
// entity follows its parent.
export function cashModeFor(orgId: string): boolean {
  if (!orgId) return false;
  const s = readSetting<{ cashMode?: unknown }>(WORKSPACE_ID, 'cybills.extraction-settings.v1', orgId);
  return s?.cashMode === true;
}

export type CashDocType = 'SPEND' | 'RECEIVE';
export const isCashDocType = (docType: unknown): docType is CashDocType => docType === 'SPEND' || docType === 'RECEIVE';

// Which way the money went. A cost is money out and a sale money in; a credit
// note reverses its side.
export function cashDocTypeFor(sale: boolean, credit: boolean): CashDocType {
  return sale === credit ? 'SPEND' : 'RECEIVE';
}

export const NO_CASH_ACCOUNT_MESSAGE =
  'This entity is in cash mode, so a document posts as money that has moved: choose the bank or credit card account it was paid from (turn Paid on and set Payment method on the document, or pick it in the Publish dialog).';

// The bank transaction an invoice-shaped payload becomes. The lines, contact,
// date and tracking are the ones the bill would have carried; what changes is
// that the record names the account the money moved through. No Status choice
// (Xero's bank transactions have no draft) and no CurrencyCode: a bank
// transaction is in its bank account's own currency.
export function bankTransactionFrom(
  payload: Record<string, unknown>,
  opts: { type: CashDocType; accountId: string; date: string; reference: string; url?: string }
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    Type: opts.type,
    Contact: payload.Contact,
    BankAccount: { AccountID: opts.accountId },
    Date: opts.date,
    LineAmountTypes: payload.LineAmountTypes ?? 'Exclusive',
    LineItems: payload.LineItems,
  };
  const reference = opts.reference.trim().slice(0, 255);
  if (reference) out.Reference = reference;
  if (opts.url) out.Url = opts.url;
  if (payload.CurrencyRate) out.CurrencyRate = payload.CurrencyRate;
  return out;
}

// What a set of lines comes to, tax-exclusive lines plus their tax, in cents.
export function linesTotalCents(lines: unknown): number {
  return (Array.isArray(lines) ? lines : []).reduce(
    (sum: number, l: any) => sum + Math.round(((Number(l?.UnitAmount) || 0) * (Number(l?.Quantity) || 1) + (Number(l?.TaxAmount) || 0)) * 100),
    0
  );
}
