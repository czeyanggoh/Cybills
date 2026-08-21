import { useRef, useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { X, FileText, Loader2, CheckCircle2, AlertTriangle, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/auth';
import {
  sha256Hex,
  fetchExtract,
  addBill,
  updateBill,
  finalizeBill,
  notifyBillsChanged,
  describeDuplicate,
  VISION_MEDIA,
} from '@/lib/bills';
import { prepareUpload } from '@/lib/image';
import { getExtractionAccounts, useVisibleTaxRates } from '@/lib/organisations';
import { useGstRegistered } from '@/lib/businessProfile';
import { autoPublishAfterRead, xeroBillUrl } from '@/lib/autoPublish';
import { getCustomerRule } from '@/lib/customerRules';
import { useExtractionSettings, defaultPaidFor, dueDateForNewDoc, resolveTaxRate } from '@/lib/extractionSettings';
import { useUsers } from '@/lib/userStore';
import { PDFDocument } from 'pdf-lib';

// Slide-over "Add documents" panel mirroring Dext's, rendered black & white.
// Costs/Sales tabs are wired to the real upload pipeline: hash → (Vision
// extract) → duplicate check → persist. Supplier statements stays UI-only.
const TABS = ['Costs', 'Sales', 'Supplier statements'];

let uid = 0;

// Split a multi-page PDF into one single-page PDF per page, client-side via
// pdf-lib (already bundled). Non-PDFs and single-page PDFs pass through
// unchanged. Powers the "Split PDF by page" mode so each page of a batched
// scan becomes its own document, extracted independently.
async function splitPdfByPage(file) {
  if (file.type !== 'application/pdf') return [file];
  try {
    const src = await PDFDocument.load(await file.arrayBuffer());
    const n = src.getPageCount();
    if (n <= 1) return [file];
    const base = file.name.replace(/\.pdf$/i, '');
    const pages = [];
    for (let i = 0; i < n; i++) {
      const doc = await PDFDocument.create();
      const [page] = await doc.copyPages(src, [i]);
      doc.addPage(page);
      const bytes = await doc.save();
      pages.push(new File([bytes], `${base} — p${i + 1}.pdf`, { type: 'application/pdf' }));
    }
    return pages;
  } catch {
    // Encrypted or unreadable PDF — upload it whole rather than dropping it.
    return [file];
  }
}

let pasteSeq = 0;

// Files off the clipboard. A file copied in Explorer/Finder arrives in
// `files`; a screenshot (Win+Shift+S, ⌘⇧4, "copy image") arrives as an image
// item with no usable name, so give those one — the row label and the stored
// fileName both come from it.
function filesFromClipboard(data) {
  if (!data) return [];
  const direct = Array.from(data.files || []);
  if (direct.length) return direct;
  return Array.from(data.items || [])
    .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
    .map((i) => i.getAsFile())
    .filter(Boolean)
    .map((f) => {
      if (f.name && f.name !== 'image.png') return f;
      const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      return new File([f], `Pasted screenshot ${++pasteSeq}.${ext}`, { type: f.type });
    });
}

function Dropzone({ hint = '6MB for images and PDFs, 100MB for ZIPs', onFiles, accept = 'image/png,image/jpeg,image/webp,image/gif,application/pdf' }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  const take = (fileList) => {
    const files = Array.from(fileList || []);
    if (files.length) onFiles(files);
  };

  // Ctrl/⌘+V anywhere in the panel feeds the clipboard straight into the same
  // pipeline as a drop. The dropzone isn't focused by default, so listen on the
  // document while it's mounted (it unmounts with the drawer) and stay out of
  // the way of pastes aimed at a real text field.
  const onFilesRef = useRef(onFiles);
  onFilesRef.current = onFiles;
  useEffect(() => {
    const onPaste = (e) => {
      const t = e.target;
      if (t?.isContentEditable || t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA') return;
      const files = filesFromClipboard(e.clipboardData);
      if (!files.length) return;
      e.preventDefault();
      onFilesRef.current(files);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, []);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        take(e.dataTransfer.files);
      }}
      className={cn(
        'rounded-lg border-2 border-dashed p-8 text-center transition-colors',
        dragging ? 'border-foreground bg-muted' : 'border-border'
      )}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={accept || undefined}
        className="hidden"
        onChange={(e) => {
          take(e.target.files);
          e.target.value = '';
        }}
      />
      <p className="text-sm font-medium">Drag &amp; drop files to upload</p>
      <p className="my-2 text-xs text-muted-foreground">or</p>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="rounded-md border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted"
      >
        Select files
      </button>
      <p className="mt-3 text-xs text-muted-foreground">
        or paste a screenshot or copied file with{' '}
        <span className="font-medium text-foreground">Ctrl/⌘ + V</span>
      </p>
      <p className="mt-4 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">File limits</span> · {hint}
      </p>
    </div>
  );
}

// One row per uploaded file, reflecting its place in the pipeline.
function UploadItem({ item, onForce, onSkip }) {
  const { status, file, error, duplicate, xeroInvoiceId, attachError } = item;
  return (
    <div className="rounded-md border p-3">
      <div className="flex items-center gap-3">
        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm">{file.name}</span>
        {status === 'extracting' && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading…
          </span>
        )}
        {status === 'uploading' && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Receiving…
          </span>
        )}
        {status === 'added' && (
          <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <CheckCircle2 className="h-3.5 w-3.5" />
            {xeroInvoiceId ? 'Added · awaiting approval in Xero' : 'Added'}
          </span>
        )}
        {status === 'added' && xeroInvoiceId && (
          <a
            href={xeroBillUrl(xeroInvoiceId)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium text-foreground underline underline-offset-2"
          >
            View in Xero <ExternalLink className="h-3 w-3" />
          </a>
        )}
        {status === 'skipped' && <span className="text-xs text-muted-foreground">Skipped</span>}
        {status === 'rejected' && (
          <span className="flex items-center gap-1.5 text-xs font-medium text-destructive">
            <AlertTriangle className="h-3.5 w-3.5" /> Rejected
          </span>
        )}
        {status === 'error' && (
          <span className="flex items-center gap-1.5 text-xs text-foreground">
            <AlertTriangle className="h-3.5 w-3.5" /> {error || 'Failed'}
          </span>
        )}
      </div>

      {status === 'added' && attachError && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-700">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>Posted to Xero, but its file could not be attached: {attachError} Open the document and use “Send file to Xero” to retry.</span>
        </p>
      )}

      {(status === 'uploading' || status === 'extracting') && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground" />
          <span>Received — it’s in Processing while Claude reads it, and moves to your inbox when done.</span>
        </p>
      )}

      {status === 'rejected' && (
        <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="flex items-start gap-2 text-xs text-foreground">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>This exact file already exists in this account. Add it anyway to put a fresh copy in the inbox, or skip it.</span>
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => onForce(item.id)}
              className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              Add anyway
            </button>
            <button
              type="button"
              onClick={() => onSkip(item.id)}
              className="rounded-md border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-background"
            >
              Skip
            </button>
          </div>
        </div>
      )}

      {status === 'duplicate' && (
        <div className="mt-2 rounded-md border border-foreground/30 bg-muted px-3 py-2">
          <p className="flex items-start gap-2 text-xs text-foreground">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              <span className="font-medium">Possible duplicate. </span>
              {describeDuplicate(duplicate)}
            </span>
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => onForce(item.id)}
              className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              Add anyway
            </button>
            <button
              type="button"
              onClick={() => onSkip(item.id)}
              className="rounded-md border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-background"
            >
              Skip
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Which drawer tab matches the workspace the user opened the drawer from.
const TAB_FOR_PATH = { '/sales': 'Sales', '/customers': 'Sales' };
function tabForPath(pathname) {
  if (pathname.startsWith('/supplier-statements')) return 'Supplier statements';
  const key = Object.keys(TAB_FOR_PATH).find((p) => pathname.startsWith(p));
  return key ? TAB_FOR_PATH[key] : 'Costs';
}

export default function AddDocumentsDrawer({ open, onClose }) {
  const { visionEnabled, user } = useAuth();
  const { pathname } = useLocation();
  const users = useUsers();
  const settings = useExtractionSettings();
  const visibleTaxRates = useVisibleTaxRates();
  const gstRegistered = useGstRegistered();
  const [tab, setTab] = useState('Costs');
  const [items, setItems] = useState([]);
  // Who the uploaded documents are attributed to. Stored as the display name
  // (not an email) so attribution shows correctly regardless of the roster's
  // email→name mapping. Defaults to the signed-in user, and keeps following the
  // signed-in user until they pick someone else — auth resolves a tick after
  // first render, so a one-shot default would freeze on a stale/empty value.
  const meName = user?.name || user?.email || '';
  const [owner, setOwner] = useState('');
  // 'file' = one document per uploaded file; 'split' = split each PDF into one
  // document per page before running the pipeline.
  const [mode, setMode] = useState('file');
  const [splitting, setSplitting] = useState(false);
  const ownerTouched = useRef(false);
  useEffect(() => {
    if (!ownerTouched.current && meName) setOwner(meName);
  }, [meName]);
  const ownerOptions = Array.from(
    new Set([meName, ...users.map((u) => u.name || u.email)].filter(Boolean))
  );

  // Default the tab to the workspace the drawer was opened from (Sales page →
  // Sales tab, etc.) each time it opens.
  useEffect(() => {
    if (open) setTab(tabForPath(pathname));
  }, [open, pathname]);

  if (!open) return null;

  const isUpload = tab === 'Costs' || tab === 'Sales' || tab === 'Supplier statements';
  // The split-by-page mode only applies to cost/sales documents, not statements.
  const showModes = tab === 'Costs' || tab === 'Sales';

  const patch = (id, next) =>
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...next } : it)));

  // Per file: hash → optional Vision extract → duplicate check → persist. The
  // extracted fields are kept on the item so "Add anyway" can reuse them without
  // re-running extraction.
  const onFiles = async (rawFiles) => {
    const kind = tab === 'Sales' ? 'sales' : tab === 'Supplier statements' ? 'supplier_statement' : 'cost';
    // Supplier statements are just stored + listed (reconciliation docs) — no
    // categorisation/extraction and no Processing step; they land straight in
    // their own list.
    const isStatement = kind === 'supplier_statement';

    // Apply the Business settings → Extraction defaults to a freshly-created
    // cost/sales doc: default tax rate (only when extraction didn't read one),
    // clear tax when "Extract tax" is off, default paid status by document type,
    // and a due date computed from the invoice date. Skipped for statements.
    const applyExtractionDefaults = async (billId, cur, extracted = null) => {
      if (isStatement) return cur;
      const p = {};
      const defRate = kind === 'sales' ? settings.defaultTaxRateSales : settings.defaultTaxRateCosts;
      // Tax rate: a rule the extractor matched, else the arithmetic fallback
      // (standard-rated vintages / No Tax only), else the configured default.
      if (!String(cur?.taxRate || '')) {
        const resolved = resolveTaxRate({
          total: cur?.total,
          tax: cur?.tax,
          rates: visibleTaxRates,
          suggested: cur?.taxRate || extracted?.taxRate,
          gstRegistered,
          defaultName: defRate,
          currency: cur?.currency,
          kind,
        });
        if (resolved) p.taxRate = resolved;
        if (resolved && extracted?.taxRateReason) p.taxRateReason = extracted.taxRateReason;
      }
      // No GST registration → nothing to claim, so never carry a tax amount.
      if (!settings.extractTax || !gstRegistered) p.tax = 0;
      p.paid = defaultPaidFor(settings, cur?.documentType);
      // Due date, in order of what the evidence supports:
      //   1. the date printed on the document (or what its stated terms resolve
      //      to) — the supplier's own answer, so nothing beats it
      //   2. the org's payment-terms rule (Extraction settings)
      // Neither → left blank, and the Xero publish omits DueDate so the
      // supplier's own terms apply. It is never silently the invoice date.
      const iso = /^\d{4}-\d{2}-\d{2}$/.test(String(cur?.date || '')) ? cur.date : '';
      const printedDue = /^\d{4}-\d{2}-\d{2}$/.test(String(extracted?.dueDate || '')) ? extracted.dueDate : '';
      const due = printedDue || dueDateForNewDoc(settings, kind, iso);
      if (due && due !== iso) p.dueDate = due;
      // Project (Xero PIC), in order of what the evidence supports:
      //   1. a "When to use" rule the document plainly matched (Lists → Projects)
      //   2. the uploader's own assigned project (Users → Project)
      // A rule is a statement about the DOCUMENT, so it outranks a default that
      // is only about who happened to upload it.
      if (!String(cur?.project || '')) {
        const byRule = String(extracted?.project || '').trim();
        if (byRule) p.project = byRule;
        else {
          const ownerName = owner || meName;
          const ownerUser = users.find((u) => u.name === ownerName || u.email === ownerName);
          if (ownerUser?.project) p.project = ownerUser.project;
        }
      }
      const r = await updateBill(billId, p).then((res) => res?.bill).catch(() => null);
      return r ?? cur;
    };
    // In "Split PDF by page" mode, expand every multi-page PDF into per-page
    // files first, so each page flows through the pipeline as its own document.
    let files = rawFiles;
    if (!isStatement && mode === 'split' && rawFiles.some((f) => f.type === 'application/pdf')) {
      setSplitting(true);
      try {
        files = (await Promise.all(rawFiles.map(splitPdfByPage))).flat();
      } finally {
        setSplitting(false);
      }
    }
    const created = files.map((file) => ({ id: ++uid, file, status: 'pending', fields: {} }));
    setItems((prev) => [...created, ...prev]);

    // Resolve the categorisation chart once for the whole batch (live Xero
    // accounts when connected, else the bundled standard chart).
    const accountsPromise = getExtractionAccounts();

    created.forEach((it) => {
      void (async () => {
        try {
          // Dedup on the ORIGINAL file bytes; store a downscaled copy so large
          // photos stay under the server body limit.
          const fileHash = await sha256Hex(it.file);
          const { base64: fileBase64, mediaType } = await prepareUpload(it.file);

          // 1) Accept the document immediately — create it in "Processing" before
          //    reading, so it lands on the Processing page right away (received).
          //    Claude Vision then reads it in the background (boss's request).
          /** @type {any} */
          const payload = {
            fileHash,
            fileName: it.file.name,
            fileBase64,
            mediaType,
            kind,
            status: isStatement ? 'new' : 'processing',
            ...(owner ? { owner } : {}),
          };
          patch(it.id, { status: 'uploading', payload });
          // Business settings → Extraction → Duplicate detection decides what a
          // match DOES: Automatic stops the upload for review, Review manually
          // lets it in carrying a flag, Off doesn't look. A byte-identical file
          // is rejected under every mode — that one needs no judgement.
          const dupMode = settings.duplicateMode;
          let result = await addBill(payload, { force: dupMode === 'Off' });
          if (result.duplicate && !result.rejected && dupMode !== 'Automatic') {
            result = await addBill(payload, { force: true });
          }
          if (result.rejected) {
            // Byte-identical file already in the account — hard reject, no override.
            patch(it.id, { status: 'rejected', duplicate: result.duplicate });
            return;
          }
          if (result.duplicate) {
            patch(it.id, { status: 'duplicate', duplicate: result.duplicate });
            return;
          }
          const bill = result.bill;
          notifyBillsChanged(); // now visible on the Processing page

          // 2) Read with Claude Vision (when available), then finalize — which
          //    applies the fields, re-checks for a duplicate now that
          //    supplier/amount/date are known, and advances the doc out of
          //    Processing: straight to Ready when complete, else the inbox. No
          //    artificial delay — it moves the moment reading is done.
          /** @type {any} */
          let fields = null;
          if (!isStatement && visionEnabled && VISION_MEDIA.includes(mediaType)) {
            patch(it.id, { status: 'extracting', bill });
            try {
              const ex = await fetchExtract(fileBase64, mediaType, await accountsPromise);
              if (ex) {
                fields = { ...ex };
                if (tab === 'Sales') {
                  const rule = getCustomerRule(ex.supplier);
                  if (rule) {
                    if (rule.currency) fields.currency = rule.currency;
                    if (rule.category) fields.category = rule.category;
                  }
                }
              }
            } catch {
              // Extraction is best-effort — the document is already saved.
            }
          }
          if (fields) {
            const fin = await finalizeBill(bill.id, fields, { checkDuplicates: dupMode !== 'Off' });
            // Only Automatic pulls the document back out for review; the other
            // modes keep it and let the flag on the row speak for itself.
            if (fin?.duplicate && dupMode === 'Automatic') {
              await updateBill(bill.id, { status: 'deleted' }).catch(() => {});
              notifyBillsChanged();
              patch(it.id, { status: 'duplicate', duplicate: fin.duplicate });
              return;
            }
            const withDefaults = await applyExtractionDefaults(bill.id, fin?.bill ?? bill, fields);
            // Reading is done: send it to Xero as Awaiting Approval. Declines
            // quietly (and leaves the document alone) when it isn't complete
            // enough to post — see autoPublishAfterRead.
            const posted = await autoPublishAfterRead(withDefaults);
            notifyBillsChanged();
            patch(it.id, {
              status: 'added',
              bill: posted?.bill ?? withDefaults,
              xeroInvoiceId: posted?.invoice?.invoiceId || posted?.bill?.xeroInvoiceId || '',
              // A published bill without its paper attached is worth saying out
              // loud here, rather than leaving it to be noticed in Xero.
              attachError: posted?.attachment && !posted.attachment.ok ? posted.attachment.error : '',
            });
          } else {
            // Nothing read (extraction off/failed) — move straight to the inbox;
            // no fuzzy dedup on empty fields.
            const advanced = await updateBill(bill.id, { status: 'new' }).then((r) => r?.bill).catch(() => null);
            const withDefaults = await applyExtractionDefaults(bill.id, advanced ?? bill);
            notifyBillsChanged();
            patch(it.id, { status: 'added', bill: withDefaults });
          }
        } catch {
          patch(it.id, { status: 'error', error: 'Upload failed' });
        }
      })();
    });
  };

  const onForce = async (id) => {
    const it = items.find((x) => x.id === id);
    if (!it) return;
    patch(id, { status: 'uploading' });
    try {
      // Reuse the payload built on the first attempt (hash, bytes, fields) so
      // "Add anyway" doesn't re-hash or re-extract.
      const payload = it.payload ?? (await (async () => {
        const { base64, mediaType } = await prepareUpload(it.file);
        return { fileHash: await sha256Hex(it.file), fileName: it.file.name, fileBase64: base64, mediaType };
      })());
      const result = await addBill(payload, { force: true });
      if (result.rejected) {
        patch(id, { status: 'rejected', duplicate: result.duplicate });
        return;
      }
      const bill = result.bill;
      notifyBillsChanged(); // in Processing
      /** @type {any} */
      let fields = {};
      if (visionEnabled && payload.fileBase64 && VISION_MEDIA.includes(payload.mediaType)) {
        patch(id, { status: 'extracting', bill });
        try {
          const ex = await fetchExtract(payload.fileBase64, payload.mediaType, await getExtractionAccounts());
          if (ex) fields = { ...ex };
        } catch {
          // best-effort
        }
      }
      // Apply fields + advance out of Processing. This is a forced add, so a
      // duplicate is expected — ignore it (the user chose "Add anyway").
      const fin = await finalizeBill(bill.id, fields).catch(() => null);
      notifyBillsChanged();
      patch(id, { status: 'added', bill: fin?.bill ?? bill });
    } catch {
      patch(id, { status: 'error', error: 'Upload failed' });
    }
  };

  const onSkip = (id) => patch(id, { status: 'skipped' });

  const close = () => {
    setItems([]);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-foreground/20" onClick={close} aria-hidden="true" />
      <div className="absolute right-0 top-0 flex h-full w-full max-w-xl flex-col bg-background shadow-xl">
        <div className="flex h-14 shrink-0 items-center justify-between border-b px-6">
          <h2 className="text-base font-semibold tracking-tight">Add documents</h2>
          <button
            type="button"
            onClick={close}
            className="text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex shrink-0 gap-5 border-b px-6">
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                '-mb-px border-b-2 py-3 text-sm transition-colors',
                tab === t
                  ? 'border-foreground font-medium text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="flex-1 space-y-6 overflow-auto p-6">
          <p className="text-sm text-muted-foreground">
            {tab === 'Costs' && 'Use this panel to add your bills, receipts and purchase invoices.'}
            {tab === 'Sales' && 'Use this panel to add your sales invoices.'}
            {tab === 'Supplier statements' &&
              'Use this panel to upload your supplier statements. PDF, JPG and PNG, one document per file.'}
          </p>

          <div>
            <h3 className="mb-3 text-sm font-medium">Upload from computer</h3>

            {isUpload && (
              <label className="mb-4 flex items-center gap-3 text-sm">
                <span className="w-32 text-muted-foreground">Document owner</span>
                <div className="relative flex-1">
                  <select
                    value={owner}
                    onChange={(e) => {
                      ownerTouched.current = true;
                      setOwner(e.target.value);
                    }}
                    className="h-9 w-full appearance-none rounded-md border bg-background px-3 pr-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {ownerOptions.map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">▾</span>
                </div>
              </label>
            )}

            {showModes && (
              <div className="mb-4 grid grid-cols-2 gap-2">
                {[
                  { k: 'file', t: 'One document per file', h: 'A PDF stays as one document' },
                  { k: 'split', t: 'Split PDF by page', h: 'Each PDF page becomes its own document' },
                ].map((m) => (
                  <button
                    key={m.k}
                    type="button"
                    onClick={() => setMode(m.k)}
                    className={cn(
                      'rounded-md border p-3 text-left transition-colors',
                      mode === m.k ? 'border-foreground bg-muted' : 'hover:bg-muted'
                    )}
                  >
                    <span className="flex items-center gap-2 text-xs font-medium">
                      <span
                        className={cn(
                          'flex h-3.5 w-3.5 items-center justify-center rounded-full border',
                          mode === m.k ? 'border-foreground' : 'border-muted-foreground'
                        )}
                      >
                        {mode === m.k && <span className="h-1.5 w-1.5 rounded-full bg-foreground" />}
                      </span>
                      {m.t}
                    </span>
                    <span className="mt-1 block text-[11px] text-muted-foreground">{m.h}</span>
                  </button>
                ))}
              </div>
            )}

            <Dropzone onFiles={onFiles} />


            {splitting && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Splitting PDF into pages…
              </p>
            )}

            {showModes && !visionEnabled && (
              <p className="mt-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                Field extraction is off (no <span className="font-mono">ANTHROPIC_API_KEY</span>). Files
                are still stored and checked for exact-file duplicates.
              </p>
            )}

            {isUpload && items.length > 0 && (
              <div className="mt-4 space-y-2">
                {items.map((it) => (
                  <UploadItem key={it.id} item={it} onForce={onForce} onSkip={onSkip} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
