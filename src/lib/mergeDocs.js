import { buildReceiptsPdf } from '@/lib/docsExport';
import { fetchExtract, addBill, updateBill, notifyBillsChanged } from '@/lib/bills';
import { getExtractionAccounts } from '@/lib/organisations';

// "Auto-merge documents": combine several cost documents that are really one
// receipt (e.g. page 1 and page 2 uploaded separately) into a single multi-page
// document, re-run extraction on the combined file so the fields reflect the
// whole receipt, then archive the originals — leaving one clean cost. Requested
// on the Support Desk ("there should be an auto merge button… it then reruns
// the document extract based on the single document").

const num = (v) => {
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

// Uint8Array → base64, chunked so a large merged PDF doesn't blow the call
// stack (String.fromCharCode(...bigArray) throws past ~100k args).
function uint8ToBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// Fallback when Vision extraction isn't available (e.g. dev with no API key):
// carry the first document's identity and sum the amounts across the pages, so
// merging still produces a sensible single cost.
function aggregateFields(docs) {
  const first = docs[0];
  return {
    supplier: first.supplier && first.supplier !== 'Unknown supplier' ? first.supplier : '',
    date: first.date && first.date !== '—' ? first.date : '',
    category: first.category && first.category !== 'Uncategorised' ? first.category : '',
    currency: first.currency || 'SGD',
    invoiceNumber: first.invoiceNumber || '',
    total: docs.reduce((s, d) => s + num(d.total), 0),
    tax: docs.reduce((s, d) => s + num(d.tax), 0),
  };
}

// Merge `docs` (rows from the Costs list) into one document. Only persisted
// bills that carry an uploaded file can be merged; anything else is skipped.
// Returns { ok, mergedId, count, skipped, extracted } or { ok:false, reason }.
export async function mergeCostDocs(docs) {
  const mergeable = docs.filter((d) => d.persisted && d.hasFile);
  const skipped = docs.length - mergeable.length;
  if (mergeable.length < 2) return { ok: false, reason: 'need_two_with_files' };

  // 1) Combine every selected file into one PDF (images → pages; existing PDFs
  //    keep their native pages).
  const { bytes, added } = await buildReceiptsPdf(mergeable);
  if (added < 2) return { ok: false, reason: 'combine_failed' };
  const base64 = uint8ToBase64(bytes);

  // 2) Re-extract from the combined document; fall back to aggregating the
  //    sources if Vision isn't configured or declines.
  let extracted = null;
  try {
    extracted = await fetchExtract(base64, 'application/pdf', getExtractionAccounts());
  } catch {
    extracted = null;
  }
  const fields = extracted || aggregateFields(mergeable);
  const first = mergeable[0];

  // 3) Create the merged cost, carrying the combined file. `force` because the
  //    combined bytes are new — it isn't a duplicate of any single source file.
  const payload = {
    fileHash: `merge_${mergeable.map((d) => d.id).join('_')}_${Date.now()}`,
    fileName: `${fields.supplier || first.supplier || 'merged-document'}.pdf`,
    supplier: fields.supplier || (first.supplier === 'Unknown supplier' ? '' : first.supplier) || '',
    invoiceNumber: fields.invoiceNumber || '',
    documentType: 'Receipt',
    date: fields.date || (first.date === '—' ? '' : first.date) || '',
    currency: fields.currency || first.currency || 'SGD',
    category: fields.category || (first.category === 'Uncategorised' ? '' : first.category) || '',
    total: fields.total != null ? String(fields.total) : '',
    tax: fields.tax != null ? String(fields.tax) : '',
    kind: 'cost',
    fileBase64: base64,
    mediaType: 'application/pdf',
  };
  const result = await addBill(payload, { force: true });
  const mergedId = result?.bill?.id || null;
  if (!mergedId) return { ok: false, reason: 'create_failed' };

  // 4) Archive the originals so only the merged document stays in the inbox.
  await Promise.all(mergeable.map((d) => updateBill(d.id, { status: 'archived' }).catch(() => {})));
  notifyBillsChanged();

  return { ok: true, mergedId, count: mergeable.length, skipped, extracted: Boolean(extracted) };
}
