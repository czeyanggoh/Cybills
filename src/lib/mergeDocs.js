import { buildReceiptsPdf } from '@/lib/docsExport';
import { fetchExtract, addBill, updateBill, notifyBillsChanged } from '@/lib/bills';
import { getExtractionAccounts } from '@/lib/organisations';

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

// Sensible defaults for the review form. Merge combines the PAGES of ONE
// document (same supplier, uploaded separately), so the merged amount is the
// document's GRAND TOTAL — the largest source total (the summary/last page) —
// NOT the sum of the pages (which would double-count a repeated total or a
// duplicate). Always editable; the combined-PDF re-read overrides it when it
// succeeds.
function aggregateFields(docs) {
  const first = docs[0] || {};
  const grand = [...docs].sort((a, b) => num(b.total) - num(a.total))[0] || {};
  // Inherit a real category from the already-coded source docs; only blank when
  // none of them are categorised.
  const category = docs.map((d) => d.category).find((c) => c && c !== 'Uncategorised') || '';
  return {
    supplier: first.supplier && first.supplier !== 'Unknown supplier' ? first.supplier : '',
    date: first.date && first.date !== '—' ? first.date : '',
    category,
    currency: first.currency || 'SGD',
    documentType: first.type || 'Receipt',
    invoiceNumber: first.invoiceNumber || first.ref || '',
    total: num(grand.total),
    tax: num(grand.tax),
  };
}

// Dext shows a warning when the selected items look unrelated. Flag the same
// mismatches so the reviewer double-checks before combining.
function mergeWarnings(docs) {
  const uniq = (vals) => [...new Set(vals.filter((v) => v != null && v !== ''))];
  const w = [];
  if (uniq(docs.map((d) => num(d.total))).length > 1) w.push('different total amounts');
  if (uniq(docs.map((d) => (d.date && d.date !== '—' ? d.date : ''))).length > 1) w.push('different dates');
  if (uniq(docs.map((d) => d.user)).length > 1) w.push('different users');
  return w;
}

// Step 1 — build the review payload: combine the files into one PDF, re-extract
// to pre-fill the combined details, and surface any mismatch warnings. Returns
// null if fewer than 2 of the selected docs carry a file.
export async function buildMergePreview(docs) {
  const mergeable = docs.filter((d) => d.persisted && d.hasFile);
  if (mergeable.length < 2) return null;

  const { bytes, added } = await buildReceiptsPdf(mergeable);
  if (added < 2) return null;
  const base64 = uint8ToBase64(bytes);

  let extracted = null;
  try {
    extracted = await fetchExtract(base64, 'application/pdf', getExtractionAccounts());
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

  // Only warn about duplicates when the sources are the SAME supplier AND the
  // same amount — that's a re-upload of one document. Same amount from DIFFERENT
  // suppliers (e.g. an itemised receipt + its card slip) is a legitimate merge,
  // so it must NOT be flagged as a duplicate.
  const warnings = mergeWarnings(mergeable);
  const norm = (s) => String(s ?? '').trim().toLowerCase();
  const totalsSet = new Set(mergeable.map((d) => num(d.total).toFixed(2)));
  const suppliersSet = new Set(mergeable.map((d) => norm(d.supplier)));
  if (mergeable.length > 1 && totalsSet.size === 1 && suppliersSet.size === 1) {
    warnings.unshift('these look like the same document (same supplier + amount) — if they are duplicates, keep one and archive the rest instead of merging');
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
    total: fields.total != null ? String(fields.total) : '',
    tax: fields.tax != null ? String(fields.tax) : '',
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
