import { accountCodeFromCategory } from '@/data/xeroAccounts';
import { isComplete } from '@/lib/costsData';
import { getExtractionSettings } from '@/lib/extractionSettings';
import {
  fetchXeroAccounts,
  fetchXeroTaxRates,
  resolveCategorisationOrgId,
  publishBillToXero,
} from '@/lib/organisations';

// A published bill's page in Xero. The classic Accounts Payable view resolves
// for any bill id and redirects into the new UI, so one shape covers every
// tenant without having to know its short code.
export function xeroBillUrl(invoiceId) {
  const id = String(invoiceId || '').trim();
  return id ? `https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=${encodeURIComponent(id)}` : '';
}

// Post a freshly-read bill to Xero as Awaiting Approval (Xero's SUBMITTED), so
// a document that's been read is already waiting in the ledger rather than
// sitting here until someone publishes it by hand.
//
// Deliberately conservative — this writes to a live ledger, so it declines
// rather than guesses:
//   - off unless Business settings → Extraction has auto-publish on
//   - never twice (a bill carrying a Xero id is skipped)
//   - only a COMPLETE document: supplier, date, a real category, a total > 0.
//     An incomplete one has no account code to post to, and a half-read bill in
//     Xero is worse than one still sitting in the inbox.
//   - only when its category maps to an account that exists in this org's chart
//   - only with a tax code: the document's own, else the account's default
// Anything missing means no publish and no error — the document stays put and
// the Publish to Xero button still works by hand.
//
// Returns the publish result on success, or null when it declined. Never
// throws: reading a document must not fail because Xero was unreachable.
export async function autoPublishAfterRead(bill) {
  try {
    if (!getExtractionSettings().autoPublishXero) return null;
    if (!bill?.id || bill.xeroInvoiceId) return null;
    if (['archived', 'deleted', 'merged'].includes(String(bill.status || ''))) return null;
    if (!isComplete(bill)) return null;

    const accountCode = accountCodeFromCategory(bill.category);
    if (!accountCode) return null;

    // The active org, else the first linked one — the same org whose chart the
    // document was categorised against.
    const orgId = await resolveCategorisationOrgId();
    if (!orgId) return null;

    const [accounts, rates] = await Promise.all([
      fetchXeroAccounts(orgId).catch(() => []),
      fetchXeroTaxRates(orgId).catch(() => []),
    ]);
    const account = accounts.find((a) => a.code === accountCode);
    if (!account) return null;

    const taxType = rates.find((t) => t.name === bill.taxRate)?.taxType || account.taxType || '';
    if (!taxType) return null;

    return await publishBillToXero(orgId, {
      billId: bill.id,
      accountCode,
      taxType,
      status: 'SUBMITTED', // "Awaiting approval" in Xero
      dueDate: bill.dueDate || undefined,
    });
  } catch {
    return null; // best-effort: publish by hand instead
  }
}
