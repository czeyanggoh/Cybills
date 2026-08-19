import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ChevronLeft,
  ChevronRight,
  Flag,
  Sparkles,
  Upload,
  ChevronDown,
  FileText,
  CheckCircle2,
  AlertCircle,
  Info,
  Plus,
  Trash2,
  Loader2,
} from 'lucide-react';
import AppShell from '@/components/AppShell';
import CostsSubnav from '@/components/CostsSubnav';
import SplitItemModal from '@/components/SplitItemModal';
import AddToClaimModal from '@/components/AddToClaimModal';
import PublishToXeroModal from '@/components/PublishToXeroModal';
import { addItemToClaim, createClaim, docToClaimTxn, useClaims } from '@/lib/claimStore';
import { claimRef } from '@/lib/exportFormat';
import { useAuth } from '@/lib/auth';
import { DOCS, getDoc } from '@/data/docs';
import { getExtractionAccounts, useCategoryOptions, useXeroPaymentMethods } from '@/lib/organisations';
import { useCategoryDisplayMode, formatCategory } from '@/lib/categoryDisplay';
import { useProjectOptions, useList } from '@/lib/listsStore';
import { useUsers } from '@/lib/userStore';
import { CUSTOMERS } from '@/data/customers';
import AddPaymentMethodModal from '@/components/AddPaymentMethodModal';
import { fetchBills, fetchBillById, billToDoc, billFileUrl, updateBill, uploadBillFile, notifyBillsChanged, addBill, fetchExtract } from '@/lib/bills';
import { unmergeCost } from '@/lib/mergeDocs';
import { getDocOverrides, setDocOverride } from '@/lib/docOverrides';
import { prepareUpload } from '@/lib/image';
import { cn } from '@/lib/utils';

function TopButton({ children, onClick = () => {}, subtle = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex h-8 items-center gap-1 rounded-md border px-3 text-sm transition-colors hover:bg-muted',
        subtle && 'border-transparent'
      )}
    >
      {children}
    </button>
  );
}

function Field({ label, children }) {
  return (
    <div className="flex items-start gap-4 py-2">
      <div className="w-40 shrink-0 pt-2 text-sm text-muted-foreground">{label}</div>
      <div className="flex-1">{children}</div>
    </div>
  );
}

function Input({ value, onChange = null, readOnly = false }) {
  return (
    <input
      value={value}
      readOnly={readOnly || !onChange}
      onChange={onChange ? (e) => onChange(e.target.value) : undefined}
      className={cn(
        'h-9 w-full rounded-md border px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
        readOnly || !onChange ? 'bg-muted text-muted-foreground' : 'bg-background'
      )}
    />
  );
}

