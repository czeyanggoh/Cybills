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
import { resolveTaxRate } from '@/lib/extractionSettings';

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
export function readDecisions(current, ex, { gstRegistered = true, taxRates = [], defaultTaxRateCosts = '' } = {}) {
  const descr =
    ex.description ||
    (Array.isArray(ex.lineItems) ? ex.lineItems.map((li) => li.description).filter(Boolean).join(', ') : '');
  // Auto-populate the tax rate from the extracted total/tax when the doc
  // doesn't already carry one (don't clobber a manual choice).
  const exTotal = ex.total != null ? ex.total : current.total;
  const exTax = ex.tax != null ? ex.tax : current.tax;
  const inferredRate = resolveTaxRate({
    total: exTotal,
    tax: exTax,
    rates: taxRates,
    suggested: ex.taxRate,
    gstRegistered,
    defaultName: defaultTaxRateCosts,
    currency: ex.currency || current.currency,
    kind: 'cost',
  });
  // Not GST-registered: there's no input tax to record, so don't carry the
  // printed GST onto the bill either.
  const exTaxOut = gstRegistered ? exTax : 0;
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
  if (ex.tax != null || !gstRegistered) patch.tax = exTaxOut;
  if (!current.taxRate && inferredRate) patch.taxRate = inferredRate;
  if (!current.taxRate && ex.taxRateReason) patch.taxRateReason = ex.taxRateReason;
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

  return { patch, rule, descr, inferredRate, exTaxOut, supplierName, categoryReason, projectReason, ruleLines };
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
// instead of stopping at the first document it can't handle.
//   'ok' | 'nofile' (nothing to re-read) | 'failed' (the read didn't come back)
export async function reReadDocument(doc, ctx) {
  if (!doc?.persisted) return 'nofile';
  const rec = await fileForDoc(doc);
  if (!rec) return 'nofile';
  try {
    const ex = await fetchExtract(rec.base64, rec.mediaType, ctx.accounts);
    if (!ex) return 'failed';
    const { patch } = readDecisions(doc, ex, ctx);
    await updateBill(doc.id, patch);
    return 'ok';
  } catch {
    return 'failed';
  }
}
