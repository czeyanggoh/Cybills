import { buildReceiptsPdf } from '@/lib/docsExport';
import { fetchExtract, fetchExtractLines, lineItemRows, addBill, updateBill, notifyBillsChanged } from '@/lib/bills';
import { getExtractionAccounts } from '@/lib/organisations';
import { looksLikeDuplicates, mergeKind, orderForMerge } from '@/lib/mergeDetect';
import { matchSupplierRule } from '@/lib/supplierRules';

// "Merge documents" (Dext-style): combine 2+ cost documents that are really one
// receipt (page 1 + page 2, an invoice + its backup, a re-upload) into a single
// multi-page document, re-run extraction, and review-and-confirm before it's
// created. The originals move to a 'merged' state (out of the active inbox) and
// can be split back apart with Unmerge.

const num = (v) => {
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

// Uint8Array → base64, chunked so a large merged PDF doesn't blow the call stack.
function uint8ToBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// Page order depends on WHAT the set is, so it comes from the detector
// (`orderForMerge`): a receipt and its card slip lead with the itemised document
// — that way docs[0] is the merchant, not the bank, and the merged document
// takes the merchant's identity. Two halves of one document lead with the half
// carrying its header (reference, date, supplier), so the pages read in order.
export function orderPages(docs) {
  return orderForMerge(docs, mergeKind(docs));
}

// Sensible defaults for the review form. Merge combines the PAGES of ONE
// document (uploaded separately), so the merged amount is the document's GRAND
// TOTAL — the largest source total (the summary/last page) — NOT the sum of the
// pages (which would double-count a repeated total or a duplicate). Always
// editable; the combined-PDF re-read overrides it when it succeeds.
function aggregateFields(docs) {
  const first = docs[0] || {};
  const grand = [...docs].sort((a, b) => num(b.total) - num(a.total))[0] || {};
  // Take each field from the first document that actually STATES it, in page
  // order — not from docs[0] alone. Two halves of one document each hold what
  // the other is missing (the header page has the reference and the date, the
  // details page has the rows), so reading only the first page would throw away
  // half the document it just combined.
  const firstOf = (pick) => docs.map(pick).find(Boolean) || '';
  // Inherit a real category from the already-coded source docs; only blank when
  // none of them are categorised.
  const category = docs.map((d) => d.category).find((c) => c && c !== 'Uncategorised') || '';
  return {
    supplier: firstOf((d) => (d.supplier && d.supplier !== 'Unknown supplier' ? d.supplier : '')),
    date: firstOf((d) => (d.date && d.date !== '—' ? d.date : '')),
    category,
    categoryReason: firstOf((d) => d.categoryReason),
    description: firstOf((d) => d.description),
    currency: first.currency || 'SGD',
    documentType: first.type || 'Receipt',
    invoiceNumber: firstOf((d) => d.invoiceNumber || d.ref),
    total: num(grand.total),
    tax: num(grand.tax),
  };
}

// Dext shows a warning when the selected items look unrelated. Flag the same
// mismatches so the reviewer double-checks before combining.
function mergeWarnings(docs) {
  // Only what a document actually STATES can disagree with another. A half-read
  // page with no total is silent, not contradictory — counting its blank as 0
  // put "different total amounts" on every page pair, which is the opposite of
  // the truth about them.
  const stated = (vals) => [...new Set(vals.filter((v) => v != null && v !== ''))];
  const w = [];
  if (stated(docs.map((d) => (num(d.total) > 0 ? num(d.total).toFixed(2) : ''))).length > 1) {
    w.push('different total amounts');
  }
  if (stated(docs.map((d) => (d.date && d.date !== '—' ? d.date : ''))).length > 1) w.push('different dates');
  if (stated(docs.map((d) => d.user)).length > 1) w.push('different users');
  return w;
}

// Step 1 — build the review payload: combine the files into one PDF, re-extract
// to pre-fill the combined details, and surface any mismatch warnings. Returns
// null if fewer than 2 of the selected docs carry a file.
export async function buildMergePreview(docs) {
  const mergeable = orderPages(docs.filter((d) => d.persisted && d.hasFile));
  if (mergeable.length < 2) return null;

  const { bytes, added } = await buildReceiptsPdf(mergeable);
  if (added < 2) return null;
  const base64 = uint8ToBase64(bytes);

  let extracted = null;
  try {
    extracted = await fetchExtract(base64, 'application/pdf', await getExtractionAccounts());
  } catch {
    extracted = null;
  }
  const agg = aggregateFields(mergeable);
  const fields = extracted
    ? {
        supplier: extracted.supplier || agg.supplier,
        date: extracted.date || agg.date,
        // Prefer the source docs' already-reviewed category over a re-read of the
        // combined PDF (which can regress to Uncategorised).
        category: agg.category || extracted.category,
        categoryReason: agg.categoryReason || extracted.categoryReason || '',
        description: extracted.description || agg.description || '',
        currency: extracted.currency || agg.currency,
        documentType: agg.documentType,
        invoiceNumber: extracted.invoiceNumber || agg.invoiceNumber,
        // Grand total: the combined PDF re-read gives the document's real total
        // (one page's grand total, not the pages added together); fall back to
        // the largest source total. Never the sum — merging must not double.
        total: String(extracted.total != null ? extracted.total : agg.total),
        tax: String(extracted.tax != null ? extracted.tax : agg.tax),
      }
    : { ...agg, total: String(agg.total), tax: String(agg.tax) };

  // Line items survive the merge.
  //
  // Two ways they can, and the order matters. If the supplier is opted into
  // "Extract line items", the combined PDF is read for them the way an upload
  // is — the dedicated pass, checked against the document's own total, which is
  // the whole point of that rule. Otherwise whatever the source documents
  // already had is carried over, because merging must not lose work: rows the
  // reader found or a reviewer typed were on the paper before the merge and are
  // on it afterwards.
  //
  // Carried over only when exactly ONE source has them. Two pages that both
  // have rows are two partial breakdowns of one document, and concatenating
  // them is how a merged bill ends up worth twice the paper.
  const vendorRule = matchSupplierRule(fields.supplier);
  let lineItems = null;
  if (vendorRule.extractLineItems) {
    const read = await fetchExtractLines(base64, 'application/pdf', await getExtractionAccounts()).catch(() => null);
    if (read?.lines?.length) lineItems = lineItemRows(read.lines, fields.category);
  }
  if (!lineItems) {
    const withLines = mergeable.filter((d) => Array.isArray(d.lineItems) && d.lineItems.length);
    if (withLines.length === 1) lineItems = withLines[0].lineItems;
  }
  if (lineItems?.length) fields.lineItems = lineItems;

  // Warn about a re-upload only when the sources really are the same document
  // twice — same supplier, same amount, and neither one filling a blank in the
  // other. Two halves of ONE document share a supplier and a total as well, and
  // telling the reviewer to archive one of those would lose half the paper.
  const warnings = mergeWarnings(mergeable);
  if (looksLikeDuplicates(mergeable)) {
    warnings.unshift('these look like the same document (same supplier + amount, neither adding anything the other is missing) — if they are duplicates, keep one and archive the rest instead of merging');
  }

  return {
    sources: mergeable,
    skipped: docs.length - mergeable.length,
    base64,
    extracted: Boolean(extracted),
    warnings,
    fields,
  };
}

// Step 2 — commit the merge with the reviewer's (possibly edited) fields: create
// the combined cost carrying the PDF + its lineage, then move the originals to
// 'merged'. Returns { ok, mergedId, count }.
export async function commitMerge(sources, base64, fields) {
  const payload = {
    fileHash: `merge_${sources.map((d) => d.id).join('_')}_${Date.now()}`,
    fileName: `${fields.supplier || 'merged-document'}.pdf`,
    supplier: fields.supplier || '',
    invoiceNumber: fields.invoiceNumber || '',
    documentType: fields.documentType || 'Receipt',
    date: fields.date || '',
    currency: fields.currency || 'SGD',
    category: fields.category || '',
    categoryReason: fields.categoryReason || '',
    description: fields.description || '',
    total: fields.total != null ? String(fields.total) : '',
    tax: fields.tax != null ? String(fields.tax) : '',
    // The rows the merge preview resolved: read from the combined PDF when the
    // supplier is opted into "Extract line items", else carried from the source
    // document that had them. Without this the merged document arrived with no
    // breakdown at all and the rule looked broken.
    ...(Array.isArray(fields.lineItems) && fields.lineItems.length ? { lineItems: fields.lineItems } : {}),
    kind: 'cost',
    fileBase64: base64,
    mediaType: 'application/pdf',
    mergedFrom: sources.map((d) => d.id),
  };
  const result = await addBill(payload, { force: true });
  const mergedId = result?.bill?.id || null;
  if (!mergedId) return { ok: false };

  await Promise.all(sources.map((d) => updateBill(d.id, { status: 'merged' }).catch(() => {})));
  notifyBillsChanged();
  return { ok: true, mergedId, count: sources.length };
}

// Unmerge: restore the originals to the inbox (readiness re-derives itself) and
// remove the merged document. Returns { ok, restored }.
export async function unmergeCost(mergedDoc) {
  const ids = Array.isArray(mergedDoc.mergedFrom) ? mergedDoc.mergedFrom : [];
  if (!ids.length) return { ok: false, restored: 0 };
  await Promise.all(ids.map((id) => updateBill(id, { status: 'new' }).catch(() => {})));
  await updateBill(mergedDoc.id, { status: 'deleted' }).catch(() => {});
  notifyBillsChanged();
  return { ok: true, restored: ids.length };
}