// Read-only dropdown-styled display of an extracted value.
// Editable dropdown (native select) for pick-from-a-list fields like Category.
function EditableSelect({ value, options, onChange, format = (x) => x }) {
  const known = options.includes(value);
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full appearance-none rounded-md border bg-background px-3 pr-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {!known && <option value={value}>{format(value)}</option>}
        {options.map((o) => (
          <option key={o} value={o}>{format(o)}</option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

function SectionHeading({ children }) {
  return (
    <h3 className="mb-1 mt-6 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </h3>
  );
}

// Left panel: the uploaded file once one exists, else a monochrome stand-in.
function ReceiptPreview({ doc, imageUrl, previewType }) {
  if (imageUrl) {
    return (
      <div className="overflow-hidden rounded-lg border bg-background">
        <div className="border-b px-4 py-3 text-sm font-medium">Uploaded receipt</div>
        {previewType === 'pdf' ? (
          <iframe src={imageUrl} title="Uploaded document" className="h-[560px] w-full" />
        ) : (
          <img src={imageUrl} alt="Uploaded receipt" className="max-h-[560px] w-full object-contain" />
        )}
      </div>
    );
  }
  // No stored file yet — neutral placeholder for every document (no seeded
  // "Grab receipt" mock). Use "Upload receipt" to attach the original.
  return (
    <div className="overflow-hidden rounded-lg border bg-background">
      <div className="border-b px-4 py-3 text-sm">
        <span className="font-medium">{doc.supplier || 'Document'}</span>
        {doc.date && doc.date !== '—' && <span className="ml-2 text-muted-foreground">· {doc.date}</span>}
      </div>
      <div className="flex h-80 flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
        <FileText className="h-8 w-8" strokeWidth={1.5} />
        <p className="text-sm">No file preview for this document.</p>
        <p className="text-xs">Use “Upload receipt” to attach the original.</p>
      </div>
    </div>
  );
}

function initialData(doc) {
  return {
    user: doc.user,
    type: doc.type,
    date: doc.date,
    supplier: doc.supplier,
    po: doc.po ?? '',
    ref: doc.ref ?? doc.invoiceNumber ?? '',
    category: doc.category,
    categoryReason: doc.categoryReason ?? '',
    currency: doc.currency,
    total: doc.total,
    tax: doc.tax,
    taxRate: doc.taxRate ?? '',
    description: doc.description ?? '',
    paymentMethod: doc.paymentMethod ?? '',
    paid: Boolean(doc.paid),
    lineItems: Array.isArray(doc.lineItems) ? doc.lineItems : [],
  };
}

export default function CostDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { visionEnabled, user } = useAuth();
  const teamUsers = useUsers();
  const ownerOptions = Array.from(
    new Set([user?.name || user?.email, ...teamUsers.map((u) => u.name || u.email)].filter(Boolean))
  );
  const categoryOptions = useCategoryOptions();
  const catMode = useCategoryDisplayMode();
  const projectOptions = useProjectOptions();
  const customerOptions = CUSTOMERS.map((c) => c.name);
  const paymentMethods = useXeroPaymentMethods();
  // GST/tax rates for purchases (Costs) — the specific rate replaces the old
  // "Extracted amount" placeholder. `rateFor` gives the % for the tax math.
  const taxRates = useList('taxRates');
  const purchaseTaxRates = taxRates.filter(
    (t) => !t.hidden && (String(t.code).includes('INPUT') || t.code === 'NONE')
  );
  const taxRateOptions = purchaseTaxRates.map((t) => t.name);
  const rateFor = (name) => Number(taxRates.find((t) => t.name === name)?.rate ?? 0);
  const [pmModalOpen, setPmModalOpen] = useState(false);
  const fileInputRef = useRef(null);

  // Sample docs carry any local (localStorage) edits applied on top.
  const rawMock = getDoc(id);
  const mockDoc = rawMock ? { ...rawMock, ...(getDocOverrides()[id] || {}) } : null;
  const [tab, setTab] = useState('details');
  const [persisted, setPersisted] = useState(null);
  const [loading, setLoading] = useState(!mockDoc);
  const [data, setData] = useState(() => initialData(mockDoc ?? {}));
  const [imageUrl, setImageUrl] = useState('');
  const [previewType, setPreviewType] = useState('image');
  const [extracting, setExtracting] = useState(false);
  const [extractingLines, setExtractingLines] = useState(false);
  const [aiError, setAiError] = useState('');
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitNote, setSplitNote] = useState('');
  const [claimOpen, setClaimOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [readyError, setReadyError] = useState([]); // required fields missing when trying to move to Ready
  const [gstOpen, setGstOpen] = useState(false); // GST-split panel open
  const [gstWith, setGstWith] = useState(''); // the GST-inclusive amount that carries GST

  const doc = mockDoc ?? persisted;
  // If this document is a line item inside an expense claim, keep the page in
  // that context: a note links back to the claim, and Back returns to it.
  const claims = useClaims();
  const claimForItem = claims.find((c) => (c.transactions || []).some((t) => String(t.itemId) === String(id)));
  const index = DOCS.findIndex((d) => String(d.id) === String(id));

  // Reset the form when navigating between documents. Sample docs resolve from
  // the in-memory mock; uploaded bills are fetched by id from the store.
  useEffect(() => {
    setImageUrl('');
    setAiError('');
    const raw = getDoc(id);
    if (raw) {
      setData(initialData({ ...raw, ...(getDocOverrides()[id] || {}) }));
      setPersisted(null);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    // Prefer the active org's list (drives prev/next); fall back to a global
    // by-id fetch so a claim's line item resolves even if its document sits in
    // another org's book.
    fetchBills()
      .then(async (bills) => {
        const match = bills.find((b) => b.id === id);
        return match || (await fetchBillById(id));
      })
      .then((match) => {
        if (!alive) return;
        const pd = match ? billToDoc(match) : null;
        setPersisted(pd);
        if (pd) {
          setData(initialData(pd));
          if (pd.hasFile) {
            setImageUrl(billFileUrl(pd.id));
            setPreviewType(pd.contentType.includes('pdf') ? 'pdf' : 'image');
          }
        }
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [id]);

  if (!doc) {
    return (
      <AppShell subnav={<CostsSubnav />}>
        <p className="text-sm text-muted-foreground">
          {loading ? 'Loading document…' : 'Document not found.'}
        </p>
      </AppShell>
    );
  }

  // Detail field key → the server bill field it maps to. Editing one of these on
  // a persisted cost auto-saves it so the server can re-derive ready vs inbox
  // (readiness is automatic now — no manual "Move to ready" needed).
  const SERVER_FIELDS = {
    supplier: 'supplier', date: 'date', category: 'category', categoryReason: 'categoryReason',
    currency: 'currency', total: 'total', tax: 'tax', ref: 'invoiceNumber', type: 'documentType',
    taxRate: 'taxRate', description: 'description', user: 'createdBy',
    paymentMethod: 'paymentMethod', paid: 'paid', lineItems: 'lineItems',
  };
  const set = (key, value) => {
    setData((d) => ({ ...d, [key]: value }));
    if (readyError.length) setReadyError([]); // fixing a field clears the "not ready" banner
    const sf = SERVER_FIELDS[key];
    if (doc?.persisted && sf) {
      // Persist + adopt the returned status so the action bar flips to "In Ready"
      // the moment the last required field is filled (and back if one is cleared).
      updateBill(doc.id, { [sf]: value })
        .then((r) => {
          if (r?.bill) {
            setPersisted(billToDoc({ ...r.bill, hasFile: Boolean(r.bill.storageKey) }));
            notifyBillsChanged();
          }
        })
        .catch(() => {});
    }
  };
  const go = (delta) => {
    const next = DOCS[index + delta];
    if (next) navigate(`/costs/${next.id}`);
  };

  // billToDoc shows an empty date as the placeholder '—'; never persist that
  // literal back — coerce anything that isn't a real ISO date to blank.
  const isoDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '');

  // Persist the current edits + set a workflow status. Uploaded bills save
  // server-side; sample docs save to localStorage.
  const persistStatus = async (status) => {
    if (doc.persisted) {
      try {
        await updateBill(doc.id, {
          status,
          supplier: data.supplier,
          date: isoDate(data.date),
          documentType: data.type,
          category: data.category,
          categoryReason: data.categoryReason,
          currency: data.currency,
          total: data.total,
          tax: data.tax,
          invoiceNumber: data.ref,
          taxRate: data.taxRate,
          description: data.description,
          paymentMethod: data.paymentMethod,
          paid: data.paid,
        });
        notifyBillsChanged();
      } catch {
        // best-effort; still navigate back
      }
    } else {
      setDocOverride(id, {
        status,
        user: data.user,
        type: data.type,
        date: isoDate(data.date),
        supplier: data.supplier,
        po: data.po,
        ref: data.ref,
        category: data.category,
        currency: data.currency,
        total: data.total,
        tax: data.tax,
        description: data.description,
      });
    }
  };

  // Save + set status, then return to the inbox (default) or a given route.
  const saveWithStatus = async (status, to = '/costs') => {
    await persistStatus(status);
    navigate(to);
  };

  // "Ready" means a document is complete enough to export / publish, so it must
  // carry the fields the rest of the workflow depends on. Instead of silently
  // advancing a half-filled doc, Move to ready validates these and tells you
  // exactly what's missing (answers "what does Move to Ready do?").
  const isBlank = (v) => !v || String(v).trim() === '' || String(v).trim() === '—';
  const amountOk = (v) => Number(String(v ?? '').replace(/[^0-9.-]/g, '')) > 0;
  const READY_REQUIRED = [
    ['supplier', 'Supplier'],
    ['date', 'Date'],
    ['category', 'Category'],
    ['total', 'Total amount'],
  ];
  const missingForReady = () =>
    READY_REQUIRED.filter(([k]) => {
      if (k === 'total') return !amountOk(data.total);
      if (k === 'category')
        return isBlank(data.category) || String(data.category).trim().toLowerCase() === 'uncategorised';
      return isBlank(data[k]);
    }).map(([, label]) => label);

  // Validate before advancing — only a complete document moves to Ready.
  const moveToReady = () => {
    const missing = missingForReady();
    if (missing.length) {
      setReadyError(missing);
      return;
    }
    setReadyError([]);
    saveWithStatus('ready');
  };

  // "Move to" another workspace — takes the item out of the Costs inbox and
  // lands on that workspace. Persist an archived status so it leaves the list.
  const MOVE_DESTS = [
    { label: 'Sales', to: '/sales' },
    { label: 'Supplier statements', to: '/supplier-statements' },
    { label: 'Vault', to: '/vault' },
  ];
  const moveTo = (dest) => {
    setMoveOpen(false);
    saveWithStatus('archived', dest.to);
  };

  // Unmerge: split a merged document back into its original items (they return
  // to the inbox) and remove the combined document. Dext parity.
  const doUnmerge = async () => {
    if (!window.confirm('Unmerge this document back into its original items? They return to the inbox and this combined document is removed.')) return;
    await unmergeCost(doc);
    navigate('/costs');
  };

  const deleteDoc = () => {
    if (!window.confirm('Delete this document? This removes it from your Costs inbox.')) return;
    saveWithStatus('archived');
  };

  // Publish to Xero (persisted bills only — the server posts the SAVED bill,
  // so flush any on-screen edits first, keeping the current workflow status).
  const openPublish = async () => {
    await persistStatus(persisted?.status ?? 'new');
    setPublishOpen(true);
  };
  const onPublished = ({ bill }) => {
    if (bill) setPersisted(billToDoc({ ...bill, hasFile: Boolean(bill.storageKey) }));
    notifyBillsChanged();
  };

  // Grab the current receipt's bytes (so the split's new item shares the image).
  const receiptToUpload = async () => {
    if (!imageUrl) return null;
    try {
      const resp = await fetch(imageUrl);
      const blob = await resp.blob();
      const type = blob.type || (previewType === 'pdf' ? 'application/pdf' : 'image/jpeg');
      const file = new File([blob], doc.fileName || 'receipt', { type });
      return await prepareUpload(file);
    } catch {
      return null;
    }
  };

  // Split: keep the current item (updated amounts/category) and create a second
  // line item from the SAME receipt with the new item's amounts/category.
  const doSplit = async ({ current, next }) => {
    setSplitOpen(false);
    // 1) apply the "current item" values to this document.
    const curPatch = { category: current.category, total: current.total, tax: current.tax };
    setData((d) => ({ ...d, ...curPatch }));
    if (doc.persisted) await updateBill(doc.id, curPatch).catch(() => {});
    else setDocOverride(doc.id, curPatch);

    // 2) create the new line item as a persisted cost, sharing the receipt image.
    const rec = await receiptToUpload();
    /** @type {any} */
    const payload = {
      fileHash: `split_${doc.id}_${Date.now()}`,
      fileName: doc.fileName || `${data.supplier || 'receipt'}`,
      supplier: data.supplier,
      invoiceNumber: data.invoiceNumber || '',
      documentType: data.type || 'Receipt',
      date: isoDate(data.date),
      currency: 'SGD',
      category: next.category,
      total: next.total,
      tax: next.tax,
      kind: 'cost',
    };
    if (rec) { payload.fileBase64 = rec.base64; payload.mediaType = rec.mediaType; }
    try {
      const result = await addBill(payload, { force: true });
      // Put the split item in the same pipeline tab as the current one.
      const status = doc.persisted ? doc.status : (getDocOverrides()[doc.id]?.status || doc.status);
      if (result?.bill?.id && status && status !== 'new') {
        await updateBill(result.bill.id, { status }).catch(() => {});
      }
      notifyBillsChanged();
      setSplitNote(`Split done — a new item for ${data.supplier || 'this receipt'} was created.`);
    } catch {
      setSplitNote('Could not create the split item. Please try again.');
    }
  };

  const num = (v) => Number(String(v ?? '').replace(/[^0-9.-]/g, '')) || 0;

  // Pick a specific GST/tax rate (replaces the "Extracted amount" placeholder).
  // A rate with a % also fills the tax amount from the GST-inclusive total.
  const setTaxRate = (name) => {
    set('taxRate', name);
    const r = rateFor(name);
    const total = num(data.total);
    const tax = r > 0 && total > 0 ? (total * r) / (100 + r) : 0;
    set('tax', tax ? tax.toFixed(2) : '0.00');
  };

  // Split an invoice that mixes GST and non-GST costs into two lines: the
  // GST-inclusive portion (carrying the tax) and the remainder (no tax). Uses the
  // selected rate, or SG's 9% default.
  // Open the GST-split panel. Pre-fill the GST-inclusive amount: if a tax amount
  // is already set, derive the taxed portion from it; otherwise start at the full
  // total so the user just types how much of it has GST.
  const openGstSplit = () => {
    const total = num(data.total);
    const r = rateFor(data.taxRate) || 9;
    const tax = num(data.tax);
    const preset = tax > 0 && r > 0 ? (tax * (100 + r)) / r : total;
    setGstWith(Math.min(preset, total).toFixed(2));
    setGstOpen(true);
  };

  // Split into a GST line (the entered amount, carrying its GST) + a no-tax line
  // for the remainder. Matches the Support Desk ask for invoices that mix GST and
  // non-GST costs.
  const runGstSplit = () => {
    const total = num(data.total);
    const withGst = num(gstWith);
    const withoutGst = total - withGst;
    const r = rateFor(data.taxRate) || 9;
    if (withGst <= 0 || withGst > total + 0.005) {
      window.alert('Enter a “with GST” amount between 0 and the total.');
      return;
    }
    if (withoutGst <= 0.005) {
      window.alert('Nothing to split — the whole total has GST, so leave it as one line.');
      return;
    }
    const gstTax = (withGst * r) / (100 + r); // GST inside the GST-inclusive amount
    setGstOpen(false);
    doSplit({
      current: { category: data.category, total: withGst.toFixed(2), tax: gstTax.toFixed(2) },
      next: { category: data.category, total: withoutGst.toFixed(2), tax: '0.00' },
    });
  };

  // Run extraction on the given bytes (with the org's Review instructions + live
  // chart), then apply + persist the results. Shared by upload and re-read.
  const extractAndApply = async (imageBase64, mediaType) => {
    setAiError('');
    setExtracting(true);
    try {
      const accounts = await getExtractionAccounts();
      const ex = await fetchExtract(imageBase64, mediaType, accounts);
      if (!ex) { setAiError('Extraction failed — please try again.'); return; }
      const descr =
        ex.description ||
        (Array.isArray(ex.lineItems) ? ex.lineItems.map((li) => li.description).filter(Boolean).join(', ') : '');
      setData((d) => ({
        ...d,
        supplier: ex.supplier || d.supplier,
        date: ex.date || d.date,
        type: ex.documentType || d.type,
        ref: ex.invoiceNumber || d.ref,
        currency: ex.currency || d.currency,
        category: ex.category || d.category,
        categoryReason: ex.categoryReason || d.categoryReason,
        total: ex.total != null ? String(ex.total) : d.total,
        tax: ex.tax != null ? String(ex.tax) : d.tax,
        description: descr || d.description,
      }));
      if (doc?.persisted) {
        const patch = {};
        if (ex.supplier) patch.supplier = ex.supplier;
        if (ex.date) patch.date = ex.date;
        if (ex.documentType) patch.documentType = ex.documentType;
        if (ex.invoiceNumber) patch.invoiceNumber = ex.invoiceNumber;
        if (ex.currency) patch.currency = ex.currency;
        if (ex.category) patch.category = ex.category;
        if (ex.categoryReason) patch.categoryReason = ex.categoryReason;
        if (ex.total != null) patch.total = ex.total;
        if (ex.tax != null) patch.tax = ex.tax;
        if (descr) patch.description = descr;
        const r = await updateBill(doc.id, patch).catch(() => null);
        if (r?.bill) {
          setPersisted(billToDoc({ ...r.bill, hasFile: Boolean(r.bill.storageKey) }));
          notifyBillsChanged();
        }
      }
    } catch {
      setAiError('Could not read that file.');
    } finally {
      setExtracting(false);
    }
  };

  // --- Line items (Dext-style per-line breakdown) --------------------------
  const lineItems = Array.isArray(data.lineItems) ? data.lineItems : [];
  const lineTotal = lineItems.reduce((s, li) => s + num(li.total), 0);
  const outBy = num(data.total) - lineTotal;
  const setLineItems = (rows) => set('lineItems', rows);
  const updateLineItem = (i, patch) =>
    setLineItems(lineItems.map((li, idx) => (idx === i ? { ...li, ...patch } : li)));
  const addLineItem = () =>
    setLineItems([...lineItems, { description: '', category: data.category || 'Uncategorised', net: '', tax: '', total: '' }]);
  const removeLineItem = (i) => setLineItems(lineItems.filter((_, idx) => idx !== i));

  // Read the attached receipt and turn its printed lines into editable rows.
  const extractLineItems = async () => {
    setAiError('');
    const rec = await receiptToUpload();
    if (!rec) { setAiError('Attach a receipt first, then extract line items.'); return; }
    setExtractingLines(true);
    try {
      const accounts = await getExtractionAccounts();
      const ex = await fetchExtract(rec.base64, rec.mediaType, accounts);
      const rows = Array.isArray(ex?.lineItems) ? ex.lineItems : [];
      if (!rows.length) { setAiError('No line items found on this document.'); return; }
      setLineItems(
        rows.map((li) => {
          const total = li.amount != null ? Number(li.amount) : num(li.net) + num(li.tax);
          const tax = li.tax != null ? Number(li.tax) : 0;
          const net = li.net != null ? Number(li.net) : total - tax;
          return {
            description: li.description || '',
            category: li.category || data.category || 'Uncategorised',
            net: net.toFixed(2),
            tax: tax.toFixed(2),
            total: total.toFixed(2),
          };
        })
      );
    } catch {
      setAiError('Could not extract line items.');
    } finally {
      setExtractingLines(false);
    }
  };

  const onUploadClick = () => {
    setAiError('');
    fileInputRef.current?.click();
  };

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setAiError('');
    // Downscale large photos so the base64 payload stays under the server body
    // limit (a raw phone photo can exceed it once encoded, which silently failed
    // the attach and lost the image on reload).
    const { base64: imageBase64, mediaType, previewUrl } = await prepareUpload(file);
    // Always attach + show the uploaded image, regardless of AI availability.
    setPreviewType(mediaType.includes('pdf') ? 'pdf' : 'image');
    setImageUrl(previewUrl);
    // Persist the file onto a real bill so it survives reload (fixes docs that
    // were uploaded before file storage worked).
    if (doc.persisted) {
      try {
        await uploadBillFile(doc.id, imageBase64, mediaType);
        notifyBillsChanged();
      } catch {
        // Surface it — a swallowed failure here is exactly why the image used to
        // vanish on reload.
        setAiError('Could not save the receipt to this document. Please try uploading again.');
      }
    }
    // Only run Claude Vision auto-fill when it's configured; otherwise the user
    // fills the (editable) fields manually.
    if (!visionEnabled) return;
    await extractAndApply(imageBase64, mediaType);
  };

  const readyMissing = missingForReady();

  return (
    <AppShell subnav={<CostsSubnav />}>
      {claimForItem && (
        <div className="mb-3 flex items-start gap-2 rounded-md border bg-muted px-3 py-2 text-sm">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            This item belongs to expense claim{' '}
            <button
              type="button"
              onClick={() => navigate(`/expense-claims/${claimForItem.id}`)}
              className="font-medium text-foreground underline underline-offset-2 hover:opacity-80"
            >
              {claimRef(claimForItem)}
            </button>{' '}
            called <span className="font-medium text-foreground">{claimForItem.claimFor}</span>
            {claimForItem.endDate ? ` (${claimForItem.endDate})` : ''}.
          </span>
        </div>
      )}
      {splitNote && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-emerald-600/30 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          <CheckCircle2 className="h-4 w-4" /> {splitNote}
          <button type="button" onClick={() => setSplitNote('')} className="ml-auto text-emerald-700/70 hover:text-emerald-700">Dismiss</button>
        </div>
      )}
      {readyError.length > 0 && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Not ready yet — this document still needs {readyError.join(', ')}. Fill{' '}
            {readyError.length === 1 ? 'it' : 'them'} in, then Move to ready.
          </span>
          <button type="button" onClick={() => setReadyError([])} className="ml-auto text-destructive/70 hover:text-destructive">Dismiss</button>
        </div>
      )}
      {/* Action bar */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <TopButton subtle onClick={() => navigate(claimForItem ? `/expense-claims/${claimForItem.id}` : '/costs')}>
          <ChevronLeft className="h-4 w-4" /> Back
        </TopButton>
        <Flag className="mx-1 h-4 w-4 text-muted-foreground" />
        {doc.status === 'ready' ? (
          <span className="inline-flex h-8 items-center gap-1 rounded-md border border-foreground/40 px-3 text-sm text-foreground">
            <CheckCircle2 className="h-4 w-4" /> In Ready
          </span>
        ) : doc.persisted ? (
          // Readiness is auto-derived from the fields — show status, no manual button.
          <span
            title={readyMissing.length ? `Missing: ${readyMissing.join(', ')}` : 'All required fields present'}
            className={cn(
              'inline-flex h-8 items-center gap-1 rounded-md border px-3 text-xs',
              readyMissing.length ? 'text-muted-foreground' : 'border-foreground/40 text-foreground'
            )}
          >
            {readyMissing.length ? (
              `Missing: ${readyMissing.join(', ')}`
            ) : (
              <>
                <CheckCircle2 className="h-3.5 w-3.5" /> Ready
              </>
            )}
          </span>
        ) : (
          // Sample/demo docs have no server to auto-derive — keep the manual move.
          <>
            <TopButton onClick={moveToReady}>Move to ready</TopButton>
            <span
              className={cn(
                'inline-flex h-8 items-center gap-1 rounded-md border px-2.5 text-xs',
                readyMissing.length ? 'text-muted-foreground' : 'border-foreground/40 text-foreground'
              )}
            >
              {readyMissing.length ? (
                `Missing ${readyMissing.length} field${readyMissing.length === 1 ? '' : 's'}`
              ) : (
                <>
                  <CheckCircle2 className="h-3.5 w-3.5" /> All fields complete
                </>
              )}
            </span>
          </>
        )}
        {doc.persisted &&
          (doc.xeroInvoiceId ? (
            <span className="inline-flex h-8 items-center gap-1 rounded-md border border-green-600/30 bg-green-600/10 px-3 text-sm text-green-700">
              Posted to {doc.xeroTenantName || 'Xero'}
            </span>
          ) : (
            <TopButton onClick={openPublish}>Publish to Xero</TopButton>
          ))}
        <TopButton onClick={() => setClaimOpen(true)}>Add to expense claim</TopButton>
        <TopButton onClick={() => setSplitOpen(true)}>Split</TopButton>
        {doc.mergedFrom?.length > 0 && <TopButton onClick={doUnmerge}>Unmerge</TopButton>}
        <TopButton onClick={() => saveWithStatus('archived')}>Archive</TopButton>
        <div className="relative">
          <TopButton onClick={() => setMoveOpen((o) => !o)}>
            Move to <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', moveOpen && 'rotate-180')} />
          </TopButton>
          {moveOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMoveOpen(false)} aria-hidden="true" />
              <div className="absolute left-0 z-20 mt-1 w-48 overflow-hidden rounded-md border bg-background py-1 shadow-lg">
                {MOVE_DESTS.map((dest) => (
                  <button
                    key={dest.label}
                    type="button"
                    onClick={() => moveTo(dest)}
                    className="flex w-full items-center px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
                  >
                    {dest.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="ml-auto flex items-center gap-3 text-sm">
          <button
            type="button"
            onClick={() => go(-1)}
            disabled={index <= 0}
            className="flex items-center gap-1 text-muted-foreground enabled:hover:text-foreground disabled:opacity-40"
          >
            <ChevronLeft className="h-4 w-4" /> Previous
          </button>
          <span className="tabular-nums text-muted-foreground">
            {index >= 0 ? index + 1 : '–'} / {DOCS.length}
          </span>
          <button
            type="button"
            onClick={() => go(1)}
            disabled={index >= DOCS.length - 1}
            className="flex items-center gap-1 text-muted-foreground enabled:hover:text-foreground disabled:opacity-40"
          >
            Next <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="mb-4">
        <button
          type="button"
          onClick={deleteDoc}
          className="inline-flex h-8 items-center rounded-md border px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          Delete
        </button>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Left: preview */}
        <ReceiptPreview doc={doc} imageUrl={imageUrl} previewType={previewType} />

        {/* Right: extracted fields */}
        <div>
          <div className="mb-4 flex items-center justify-between border-b">
            <div className="flex gap-6">
              {['details', 'note', 'history'].map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={cn(
                    '-mb-px border-b-2 pb-3 pt-1 text-sm capitalize transition-colors',
                    tab === t
                      ? 'border-foreground font-medium text-foreground'
                      : 'border-transparent text-muted-foreground hover:text-foreground'
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
            <span className="mb-2 rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">Viewed</span>
          </div>

          {tab === 'details' && (
            <div>
              {/* Upload a receipt image (always) + Claude Vision auto-fill (when on) */}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,application/pdf"
                className="hidden"
                onChange={onFile}
              />
              <button
                type="button"
                onClick={onUploadClick}
                disabled={extracting}
                className="mb-2 flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {visionEnabled ? <Sparkles className="h-4 w-4" strokeWidth={2} /> : <Upload className="h-4 w-4" strokeWidth={2} />}
                {extracting
                  ? 'Reading receipt…'
                  : imageUrl
                    ? visionEnabled ? 'Replace file & re-read with Claude' : 'Replace file'
                    : visionEnabled ? 'Upload receipt & auto-fill with Claude' : 'Upload receipt'}
              </button>
              <p className="mb-2 text-center text-xs text-muted-foreground">
                {imageUrl
                  ? 'Replaces the file on this same document — it won’t create a new one.'
                  : 'Attaches the receipt to this document — it won’t create a new one.'}
              </p>
              {aiError && (
                <p className="mb-2 rounded-md border border-foreground/20 bg-muted px-3 py-2 text-center text-xs text-foreground">
                  {aiError}
                </p>
              )}
              {imageUrl && !visionEnabled && (
                <p className="mb-2 rounded-md border border-dashed px-3 py-2 text-center text-xs text-muted-foreground">
                  Receipt attached. AI auto-fill is off — fill in the fields below manually.
                </p>
              )}

              <SectionHeading>Item details</SectionHeading>
              <Field label="Item ID"><Input value={doc.itemId} readOnly /></Field>
              <Field label="Document owner"><EditableSelect value={data.user} options={ownerOptions} onChange={(v) => set('user', v)} /></Field>
              <Field label="Type"><Input value={data.type} onChange={(v) => set('type', v)} /></Field>
              <Field label="Date">
                <input
                  type="date"
                  value={/^\d{4}-\d{2}-\d{2}$/.test(data.date) ? data.date : ''}
                  onChange={(e) => set('date', e.target.value)}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </Field>
              <Field label="Supplier"><Input value={data.supplier} onChange={(v) => set('supplier', v)} /></Field>
              <Field label="Purchase order number"><Input value={data.po} onChange={(v) => set('po', v)} /></Field>
              <Field label="Document reference"><Input value={data.ref} onChange={(v) => set('ref', v)} /></Field>
              <Field label="Category">
                <EditableSelect value={data.category} options={categoryOptions} onChange={(v) => set('category', v)} format={(c) => formatCategory(c, catMode)} />
              </Field>
              <Field label="Reason">
                <textarea
                  rows={2}
                  value={data.categoryReason}
                  onChange={(e) => set('categoryReason', e.target.value)}
                  placeholder={extracting ? 'Reading…' : 'Why this category — filled in by the AI, editable'}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </Field>

              <SectionHeading>Allocation</SectionHeading>
              <Field label="Customer"><EditableSelect value={data.customer || ''} options={customerOptions} onChange={(v) => set('customer', v)} /></Field>
              <Field label="Project"><EditableSelect value={data.project || ''} options={projectOptions} onChange={(v) => set('project', v)} /></Field>
              <Field label="Description">
                <textarea
                  rows={2}
                  value={data.description}
                  onChange={(e) => set('description', e.target.value)}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </Field>

              <SectionHeading>Amount</SectionHeading>
              <Field label="Currency"><Input value={data.currency} onChange={(v) => set('currency', v)} /></Field>
              <Field label="Total amount"><Input value={data.total} onChange={(v) => set('total', v)} /></Field>
              <Field label="Tax rate">
                <EditableSelect value={data.taxRate} options={taxRateOptions} onChange={setTaxRate} />
              </Field>
              <Field label="Tax amount"><Input value={data.tax} onChange={(v) => set('tax', v)} /></Field>
              <Field label="Net amount"><Input value={(num(data.total) - num(data.tax)).toFixed(2)} readOnly /></Field>
              {num(data.total) > 0 && (
                <div className="flex items-start gap-4 py-2">
                  <div className="w-40 shrink-0" />
                  <div className="flex-1">
                    {!gstOpen ? (
                      <>
                        <button
                          type="button"
                          onClick={openGstSplit}
                          className="inline-flex h-8 items-center rounded-md border px-3 text-sm transition-colors hover:bg-muted"
                        >
                          Split GST / non-GST
                        </button>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Invoice mixes GST and non-GST costs? Split it into a line with GST and a line without.
                        </p>
                      </>
                    ) : (
                      <div className="space-y-2 rounded-md border p-3">
                        <p className="text-xs font-medium">Split into a GST line + a non-GST line</p>
                        <label className="flex items-center gap-2 text-xs">
                          <span className="w-32 shrink-0 text-muted-foreground">Amount with GST</span>
                          <input
                            value={gstWith}
                            onChange={(e) => setGstWith(e.target.value)}
                            className="h-8 flex-1 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          />
                        </label>
                        <label className="flex items-center gap-2 text-xs">
                          <span className="w-32 shrink-0 text-muted-foreground">Amount without GST</span>
                          <span className="flex-1 tabular-nums">{(num(data.total) - num(gstWith)).toFixed(2)}</span>
                        </label>
                        <p className="text-[11px] text-muted-foreground">
                          GST rate: {data.taxRate || 'Standard-Rated Purchases (9%)'}. The GST line carries the tax; the other line has none.
                        </p>
                        <div className="flex gap-2 pt-1">
                          <button
                            type="button"
                            onClick={runGstSplit}
                            className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90"
                          >
                            Create 2 lines
                          </button>
                          <button
                            type="button"
                            onClick={() => setGstOpen(false)}
                            className="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-muted"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              <SectionHeading>Payment</SectionHeading>
              <Field label="Paid">
                <button type="button" onClick={() => set('paid', !data.paid)} className="flex items-center gap-2 pt-1">
                  <span className={cn('flex h-5 w-9 items-center rounded-full p-0.5 transition-colors', data.paid ? 'justify-end bg-foreground' : 'justify-start border')}>
                    <span className={cn('h-4 w-4 rounded-full', data.paid ? 'bg-background' : 'bg-muted-foreground/50')} />
                  </span>
                  <span className="text-sm text-muted-foreground">{data.paid ? 'Yes' : 'No'}</span>
                </button>
              </Field>
              <Field label="Payment method">
                <EditableSelect
                  value={data.paymentMethod || ''}
                  options={paymentMethods.map((p) => p.label)}
                  onChange={(v) => set('paymentMethod', v)}
                />
                <button
                  type="button"
                  onClick={() => setPmModalOpen(true)}
                  className="mt-1 text-xs font-medium text-emerald-600 hover:underline"
                >
                  Add payment method
                </button>
              </Field>

              <SectionHeading>Line items</SectionHeading>
              {lineItems.length > 0 && (
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                        <th className="px-2 py-2 font-medium">Description</th>
                        <th className="px-2 py-2 font-medium">Category</th>
                        <th className="px-2 py-2 text-right font-medium">Net</th>
                        <th className="px-2 py-2 text-right font-medium">Tax</th>
                        <th className="px-2 py-2 text-right font-medium">Total</th>
                        <th className="w-8" />
                      </tr>
                    </thead>
                    <tbody>
                      {lineItems.map((li, i) => (
                        <tr key={i} className="border-b last:border-0 align-top">
                          <td className="px-2 py-1.5">
                            <input
                              value={li.description || ''}
                              onChange={(e) => updateLineItem(i, { description: e.target.value })}
                              className="h-8 w-full min-w-[9rem] rounded border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <select
                              value={li.category || ''}
                              onChange={(e) => updateLineItem(i, { category: e.target.value })}
                              className="h-8 w-full min-w-[9rem] rounded border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              {Array.from(new Set([li.category, ...categoryOptions].filter(Boolean))).map((c) => (
                                <option key={c} value={c}>{formatCategory(c, catMode)}</option>
                              ))}
                            </select>
                          </td>
                          {['net', 'tax', 'total'].map((f) => (
                            <td key={f} className="px-2 py-1.5">
                              <input
                                value={li[f] || ''}
                                inputMode="decimal"
                                onChange={(e) => updateLineItem(i, { [f]: e.target.value })}
                                className="h-8 w-20 rounded border bg-background px-2 text-right text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              />
                            </td>
                          ))}
                          <td className="px-1 py-1.5 text-center">
                            <button type="button" onClick={() => removeLineItem(i)} aria-label="Remove line" className="text-muted-foreground transition-colors hover:text-destructive">
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t bg-muted/20 text-xs">
                        <td className="px-2 py-2 font-medium" colSpan={4}>Item total</td>
                        <td className="px-2 py-2 text-right font-semibold">{lineTotal.toFixed(2)}</td>
                        <td />
                      </tr>
                      <tr className="text-xs">
                        <td className={cn('px-2 py-2 font-medium', Math.abs(outBy) > 0.005 && 'text-destructive')} colSpan={4}>
                          Out by
                        </td>
                        <td className={cn('px-2 py-2 text-right font-semibold', Math.abs(outBy) > 0.005 && 'text-destructive')}>
                          {outBy.toFixed(2)}
                        </td>
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={extractLineItems}
                  disabled={extractingLines || !visionEnabled}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {extractingLines ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Extracting…</> : <><Sparkles className="h-3.5 w-3.5" /> Extract line items</>}
                </button>
                <button
                  type="button"
                  onClick={addLineItem}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted"
                >
                  <Plus className="h-3.5 w-3.5" /> Create line item
                </button>
              </div>
              {!visionEnabled && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Line-item extraction needs an <span className="font-mono">ANTHROPIC_API_KEY</span>. You can still add lines manually.
                </p>
              )}

              <div className="mt-6 flex flex-wrap gap-2 border-t pt-4">
                {doc.status === 'ready' ? (
                  <span className="inline-flex h-9 items-center gap-1 rounded-md border border-foreground/40 px-3 text-sm font-medium text-foreground">
                    <CheckCircle2 className="h-4 w-4" /> In Ready
                  </span>
                ) : doc.persisted ? (
                  <span className="inline-flex h-9 items-center gap-1 rounded-md border px-3 text-sm text-muted-foreground">
                    {readyMissing.length ? `Missing: ${readyMissing.join(', ')}` : 'Ready'}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={moveToReady}
                    className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
                  >
                    Move to ready
                  </button>
                )}
                <TopButton onClick={() => setClaimOpen(true)}>Add to expense claim</TopButton>
                <TopButton onClick={() => saveWithStatus('archived')}>Archive</TopButton>
                <TopButton onClick={() => setSplitOpen(true)}>Split</TopButton>
              </div>
            </div>
          )}

          {tab === 'note' && (
            <textarea
              rows={6}
              placeholder="Add a note about this document…"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          )}

          {tab === 'history' && (
            <ul className="space-y-3 text-sm">
              <li className="flex justify-between border-b pb-2">
                <span>Uploaded by {doc.user}</span>
                <span className="text-muted-foreground">{doc.date}</span>
              </li>
              <li className="flex justify-between border-b pb-2">
                <span>Data extracted</span>
                <span className="text-muted-foreground">{doc.date}</span>
              </li>
              <li className="flex justify-between">
                <span>Viewed by {user?.name || 'you'}</span>
                <span className="text-muted-foreground">{doc.date}</span>
              </li>
            </ul>
          )}
        </div>
      </div>

      <SplitItemModal
        open={splitOpen}
        onClose={() => setSplitOpen(false)}
        onSplit={doSplit}
        imageUrl={imageUrl}
        previewType={previewType}
        current={{ category: data.category, total: data.total, tax: data.tax }}
      />
      <AddToClaimModal
        open={claimOpen}
        onClose={() => setClaimOpen(false)}
        onAdd={async ({ claimId, newClaim }) => {
          setClaimOpen(false);
          setAiError('');
          // Link this cost to the chosen (or newly created) claim so it shows
          // up as a line item there, then mark it as in an expense claim.
          try {
            const targetId = newClaim ? (await createClaim(newClaim)).id : claimId;
            const actor = user?.name || user?.email || 'You';
            if (targetId) await addItemToClaim(targetId, docToClaimTxn(doc, data, actor));
            await saveWithStatus('expenseclaim');
          } catch (err) {
            setAiError(
              err?.code === 'claim_locked'
                ? 'That claim is already approved, so items can’t be added to it.'
                : 'Could not add this item to the claim — please try again.'
            );
          }
        }}
      />
      <PublishToXeroModal
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        bill={{ id: doc.id, supplier: data.supplier, total: data.total, currency: data.currency, date: data.date }}
        onPublished={onPublished}
      />

      <AddPaymentMethodModal
        open={pmModalOpen}
        onClose={() => setPmModalOpen(false)}
        onAdded={(pm) => set('paymentMethod', pm.label)}
      />
    </AppShell>
  );
}
