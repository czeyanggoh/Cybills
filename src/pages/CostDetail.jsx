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
} from 'lucide-react';
import AppShell from '@/components/AppShell';
import CostsSubnav from '@/components/CostsSubnav';
import SplitItemModal from '@/components/SplitItemModal';
import AddToClaimModal from '@/components/AddToClaimModal';
import PublishToXeroModal from '@/components/PublishToXeroModal';
import { addItemToClaim, createClaim, docToClaimTxn } from '@/lib/claimStore';
import { useAuth } from '@/lib/auth';
import { DOCS, getDoc } from '@/data/docs';
import { getExtractionAccounts, useCategoryOptions } from '@/lib/organisations';
import { fetchBills, billToDoc, billFileUrl, updateBill, uploadBillFile, notifyBillsChanged } from '@/lib/bills';
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
function Select({ value }) {
  return (
    <div className="flex h-9 w-full items-center justify-between rounded-md border bg-background px-3 text-sm">
      <span className="truncate">{value}</span>
      <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
    </div>
  );
}

// Editable dropdown (native select) for pick-from-a-list fields like Category.
function EditableSelect({ value, options, onChange }) {
  const known = options.includes(value);
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full appearance-none rounded-md border bg-background px-3 pr-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {!known && <option value={value}>{value}</option>}
        {options.map((o) => (
          <option key={o} value={o}>{o}</option>
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

const EXTRACT_ERRORS = {
  vision_not_configured: 'Vision extraction isn’t configured on the server yet.',
  invalid_image: 'That file type isn’t supported — use a PNG, JPG, or WebP.',
  refused: 'Claude declined to read that image.',
  no_data: 'Couldn’t read fields from that image — try a clearer photo.',
};

function initialData(doc) {
  return {
    user: doc.user,
    type: doc.type,
    date: doc.date,
    supplier: doc.supplier,
    po: doc.po ?? '',
    ref: doc.ref ?? doc.invoiceNumber ?? '',
    category: doc.category,
    currency: doc.currency,
    total: doc.total,
    tax: doc.tax,
    description: doc.description ?? '',
  };
}

export default function CostDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { visionEnabled, user } = useAuth();
  const categoryOptions = useCategoryOptions();
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
  const [aiError, setAiError] = useState('');
  const [splitOpen, setSplitOpen] = useState(false);
  const [claimOpen, setClaimOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);

  const doc = mockDoc ?? persisted;
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
    fetchBills().then((bills) => {
      if (!alive) return;
      const match = bills.find((b) => b.id === id);
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

  const set = (key, value) => setData((d) => ({ ...d, [key]: value }));
  const go = (delta) => {
    const next = DOCS[index + delta];
    if (next) navigate(`/costs/${next.id}`);
  };

  // Persist the current edits + set a workflow status. Uploaded bills save
  // server-side; sample docs save to localStorage.
  const persistStatus = async (status) => {
    if (doc.persisted) {
      try {
        await updateBill(doc.id, {
          status,
          supplier: data.supplier,
          date: data.date,
          documentType: data.type,
          category: data.category,
          currency: data.currency,
          total: data.total,
          tax: data.tax,
          invoiceNumber: data.ref,
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
        date: data.date,
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
    setExtracting(true);
    try {
      // Classify into the connected org's live Xero chart (bundled fallback).
      const accounts = await getExtractionAccounts();
      const res = await fetch('/api/costs/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64, mediaType, accounts }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setAiError(EXTRACT_ERRORS[body.error] ?? 'Extraction failed — please try again.');
        return;
      }
      const { data: ex } = await res.json();
      setData((d) => ({
        ...d,
        supplier: ex.supplier || d.supplier,
        date: ex.date || d.date,
        type: ex.documentType || d.type,
        ref: ex.invoiceNumber || d.ref,
        currency: ex.currency || d.currency,
        category: ex.category || d.category,
        total: ex.total != null ? String(ex.total) : d.total,
        tax: ex.tax != null ? String(ex.tax) : d.tax,
      }));
    } catch {
      setAiError('Could not read that file.');
    } finally {
      setExtracting(false);
    }
  };

  return (
    <AppShell subnav={<CostsSubnav />}>
      {/* Action bar */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <TopButton subtle onClick={() => navigate('/costs')}>
          <ChevronLeft className="h-4 w-4" /> Back
        </TopButton>
        <Flag className="mx-1 h-4 w-4 text-muted-foreground" />
        <TopButton onClick={() => saveWithStatus('ready')}>Move to ready</TopButton>
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
                  : visionEnabled
                    ? 'Upload receipt & auto-fill with Claude'
                    : 'Upload receipt'}
              </button>
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
              <Field label="Document owner"><Input value={data.user} onChange={(v) => set('user', v)} /></Field>
              <Field label="Type"><Input value={data.type} onChange={(v) => set('type', v)} /></Field>
              <Field label="Date"><Input value={data.date} onChange={(v) => set('date', v)} /></Field>
              <Field label="Supplier"><Input value={data.supplier} onChange={(v) => set('supplier', v)} /></Field>
              <Field label="Purchase order number"><Input value={data.po} onChange={(v) => set('po', v)} /></Field>
              <Field label="Document reference"><Input value={data.ref} onChange={(v) => set('ref', v)} /></Field>
              <Field label="Category">
                <EditableSelect value={data.category} options={categoryOptions} onChange={(v) => set('category', v)} />
              </Field>

              <SectionHeading>Allocation</SectionHeading>
              <Field label="Customer"><Select value="ST Engineering Info-Security Pte. Ltd." /></Field>
              <Field label="Project"><Select value="Red Alpha LLC" /></Field>
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
              <Field label="Tax"><Select value="Extracted amount" /></Field>
              <Field label="Tax amount"><Input value={data.tax} onChange={(v) => set('tax', v)} /></Field>
              <Field label="Net amount"><Input value={data.total} readOnly /></Field>

              <SectionHeading>Payment</SectionHeading>
              <Field label="Paid">
                <div className="flex items-center gap-2">
                  <span className="flex h-5 w-9 items-center rounded-full border p-0.5">
                    <span className="h-4 w-4 rounded-full bg-muted-foreground/50" />
                  </span>
                  <span className="text-sm text-muted-foreground">No</span>
                </div>
              </Field>
              <Field label="Payment method"><Select value="—" /></Field>

              <div className="mt-6 flex flex-wrap gap-2 border-t pt-4">
                <button
                  type="button"
                  onClick={() => saveWithStatus('ready')}
                  className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
                >
                  Move to ready
                </button>
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
                <span>Viewed by Astrid Yang</span>
                <span className="text-muted-foreground">{doc.date}</span>
              </li>
            </ul>
          )}
        </div>
      </div>

      <SplitItemModal
        open={splitOpen}
        onClose={() => setSplitOpen(false)}
        onSplit={() => setSplitOpen(false)}
        imageUrl={imageUrl}
        previewType={previewType}
        current={{ category: data.category, total: data.total, tax: data.tax }}
      />
      <AddToClaimModal
        open={claimOpen}
        onClose={() => setClaimOpen(false)}
        onAdd={({ claimId, newClaim }) => {
          setClaimOpen(false);
          // Link this cost to the chosen (or newly created) claim so it shows
          // up as a line item there, then mark it as in an expense claim.
          const targetId = newClaim ? createClaim(newClaim).id : claimId;
          const actor = user?.name || 'Astrid Yang';
          if (targetId) addItemToClaim(targetId, docToClaimTxn(doc, data, actor));
          saveWithStatus('expenseclaim');
        }}
      />
      <PublishToXeroModal
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        bill={{ id: doc.id, supplier: data.supplier, total: data.total, currency: data.currency, date: data.date }}
        onPublished={onPublished}
      />
    </AppShell>
  );
}
