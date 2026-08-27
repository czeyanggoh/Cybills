// Re-reading a document that already exists — the "run this through the reader
// again" path, shared by the document page's single re-read and the Costs
// inbox's bulk one.
//
// It exists because a re-read is not the same as a first read: the document
// already carries fields (some edited by hand), and a supplier rule written
// AFTER the upload only reaches it through this path. Which value wins is a
// precedence question with several near-misses, so it is decided ONCE here
// rather than separately in each caller.
import { billFileUrl, fetchExtract, updateBill, lineItemRows } from '@/lib/bills';
import { prepareUpload } from '@/lib/image';
import {
  matchSupplierRule,
  supplierRulePatch,
  supplierRuleCategoryReason,
  supplierRuleProjectReason,
} from '@/lib/supplierRules';
import { taxRateOutcome } from '@/lib/extractionSettings';

// What a re-read decided, given the document as it stands (`current`) and what
// the reader returned (`ex`). `patch` is what to save; the rest is the working
// out, so an interactive caller can mirror the same result into its form state
// without recomputing it.
//
// Precedence, highest first:
//   1. A supplier rule — a standing instruction for this vendor, and the whole
//      reason someone re-reads a document they already have.
//   2. The document's own printed due date, which beats the rule's payment terms.
//   3. What the reader read this time.
//   4. What the document already carried (a hand-edited tax rate, existing
//      line items) — never clobbered.
export function readDecisions(
  current,
  ex,
  { gstRegistered = true, taxRates = [], allTaxRates = null, defaultTaxRateCosts = '', accounts = [] } = {}
) {
  const descr =
    ex.description ||
    (Array.isArray(ex.lineItems) ? ex.lineItems.map((li) => li.description).filter(Boolean).join(', ') : '');
  // Auto-populate the tax rate from the extracted total/tax when the doc
  // doesn't already carry one (don't clobber a manual choice).
  const exTotal = ex.total != null ? ex.total : current.total;
  const exTax = ex.tax != null ? ex.tax : current.tax;
  // The account this document was coded to decides its tax code when the printed
  // GST agrees with it — what Xero's own UI does when you pick an account.
  const codedTo = String(ex.category || current.category || '');
  const account = (accounts ?? []).find(
    (a) => `${a.code} - ${a.name}` === codedTo || a.code === codedTo
  );
  const rate = taxRateOutcome({
    total: exTotal,
    tax: exTax,
    rates: taxRates,
    allRates: allTaxRates,
    suggested: ex.taxRate,
    gstRegistered,
    defaultName: defaultTaxRateCosts,
    currency: ex.currency || current.currency,
    kind: 'cost',
    accountTaxType: account?.taxType || '',
    accountLabel: account?.code || '',
    // Only Singapore GST from a registered supplier is input tax to claim.
    gstRegNo: ex.supplierGstRegNo || '',
    taxLabel: ex.taxLabel || '',
  });
  const inferredRate = rate.name;
  // Tax is RECORDED only when it is Singapore GST this business can claim:
  // we aren't registered, or the supplier isn't (or charged a foreign tax), and
  // the amount belongs in the cost rather than in the GST box. The total is
  // untouched either way — the money paid doesn't change.
  const exTaxOut = gstRegistered && rate.claimsTax !== false ? exTax : 0;
  const supplierName = ex.supplier || current.supplier;
  const vendorRule = matchSupplierRule(supplierName);
  const rule = supplierRulePatch(vendorRule, { invoiceDate: ex.date || current.date, gstRegistered });
  const projectReason =
    supplierRuleProjectReason(vendorRule, supplierName) || String(ex.projectReason || '').trim();
  const categoryReason =
    supplierRuleCategoryReason(vendorRule, supplierName) || String(ex.categoryReason || '').trim();
  const ruleLines =
    vendorRule.extractLineItems && Array.isArray(ex.lineItems)
      ? lineItemRows(ex.lineItems, rule.category || ex.category || current.category)
      : [];

  const patch = {};
  if (ex.supplier) patch.supplier = ex.supplier;
  if (ex.date) patch.date = ex.date;
  if (ex.documentType) patch.documentType = ex.documentType;
  if (ex.invoiceNumber) patch.invoiceNumber = ex.invoiceNumber;
  if (ex.currency) patch.currency = ex.currency;
  if (ex.category) patch.category = ex.category;
  if (ex.categoryReason) patch.categoryReason = ex.categoryReason;
  if (ex.total != null) patch.total = ex.total;
  if (ex.tax != null || !gstRegistered || rate.claimsTax === false) patch.tax = exTaxOut;
  if (!current.taxRate && inferredRate) patch.taxRate = inferredRate;
  // Why it was coded that way — or, when nothing could be, why not. A blank tax
  // rate with no explanation is indistinguishable from a bug.
  if (!current.taxRate) patch.taxRateReason = ex.taxRateReason || rate.reason || '';
  if (descr) patch.description = descr;
  if (ex.cardLast4) patch.cardLast4 = ex.cardLast4;
  if (ex.project) {
    patch.project = ex.project;
    patch.projectReason = projectReason;
  }
  // The rule has the last word on everything it sets…
  Object.assign(patch, rule);
  if (rule.category) patch.categoryReason = categoryReason;
  if (rule.taxRate) patch.taxRateReason = `Standing rule: documents from ${supplierName} are coded ${rule.taxRate}.`;
  if (rule.project) patch.projectReason = projectReason;
  // …except the due date, where the document's own beats the rule's terms.
  if (ex.dueDate) patch.dueDate = ex.dueDate;
  if (ruleLines.length && !current.lineItems?.length) patch.lineItems = ruleLines;

  return {
    patch, rule, descr, inferredRate, rateReason: rate.reason, exTaxOut,
    supplierName, categoryReason, projectReason, ruleLines,
  };
}

// The document's stored file, downscaled the same way an upload is (a raw phone
// photo is several MB once base64-encoded — over the server's body limit).
// Returns null when there's no file, or it can't be fetched.
async function fileForDoc(doc) {
  if (!doc?.hasFile) return null;
  try {
    const resp = await fetch(billFileUrl(doc.id));
    if (!resp.ok) return null;
    const blob = await resp.blob();
    const type = blob.type || doc.contentType || 'image/jpeg';
    return await prepareUpload(new File([blob], doc.fileName || 'receipt', { type }));
  } catch {
    return null;
  }
}

// Re-read ONE stored document and save what came back. Returns a reason code
// rather than throwing, so a bulk caller can report "3 read, 1 had no file"
// instead of stopping at the first document it can't handle:
//
//   'ok'     — read, and it found the document's identity
//   'blank'  — the reader came back with neither a supplier nor a total. Saved
//              anyway (it may still have read a date or a reference), but said
//              out loud: a document that reads as nothing twice is a problem
//              with the FILE — a dark photo, a scan of a scan — and no amount of
//              running it again will fix that.
//   'nofile' — nothing to re-read
//   'failed' — the read didn't come back at all
export async function reReadDocument(doc, ctx) {
  if (!doc?.persisted) return 'nofile';
  const rec = await fileForDoc(doc);
  if (!rec) return 'nofile';
  try {
    // Emailed documents keep the note they came with, so a re-read is given the
    // same instruction the first read had.
    const ex = await fetchExtract(rec.base64, rec.mediaType, ctx.accounts, doc?.email || null);
    if (!ex) return 'failed';
    const { patch } = readDecisions(doc, ex, ctx);
    await updateBill(doc.id, patch);
    return ex.supplier || Number(ex.total) > 0 ? 'ok' : 'blank';
  } catch {
    return 'failed';
  }
}
